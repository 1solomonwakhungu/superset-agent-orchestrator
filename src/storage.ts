import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRepositories, type Repositories } from "./repositories.js";

export const CURRENT_SCHEMA_VERSION = 2;

export interface StorageOptions {
  resultRetentionDays?: number;
  idempotencyRetentionDays?: number;
}

export interface CleanupSummary {
  assignmentsRedacted: number;
  resultsRedacted: number;
  idempotencyDeleted: number;
  leasesDeleted: number;
}

export interface IntegrityReport {
  ok: boolean;
  schemaVersion?: number;
  databaseErrors: string[];
  foreignKeyErrors: Record<string, unknown>[];
  schemaErrors: string[];
}

interface Migration { version: number; up: string; down: string }

const migrations: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE batches (id TEXT PRIMARY KEY, name TEXT NOT NULL, requester TEXT NOT NULL,
        status TEXT NOT NULL, policy_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, terminal_at TEXT) STRICT;
      CREATE TABLE assignments (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
        label TEXT NOT NULL, prompt TEXT, workspace_id TEXT NOT NULL, expected_output TEXT,
        created_at TEXT NOT NULL, payload_purged_at TEXT) STRICT;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id),
        backend TEXT NOT NULL, backend_session_id TEXT, attempt INTEGER NOT NULL CHECK (attempt > 0),
        state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT,
        UNIQUE (assignment_id, attempt)) STRICT;
      CREATE TABLE results (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        body TEXT, artifacts_json TEXT NOT NULL DEFAULT '[]', stop_reason TEXT, captured_at TEXT NOT NULL,
        payload_purged_at TEXT) STRICT;
      CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL,
        actor TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL) STRICT;
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE INDEX assignments_batch_idx ON assignments(batch_id);
      CREATE INDEX sessions_assignment_idx ON sessions(assignment_id);
      CREATE INDEX events_aggregate_idx ON events(aggregate_type, aggregate_id, sequence);`,
    down: `DROP TRIGGER events_no_delete; DROP TRIGGER events_no_update; DROP TABLE events;
      DROP TABLE results; DROP TABLE sessions; DROP TABLE assignments; DROP TABLE batches;`,
  },
  {
    version: 2,
    up: `
      CREATE TABLE workspace_leases (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('read-only', 'writer')),
        owner_session_id TEXT REFERENCES sessions(id), owner_batch_id TEXT NOT NULL REFERENCES batches(id),
        acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, released_at TEXT) STRICT;
      CREATE UNIQUE INDEX one_active_writer_per_workspace ON workspace_leases(workspace_id)
        WHERE mode = 'writer' AND released_at IS NULL;
      CREATE INDEX workspace_lease_expiry_idx ON workspace_leases(expires_at);
      CREATE TABLE idempotency_records (scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (scope, key)) WITHOUT ROWID, STRICT;
      CREATE INDEX idempotency_expiry_idx ON idempotency_records(expires_at);
      CREATE INDEX batches_retention_idx ON batches(terminal_at);`,
    down: `DROP INDEX batches_retention_idx; DROP TABLE idempotency_records;
      DROP INDEX workspace_lease_expiry_idx; DROP INDEX one_active_writer_per_workspace;
      DROP TABLE workspace_leases;`,
  },
];

const sqlTimestamp = (date: Date): string => date.toISOString();
const cutoff = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

export class OrchestratorStorage {
  readonly database: DatabaseSync;
  readonly repositories!: Repositories;
  private readonly resultRetentionDays: number;
  private readonly idempotencyRetentionDays: number;

  constructor(readonly path: string, options: StorageOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.resultRetentionDays = options.resultRetentionDays ?? 30;
    this.idempotencyRetentionDays = options.idempotencyRetentionDays ?? 7;
    this.database = new DatabaseSync(path);
    try {
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      const integrity = this.database.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (integrity.quick_check !== "ok") throw new Error(`integrity check failed: ${integrity.quick_check}`);
      if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.migrate();
      this.repositories = createRepositories(this.database);
    } catch (error) {
      this.database.close();
      throw new Error(`Cannot open orchestrator registry at ${path}: ${(error as Error).message}`, { cause: error });
    }
  }

  close(): void { this.database.close(); }

  schemaVersion(): number {
    return (this.database.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_migrations").get() as { version: number }).version;
  }

  migrate(targetVersion = CURRENT_SCHEMA_VERSION): void {
    if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Unsupported schema version ${targetVersion}`);
    }
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;");
    const current = this.schemaVersion();
    if (current > targetVersion) throw new Error("Use rollback() to move to an older schema");
    for (const migration of migrations.filter(({ version }) => version > current && version <= targetVersion)) {
      this.transaction(() => {
        this.database.exec(migration.up);
        this.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      });
    }
  }

  rollback(targetVersion: number, backupPath: string): void {
    if (!Number.isInteger(targetVersion) || targetVersion < 0) throw new Error("Rollback target must be a non-negative integer");
    const current = this.schemaVersion();
    if (targetVersion >= current) throw new Error(`Rollback target must be below current version ${current}`);
    this.backup(backupPath);
    for (const migration of [...migrations].reverse().filter(({ version }) => version > targetVersion && version <= current)) {
      this.transaction(() => {
        this.database.exec(migration.down);
        this.database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(migration.version);
      });
    }
  }

  appendEvent(input: { aggregateType: string; aggregateId: string; eventType: string; actor: string; data?: unknown; occurredAt?: Date }): string {
    const id = randomUUID();
    this.database.prepare(`INSERT INTO events(id, aggregate_type, aggregate_id, event_type, actor, data_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.aggregateType, input.aggregateId, input.eventType, input.actor,
      JSON.stringify(input.data ?? {}), sqlTimestamp(input.occurredAt ?? new Date()));
    return id;
  }

  cleanup(now = new Date()): CleanupSummary {
    const expiredPayload = cutoff(now, this.resultRetentionDays);
    const expiredIdempotency = cutoff(now, this.idempotencyRetentionDays);
    return this.transaction(() => {
      const assignmentsRedacted = Number(this.database.prepare(`UPDATE assignments
        SET prompt = NULL, expected_output = NULL, payload_purged_at = ?
        WHERE payload_purged_at IS NULL AND batch_id IN
          (SELECT id FROM batches WHERE terminal_at IS NOT NULL AND terminal_at < ?)`)
        .run(sqlTimestamp(now), expiredPayload).changes);
      const resultsRedacted = Number(this.database.prepare(`UPDATE results
        SET body = NULL, artifacts_json = '[]', payload_purged_at = ?
        WHERE payload_purged_at IS NULL AND captured_at < ?`).run(sqlTimestamp(now), expiredPayload).changes);
      const idempotencyDeleted = Number(this.database.prepare(
        "DELETE FROM idempotency_records WHERE expires_at < ? OR created_at < ?",
      ).run(sqlTimestamp(now), expiredIdempotency).changes);
      const leasesDeleted = Number(this.database.prepare(
        "DELETE FROM workspace_leases WHERE expires_at < ? OR released_at IS NOT NULL",
      ).run(sqlTimestamp(now)).changes);
      if (assignmentsRedacted + resultsRedacted + idempotencyDeleted + leasesDeleted > 0) {
        this.appendEvent({ aggregateType: "registry", aggregateId: "maintenance", eventType: "retention.cleanup_completed",
          actor: "system", data: { assignmentsRedacted, resultsRedacted, idempotencyDeleted, leasesDeleted }, occurredAt: now });
      }
      return { assignmentsRedacted, resultsRedacted, idempotencyDeleted, leasesDeleted };
    });
  }

  exportJson(path: string): void {
    const tables = ["schema_migrations", "batches", "assignments", "sessions", "results", "events", "workspace_leases", "idempotency_records"];
    const output = this.transaction(() => ({ format: "superset-agent-orchestrator-export", formatVersion: 1,
      schemaVersion: this.schemaVersion(), exportedAt: new Date().toISOString(),
      tables: Object.fromEntries(tables.map((table) => [table, this.database.prepare(`SELECT * FROM ${table}`).all()])) }));
    this.writeAtomically(path, `${JSON.stringify(output, null, 2)}\n`);
  }

  static checkIntegrity(path: string): IntegrityReport {
    const report: IntegrityReport = { ok: false, databaseErrors: [], foreignKeyErrors: [], schemaErrors: [] };
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      report.databaseErrors = (database.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[])
        .map(({ integrity_check }) => integrity_check).filter((message) => message !== "ok");
      report.foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
      const migrations = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
        .map((row) => Number((row as { version: number }).version));
      report.schemaVersion = migrations.at(-1) ?? 0;
      const expected = Array.from({ length: report.schemaVersion }, (_, index) => index + 1);
      if (JSON.stringify(migrations) !== JSON.stringify(expected)) report.schemaErrors.push("migration ledger is not contiguous");
      if (report.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        report.schemaErrors.push(`expected schema version ${CURRENT_SCHEMA_VERSION}, found ${report.schemaVersion}`);
      }
      const requiredObjects = [
        ...["schema_migrations", "batches", "assignments", "sessions", "results", "events", "workspace_leases", "idempotency_records"]
          .map((name) => ["table", name]),
        ["trigger", "events_no_update"], ["trigger", "events_no_delete"],
        ["index", "one_active_writer_per_workspace"],
      ];
      const objects = new Set((database.prepare("SELECT type, name FROM sqlite_schema").all() as { type: string; name: string }[])
        .map(({ type, name }) => `${type}:${name}`));
      for (const [type, name] of requiredObjects) {
        if (!objects.has(`${type}:${name}`)) report.schemaErrors.push(`missing required ${type} ${name}`);
      }
    } catch (error) {
      report.databaseErrors.push((error as Error).message);
    } finally {
      database?.close();
    }
    report.ok = report.databaseErrors.length === 0 && report.foreignKeyErrors.length === 0 && report.schemaErrors.length === 0;
    return report;
  }

  backup(path: string): void {
    if (this.path === ":memory:") throw new Error("File backup is unavailable for an in-memory registry");
    const destination = resolve(path);
    if (destination === resolve(this.path)) throw new Error("Backup path must differ from the live registry");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
    this.database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    const verification = new DatabaseSync(destination, { readOnly: true });
    try {
      const result = verification.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      if (result.integrity_check !== "ok") throw new Error(`Backup integrity check failed: ${result.integrity_check}`);
    } finally { verification.close(); }
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private writeAtomically(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporaryPath, path);
    } catch (error) { rmSync(temporaryPath, { force: true }); throw error; }
  }
}

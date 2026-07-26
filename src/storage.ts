import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const durableTables = ["schema_migrations", "batches", "assignments", "sessions", "results", "events", "workspace_leases", "idempotency_records"];
const sqliteSidecarSuffixes = ["-wal", "-shm", "-journal"];

function preparePrivateDirectory(path: string): void {
  let created = false;
  try { mkdirSync(path, { recursive: false, mode: 0o700 }); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory()) throw new Error(`Storage directory must be a real directory: ${path}`);
    if (created) fchmodSync(descriptor, 0o700);
    else if ((stat.mode & 0o077) !== 0) throw new Error(`Preexisting storage directory must already be owner-only (0700): ${path}`);
  } finally { closeSync(descriptor); }
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateOwnerOnlyFile(path: string): void {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`Storage path must be a regular non-symlink file: ${path}`, { cause: error }); }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Storage path must be a regular file: ${path}`);
    if (stat.nlink !== 1) throw new Error(`Storage path must not have multiple hard links: ${path}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Storage path must already be owner-only (0600): ${path}`);
  } finally { closeSync(descriptor); }
}

function secureCreatedFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Storage path must be a regular file: ${path}`);
    if (stat.nlink !== 1) throw new Error(`Storage path must not have multiple hard links: ${path}`);
    fchmodSync(descriptor, 0o600);
  } finally { closeSync(descriptor); }
}

function validateOwnerOnlyDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory()) throw new Error(`Storage directory must be a real directory: ${path}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Storage directory must be owner-only (0700): ${path}`);
  } finally { closeSync(descriptor); }
}

function prepareRegistryPath(path: string): void {
  preparePrivateDirectory(dirname(path));
  if (!pathExists(path)) closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  validateOwnerOnlyFile(path);
  for (const suffix of sqliteSidecarSuffixes) if (pathExists(`${path}${suffix}`)) validateOwnerOnlyFile(`${path}${suffix}`);
}

function secureSqliteFiles(path: string): void {
  validateOwnerOnlyDirectory(dirname(path));
  validateOwnerOnlyFile(path);
  for (const suffix of sqliteSidecarSuffixes) if (pathExists(`${path}${suffix}`)) secureCreatedFile(`${path}${suffix}`);
}

function validateSecureSqliteFiles(path: string): void {
  validateOwnerOnlyDirectory(dirname(path));
  validateOwnerOnlyFile(path);
  for (const suffix of sqliteSidecarSuffixes) if (pathExists(`${path}${suffix}`)) validateOwnerOnlyFile(`${path}${suffix}`);
}

function rejectLiveDestination(livePath: string, destination: string): void {
  const resolvedLive = resolve(livePath);
  const resolvedDestination = resolve(destination);
  if ([resolvedLive, ...sqliteSidecarSuffixes.map((suffix) => `${resolvedLive}${suffix}`)].includes(resolvedDestination)) {
    throw new Error("Destination must differ from the live registry and its SQLite sidecars");
  }
  if (pathExists(destination) && pathExists(livePath)) {
    const targetType = lstatSync(destination);
    if (targetType.isSymbolicLink()) throw new Error(`Destination must be a regular non-symlink file: ${destination}`);
    const target = statSync(destination);
    for (const source of [livePath, ...sqliteSidecarSuffixes.map((suffix) => `${livePath}${suffix}`)]) {
      if (!pathExists(source)) continue;
      const live = statSync(source);
      if (live.dev === target.dev && live.ino === target.ino) throw new Error("Destination aliases the live registry or a SQLite sidecar");
    }
  }
}

function applyMigrations(database: DatabaseSync, targetVersion: number): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;");
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = (database.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_migrations").get() as { version: number }).version;
    if (current > targetVersion) throw new Error("Use rollback() to move to an older schema");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  for (const migration of migrations.filter(({ version }) => version <= targetVersion)) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const current = (database.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_migrations").get() as { version: number }).version;
      if (current > targetVersion) throw new Error("Use rollback() to move to an older schema");
      if (migration.version > current) {
        database.exec(migration.up);
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function schemaDefinitions(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare(`SELECT type, name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`).all() as { type: string; name: string; sql: string }[];
  return new Map(rows.map(({ type, name, sql }) => [`${type}:${name}`, sql.replaceAll(/\s+/g, " ").trim()]));
}

function expectedSchemaDefinitions(version: number): Map<string, string> {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database, version);
    return schemaDefinitions(database);
  } finally {
    database.close();
  }
}

function validateSchema(database: DatabaseSync, report: IntegrityReport, expectedVersion = CURRENT_SCHEMA_VERSION): void {
  const migrations = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    .map((row) => Number((row as { version: number }).version));
  report.schemaVersion = migrations.at(-1) ?? 0;
  const expectedVersions = Array.from({ length: report.schemaVersion }, (_, index) => index + 1);
  if (JSON.stringify(migrations) !== JSON.stringify(expectedVersions)) report.schemaErrors.push("migration ledger is not contiguous");
  if (report.schemaVersion !== expectedVersion) {
    report.schemaErrors.push(`expected schema version ${expectedVersion}, found ${report.schemaVersion}`);
    return;
  }
  const expected = expectedSchemaDefinitions(expectedVersion);
  const actual = schemaDefinitions(database);
  for (const [object, sql] of expected) {
    if (!actual.has(object)) report.schemaErrors.push(`missing required ${object.replace(":", " ")}`);
    else if (actual.get(object) !== sql) report.schemaErrors.push(`definition mismatch for ${object.replace(":", " ")}`);
  }
  for (const object of actual.keys()) {
    if (!expected.has(object)) report.schemaErrors.push(`unexpected schema object ${object}`);
  }
}

function inspectIntegrity(database: DatabaseSync): IntegrityReport {
  const report: IntegrityReport = { ok: false, databaseErrors: [], foreignKeyErrors: [], schemaErrors: [] };
  try {
    report.databaseErrors = (database.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[])
      .map(({ integrity_check }) => integrity_check).filter((message) => message !== "ok");
    report.foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
    validateSchema(database, report);
  } catch (error) {
    report.databaseErrors.push((error as Error).message);
  }
  report.ok = report.databaseErrors.length === 0 && report.foreignKeyErrors.length === 0 && report.schemaErrors.length === 0;
  return report;
}

export class OrchestratorStorage {
  readonly database: DatabaseSync;
  readonly repositories!: Repositories;
  private readonly resultRetentionDays: number;
  private readonly idempotencyRetentionDays: number;

  constructor(readonly path: string, options: StorageOptions = {}) {
    this.resultRetentionDays = options.resultRetentionDays ?? 30;
    this.idempotencyRetentionDays = options.idempotencyRetentionDays ?? 7;
    if (!Number.isFinite(this.resultRetentionDays) || this.resultRetentionDays < 0) {
      throw new Error("resultRetentionDays must be a finite non-negative number");
    }
    if (!Number.isFinite(this.idempotencyRetentionDays) || this.idempotencyRetentionDays < 0) {
      throw new Error("idempotencyRetentionDays must be a finite non-negative number");
    }
    if (path !== ":memory:") prepareRegistryPath(path);
    this.database = new DatabaseSync(path);
    try {
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      const integrity = this.database.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (integrity.quick_check !== "ok") throw new Error(`integrity check failed: ${integrity.quick_check}`);
      const objects = Number(this.database.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.count);
      if (objects > 0) {
        const ledger = this.database.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
        if (Number(ledger?.count) !== 1) throw new Error("schema validation failed: existing registry has no migration ledger");
        const version = this.schemaVersion();
        if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Unsupported future schema version ${version}`);
        const preMigrationReport: IntegrityReport = { ok: false, databaseErrors: [], foreignKeyErrors: [], schemaErrors: [] };
        validateSchema(this.database, preMigrationReport, version);
        if (preMigrationReport.schemaErrors.length > 0) {
          throw new Error(`schema validation failed before migration: ${preMigrationReport.schemaErrors.join("; ")}`);
        }
        const preMigrationForeignKeyErrors = this.database.prepare("PRAGMA foreign_key_check").all();
        if (preMigrationForeignKeyErrors.length > 0) {
          throw new Error(`foreign key validation failed before migration: ${preMigrationForeignKeyErrors.length} violation(s)`);
        }
      }
      if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      if (path !== ":memory:") secureSqliteFiles(path);
      this.migrate();
      const schemaReport: IntegrityReport = { ok: false, databaseErrors: [], foreignKeyErrors: [], schemaErrors: [] };
      validateSchema(this.database, schemaReport);
      if (schemaReport.schemaErrors.length > 0) throw new Error(`schema validation failed: ${schemaReport.schemaErrors.join("; ")}`);
      const foreignKeyErrors = this.database.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyErrors.length > 0) throw new Error(`foreign key validation failed: ${foreignKeyErrors.length} violation(s)`);
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
    applyMigrations(this.database, targetVersion);
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
        "DELETE FROM workspace_leases WHERE released_at IS NOT NULL",
      ).run().changes);
      if (assignmentsRedacted + resultsRedacted + idempotencyDeleted + leasesDeleted > 0) {
        this.appendEvent({ aggregateType: "registry", aggregateId: "maintenance", eventType: "retention.cleanup_completed",
          actor: "system", data: { assignmentsRedacted, resultsRedacted, idempotencyDeleted, leasesDeleted }, occurredAt: now });
      }
      return { assignmentsRedacted, resultsRedacted, idempotencyDeleted, leasesDeleted };
    });
  }

  exportJson(path: string): void {
    if (this.path !== ":memory:") rejectLiveDestination(this.path, path);
    const output = this.transaction(() => ({ format: "superset-agent-orchestrator-export", formatVersion: 1,
      schemaVersion: this.schemaVersion(), exportedAt: new Date().toISOString(),
      tables: Object.fromEntries(durableTables.map((table) => [table, this.database.prepare(`SELECT * FROM ${table}`).all()])) }));
    this.writeAtomically(path, `${JSON.stringify(output, null, 2)}\n`);
  }

  static exportJson(path: string, outputPath: string): void {
    rejectLiveDestination(path, outputPath);
    validateSecureSqliteFiles(path);
    preparePrivateDirectory(dirname(outputPath));
    if (pathExists(outputPath)) throw new Error("Export destination already exists");
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      database.exec("BEGIN");
      const report = inspectIntegrity(database);
      if (!report.ok) throw new Error(`Cannot export invalid registry: ${[...report.databaseErrors, ...report.schemaErrors, ...report.foreignKeyErrors.map((error) => JSON.stringify(error))].join("; ")}`);
      const output = { format: "superset-agent-orchestrator-export", formatVersion: 1,
        schemaVersion: report.schemaVersion, exportedAt: new Date().toISOString(),
        tables: Object.fromEntries(durableTables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()])) };
      database.exec("COMMIT");
      this.writeFileAtomically(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      throw error;
    } finally {
      database.close();
    }
  }

  static checkIntegrity(path: string): IntegrityReport {
    let database: DatabaseSync | undefined;
    try {
      validateSecureSqliteFiles(path);
      database = new DatabaseSync(path, { readOnly: true });
      return inspectIntegrity(database);
    } catch (error) {
      return { ok: false, databaseErrors: [(error as Error).message], foreignKeyErrors: [], schemaErrors: [] };
    } finally {
      database?.close();
    }
  }

  backup(path: string): void {
    if (this.path === ":memory:") throw new Error("File backup is unavailable for an in-memory registry");
    const destination = resolve(path);
    rejectLiveDestination(this.path, destination);
    preparePrivateDirectory(dirname(destination));
    if (pathExists(destination)) throw new Error("Backup destination already exists");
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
    this.database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    secureCreatedFile(destination);
    const verification = new DatabaseSync(destination, { readOnly: true });
    try {
      const report = inspectIntegrity(verification);
      if (!report.ok) {
        throw new Error(`Backup integrity check failed: ${[...report.databaseErrors, ...report.schemaErrors, ...report.foreignKeyErrors.map((error) => JSON.stringify(error))].join("; ")}`);
      }
    } finally { verification.close(); }
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private writeAtomically(path: string, contents: string): void {
    OrchestratorStorage.writeFileAtomically(path, contents);
  }

  private static writeFileAtomically(path: string, contents: string): void {
    preparePrivateDirectory(dirname(path));
    if (pathExists(path)) throw new Error("Export destination already exists");
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      linkSync(temporaryPath, path);
      rmSync(temporaryPath);
    } catch (error) { rmSync(temporaryPath, { force: true }); throw error; }
  }
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 3;

export type LeaseState = "active" | "releasing" | "released" | "quarantined";

/**
 * Private bearer authority for one writer generation. The fencing token is never
 * persisted, audited, or returned through a client-visible channel; only its
 * digest is stored, so possession of this value is the proof of authority.
 */
export interface LeaseAuthority {
  leaseId: string;
  workspaceId: string;
  ownerSessionId: string | null;
  ownerBatchId: string;
  generation: number;
  fencingToken: string;
  rowVersion: number;
  expiresAt: string;
  serverInstanceId: string;
  ownerHost: string;
  processId: number | null;
  processStartToken: string | null;
}

export interface WorkspaceLeaseStatus {
  leaseId: string;
  workspaceId: string;
  ownerSessionId: string | null;
  ownerBatchId: string;
  generation: number;
  state: LeaseState;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  quarantineReason: string | null;
  rowVersion: number;
  serverInstanceId: string;
  ownerHost: string;
  processId: number | null;
  processStartToken: string | null;
}

/** Another writer authority exists, or its existence is uncertain. */
export class WorkspaceWriterBusyError extends Error {
  readonly code = "WORKSPACE_WRITER_BUSY";
}

/** The caller does not own the current generation. */
export class LeaseFencedError extends Error {
  readonly code = "LEASE_FENCED";
}

/** Process, lock, target, or durable evidence is inconclusive. */
export class LeaseRecoveryAmbiguousError extends Error {
  readonly code = "LEASE_RECOVERY_AMBIGUOUS";
}

/** Lease state failed integrity validation. */
export class LeaseStateCorruptError extends Error {
  readonly code = "LEASE_STATE_CORRUPT";
}

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
  {
    version: 3,
    up: `
      CREATE TABLE IF NOT EXISTS workspace_fencing (workspace_id TEXT PRIMARY KEY,
        last_generation INTEGER NOT NULL CHECK (last_generation > 0)) STRICT;
      ALTER TABLE workspace_leases ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0);
      ALTER TABLE workspace_leases ADD COLUMN fencing_token_digest TEXT NOT NULL DEFAULT '';
      ALTER TABLE workspace_leases ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'releasing', 'released', 'quarantined'));
      ALTER TABLE workspace_leases ADD COLUMN heartbeat_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE workspace_leases ADD COLUMN quarantine_reason TEXT;
      ALTER TABLE workspace_leases ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0);
      ALTER TABLE workspace_leases ADD COLUMN server_instance_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE workspace_leases ADD COLUMN owner_host TEXT NOT NULL DEFAULT '';
      ALTER TABLE workspace_leases ADD COLUMN process_id INTEGER;
      ALTER TABLE workspace_leases ADD COLUMN process_start_token TEXT;
      UPDATE workspace_leases SET heartbeat_at = acquired_at,
        state = CASE WHEN released_at IS NULL THEN 'quarantined' ELSE 'released' END,
        quarantine_reason = CASE WHEN released_at IS NULL
          THEN 'legacy lease predates fencing and requires evidence-based repair' END;
      INSERT INTO workspace_fencing(workspace_id, last_generation)
        SELECT workspace_id, MAX(generation) FROM workspace_leases GROUP BY workspace_id
        ON CONFLICT(workspace_id) DO UPDATE
          SET last_generation = MAX(last_generation, excluded.last_generation);
      DROP INDEX one_active_writer_per_workspace;
      CREATE UNIQUE INDEX one_active_writer_per_workspace ON workspace_leases(workspace_id)
        WHERE mode = 'writer' AND state != 'released';
      CREATE INDEX workspace_lease_state_idx ON workspace_leases(workspace_id, state);`,
    // workspace_fencing deliberately survives rollback: generations are never
    // reused, so a downgrade followed by a re-upgrade must not hand a new writer
    // a generation that an older stale owner already holds a token for.
    down: `
      DROP INDEX workspace_lease_state_idx;
      DROP INDEX one_active_writer_per_workspace;
      CREATE UNIQUE INDEX one_active_writer_per_workspace ON workspace_leases(workspace_id)
        WHERE mode = 'writer' AND released_at IS NULL;
      ALTER TABLE workspace_leases DROP COLUMN process_start_token;
      ALTER TABLE workspace_leases DROP COLUMN process_id;
      ALTER TABLE workspace_leases DROP COLUMN owner_host;
      ALTER TABLE workspace_leases DROP COLUMN server_instance_id;
      ALTER TABLE workspace_leases DROP COLUMN row_version;
      ALTER TABLE workspace_leases DROP COLUMN quarantine_reason;
      ALTER TABLE workspace_leases DROP COLUMN heartbeat_at;
      ALTER TABLE workspace_leases DROP COLUMN state;
      ALTER TABLE workspace_leases DROP COLUMN fencing_token_digest;
      ALTER TABLE workspace_leases DROP COLUMN generation;`,
  },
];

const LEASE_COLUMNS = `id leaseId, workspace_id workspaceId, owner_session_id ownerSessionId,
  owner_batch_id ownerBatchId, generation, state, acquired_at acquiredAt, heartbeat_at heartbeatAt,
  expires_at expiresAt, released_at releasedAt, quarantine_reason quarantineReason,
  row_version rowVersion, server_instance_id serverInstanceId, owner_host ownerHost,
  process_id processId, process_start_token processStartToken`;

const sqlTimestamp = (date: Date): string => date.toISOString();
const cutoff = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

export class OrchestratorStorage {
  readonly database: DatabaseSync;
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
    if (this.schemaVersion() > targetVersion) throw new Error("Use rollback() to move to an older schema");
    for (const migration of migrations.filter(({ version }) => version <= targetVersion)) {
      this.transaction(() => {
        // Re-read under the write lock: another process may have migrated while
        // this connection waited to begin its transaction.
        if (this.schemaVersion() >= migration.version) return;
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

  /**
   * Allocates the next writer generation and creates its lease in one serializable
   * transaction. Any lease that is not `released` denies admission, so expiry alone
   * never hands the workspace to a second writer.
   */
  acquireWriterLease(input: {
    workspaceId: string;
    ownerSessionId?: string | null;
    ownerBatchId: string;
    ttlMs: number;
    serverInstanceId?: string;
    ownerHost?: string;
    processId?: number | null;
    processStartToken?: string | null;
    now?: Date;
  }): LeaseAuthority {
    if (!input.workspaceId.trim()) throw new Error("workspaceId must not be empty");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error("ttlMs must be positive");
    const now = input.now ?? new Date();
    const actor = input.ownerSessionId ?? input.ownerBatchId;
    const token = randomBytes(32).toString("base64url");
    const owner = {
      serverInstanceId: input.serverInstanceId ?? "",
      ownerHost: input.ownerHost ?? "",
      processId: input.processId ?? null,
      processStartToken: input.processStartToken ?? null,
    };
    // A denial must be audited even though its transaction is rolled back, so the
    // conflict is reported out of the transaction rather than thrown from inside it.
    const outcome = this.transaction<LeaseAuthority | { deniedState: LeaseState }>(() => {
      const existing = this.database.prepare(`SELECT id, state FROM workspace_leases
        WHERE workspace_id = ? AND mode = 'writer' AND state != 'released'`).get(input.workspaceId) as
        { id: string; state: LeaseState } | undefined;
      if (existing) return { deniedState: existing.state };
      const generation = Number((this.database.prepare(`INSERT INTO workspace_fencing(workspace_id, last_generation)
        VALUES (?, 1) ON CONFLICT(workspace_id) DO UPDATE SET last_generation = last_generation + 1
        RETURNING last_generation`).get(input.workspaceId) as { last_generation: number }).last_generation);
      const leaseId = randomUUID();
      const timestamp = sqlTimestamp(now);
      const expiresAt = sqlTimestamp(new Date(now.getTime() + input.ttlMs));
      this.database.prepare(`INSERT INTO workspace_leases
        (id, workspace_id, mode, owner_session_id, owner_batch_id, acquired_at, expires_at, released_at,
          generation, fencing_token_digest, state, heartbeat_at, quarantine_reason, row_version,
          server_instance_id, owner_host, process_id, process_start_token)
        VALUES (?, ?, 'writer', ?, ?, ?, ?, NULL, ?, ?, 'active', ?, NULL, 1, ?, ?, ?, ?)`)
        .run(leaseId, input.workspaceId, input.ownerSessionId ?? null, input.ownerBatchId,
          timestamp, expiresAt, generation, this.tokenDigest(token), timestamp,
          owner.serverInstanceId, owner.ownerHost, owner.processId, owner.processStartToken);
      this.appendEvent({ aggregateType: "workspace_lease", aggregateId: leaseId,
        eventType: "lease_acquired", actor,
        data: { workspaceId: input.workspaceId, generation, serverInstanceId: owner.serverInstanceId },
        occurredAt: now });
      return { leaseId, workspaceId: input.workspaceId, ownerSessionId: input.ownerSessionId ?? null,
        ownerBatchId: input.ownerBatchId, generation, fencingToken: token, rowVersion: 1, expiresAt, ...owner };
    });
    if ("deniedState" in outcome) {
      this.recordPolicyDenial(input.workspaceId, "WORKSPACE_WRITER_BUSY", actor,
        { state: outcome.deniedState }, now);
      throw new WorkspaceWriterBusyError("Workspace already has an authoritative writer generation");
    }
    return outcome;
  }

  /** Durable, attributable record of a refusal. It carries no token or path. */
  recordPolicyDenial(workspaceId: string, code: string, actor: string,
    data: Record<string, unknown> = {}, now = new Date()): void {
    this.appendEvent({ aggregateType: "workspace", aggregateId: workspaceId, eventType: "policy_denied",
      actor, data: { ...data, code }, occurredAt: now });
  }

  /**
   * Binds the spawned owner process to the lease. Called once, after the child
   * exists, so recovery can later prove the exact process rather than a bare PID.
   */
  bindWriterProcess(authority: LeaseAuthority, processId: number, processStartToken: string,
    now = new Date()): LeaseAuthority {
    return this.transaction(() => {
      const result = this.database.prepare(`UPDATE workspace_leases SET process_id = ?,
        process_start_token = ?, row_version = row_version + 1
        WHERE ${this.ownershipPredicate()} AND state = 'active' RETURNING row_version`)
        .get(processId, processStartToken, ...this.ownershipValues(authority)) as
        { row_version: number } | undefined;
      if (!result) throw new LeaseFencedError("Process binding rejected because authority is stale");
      this.appendEvent({ aggregateType: "workspace_lease", aggregateId: authority.leaseId,
        eventType: "lease_process_bound", actor: authority.ownerSessionId ?? authority.ownerBatchId,
        data: { generation: authority.generation }, occurredAt: now });
      return { ...authority, processId, processStartToken, rowVersion: result.row_version };
    });
  }

  /**
   * Compare-and-set renewal on lease ID, generation, token digest, owner identity,
   * state, and row version. A stale or expired authority is fenced, never renewed.
   */
  heartbeatWriterLease(authority: LeaseAuthority, ttlMs: number, now = new Date()): LeaseAuthority {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be positive");
    const heartbeatAt = sqlTimestamp(now);
    const expiresAt = sqlTimestamp(new Date(now.getTime() + ttlMs));
    return this.transaction(() => {
      const result = this.database.prepare(`UPDATE workspace_leases SET heartbeat_at = ?, expires_at = ?,
        row_version = row_version + 1 WHERE ${this.ownershipPredicate()}
        AND state = 'active' AND expires_at > ? RETURNING row_version`)
        .get(heartbeatAt, expiresAt, ...this.ownershipValues(authority), heartbeatAt) as
        { row_version: number } | undefined;
      if (!result) throw new LeaseFencedError("Lease heartbeat rejected because authority is stale or expired");
      this.appendEvent({ aggregateType: "workspace_lease", aggregateId: authority.leaseId,
        eventType: "lease_heartbeat", actor: authority.ownerSessionId ?? authority.ownerBatchId,
        data: { generation: authority.generation }, occurredAt: now });
      return { ...authority, rowVersion: result.row_version, expiresAt };
    });
  }

  /** Throws unless the caller still owns the live current generation. */
  assertWriterLease(authority: LeaseAuthority, now = new Date()): void {
    const row = this.database.prepare(`SELECT 1 FROM workspace_leases
      WHERE ${this.ownershipPredicate()} AND state = 'active' AND expires_at > ?`)
      .get(...this.ownershipValues(authority), sqlTimestamp(now));
    if (!row) throw new LeaseFencedError("Writer does not hold the current live lease generation");
  }

  /**
   * Two-phase release: `active` to `releasing` under compare-and-set, then
   * `releasing` to `released` with the audit event in the same transaction.
   */
  releaseWriterLease(authority: LeaseAuthority, now = new Date()): void {
    this.transaction(() => {
      const digest = this.tokenDigest(authority.fencingToken);
      const releasing = this.database.prepare(`UPDATE workspace_leases SET state = 'releasing',
        row_version = row_version + 1 WHERE ${this.ownershipPredicate()} AND state = 'active'
        RETURNING row_version`).get(...this.ownershipValues(authority)) as
        { row_version: number } | undefined;
      if (!releasing) throw new LeaseFencedError("Lease release rejected because authority is stale");
      const released = this.database.prepare(`UPDATE workspace_leases SET state = 'released', released_at = ?,
        row_version = row_version + 1 WHERE id = ? AND generation = ? AND fencing_token_digest = ?
        AND state = 'releasing' AND row_version = ?`).run(sqlTimestamp(now), authority.leaseId,
          authority.generation, digest, releasing.row_version);
      if (Number(released.changes) !== 1) {
        throw new LeaseStateCorruptError("Lease release could not complete its second phase");
      }
      this.appendEvent({ aggregateType: "workspace_lease", aggregateId: authority.leaseId,
        eventType: "lease_released", actor: authority.ownerSessionId ?? authority.ownerBatchId,
        data: { generation: authority.generation }, occurredAt: now });
    });
  }

  /**
   * Recovery path for a crashed owner. Requires an expired `active` lease plus the
   * caller's proof that the exact owner process is absent; the generation is
   * retired, never reassigned, so a later acquisition always fences the old owner.
   */
  recoverExpiredWriterLease(leaseId: string, evidence: { ownerProcessAbsent: true; detail?: string },
    actor: string, now = new Date()): void {
    this.transaction(() => {
      const timestamp = sqlTimestamp(now);
      const lease = this.database.prepare(`SELECT workspace_id, generation, state, expires_at
        FROM workspace_leases WHERE id = ?`).get(leaseId) as
        { workspace_id: string; generation: number; state: LeaseState; expires_at: string } | undefined;
      if (!lease || lease.state !== "active" || lease.expires_at > timestamp) {
        throw new LeaseRecoveryAmbiguousError("Recovery requires an expired active lease");
      }
      if (evidence.ownerProcessAbsent !== true) {
        throw new LeaseRecoveryAmbiguousError("Recovery requires verified owner-process absence");
      }
      this.database.prepare(`UPDATE workspace_leases SET state = 'released', released_at = ?,
        row_version = row_version + 1 WHERE id = ? AND state = 'active'`).run(timestamp, leaseId);
      this.appendEvent({ aggregateType: "workspace_lease", aggregateId: leaseId,
        eventType: "lease_recovered", actor, data: { workspaceId: lease.workspace_id,
          generation: lease.generation, evidence: "owner_process_absent", detail: evidence.detail },
        occurredAt: now });
    });
  }

  /** Freezes a lease whose evidence is inconclusive. Quarantine denies new writers. */
  quarantineWriterLease(leaseId: string, reason: string, actor: string, now = new Date()): void {
    this.transaction(() => {
      const row = this.database.prepare(`UPDATE workspace_leases SET state = 'quarantined',
        quarantine_reason = ?, row_version = row_version + 1
        WHERE id = ? AND state IN ('active', 'releasing') RETURNING workspace_id, generation`)
        .get(reason, leaseId) as { workspace_id: string; generation: number } | undefined;
      if (!row) throw new LeaseStateCorruptError("Only an active or releasing lease can be quarantined");
      this.appendEvent({ aggregateType: "workspace_lease", aggregateId: leaseId,
        eventType: "lease_quarantined", actor,
        data: { workspaceId: row.workspace_id, generation: row.generation, reason }, occurredAt: now });
    });
  }

  /**
   * Fixed operator repair. It retires a quarantined generation so normal
   * acquisition of a higher generation can proceed. It never assigns an active
   * lease, reuses a generation, or launches a process.
   */
  repairQuarantinedWriterLease(leaseId: string, evidence: { ownerProcessAbsent: true; detail?: string },
    actor: string, now = new Date()): void {
    this.transaction(() => {
      if (evidence.ownerProcessAbsent !== true) {
        throw new LeaseRecoveryAmbiguousError("Repair requires verified owner-process absence");
      }
      const row = this.database.prepare(`UPDATE workspace_leases SET state = 'released', released_at = ?,
        row_version = row_version + 1 WHERE id = ? AND state = 'quarantined'
        RETURNING workspace_id, generation, quarantine_reason`).get(sqlTimestamp(now), leaseId) as
        { workspace_id: string; generation: number; quarantine_reason: string | null } | undefined;
      if (!row) throw new LeaseStateCorruptError("Only a quarantined lease can be repaired");
      this.appendEvent({ aggregateType: "workspace_lease", aggregateId: leaseId,
        eventType: "lease_repaired", actor, data: { workspaceId: row.workspace_id,
          generation: row.generation, quarantineReason: row.quarantine_reason, detail: evidence.detail },
        occurredAt: now });
    });
  }

  /** Latest generation recorded for the workspace, released or not. */
  workspaceLeaseStatus(workspaceId: string): WorkspaceLeaseStatus | null {
    const row = this.database.prepare(`SELECT ${LEASE_COLUMNS} FROM workspace_leases
      WHERE workspace_id = ? ORDER BY generation DESC LIMIT 1`).get(workspaceId);
    return (row as WorkspaceLeaseStatus | undefined) ?? null;
  }

  workspaceLeaseById(leaseId: string): WorkspaceLeaseStatus | null {
    const row = this.database.prepare(`SELECT ${LEASE_COLUMNS} FROM workspace_leases WHERE id = ?`).get(leaseId);
    return (row as WorkspaceLeaseStatus | undefined) ?? null;
  }

  /** The lease that currently blocks admission, if any. */
  blockingWriterLease(workspaceId: string): WorkspaceLeaseStatus | null {
    const row = this.database.prepare(`SELECT ${LEASE_COLUMNS} FROM workspace_leases
      WHERE workspace_id = ? AND mode = 'writer' AND state != 'released'
      ORDER BY generation DESC LIMIT 1`).get(workspaceId);
    return (row as WorkspaceLeaseStatus | undefined) ?? null;
  }

  /** Highest generation ever allocated, including retired ones. */
  lastAllocatedGeneration(workspaceId: string): number {
    const row = this.database.prepare("SELECT last_generation FROM workspace_fencing WHERE workspace_id = ?")
      .get(workspaceId) as { last_generation: number } | undefined;
    return row ? Number(row.last_generation) : 0;
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
        "DELETE FROM workspace_leases WHERE state = 'released' AND released_at < ?",
      ).run(expiredPayload).changes);
      if (assignmentsRedacted + resultsRedacted + idempotencyDeleted + leasesDeleted > 0) {
        this.appendEvent({ aggregateType: "registry", aggregateId: "maintenance", eventType: "retention.cleanup_completed",
          actor: "system", data: { assignmentsRedacted, resultsRedacted, idempotencyDeleted, leasesDeleted }, occurredAt: now });
      }
      return { assignmentsRedacted, resultsRedacted, idempotencyDeleted, leasesDeleted };
    });
  }

  exportJson(path: string): void {
    const tables = ["schema_migrations", "batches", "assignments", "sessions", "results", "events", "workspace_leases", "workspace_fencing", "idempotency_records"];
    const output = { format: "superset-agent-orchestrator-export", formatVersion: 1,
      schemaVersion: this.schemaVersion(), exportedAt: new Date().toISOString(),
      tables: Object.fromEntries(tables.map((table) => [table, this.database.prepare(`SELECT * FROM ${table}`).all()])) };
    this.writeAtomically(path, `${JSON.stringify(output, null, 2)}\n`);
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

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private tokenDigest(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /** Every fact a caller must present to act as the current writer generation. */
  private ownershipPredicate(): string {
    return `id = ? AND workspace_id = ? AND generation = ? AND fencing_token_digest = ?
      AND owner_batch_id = ? AND owner_session_id IS ? AND server_instance_id = ?
      AND owner_host = ? AND process_id IS ? AND process_start_token IS ? AND row_version = ?`;
  }

  private ownershipValues(authority: LeaseAuthority): SQLInputValue[] {
    return [authority.leaseId, authority.workspaceId, authority.generation,
      this.tokenDigest(authority.fencingToken), authority.ownerBatchId, authority.ownerSessionId,
      authority.serverInstanceId, authority.ownerHost, authority.processId,
      authority.processStartToken, authority.rowVersion];
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

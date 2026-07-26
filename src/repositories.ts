import type { DatabaseSync } from "node:sqlite";

export interface BatchRecord { id: string; name: string; requester: string; status: string; policy: unknown; createdAt: string; updatedAt: string; terminalAt: string | null }
export interface AssignmentRecord { id: string; batchId: string; label: string; prompt: string | null; workspaceId: string; expectedOutput: string | null; createdAt: string; payloadPurgedAt: string | null }
export interface SessionRecord { id: string; assignmentId: string; backend: string; backendSessionId: string | null; attempt: number; state: string; createdAt: string; updatedAt: string; terminalAt: string | null }
export interface ResultRecord { id: string; sessionId: string; body: string | null; artifacts: unknown; stopReason: string | null; capturedAt: string; payloadPurgedAt: string | null }
export interface EventRecord { sequence: number; id: string; aggregateType: string; aggregateId: string; eventType: string; actor: string; data: unknown; occurredAt: string }
export interface WorkspaceLeaseRecord { id: string; workspaceId: string; mode: "read-only" | "writer"; ownerSessionId: string | null; ownerBatchId: string; acquiredAt: string; expiresAt: string; releasedAt: string | null }
export interface IdempotencyRecord { scope: string; key: string; requestHash: string; response: unknown; resourceType: string; resourceId: string; createdAt: string; expiresAt: string }

export interface Repository<T> { get(id: string): T | undefined; insert(record: T): void }
export interface Repositories {
  batches: Repository<BatchRecord>;
  assignments: Repository<AssignmentRecord> & { listByBatch(batchId: string): AssignmentRecord[] };
  sessions: Repository<SessionRecord> & { listByAssignment(assignmentId: string): SessionRecord[] };
  results: Repository<ResultRecord> & { getBySession(sessionId: string): ResultRecord | undefined };
  events: { get(id: string): EventRecord | undefined; append(record: Omit<EventRecord, "sequence">): EventRecord; list(aggregateType: string, aggregateId: string): EventRecord[] };
  workspaceLeases: Repository<WorkspaceLeaseRecord> & { activeWriter(workspaceId: string): WorkspaceLeaseRecord | undefined };
  idempotency: { get(scope: string, key: string): IdempotencyRecord | undefined; insert(record: IdempotencyRecord): void };
}

const json = (value: string, field: string): unknown => {
  try { return JSON.parse(value); } catch (error) { throw new Error(`Corrupt ${field}: ${(error as Error).message}`, { cause: error }); }
};

export function createRepositories(database: DatabaseSync): Repositories {
  const batch = (row: unknown): BatchRecord => { const r = row as Record<string, string | null>; return { id: r.id!, name: r.name!, requester: r.requester!, status: r.status!, policy: json(r.policy_json!, "batch policy_json"), createdAt: r.created_at!, updatedAt: r.updated_at!, terminalAt: r.terminal_at ?? null }; };
  const assignment = (row: unknown): AssignmentRecord => { const r = row as Record<string, string | null>; return { id: r.id!, batchId: r.batch_id!, label: r.label!, prompt: r.prompt ?? null, workspaceId: r.workspace_id!, expectedOutput: r.expected_output ?? null, createdAt: r.created_at!, payloadPurgedAt: r.payload_purged_at ?? null }; };
  const session = (row: unknown): SessionRecord => { const r = row as Record<string, string | number | null>; return { id: r.id as string, assignmentId: r.assignment_id as string, backend: r.backend as string, backendSessionId: r.backend_session_id as string | null, attempt: Number(r.attempt), state: r.state as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string, terminalAt: r.terminal_at as string | null }; };
  const result = (row: unknown): ResultRecord => { const r = row as Record<string, string | null>; return { id: r.id!, sessionId: r.session_id!, body: r.body ?? null, artifacts: json(r.artifacts_json!, "result artifacts_json"), stopReason: r.stop_reason ?? null, capturedAt: r.captured_at!, payloadPurgedAt: r.payload_purged_at ?? null }; };
  const event = (row: unknown): EventRecord => { const r = row as Record<string, string | number>; return { sequence: Number(r.sequence), id: r.id as string, aggregateType: r.aggregate_type as string, aggregateId: r.aggregate_id as string, eventType: r.event_type as string, actor: r.actor as string, data: json(r.data_json as string, "event data_json"), occurredAt: r.occurred_at as string }; };
  const lease = (row: unknown): WorkspaceLeaseRecord => { const r = row as Record<string, string | null>; return { id: r.id!, workspaceId: r.workspace_id!, mode: r.mode as WorkspaceLeaseRecord["mode"], ownerSessionId: r.owner_session_id ?? null, ownerBatchId: r.owner_batch_id!, acquiredAt: r.acquired_at!, expiresAt: r.expires_at!, releasedAt: r.released_at ?? null }; };
  const idempotency = (row: unknown): IdempotencyRecord => { const r = row as Record<string, string>; return { scope: r.scope!, key: r.key!, requestHash: r.request_hash!, response: json(r.response_json!, "idempotency response_json"), resourceType: r.resource_type!, resourceId: r.resource_id!, createdAt: r.created_at!, expiresAt: r.expires_at! }; };
  const get = <T>(table: string, mapper: (row: unknown) => T) => (id: string): T | undefined => { const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id); return row ? mapper(row) : undefined; };

  return {
    batches: { get: get("batches", batch), insert: (r) => { database.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(r.id, r.name, r.requester, r.status, JSON.stringify(r.policy), r.createdAt, r.updatedAt, r.terminalAt); } },
    assignments: { get: get("assignments", assignment), insert: (r) => { database.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(r.id, r.batchId, r.label, r.prompt, r.workspaceId, r.expectedOutput, r.createdAt, r.payloadPurgedAt); }, listByBatch: (id) => database.prepare("SELECT * FROM assignments WHERE batch_id = ? ORDER BY created_at, id").all(id).map(assignment) },
    sessions: { get: get("sessions", session), insert: (r) => { database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(r.id, r.assignmentId, r.backend, r.backendSessionId, r.attempt, r.state, r.createdAt, r.updatedAt, r.terminalAt); }, listByAssignment: (id) => database.prepare("SELECT * FROM sessions WHERE assignment_id = ? ORDER BY attempt").all(id).map(session) },
    results: { get: get("results", result), insert: (r) => { database.prepare("INSERT INTO results VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.id, r.sessionId, r.body, JSON.stringify(r.artifacts), r.stopReason, r.capturedAt, r.payloadPurgedAt); }, getBySession: (id) => { const row = database.prepare("SELECT * FROM results WHERE session_id = ?").get(id); return row ? result(row) : undefined; } },
    events: { get: get("events", event), append: (r) => { database.prepare("INSERT INTO events(id, aggregate_type, aggregate_id, event_type, actor, data_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.id, r.aggregateType, r.aggregateId, r.eventType, r.actor, JSON.stringify(r.data), r.occurredAt); return event(database.prepare("SELECT * FROM events WHERE id = ?").get(r.id)); }, list: (type, id) => database.prepare("SELECT * FROM events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY sequence").all(type, id).map(event) },
    workspaceLeases: { get: get("workspace_leases", lease), insert: (r) => {
      if (r.mode === "writer") throw new Error("Writer leases require fenced acquisition");
      database.prepare(`INSERT INTO workspace_leases
        (id, workspace_id, mode, owner_session_id, owner_batch_id, acquired_at, expires_at, released_at,
          state, heartbeat_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.id, r.workspaceId, r.mode, r.ownerSessionId, r.ownerBatchId, r.acquiredAt, r.expiresAt,
          r.releasedAt, r.releasedAt === null ? "active" : "released", r.acquiredAt);
    }, activeWriter: (id) => { const row = database.prepare("SELECT * FROM workspace_leases WHERE workspace_id = ? AND mode = 'writer' AND state != 'released'").get(id); return row ? lease(row) : undefined; } },
    idempotency: { get: (scope, key) => { const row = database.prepare("SELECT * FROM idempotency_records WHERE scope = ? AND key = ?").get(scope, key); return row ? idempotency(row) : undefined; }, insert: (r) => { database.prepare("INSERT INTO idempotency_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(r.scope, r.key, r.requestHash, JSON.stringify(r.response), r.resourceType, r.resourceId, r.createdAt, r.expiresAt); } },
  };
}

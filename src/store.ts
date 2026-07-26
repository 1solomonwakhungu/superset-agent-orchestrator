import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { auditField, RedactionPolicy, SecurityError, SECURITY_POLICY_VERSION } from "./security.js";

export type WorkerStatus = "requested" | "running" | "succeeded" | "failed" | "unknown_outcome";
export type DiagnosticKind = "orphan" | "unknown_outcome" | "missing_result";
export type LaunchStatus = "reserved" | "dispatching" | "unknown_outcome" | "bound";
export type ResultCompleteness = "complete" | "empty" | "partial" | "missing" | "malformed";

export interface Session {
  id: string;
  clientId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface Batch {
  id: string;
  name: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  idempotencyKey?: string;
  clientId?: string;
  requestFingerprint?: string;
}

export interface WorkerAttribution {
  agent: string;
  task: string;
}

export interface Worker {
  id: string;
  batchId: string;
  sessionId: string;
  pid?: number;
  processStartedAt?: string;
  status: WorkerStatus;
  attribution: WorkerAttribution;
  startedAt: string;
  completedAt?: string;
  result?: unknown;
  position?: number;
}

export interface BatchAssignment {
  agent: string;
  task: string;
}

export interface QueryMeasurement {
  operation: "batch_get" | "batch_status" | "batch_results";
  examined: number;
  returned: number;
  durationMs: number;
}

export interface BatchPage {
  batch: Batch;
  sessions: Worker[];
  unknownIds: string[];
  nextCursor?: string;
}

export class BatchQueryError extends Error {
  constructor(readonly code: "duplicate_ids" | "invalid_cursor" | "invalid_request" | "idempotency_conflict" | "not_found", message: string) {
    super(message);
  }
}

export interface Diagnostic {
  id: string;
  kind: DiagnosticKind;
  workerId: string;
  message: string;
  detectedAt: string;
}

export type AssignmentLaunchStatus = "accepted" | "launching" | "launched" | "failed";

export interface Assignment {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  batchId: string;
  sessionId: string;
  status: AssignmentLaunchStatus;
  attribution: WorkerAttribution;
  prompt: string;
  workspaceId?: string;
  workspacePath: string;
  attemptId?: string;
  attempt?: number;
  acceptedAt: string;
  updatedAt: string;
  runId?: string;
  error?: string;
}

export interface AgentResultClaim {
  status: "succeeded" | "failed" | "cancelled" | "stopped_without_result" | "malformed";
  completeness: ResultCompleteness;
  output?: string;
  error?: string;
  retryable?: boolean;
  stopReason?: string;
  resume?: { adapter: string; token: string };
}

export interface CapturedResult {
  deliveryId: string;
  deliveryFingerprint: string;
  assignmentId: string;
  batchId: string;
  sessionId: string;
  workspaceId?: string;
  workspacePath: string;
  attemptId: string;
  attempt: number;
  runId: string;
  attribution: WorkerAttribution;
  claim: AgentResultClaim;
  verifiedArtifacts: readonly [];
  capturedAt: string;
}

export type LaunchAuditType = "launch_accepted" | "launch_reserved" | "execution_started" | "launch_failed";

export interface LaunchAuditEvent {
  id: string;
  assignmentId: string;
  type: LaunchAuditType;
  occurredAt: string;
  runId?: string;
  error?: string;
}

export interface SecurityAuditEvent {
  id: string;
  sequence: number;
  occurredAt: string;
  requesterId: string;
  operation: string;
  decision: "allowed" | "denied" | "failed";
  reasonCode: string;
  correlationId: string;
  policyVersion: string;
  workspaceId?: string;
  projectId?: string;
  assignmentId?: string;
  previousEventHash: string;
  eventHash: string;
}

export interface SecurityAuditChainVerification {
  valid: boolean;
  length: number;
  brokenAtSequence?: number;
}

export type SecurityAuditInput = Omit<
  SecurityAuditEvent,
  "id" | "sequence" | "occurredAt" | "policyVersion" | "previousEventHash" | "eventHash"
>;

const GENESIS_AUDIT_HASH = "0".repeat(64);
const SECURITY_AUDIT_HASH_FIELDS = [
  "id", "sequence", "occurredAt", "requesterId", "operation", "decision", "reasonCode",
  "correlationId", "policyVersion", "workspaceId", "projectId", "assignmentId", "previousEventHash",
] as const;

function securityAuditEventHash(event: Omit<SecurityAuditEvent, "eventHash">): string {
  const canonical = JSON.stringify(SECURITY_AUDIT_HASH_FIELDS.map((field) => event[field] ?? null));
  return createHash("sha256").update(canonical).digest("hex");
}

export interface LaunchIntent {
  idempotencyKey: string;
  requestHash: string;
  sessionId: string;
  batchId: string;
  workerId: string;
  workspaceId?: string;
  attribution: WorkerAttribution;
  status: LaunchStatus;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  diagnostic?: string;
}

export interface DurableState {
  version: 1;
  sessions: Session[];
  batches: Batch[];
  workers: Worker[];
  diagnostics: Diagnostic[];
  assignments: Assignment[];
  auditEvents: LaunchAuditEvent[];
  launchIntents: LaunchIntent[];
  capturedResults?: CapturedResult[];
  securityAuditEvents?: SecurityAuditEvent[];
  securityAuditHead?: { sequence: number; eventHash: string };
  reconciledAt?: string;
}

export interface ReconciliationSummary {
  sessionsRecovered: number;
  batchesRecovered: number;
  workersRecovered: number;
  runningWorkers: number;
  diagnosticsAdded: number;
  reconciledAt: string;
}

const attributionSchema = z.object({ agent: z.string().min(1), task: z.string().min(1) });
const sessionSchema = z.object({
  id: z.string().min(1), clientId: z.string().min(1), createdAt: z.iso.datetime(), lastSeenAt: z.iso.datetime(),
});
const batchSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), sessionId: z.string().min(1),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), idempotencyKey: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(), requestFingerprint: z.string().min(1).optional(),
});
const workerSchema = z.object({
  id: z.string().min(1), batchId: z.string().min(1), sessionId: z.string().min(1),
  pid: z.number().int().positive().optional(),
  processStartedAt: z.string().min(1).optional(),
  status: z.enum(["requested", "running", "succeeded", "failed", "unknown_outcome"]),
  attribution: attributionSchema, startedAt: z.iso.datetime(), completedAt: z.iso.datetime().optional(),
  result: z.unknown().optional(), position: z.number().int().nonnegative().optional(),
}).superRefine((worker, context) => {
  if (worker.status === "running" && (worker.pid === undefined || worker.processStartedAt === undefined)) {
    context.addIssue({ code: "custom", message: "Running workers require a PID and process start token" });
  }
});
const diagnosticSchema = z.object({
  id: z.string().min(1), kind: z.enum(["orphan", "unknown_outcome", "missing_result"]),
  workerId: z.string().min(1), message: z.string().min(1), detectedAt: z.iso.datetime(),
});
const assignmentSchema = z.object({
  id: z.string().min(1), idempotencyKey: z.string().min(1), requestFingerprint: z.string().min(1),
  batchId: z.string().min(1), sessionId: z.string().min(1),
  status: z.enum(["accepted", "launching", "launched", "failed"]), attribution: attributionSchema,
  prompt: z.string().min(1), workspaceId: z.string().min(1).optional(), workspacePath: z.string().min(1),
  attemptId: z.string().min(1).optional(), attempt: z.number().int().positive().optional(), acceptedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(), runId: z.string().min(1).optional(), error: z.string().min(1).optional(),
});
const resultClaimSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled", "stopped_without_result", "malformed"]),
  completeness: z.enum(["complete", "empty", "partial", "missing", "malformed"]),
  output: z.string().optional(), error: z.string().min(1).optional(), retryable: z.boolean().optional(),
  stopReason: z.string().min(1).optional(),
  resume: z.object({ adapter: z.string().min(1), token: z.string().min(1) }).optional(),
});
const capturedResultSchema = z.object({
  deliveryId: z.string().min(1), deliveryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  assignmentId: z.string().min(1), batchId: z.string().min(1), sessionId: z.string().min(1),
  workspaceId: z.string().min(1), workspacePath: z.string().min(1), attemptId: z.string().min(1),
  attempt: z.number().int().positive(), runId: z.string().min(1), attribution: attributionSchema,
  claim: resultClaimSchema, verifiedArtifacts: z.tuple([]), capturedAt: z.iso.datetime(),
});
const auditEventSchema = z.object({
  id: z.string().min(1), assignmentId: z.string().min(1),
  type: z.enum(["launch_accepted", "launch_reserved", "execution_started", "launch_failed"]),
  occurredAt: z.iso.datetime(), runId: z.string().min(1).optional(), error: z.string().min(1).optional(),
});
const securityAuditEventSchema = z.object({
  id: z.string().min(1), sequence: z.number().int().positive(), occurredAt: z.iso.datetime(),
  requesterId: z.string().min(1),
  operation: z.string().min(1), decision: z.enum(["allowed", "denied", "failed"]),
  reasonCode: z.string().min(1), correlationId: z.string().min(1), policyVersion: z.string().min(1),
  workspaceId: z.string().min(1).optional(), projectId: z.string().min(1).optional(),
  assignmentId: z.string().min(1).optional(),
  previousEventHash: z.string().regex(/^[a-f0-9]{64}$/), eventHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const launchIntentSchema = z.object({
  idempotencyKey: z.string().min(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().min(1), batchId: z.string().min(1), workerId: z.string().min(1), workspaceId: z.string().min(1).optional(),
  attribution: attributionSchema,
  status: z.enum(["reserved", "dispatching", "unknown_outcome", "bound"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), runId: z.string().min(1).optional(),
  diagnostic: z.string().min(1).optional(),
}).superRefine((intent, context) => {
  if (intent.status === "bound" && intent.runId === undefined) {
    context.addIssue({ code: "custom", message: "Bound launch intents require a run ID" });
  }
});
const stateSchema = z.object({
  version: z.literal(1), sessions: z.array(sessionSchema), batches: z.array(batchSchema),
  workers: z.array(workerSchema), diagnostics: z.array(diagnosticSchema),
  assignments: z.array(assignmentSchema).default([]), auditEvents: z.array(auditEventSchema).default([]),
  launchIntents: z.array(launchIntentSchema).default([]), capturedResults: z.array(capturedResultSchema).default([]),
  securityAuditEvents: z.array(securityAuditEventSchema).default([]),
  securityAuditHead: z.object({
    sequence: z.number().int().nonnegative(), eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  reconciledAt: z.iso.datetime().optional(),
}).superRefine((state, context) => {
  for (const [kind, records] of [["session", state.sessions], ["batch", state.batches], ["worker", state.workers],
    ["assignment", state.assignments], ["audit event", state.auditEvents]] as const) {
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) context.addIssue({ code: "custom", message: `Duplicate ${kind} ID: ${record.id}` });
      ids.add(record.id);
    }
  }
  const keys = new Set<string>();
  for (const intent of state.launchIntents) {
    if (keys.has(intent.idempotencyKey)) context.addIssue({ code: "custom", message: `Duplicate idempotency key: ${intent.idempotencyKey}` });
    keys.add(intent.idempotencyKey);
  }
  const deliveries = new Set<string>();
  const attempts = new Set<string>();
  for (const result of state.capturedResults ?? []) {
    if (deliveries.has(result.deliveryId)) context.addIssue({ code: "custom", message: `Duplicate result delivery ID: ${result.deliveryId}` });
    if (attempts.has(result.attemptId)) context.addIssue({ code: "custom", message: `Duplicate result attempt ID: ${result.attemptId}` });
    deliveries.add(result.deliveryId);
    attempts.add(result.attemptId);
  }
  for (const assignment of state.assignments.filter(({ workspaceId }) => workspaceId !== undefined)) {
    if (!state.securityAuditEvents.some((event) => event.assignmentId === assignment.id
      && event.reasonCode === "launch_accepted" && event.decision === "allowed")) {
      context.addIssue({ code: "custom", message: `Security-controlled assignment ${assignment.id} requires an acceptance audit event` });
    }
  }
});

const EMPTY_STATE: DurableState = {
  version: 1,
  sessions: [],
  batches: [],
  workers: [],
  diagnostics: [],
  assignments: [],
  auditEvents: [],
  launchIntents: [],
  capturedResults: [],
  securityAuditEvents: [],
  securityAuditHead: { sequence: 0, eventHash: GENESIS_AUDIT_HASH },
};

export class DurableStore {
  private state: DurableState = structuredClone(EMPTY_STATE);
  private readonly batchesById = new Map<string, Batch>();
  private readonly workersById = new Map<string, Worker>();
  private readonly workerIdsByBatchId = new Map<string, string[]>();
  private readonly batchesByIdempotencyKey = new Map<string, string>();

  constructor(
    private readonly path: string,
    private readonly isProcessAlive: (pid: number, processStartedAt?: string) => boolean = DurableStore.isProcessAlive.bind(DurableStore),
    private readonly observeQuery: (measurement: QueryMeasurement) => void = () => undefined,
    private readonly now: () => number = performance.now.bind(performance),
    private readonly redaction = new RedactionPolicy(),
  ) {}

  redactText(value: string): string {
    return this.redaction.text(value);
  }

  redactValue(value: unknown): unknown {
    return this.redaction.value(value);
  }

  safeError(error: unknown): string {
    return this.redaction.error(error);
  }

  async createBatch(
    name: string,
    clientId: string,
    assignments: BatchAssignment[],
    idempotencyKey?: string,
    at = new Date(),
  ): Promise<{ batch: Batch; sessions: Worker[]; duplicate: boolean }> {
    if (assignments.length === 0 || assignments.length > 250) {
      throw new BatchQueryError("invalid_request", "A batch requires between 1 and 250 assignments");
    }
    return this.withLock(async () => {
      await this.load();
      const requestFingerprint = createHash("sha256").update(JSON.stringify({ name, assignments })).digest("hex");
      if (idempotencyKey !== undefined) {
        const existingId = this.batchesByIdempotencyKey.get(`${clientId}\0${idempotencyKey}`);
        if (existingId !== undefined) {
          const existing = this.batchesById.get(existingId);
          if (existing === undefined) throw new Error(`Missing indexed batch ${existingId}`);
          if (existing.requestFingerprint !== requestFingerprint) {
            throw new BatchQueryError("idempotency_conflict", "Idempotency key was already used with a different batch request");
          }
          return { batch: structuredClone(existing), sessions: this.workersForBatch(existing.id), duplicate: true };
        }
      }

      const timestamp = at.toISOString();
      const ownerSession: Session = {
        id: randomUUID(), clientId, createdAt: timestamp, lastSeenAt: timestamp,
      };
      const batch: Batch = {
        id: randomUUID(), name, sessionId: ownerSession.id, createdAt: timestamp, updatedAt: timestamp,
        clientId, requestFingerprint, ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
      const workers = assignments.map((attribution, position): Worker => ({
        id: randomUUID(), batchId: batch.id, sessionId: ownerSession.id, status: "requested",
        attribution, startedAt: timestamp, position,
      }));
      const previousState = structuredClone(this.state);
      try {
        this.state.sessions.push(ownerSession);
        this.state.batches.push(batch);
        this.state.workers.push(...workers);
        this.rebuildIndexes();
        await this.persist();
      } catch (error) {
        await this.load().catch(() => {
          this.state = previousState;
          this.rebuildIndexes();
        });
        throw error;
      }
      return { batch: structuredClone(batch), sessions: structuredClone(workers), duplicate: false };
    });
  }

  async getBatch(batchId: string, options: { ids?: string[]; limit?: number; cursor?: string } = {}): Promise<BatchPage> {
    return this.withFreshState(() => this.queryBatch("batch_get", batchId, options));
  }

  async batchStatus(batchId: string, options: { ids?: string[]; limit?: number; cursor?: string } = {}) {
    return this.withFreshState(() => {
    const page = this.queryBatch("batch_status", batchId, options);
    const counts: Record<WorkerStatus, number> = {
      requested: 0, running: 0, succeeded: 0, failed: 0, unknown_outcome: 0,
    };
    for (const worker of this.workersForBatch(batchId)) counts[worker.status] += 1;
    const settled = counts.succeeded + counts.failed + counts.unknown_outcome;
    return {
      ...page,
      sessions: page.sessions.map(({ id, batchId: attributedBatchId, status, attribution, startedAt, completedAt }) => ({
        sessionId: id, batchId: attributedBatchId, status, attribution, startedAt, completedAt,
      })),
      summary: {
        total: Object.values(counts).reduce((sum, count) => sum + count, 0),
        settled,
        complete: settled === Object.values(counts).reduce((sum, count) => sum + count, 0),
        partiallyComplete: settled > 0 && settled < Object.values(counts).reduce((sum, count) => sum + count, 0),
        counts,
      },
    };
    });
  }

  async batchResults(batchId: string, options: { ids?: string[]; limit?: number; cursor?: string } = {}) {
    return this.withFreshState(() => {
    const page = this.queryBatch("batch_results", batchId, options);
    const results = page.sessions
      .filter(({ result }) => result !== undefined)
      .map(({ id, batchId: attributedBatchId, status, attribution, startedAt, completedAt, result }) => ({
        sessionId: id, batchId: attributedBatchId, status, attribution, startedAt, completedAt, result,
      }));
    return {
      batch: page.batch,
      results,
      unavailable: page.sessions
        .filter(({ result }) => result === undefined)
        .map(({ id, status }) => ({ sessionId: id, status })),
      unknownIds: page.unknownIds,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
    });
  }

  async reconcile(now = new Date()): Promise<ReconciliationSummary> {
    return this.withLock(async () => {
      await this.load();
      const detectedAt = now.toISOString();
      const sessionIds = new Set(this.state.sessions.map(({ id }) => id));
      const batches = new Map(this.state.batches.map((batch) => [batch.id, batch]));
      let diagnosticsAdded = 0;

      const diagnose = (kind: DiagnosticKind, worker: Worker, message: string): void => {
        const id = `${kind}:${worker.id}`;
        if (this.state.diagnostics.some((diagnostic) => diagnostic.id === id)) return;
        this.state.diagnostics.push({ id, kind, workerId: worker.id, message, detectedAt });
        diagnosticsAdded += 1;
      };

      for (const worker of this.state.workers) {
        const batch = batches.get(worker.batchId);
        if (!sessionIds.has(worker.sessionId) || batch === undefined || batch.sessionId !== worker.sessionId) {
          diagnose("orphan", worker, "Worker references a missing or inconsistent durable session or batch");
        }

        if (worker.status === "running"
          && (worker.pid === undefined || !this.isProcessAlive(worker.pid, worker.processStartedAt))) {
          worker.status = "unknown_outcome";
          worker.completedAt = detectedAt;
          diagnose("unknown_outcome", worker, "Worker process was absent during startup reconciliation");
        }

        if ((worker.status === "succeeded" || worker.status === "failed") && worker.result === undefined) {
          diagnose("missing_result", worker, "Terminal worker has no persisted result");
        }
      }

      this.state.reconciledAt = detectedAt;
      this.rebuildIndexes();
      await this.persist();
      return {
        sessionsRecovered: this.state.sessions.length,
        batchesRecovered: this.state.batches.length,
        workersRecovered: this.state.workers.length,
        runningWorkers: this.state.workers.filter(({ status }) => status === "running").length,
        diagnosticsAdded,
        reconciledAt: detectedAt,
      };
    });
  }

  recentSessions(limit: number): Session[] {
    return [...this.state.sessions]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, limit);
  }

  reopenBatch(name: string): { batch: Batch; session: Session | undefined; workers: Worker[] } | undefined {
    const batch = [...this.state.batches]
      .filter((candidate) => candidate.name === name)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!batch) return undefined;
    return {
      batch,
      session: this.state.sessions.find(({ id }) => id === batch.sessionId),
      workers: this.state.workers.filter(({ batchId }) => batchId === batch.id),
    };
  }

  diagnostics(kind?: DiagnosticKind): Diagnostic[] {
    return this.state.diagnostics.filter((diagnostic) => kind === undefined || diagnostic.kind === kind);
  }

  async reserveLaunch(intent: Omit<LaunchIntent, "status" | "createdAt" | "updatedAt">, now = new Date()): Promise<{ intent: LaunchIntent; created: boolean }> {
    return this.withLock(async () => {
      await this.load();
      const launches = this.state.launchIntents ??= [];
      const existing = launches.find(({ idempotencyKey }) => idempotencyKey === intent.idempotencyKey);
      if (existing !== undefined) {
        if (existing.requestHash !== intent.requestHash) throw new Error("Idempotency key was already used for a different launch request");
        return { intent: structuredClone(existing), created: false };
      }
      const timestamp = now.toISOString();
      const reserved: LaunchIntent = { ...intent, status: "reserved", createdAt: timestamp, updatedAt: timestamp };
      launches.push(reserved);
      await this.persist();
      return { intent: structuredClone(reserved), created: true };
    });
  }

  async updateLaunch(
    idempotencyKey: string,
    status: LaunchStatus,
    options: { runId?: string; diagnostic?: string; securityAudit?: SecurityAuditInput } = {},
    now = new Date(),
  ): Promise<LaunchIntent> {
    return this.withLock(async () => {
      await this.load();
      const intent = this.state.launchIntents?.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (intent === undefined) throw new Error(`Unknown launch idempotency key: ${idempotencyKey}`);
      if (intent.status === "bound" && (status !== "bound" || options.runId !== undefined && options.runId !== intent.runId)) {
        throw new Error("A bound launch cannot be rebound or regressed");
      }
      const previousState = structuredClone(this.state);
      try {
        intent.status = status;
        intent.updatedAt = now.toISOString();
        if (options.runId !== undefined) intent.runId = options.runId;
        if (options.diagnostic !== undefined) intent.diagnostic = this.redaction.text(options.diagnostic);
        if (options.securityAudit !== undefined) this.appendSecurityAuditToState(options.securityAudit, now);
        await this.persist();
      } catch (error) {
        await this.load().catch(() => {
          this.state = previousState;
          this.rebuildIndexes();
        });
        throw error;
      }
      return structuredClone(intent);
    });
  }

  launchIntents(): LaunchIntent[] {
    return structuredClone(this.state.launchIntents ?? []);
  }

  snapshot(): DurableState {
    return structuredClone(this.state);
  }

  async acceptLaunch(input: {
    assignment: Assignment;
    session: Session;
    batch: Batch;
    event: LaunchAuditEvent;
    securityAudit: SecurityAuditInput;
  }): Promise<{ assignment: Assignment; created: boolean }> {
    return this.withLock(async () => {
      await this.load();
      assignmentSchema.parse(input.assignment);
      sessionSchema.parse(input.session);
      batchSchema.parse(input.batch);
      auditEventSchema.parse(input.event);
      const existing = this.state.assignments.find(({ idempotencyKey }) => idempotencyKey === input.assignment.idempotencyKey);
      if (existing !== undefined) {
        if (existing.requestFingerprint !== input.assignment.requestFingerprint) {
          throw new Error(`Idempotency key ${JSON.stringify(input.assignment.idempotencyKey)} was already used for a different launch`);
        }
        return { assignment: structuredClone(existing), created: false };
      }
      const previousState = structuredClone(this.state);
      try {
        this.state.sessions.push(input.session);
        this.state.batches.push(input.batch);
        this.state.assignments.push(input.assignment);
        this.state.auditEvents.push(input.event);
        this.appendSecurityAuditToState(input.securityAudit, new Date(input.event.occurredAt));
        await this.persist();
      } catch (error) {
        await this.load().catch(() => {
          this.state = previousState;
          this.rebuildIndexes();
        });
        throw error;
      }
      return { assignment: structuredClone(input.assignment), created: true };
    });
  }

  /**
   * Appends a normalized, redacted, tamper-evident security decision. Every field
   * that can carry untrusted text is bounded and stripped of control characters so
   * that no payload can forge or truncate a later record, and each event is chained
   * to its predecessor's hash. Persistence failure propagates so the caller fails
   * closed rather than proceeding without an audit record.
   */
  async appendSecurityAudit(input: SecurityAuditInput, now = new Date()): Promise<SecurityAuditEvent> {
    return this.withLock(async () => {
      await this.load();
      const event = this.appendSecurityAuditToState(input, now);
      await this.persist();
      return structuredClone(event);
    });
  }

  securityAuditEvents(): SecurityAuditEvent[] {
    return structuredClone(this.state.securityAuditEvents ?? []);
  }

  /** Detects any edit, deletion, or reordering of the persisted audit sequence. */
  verifySecurityAuditChain(): SecurityAuditChainVerification {
    const events = this.state.securityAuditEvents ?? [];
    let previousHash = GENESIS_AUDIT_HASH;
    for (const [index, event] of events.entries()) {
      const { eventHash, ...body } = event;
      if (event.sequence !== index + 1 || event.previousEventHash !== previousHash
        || securityAuditEventHash(body) !== eventHash) {
        return { valid: false, length: events.length, brokenAtSequence: index + 1 };
      }
      previousHash = eventHash;
    }
    const head = this.state.securityAuditHead;
    if (head !== undefined && (head.sequence !== events.length || head.eventHash !== previousHash)) {
      return { valid: false, length: events.length, brokenAtSequence: events.length + 1 };
    }
    return { valid: true, length: events.length };
  }

  private assertSecurityAuditChain(): void {
    const verification = this.verifySecurityAuditChain();
    if (!verification.valid) {
      throw new SecurityError("INTEGRITY_FAILURE", `Security audit integrity failure at sequence ${verification.brokenAtSequence}`);
    }
  }

  async pendingAssignments(): Promise<Assignment[]> {
    return this.withLock(async () => {
      await this.load();
      return structuredClone(this.state.assignments.filter(({ status }) => status === "accepted" || status === "launching"));
    });
  }

  async recordLaunchEvent(
    assignmentId: string,
    status: Extract<AssignmentLaunchStatus, "launching" | "launched" | "failed">,
    event: LaunchAuditEvent,
    securityAudit?: SecurityAuditInput,
  ): Promise<Assignment> {
    return this.withLock(async () => {
      await this.load();
      const assignment = this.state.assignments.find(({ id }) => id === assignmentId);
      if (assignment === undefined) throw new Error(`Unknown assignment: ${assignmentId}`);
      if (assignment.status === "launched" || assignment.status === "failed") return structuredClone(assignment);
      const previousState = structuredClone(this.state);
      try {
        assignment.status = status;
        assignment.updatedAt = event.occurredAt;
        if (event.runId !== undefined) assignment.runId = event.runId;
        if (event.error !== undefined) assignment.error = event.error;
        if (!this.state.auditEvents.some(({ id }) => id === event.id)) this.state.auditEvents.push(event);
        if (securityAudit !== undefined) this.appendSecurityAuditToState(securityAudit, new Date(event.occurredAt));
        await this.persist();
      } catch (error) {
        this.state = previousState;
        this.rebuildIndexes();
        throw error;
      }
      return structuredClone(assignment);
    });
  }

  private appendSecurityAuditToState(input: SecurityAuditInput, now: Date): SecurityAuditEvent {
    const audit = this.state.securityAuditEvents ??= [];
    this.assertSecurityAuditChain();
    const previous = audit.at(-1);
    const body = {
      id: randomUUID(),
      sequence: (previous?.sequence ?? 0) + 1,
      occurredAt: now.toISOString(),
        requesterId: auditField(input.requesterId, this.redaction.canaries),
        operation: auditField(input.operation, this.redaction.canaries),
      decision: input.decision,
        reasonCode: auditField(input.reasonCode, this.redaction.canaries),
        correlationId: auditField(input.correlationId, this.redaction.canaries),
      policyVersion: SECURITY_POLICY_VERSION,
        ...(input.workspaceId === undefined ? {} : { workspaceId: auditField(input.workspaceId, this.redaction.canaries) }),
        ...(input.projectId === undefined ? {} : { projectId: auditField(input.projectId, this.redaction.canaries) }),
        ...(input.assignmentId === undefined ? {} : { assignmentId: auditField(input.assignmentId, this.redaction.canaries) }),
      previousEventHash: previous?.eventHash ?? GENESIS_AUDIT_HASH,
    };
    const event: SecurityAuditEvent = { ...body, eventHash: securityAuditEventHash(body) };
    securityAuditEventSchema.parse(event);
    audit.push(event);
    this.state.securityAuditHead = { sequence: event.sequence, eventHash: event.eventHash };
    return event;
  }

  async assignmentForResult(assignmentId: string): Promise<Assignment> {
    return this.withFreshState(() => {
      const assignment = this.state.assignments.find(({ id }) => id === assignmentId);
      if (assignment === undefined) throw new Error(`Unknown assignment: ${assignmentId}`);
      return structuredClone(assignment);
    });
  }

  async captureResult(input: CapturedResult): Promise<{ result: CapturedResult; duplicate: boolean }> {
    return this.withLock(async () => {
      await this.load();
      capturedResultSchema.parse(input);
      const assignment = this.state.assignments.find(({ id }) => id === input.assignmentId);
      if (assignment === undefined) throw new Error(`Unknown assignment: ${input.assignmentId}`);
      if (assignment.workspaceId === undefined || assignment.attemptId === undefined || assignment.attempt === undefined) {
        throw new Error("Legacy assignments without exact workspace and attempt identities cannot accept results");
      }
      const identities = ["batchId", "sessionId", "workspaceId", "workspacePath", "attemptId", "attempt", "runId"] as const;
      for (const identity of identities) {
        if (assignment[identity] !== input[identity]) throw new Error(`Result ${identity} does not match its assignment`);
      }
      if (assignment.status !== "launched") throw new Error("Results require a launched assignment");
      const results = this.state.capturedResults ??= [];
      const existingDelivery = results.find(({ deliveryId }) => deliveryId === input.deliveryId);
      if (existingDelivery !== undefined) {
        if (existingDelivery.deliveryFingerprint !== input.deliveryFingerprint) {
          throw new Error(`Result delivery ${JSON.stringify(input.deliveryId)} conflicts with its first payload`);
        }
        return { result: structuredClone(existingDelivery), duplicate: true };
      }
      const existingAttempt = results.find(({ attemptId }) => attemptId === input.attemptId);
      if (existingAttempt !== undefined) {
        if (existingAttempt.deliveryFingerprint !== input.deliveryFingerprint) {
          throw new Error(`Attempt ${JSON.stringify(input.attemptId)} already has a different authoritative result`);
        }
        return { result: structuredClone(existingAttempt), duplicate: true };
      }
      results.push(input);
      await this.persist();
      return { result: structuredClone(input), duplicate: false };
    });
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.state = stateSchema.parse(parsed) as DurableState;
      this.assertSecurityAuditChain();
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot load orchestrator state at ${this.path}: ${(error as Error).message}`, { cause: error });
      }
      this.state = structuredClone(EMPTY_STATE);
    }
    this.rebuildIndexes();
  }

  private queryBatch(
    operation: QueryMeasurement["operation"],
    batchId: string,
    { ids, limit = 100, cursor }: { ids?: string[]; limit?: number; cursor?: string },
  ): BatchPage {
    const startedAt = this.now();
    const batch = this.batchesById.get(batchId);
    if (batch === undefined) throw new BatchQueryError("not_found", `Unknown batch ID: ${batchId}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      throw new BatchQueryError("invalid_cursor", "Limit must be between 1 and 250");
    }
    if (ids !== undefined && cursor !== undefined) {
      throw new BatchQueryError("invalid_cursor", "IDs and cursor cannot be combined");
    }

    let examined = 0;
    let sessions: Worker[];
    const unknownIds: string[] = [];
    let nextCursor: string | undefined;
    if (ids !== undefined) {
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      if (duplicates.length > 0) {
        throw new BatchQueryError("duplicate_ids", `Duplicate session IDs: ${[...new Set(duplicates)].join(", ")}`);
      }
      sessions = [];
      for (const id of ids) {
        examined += 1;
        const worker = this.workersById.get(id);
        if (worker === undefined || worker.batchId !== batchId) unknownIds.push(id);
        else sessions.push(worker);
      }
    } else {
      const memberIds = this.workerIdsByBatchId.get(batchId) ?? [];
      const offset = cursor === undefined ? 0 : this.decodeCursor(cursor, batchId);
      const pageIds = memberIds.slice(offset, offset + limit);
      examined = pageIds.length;
      sessions = pageIds.flatMap((id) => {
        const worker = this.workersById.get(id);
        return worker === undefined ? [] : [worker];
      });
      if (offset + pageIds.length < memberIds.length) nextCursor = this.encodeCursor(batchId, offset + pageIds.length);
    }
    this.observeQuery({ operation, examined, returned: sessions.length, durationMs: this.now() - startedAt });
    return {
      batch: structuredClone(batch), sessions: structuredClone(sessions), unknownIds,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  private workersForBatch(batchId: string): Worker[] {
    return (this.workerIdsByBatchId.get(batchId) ?? []).flatMap((id) => {
      const worker = this.workersById.get(id);
      return worker === undefined ? [] : [worker];
    });
  }

  private rebuildIndexes(): void {
    this.batchesById.clear();
    this.workersById.clear();
    this.workerIdsByBatchId.clear();
    this.batchesByIdempotencyKey.clear();
    for (const batch of this.state.batches) {
      this.batchesById.set(batch.id, batch);
      if (batch.idempotencyKey !== undefined && batch.clientId !== undefined) {
        this.batchesByIdempotencyKey.set(`${batch.clientId}\0${batch.idempotencyKey}`, batch.id);
      }
    }
    for (const worker of this.state.workers) {
      this.workersById.set(worker.id, worker);
      const members = this.workerIdsByBatchId.get(worker.batchId) ?? [];
      members.push(worker.id);
      this.workerIdsByBatchId.set(worker.batchId, members);
    }
    for (const members of this.workerIdsByBatchId.values()) {
      members.sort((leftId, rightId) => {
        const left = this.workersById.get(leftId)!;
        const right = this.workersById.get(rightId)!;
        return (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)
          || left.startedAt.localeCompare(right.startedAt)
          || left.id.localeCompare(right.id);
      });
    }
  }

  private encodeCursor(batchId: string, offset: number): string {
    return Buffer.from(JSON.stringify({ batchId, offset }), "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string, batchId: string): number {
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      const parsed = z.object({ batchId: z.string(), offset: z.number().int().nonnegative() }).parse(value);
      if (parsed.batchId !== batchId) throw new Error("wrong batch");
      return parsed.offset;
    } catch {
      throw new BatchQueryError("invalid_cursor", "Invalid pagination cursor");
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, this.path);
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 50, minTimeout: 50, maxTimeout: 200 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async withFreshState<T>(query: () => T): Promise<T> {
    return this.withLock(async () => {
      await this.load();
      return query();
    });
  }

  static processStartedAt(pid: number): string | undefined {
    try {
      if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      }
      return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private static isProcessAlive(pid: number, processStartedAt?: string): boolean {
    if (processStartedAt === undefined || !DurableStore.pidExists(pid)) return false;
    return DurableStore.processStartedAt(pid) === processStartedAt;
  }

  private static pidExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}

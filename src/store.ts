import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { auditField, RedactionPolicy, SecurityError, SECURITY_POLICY_VERSION } from "./security.js";
import { assertPrivateStatePath } from "./state-path.js";
import { preparePrivateDirectory, secureCreatedFile, validateOwnerOnlyFile } from "./storage.js";

const processLockQueues = new Map<string, Promise<void>>();

export type WorkerStatus = "requested" | "running" | "canceling" | "succeeded" | "failed" | "canceled" | "unknown_outcome";
export type TerminalWorkerStatus = Extract<WorkerStatus, "succeeded" | "failed" | "canceled" | "unknown_outcome">;
/** Stop reasons the state machine allows for a canceled session. */
export type CancellationReason = "user_requested" | "orchestrator_shutdown" | "superseded" | "policy_revoked";
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
  runId?: string;
  stopReason?: string;
  stopDetail?: string;
  cancelRequestedAt?: string;
  preCancelStatus?: WorkerStatus;
  deadlineAt?: string;
  lifecycleReconcilePending?: boolean;
  cancellationDeliveryPending?: boolean;
  cancellationDeliveryClaimed?: boolean;
  cancellationDelivered?: boolean;
  providerStopPending?: boolean;
  providerStopClaimed?: boolean;
  providerStopUnsupported?: boolean;
  lateObservations?: LateObservation[];
}

/** Evidence that arrived after a worker was already terminal. It never changes state. */
export interface LateObservation {
  observedAt: string;
  status: string;
  retainedResult: boolean;
}

const MAX_LATE_OBSERVATIONS = 32;

function appendLateObservation(worker: Worker, observation: LateObservation): void {
  const observations = (worker.lateObservations ??= []);
  observations.push(observation);
  if (observations.length > MAX_LATE_OBSERVATIONS) observations.splice(0, observations.length - MAX_LATE_OBSERVATIONS);
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
  errorCode?: string;
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
  errorCode?: string;
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

const attributionSchema = z.object({ agent: z.string().min(1), task: z.string().min(1) }).strict();
const sessionSchema = z.object({
  id: z.string().min(1), clientId: z.string().min(1), createdAt: z.iso.datetime(), lastSeenAt: z.iso.datetime(),
}).strict();
const batchSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), sessionId: z.string().min(1),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), idempotencyKey: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(), requestFingerprint: z.string().min(1).optional(),
}).strict();
const workerStatusSchema = z.enum([
  "requested", "running", "canceling", "succeeded", "failed", "canceled", "unknown_outcome",
]);
/**
 * Stop reasons the authoritative state machine allows per terminal status.
 * See docs/session-state-machine.md; deadlines are a `failed`/`deadline_exceeded` outcome,
 * not a separate terminal state.
 */
const STOP_REASONS_BY_STATUS = {
  succeeded: new Set(["succeeded", "succeeded_before_cancellation"]),
  failed: new Set([
    "invalid_request", "policy_denied", "dependency_unavailable", "launch_error", "launch_timeout",
    "execution_error", "worker_crash", "resource_exhausted", "deadline_exceeded", "artifact_error",
  ]),
  canceled: new Set(["user_requested", "orchestrator_shutdown", "superseded", "policy_revoked"]),
} as const;
const CANCELLATION_REASONS: ReadonlySet<string> = STOP_REASONS_BY_STATUS.canceled;
const workerSchema = z.object({
  id: z.string().min(1), batchId: z.string().min(1), sessionId: z.string().min(1),
  pid: z.number().int().positive().optional(),
  processStartedAt: z.string().min(1).optional(),
  status: workerStatusSchema,
  attribution: attributionSchema, startedAt: z.iso.datetime(), completedAt: z.iso.datetime().optional(),
  result: z.unknown().optional(), position: z.number().int().nonnegative().optional(), runId: z.string().min(1).optional(),
  stopReason: z.string().min(1).optional(), stopDetail: z.string().min(1).optional(),
  cancelRequestedAt: z.iso.datetime().optional(), preCancelStatus: workerStatusSchema.optional(),
  deadlineAt: z.iso.datetime().optional(),
  lifecycleReconcilePending: z.boolean().optional(),
  cancellationDeliveryPending: z.boolean().optional(),
  cancellationDeliveryClaimed: z.boolean().optional(),
  cancellationDelivered: z.boolean().optional(),
  providerStopPending: z.boolean().optional(),
  providerStopClaimed: z.boolean().optional(),
  providerStopUnsupported: z.boolean().optional(),
  lateObservations: z.array(z.object({
    observedAt: z.iso.datetime(), status: z.string().min(1), retainedResult: z.boolean(),
  })).optional(),
}).strict().superRefine((worker, context) => {
  if (worker.status === "running" && (worker.pid === undefined || worker.processStartedAt === undefined)) {
    context.addIssue({ code: "custom", message: "Running workers require a PID and process start token" });
  }
  const allowed = STOP_REASONS_BY_STATUS[worker.status as keyof typeof STOP_REASONS_BY_STATUS];
  if (allowed !== undefined && worker.stopReason !== undefined && !allowed.has(worker.stopReason)) {
    context.addIssue({ code: "custom", message: `${worker.status} cannot use stop reason ${JSON.stringify(worker.stopReason)}` });
  }
});
const diagnosticSchema = z.object({
  id: z.string().min(1), kind: z.enum(["orphan", "unknown_outcome", "missing_result"]),
  workerId: z.string().min(1), message: z.string().min(1), detectedAt: z.iso.datetime(),
}).strict();
const assignmentSchema = z.object({
  id: z.string().min(1), idempotencyKey: z.string().min(1), requestFingerprint: z.string().min(1),
  batchId: z.string().min(1), sessionId: z.string().min(1),
  status: z.enum(["accepted", "launching", "launched", "failed"]), attribution: attributionSchema,
  prompt: z.string().min(1), workspaceId: z.string().min(1).optional(), workspacePath: z.string().min(1),
  attemptId: z.string().min(1).optional(), attempt: z.number().int().positive().optional(), acceptedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(), runId: z.string().min(1).optional(), error: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
}).strict();
const resultClaimSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled", "stopped_without_result", "malformed"]),
  completeness: z.enum(["complete", "empty", "partial", "missing", "malformed"]),
  output: z.string().optional(), error: z.string().min(1).optional(), retryable: z.boolean().optional(),
  stopReason: z.string().min(1).optional(),
  resume: z.object({ adapter: z.string().min(1), token: z.string().min(1) }).strict().optional(),
}).strict();
const capturedResultSchema = z.object({
  deliveryId: z.string().min(1), deliveryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  assignmentId: z.string().min(1), batchId: z.string().min(1), sessionId: z.string().min(1),
  workspaceId: z.string().min(1), workspacePath: z.string().min(1), attemptId: z.string().min(1),
  attempt: z.number().int().positive(), runId: z.string().min(1), attribution: attributionSchema,
  claim: resultClaimSchema, verifiedArtifacts: z.tuple([]), capturedAt: z.iso.datetime(),
}).strict();
const auditEventSchema = z.object({
  id: z.string().min(1), assignmentId: z.string().min(1),
  type: z.enum(["launch_accepted", "launch_reserved", "execution_started", "launch_failed"]),
  occurredAt: z.iso.datetime(), runId: z.string().min(1).optional(), error: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
}).strict();
const securityAuditEventSchema = z.object({
  id: z.string().min(1), sequence: z.number().int().positive(), occurredAt: z.iso.datetime(),
  requesterId: z.string().min(1),
  operation: z.string().min(1), decision: z.enum(["allowed", "denied", "failed"]),
  reasonCode: z.string().min(1), correlationId: z.string().min(1), policyVersion: z.string().min(1),
  workspaceId: z.string().min(1).optional(), projectId: z.string().min(1).optional(),
  assignmentId: z.string().min(1).optional(),
  previousEventHash: z.string().regex(/^[a-f0-9]{64}$/), eventHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const launchIntentSchema = z.object({
  idempotencyKey: z.string().min(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().min(1), batchId: z.string().min(1), workerId: z.string().min(1), workspaceId: z.string().min(1).optional(),
  attribution: attributionSchema,
  status: z.enum(["reserved", "dispatching", "unknown_outcome", "bound"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), runId: z.string().min(1).optional(),
  diagnostic: z.string().min(1).optional(),
}).strict().superRefine((intent, context) => {
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
  }).strict().optional(),
  reconciledAt: z.iso.datetime().optional(),
}).strict().superRefine((state, context) => {
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
  const sessions = new Set(state.sessions.map(({ id }) => id));
  const batches = new Map(state.batches.map((batch) => [batch.id, batch]));
  const assignments = new Map(state.assignments.map((assignment) => [assignment.id, assignment]));
  for (const batch of state.batches) {
    if (!sessions.has(batch.sessionId)) context.addIssue({ code: "custom", message: `Batch ${batch.id} references a missing session` });
  }
  for (const assignment of state.assignments) {
    const batch = batches.get(assignment.batchId);
    if (!sessions.has(assignment.sessionId) || batch === undefined) {
      context.addIssue({ code: "custom", message: `Assignment ${assignment.id} has inconsistent durable identity` });
    }
  }
  for (const event of state.auditEvents) {
    if (!assignments.has(event.assignmentId)) context.addIssue({ code: "custom", message: `Audit event ${event.id} references a missing assignment` });
  }
  for (const result of state.capturedResults ?? []) {
    const assignment = assignments.get(result.assignmentId);
    if (assignment === undefined || result.batchId !== assignment.batchId || result.sessionId !== assignment.sessionId
      || result.workspaceId !== assignment.workspaceId || result.workspacePath !== assignment.workspacePath
      || result.attemptId !== assignment.attemptId || result.attempt !== assignment.attempt
      || result.runId !== assignment.runId) {
      context.addIssue({ code: "custom", message: `Captured result ${result.deliveryId} has inconsistent durable identity` });
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
  private readonly redaction: RedactionPolicy;
  private readonly dispatchLockStaleMs: number;

  constructor(
    private readonly path: string,
    private readonly isProcessAlive: (pid: number, processStartedAt?: string) => boolean = DurableStore.isProcessAlive.bind(DurableStore),
    private readonly observeQuery: (measurement: QueryMeasurement) => void = () => undefined,
    private readonly now: () => number = performance.now.bind(performance),
    redactionOrDispatchLockStaleMs: RedactionPolicy | number = new RedactionPolicy(),
    dispatchLockStaleMs = 10_000,
  ) {
    this.redaction = redactionOrDispatchLockStaleMs instanceof RedactionPolicy
      ? redactionOrDispatchLockStaleMs
      : new RedactionPolicy();
    this.dispatchLockStaleMs = typeof redactionOrDispatchLockStaleMs === "number"
      ? redactionOrDispatchLockStaleMs
      : dispatchLockStaleMs;
  }

  redactText(value: string): string {
    return this.redaction.text(value);
  }

  redactValue(value: unknown): unknown {
    return this.redaction.value(value);
  }

  safeError(error: unknown): string {
    return this.redaction.error(error);
  }

  get statePath(): string { return this.path; }

  async withLaunchDispatchLock<T>(assignmentId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.${assignmentId}.dispatch`;
    const release = await lockfile.lock(lockPath, {
      realpath: false,
      stale: this.dispatchLockStaleMs,
      update: Math.max(1_000, Math.floor(this.dispatchLockStaleMs / 5)),
      retries: { retries: 300, minTimeout: 50, maxTimeout: 200 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
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
      requested: 0, running: 0, canceling: 0, succeeded: 0, failed: 0, canceled: 0, unknown_outcome: 0,
    };
    for (const worker of this.workersForBatch(batchId)) counts[worker.status] += 1;
    const settled = counts.succeeded + counts.failed + counts.canceled;
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

  async worker(workerId: string): Promise<Worker | undefined> {
    return this.withFreshState(() => {
      const worker = this.workersById.get(workerId);
      return worker === undefined ? undefined : structuredClone(worker);
    });
  }

  async workersInBatch(batchId: string): Promise<Worker[]> {
    return this.withFreshState(() => {
      if (!this.batchesById.has(batchId)) throw new BatchQueryError("not_found", `Unknown batch ID: ${batchId}`);
      return structuredClone(this.workersForBatch(batchId));
    });
  }

  /**
   * Binds a worker to exactly one execution identity. A rebind to a different run ID is refused so a
   * single session can never be attributed to two executions. Process evidence promotes the worker to
   * `running`; without it the status is left alone, because `running` requires a liveness token.
   */
  async bindWorkerRun(
    workerId: string,
    runId: string,
    execution: { pid: number; processStartedAt: string } | undefined = undefined,
  ): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      if (DurableStore.isTerminal(worker.status)) {
        throw new BatchQueryError("invalid_request", "Cannot bind a terminal worker to a run");
      }
      if (worker.runId !== undefined && worker.runId !== runId) {
        throw new BatchQueryError("invalid_request", "Worker is already bound to another run");
      }
      worker.runId = runId;
      if (execution !== undefined && (worker.status === "requested" || worker.status === "running")) {
        worker.status = "running";
        worker.pid = execution.pid;
        worker.processStartedAt = execution.processStartedAt;
      }
    });
  }

  /** Records the wall-clock instant after which a nonterminal worker must be expired. */
  async setWorkerDeadline(workerId: string, deadline: Date): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      if (DurableStore.isTerminal(worker.status)) {
        throw new BatchQueryError("invalid_request", "Cannot set a deadline on a terminal session");
      }
      worker.deadlineAt = deadline.toISOString();
    });
  }

  /**
   * Durably records cancellation intent before any provider call. Repeated or concurrent requests are
   * idempotent and preserve the first reason; only the caller that actually performed the transition
   * receives `claimed: true`, so exactly one caller is responsible for issuing the provider stop.
   */
  async requestWorkerCancellation(
    workerId: string,
    reason: CancellationReason = "user_requested",
    options: { detail?: string; at?: Date } = {},
  ): Promise<{ worker: Worker; claimed: boolean; local: boolean }> {
    if (!CANCELLATION_REASONS.has(reason)) {
      throw new BatchQueryError("invalid_request", `Unsupported cancellation reason: ${reason}`);
    }
    const at = options.at ?? new Date();
    let claimed = false;
    let local = false;
    const worker = await this.updateWorker(workerId, (candidate) => {
      if (DurableStore.isTerminal(candidate.status) || candidate.status === "canceling") return;
      claimed = true;
      const launch = this.state.assignments.find(({ sessionId }) => sessionId === candidate.id);
      if (candidate.runId === undefined && launch?.status !== "launching") {
        local = true;
        candidate.status = "canceled";
        candidate.completedAt = at.toISOString();
        candidate.stopReason = reason;
        if (options.detail !== undefined) candidate.stopDetail = options.detail;
        return;
      }
      candidate.preCancelStatus = candidate.status;
      candidate.status = "canceling";
      candidate.cancellationDeliveryPending = true;
      candidate.cancelRequestedAt = at.toISOString();
      candidate.stopReason = reason;
      if (options.detail !== undefined) candidate.stopDetail = options.detail;
    });
    return { worker, claimed, local };
  }

  /** Returns bound cancellations that still need a provider terminal observation. */
  async cancelingWorkers(): Promise<Worker[]> {
    return this.withFreshState(() => structuredClone(this.state.workers
      .filter((worker) => worker.status === "canceling" && worker.runId !== undefined)));
  }

  async claimCancellationDelivery(workerId: string): Promise<boolean> {
    let claimed = false;
    await this.updateWorker(workerId, (worker) => {
      if (!worker.cancellationDeliveryPending || worker.cancellationDeliveryClaimed) return;
      delete worker.cancellationDeliveryPending;
      worker.cancellationDeliveryClaimed = true;
      claimed = true;
    });
    return claimed;
  }

  async releaseCancellationDelivery(workerId: string): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      delete worker.cancellationDeliveryClaimed;
      if (worker.status === "canceling") worker.cancellationDeliveryPending = true;
      else if (worker.status === "failed" && worker.stopReason === "deadline_exceeded" && worker.runId !== undefined) {
        worker.providerStopPending = true;
      }
    });
  }

  async markCancellationDelivered(workerId: string): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      delete worker.cancellationDeliveryPending;
      delete worker.cancellationDeliveryClaimed;
      worker.cancellationDelivered = true;
      delete worker.providerStopPending;
      delete worker.providerStopClaimed;
    });
  }

  async markProviderStopDelivered(workerId: string): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      delete worker.providerStopPending;
      delete worker.providerStopClaimed;
      delete worker.providerStopUnsupported;
    });
  }

  async markProviderStopUnsupported(workerId: string): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      delete worker.providerStopPending;
      delete worker.providerStopClaimed;
      worker.providerStopUnsupported = true;
    });
  }

  async handleUnsupportedCancellation(workerId: string): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      delete worker.cancellationDeliveryPending;
      delete worker.cancellationDeliveryClaimed;
      if (worker.status === "failed" && worker.stopReason === "deadline_exceeded") {
        delete worker.providerStopPending;
        delete worker.providerStopClaimed;
        worker.providerStopUnsupported = true;
        return;
      }
      if (worker.status !== "canceling") return;
      worker.status = worker.preCancelStatus ?? "requested";
      delete worker.preCancelStatus;
      delete worker.cancelRequestedAt;
      delete worker.stopReason;
      delete worker.stopDetail;
    });
  }

  async claimProviderStop(workerId: string): Promise<boolean> {
    let claimed = false;
    await this.updateWorker(workerId, (worker) => {
      if (!worker.providerStopPending || worker.providerStopClaimed) return;
      delete worker.providerStopPending;
      worker.providerStopClaimed = true;
      claimed = true;
    });
    return claimed;
  }

  async releaseProviderStop(workerId: string): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      delete worker.providerStopClaimed;
      if (worker.runId !== undefined) worker.providerStopPending = true;
    });
  }

  /** Returns timed-out executions whose eventual provider result has not yet been observed. */
  async workersPendingLifecycleReconciliation(): Promise<Worker[]> {
    return this.withFreshState(() => structuredClone(this.state.workers
      .filter((worker) => (worker.lifecycleReconcilePending === true || worker.providerStopPending === true)
        && worker.runId !== undefined)));
  }

  async recoverLifecycleDeliveryClaims(): Promise<void> {
    await this.withLock(async () => {
      await this.load();
      let changed = false;
      for (const worker of this.state.workers) {
        if (worker.cancellationDeliveryClaimed) {
          delete worker.cancellationDeliveryClaimed;
          if (worker.status === "unknown_outcome") worker.status = "canceling";
          if (worker.runId !== undefined && !DurableStore.isTerminal(worker.status)) {
            worker.cancellationDeliveryPending = true;
          } else if (worker.runId !== undefined && worker.status === "failed" && worker.stopReason === "deadline_exceeded") {
            worker.providerStopPending = true;
          }
          changed = true;
        }
        if (worker.providerStopClaimed) {
          delete worker.providerStopClaimed;
          if (worker.runId !== undefined) worker.providerStopPending = true;
          changed = true;
        }
      }
      if (changed) await this.persist();
    });
  }

  /**
   * Withdraws unconfirmed cancellation intent, restoring the pre-cancel status. Used when a backend
   * that advertised cancellation rejects the command as unsupported, so state stays honest.
   */
  async clearWorkerCancellation(workerId: string): Promise<Worker> {
    return this.updateWorker(workerId, (worker) => {
      if (worker.status !== "canceling") return;
      worker.status = worker.preCancelStatus ?? "requested";
      delete worker.preCancelStatus;
      delete worker.cancelRequestedAt;
      delete worker.cancellationDeliveryPending;
      delete worker.cancellationDeliveryClaimed;
      delete worker.cancellationDelivered;
      delete worker.stopReason;
      delete worker.stopDetail;
    });
  }

  /**
   * Appends the one winning terminal outcome. Terminal state is monotonic: a later observation never
   * changes status or stop reason, but its result is retained and audited as a late observation.
   */
  async recordWorkerTerminal(
    workerId: string,
    status: TerminalWorkerStatus,
    options: { result?: unknown; stopReason?: string; at?: Date } = {},
  ): Promise<Worker> {
    validateStopReason(status, options.stopReason);
    const at = options.at ?? new Date();
    return this.updateWorker(workerId, (worker) => {
      if (DurableStore.isTerminal(worker.status)) {
        const retainedResult = options.result !== undefined && worker.result === undefined;
        if (retainedResult) worker.result = options.result;
        appendLateObservation(worker, { observedAt: at.toISOString(), status, retainedResult });
        delete worker.lifecycleReconcilePending;
        return;
      }
      const cancellationRequested = worker.status === "canceling";
      worker.status = status;
      worker.completedAt = at.toISOString();
      delete worker.lifecycleReconcilePending;
      delete worker.cancellationDeliveryPending;
      delete worker.cancellationDeliveryClaimed;
      if (options.result !== undefined) worker.result = options.result;
      delete worker.preCancelStatus;
      const stopReason = options.stopReason
        ?? (status === "succeeded" ? (cancellationRequested ? "succeeded_before_cancellation" : "succeeded") : undefined)
        ?? (status === "canceled" ? (worker.stopReason ?? "user_requested") : undefined)
        ?? (status === "failed" ? "execution_error" : undefined);
      if (stopReason === undefined) delete worker.stopReason;
      else worker.stopReason = stopReason;
    });
  }

  /** Records a provider terminal observation only if cancellation is still pending. */
  async settleWorkerCancellation(
    workerId: string,
    status: TerminalWorkerStatus,
    options: { result?: unknown; stopReason?: string; at?: Date; keepReconciliationPending?: boolean } = {},
  ): Promise<{ worker: Worker; claimed: boolean }> {
    validateStopReason(status, options.stopReason);
    const at = options.at ?? new Date();
    let claimed = false;
    const worker = await this.updateWorker(workerId, (candidate) => {
      if (DurableStore.isTerminal(candidate.status)) {
        const wasPending = candidate.lifecycleReconcilePending === true;
        const retainedResult = options.result !== undefined && candidate.result === undefined;
        const changedResult = options.result !== undefined
          && JSON.stringify(candidate.result) !== JSON.stringify(options.result);
        if (retainedResult || (options.result !== undefined && candidate.lifecycleReconcilePending)) {
          candidate.result = options.result;
        }
        if (retainedResult || changedResult || !options.keepReconciliationPending) {
          appendLateObservation(candidate, { observedAt: at.toISOString(), status, retainedResult });
        }
        if (options.keepReconciliationPending && wasPending) candidate.lifecycleReconcilePending = true;
        else delete candidate.lifecycleReconcilePending;
        delete candidate.cancellationDeliveryPending;
        delete candidate.cancellationDeliveryClaimed;
        return;
      }
      if (candidate.status !== "canceling") return;
      claimed = true;
      candidate.status = status;
      candidate.completedAt = at.toISOString();
      if (options.keepReconciliationPending) candidate.lifecycleReconcilePending = true;
      else delete candidate.lifecycleReconcilePending;
      delete candidate.cancellationDeliveryPending;
      delete candidate.cancellationDeliveryClaimed;
      if (options.result !== undefined) candidate.result = options.result;
      delete candidate.preCancelStatus;
      const stopReason = options.stopReason
        ?? (status === "succeeded" ? "succeeded_before_cancellation" : undefined)
        ?? (status === "canceled" ? (candidate.stopReason ?? "user_requested") : undefined)
        ?? (status === "failed" ? "execution_error" : undefined);
      if (stopReason === undefined) delete candidate.stopReason;
      else candidate.stopReason = stopReason;
    });
    return { worker, claimed };
  }

  /**
   * Expires one worker whose deadline passed. Per the state machine this is `failed`/`deadline_exceeded`.
   * Only the caller that performed the transition receives `claimed: true`, so concurrent sweeps report
   * each expiry exactly once.
   */
  async expireWorker(workerId: string, options: { deadline?: Date; at?: Date } = {}): Promise<{ worker: Worker; claimed: boolean }> {
    const at = options.at ?? new Date();
    let claimed = false;
    const worker = await this.updateWorker(workerId, (candidate) => {
      if (options.deadline !== undefined) candidate.deadlineAt = options.deadline.toISOString();
      if (DurableStore.isTerminal(candidate.status)
        || candidate.deadlineAt === undefined
        || candidate.deadlineAt > at.toISOString()) return;
      claimed = true;
      candidate.status = "failed";
      candidate.stopReason = "deadline_exceeded";
      candidate.completedAt = at.toISOString();
      const launch = this.state.assignments.find(({ sessionId }) => sessionId === candidate.id);
      if (candidate.runId !== undefined || launch?.status === "launching") {
        candidate.lifecycleReconcilePending = true;
        if (!candidate.cancellationDeliveryClaimed && !candidate.cancellationDelivered) candidate.providerStopPending = true;
      }
      delete candidate.cancellationDeliveryPending;
      if (!candidate.cancellationDeliveryClaimed) delete candidate.cancellationDeliveryClaimed;
      delete candidate.preCancelStatus;
    });
    return { worker, claimed };
  }

  /** Returns every nonterminal worker whose recorded deadline is at or before `now`, oldest deadline first. */
  async overdueWorkers(now = new Date()): Promise<Worker[]> {
    const cutoff = now.toISOString();
    return this.withFreshState(() => structuredClone(this.state.workers
      .filter((worker) => worker.deadlineAt !== undefined
        && worker.deadlineAt <= cutoff
        && !DurableStore.isTerminal(worker.status))
      .sort((left, right) => left.deadlineAt!.localeCompare(right.deadlineAt!))
      .slice(0, 250)));
  }

  async recordWorkerResult(
    workerId: string,
    status: Extract<WorkerStatus, "succeeded" | "failed">,
    result: unknown,
    completedAt = new Date(),
  ): Promise<Worker> {
    return this.withLock(async () => {
      await this.load();
      const worker = this.workersById.get(workerId);
      if (worker === undefined) throw new Error(`Unknown worker: ${workerId}`);
      if (DurableStore.isTerminal(worker.status)) {
        if (worker.status !== status || JSON.stringify(worker.result) !== JSON.stringify(result)) {
          throw new Error(`Worker ${workerId} already has a different terminal result`);
        }
        return structuredClone(worker);
      }
      worker.status = status;
      worker.result = structuredClone(result);
      worker.completedAt = completedAt.toISOString();
      await this.persist();
      return structuredClone(worker);
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
        if (!sessionIds.has(worker.sessionId) || batch === undefined) {
          diagnose("orphan", worker, "Worker references a missing or inconsistent durable session or batch");
        }

        if (worker.status === "running"
          && (worker.pid === undefined || !this.isProcessAlive(worker.pid, worker.processStartedAt))) {
          worker.status = "unknown_outcome";
          worker.completedAt = detectedAt;
          diagnose("unknown_outcome", worker, "Worker process was absent during startup reconciliation");
        }

        // A canceling worker whose process is provably gone never reported its terminal outcome.
        if (worker.status === "canceling" && worker.pid !== undefined
          && !worker.cancellationDeliveryPending
          && !this.isProcessAlive(worker.pid, worker.processStartedAt)) {
          diagnose("unknown_outcome", worker, "Canceling worker process was absent; exact provider reconciliation remains pending");
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
    worker: Worker;
  }): Promise<{ assignment: Assignment; created: boolean }> {
    return this.withLock(async () => {
      await this.load();
      const worker = {
        ...input.worker,
        attribution: {
          agent: this.redactText(input.worker.attribution.agent),
          task: this.redactText(input.worker.attribution.task),
        },
      };
      assignmentSchema.parse(input.assignment);
      sessionSchema.parse(input.session);
      batchSchema.parse(input.batch);
      auditEventSchema.parse(input.event);
      workerSchema.parse(worker);
      if (input.event.assignmentId !== input.assignment.id) {
        throw new Error("Launch acceptance event assignment does not match its target");
      }
      if (input.event.type !== "launch_accepted") {
        throw new Error("Launch acceptance event must have type launch_accepted");
      }
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
        this.state.workers.push(worker);
        this.state.auditEvents.push(input.event);
        this.appendSecurityAuditToState(input.securityAudit, new Date(input.event.occurredAt));
        this.rebuildIndexes();
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

  async acceptLaunchBatch(input: {
    assignments: Assignment[];
    sessions: Session[];
    batch: Batch;
    workers: Worker[];
    events: LaunchAuditEvent[];
    securityAudits: SecurityAuditInput[];
  }): Promise<{ assignments: Assignment[]; created: boolean }> {
    return this.withLock(async () => {
      await this.load();
      input.assignments.forEach((assignment) => assignmentSchema.parse(assignment));
      input.sessions.forEach((session) => sessionSchema.parse(session));
      input.workers.forEach((worker) => workerSchema.parse(worker));
      batchSchema.parse(input.batch);
      input.events.forEach((auditEvent) => auditEventSchema.parse(auditEvent));
      if (input.sessions.length !== input.assignments.length
        || input.workers.length !== input.assignments.length
        || input.events.length !== input.assignments.length
        || input.securityAudits.length !== input.assignments.length
        || input.assignments.some((assignment, index) => input.sessions[index]?.id !== assignment.sessionId
          || input.workers[index]?.sessionId !== assignment.sessionId
          || input.events[index]?.assignmentId !== assignment.id
          || input.events[index]?.type !== "launch_accepted"
          || input.securityAudits[index]?.assignmentId !== assignment.id)) {
        throw new Error("Launch batch records must match assignments in order");
      }
      const existing = input.assignments.map((assignment) =>
        this.state.assignments.find(({ idempotencyKey }) => idempotencyKey === assignment.idempotencyKey));
      if (existing.some((assignment) => assignment !== undefined)) {
        if (existing.some((assignment) => assignment === undefined)) {
          throw new Error("A batch idempotency replay matched only part of the original batch");
        }
        const replay = existing as Assignment[];
        for (const [index, assignment] of replay.entries()) {
          if (assignment.requestFingerprint !== input.assignments[index]?.requestFingerprint
            || assignment.batchId !== input.batch.id) {
            throw new Error("A batch idempotency key was reused with different launch input");
          }
        }
        return { assignments: structuredClone(replay), created: false };
      }
      if (this.state.batches.some(({ id }) => id === input.batch.id)) {
        throw new Error("A batch idempotency key was reused with different assignments");
      }
      const previousState = structuredClone(this.state);
      try {
        this.state.sessions.push(...input.sessions);
        this.state.batches.push(input.batch);
        this.state.assignments.push(...input.assignments);
        this.state.workers.push(...input.workers);
        this.state.auditEvents.push(...input.events);
        this.rebuildIndexes();
        input.securityAudits.forEach((audit, index) => {
          this.appendSecurityAuditToState(audit, new Date(input.events[index]!.occurredAt));
        });
        await this.persist();
      } catch (error) {
        await this.load().catch(() => {
          this.state = previousState;
          this.rebuildIndexes();
        });
        throw error;
      }
      return { assignments: structuredClone(input.assignments), created: true };
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
    if ((events.length > 0 && head === undefined)
      || (head !== undefined && (head.sequence !== events.length || head.eventHash !== previousHash))) {
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
      return structuredClone(this.state.assignments.filter((assignment) => {
        if (assignment.status !== "accepted" && assignment.status !== "launching") return false;
        const worker = this.state.workers.find(({ id }) => id === assignment.sessionId);
        return worker !== undefined && !DurableStore.isTerminal(worker.status);
      }));
    });
  }

  async recordLaunchEvent(
    assignmentId: string,
    status: Extract<AssignmentLaunchStatus, "launching" | "launched" | "failed">,
    event: LaunchAuditEvent,
    securityAudit?: SecurityAuditInput,
  ): Promise<{ assignment: Assignment; transitioned: boolean }> {
    return this.withLock(async () => {
      await this.load();
      auditEventSchema.parse(event);
      const assignment = this.state.assignments.find(({ id }) => id === assignmentId);
      if (assignment === undefined) throw new Error(`Unknown assignment: ${assignmentId}`);
      const lifecycleWorker = this.state.workers.find(({ id }) => id === assignment.sessionId);
      if (status === "launching" && lifecycleWorker !== undefined && DurableStore.isTerminal(lifecycleWorker.status)) {
        const previousState = structuredClone(this.state);
        assignment.status = "failed";
        assignment.updatedAt = event.occurredAt;
        assignment.error = "Launch was canceled before provider dispatch";
        this.state.auditEvents.push({
          ...event,
          type: "launch_failed",
          error: assignment.error,
        });
        if (securityAudit !== undefined) this.appendSecurityAuditToState(securityAudit, new Date(event.occurredAt));
        try {
          await this.persist();
        } catch (error) {
          this.state = previousState;
          this.rebuildIndexes();
          throw error;
        }
        return { assignment: structuredClone(assignment), transitioned: false };
      }
      if (event.assignmentId !== assignmentId) throw new Error("Launch event assignment does not match its target");
      const expectedType: Record<typeof status, LaunchAuditType> = {
        launching: "launch_reserved",
        launched: "execution_started",
        failed: "launch_failed",
      };
      if (event.type !== expectedType[status]) throw new Error("Launch event type does not match its transition");
      const existingEvent = this.state.auditEvents.find(({ id }) => id === event.id);
      if (existingEvent !== undefined && (existingEvent.assignmentId !== event.assignmentId
        || existingEvent.type !== event.type
        || existingEvent.occurredAt !== event.occurredAt
        || existingEvent.runId !== event.runId
        || existingEvent.error !== event.error
        || existingEvent.errorCode !== event.errorCode)) {
        throw new Error(`Launch audit event ID ${JSON.stringify(event.id)} conflicts with existing evidence`);
      }
      const allowed = assignment.status === "accepted" && (status === "launching" || status === "failed")
        || assignment.status === "launching" && (status === "launched" || status === "failed");
      if (!allowed) return { assignment: structuredClone(assignment), transitioned: false };
      const previousState = structuredClone(this.state);
      try {
        assignment.status = status;
        assignment.updatedAt = event.occurredAt < assignment.updatedAt ? assignment.updatedAt : event.occurredAt;
        if (event.runId !== undefined) assignment.runId = event.runId;
        if (event.runId !== undefined) {
          const worker = this.state.workers.find(({ id }) => id === assignment.sessionId);
          if (worker === undefined) throw new Error(`Missing lifecycle worker for assignment: ${assignmentId}`);
          if (worker.runId !== undefined && worker.runId !== event.runId) throw new Error("Worker is already bound to another run");
          worker.runId = event.runId;
          if (DurableStore.isTerminal(worker.status)) {
            worker.lifecycleReconcilePending = true;
            worker.providerStopPending = true;
          }
        }
        if (event.error !== undefined) assignment.error = this.redaction.text(event.error);
        if (event.errorCode !== undefined) assignment.errorCode = event.errorCode;
        if (status === "failed") {
          const worker = this.state.workers.find(({ id }) => id === assignment.sessionId);
          if (worker === undefined) throw new Error(`Missing lifecycle worker for assignment: ${assignmentId}`);
          if (!DurableStore.isTerminal(worker.status)) {
            worker.status = "failed";
            worker.completedAt = event.occurredAt;
            worker.stopReason = "launch_error";
            worker.result = {
              status: "failed",
              completeness: "missing",
              error: this.redaction.text(event.error ?? "Provider launch failed"),
            };
          }
          delete worker.preCancelStatus;
          delete worker.cancelRequestedAt;
          delete worker.cancellationDeliveryPending;
          delete worker.cancellationDeliveryClaimed;
          delete worker.lifecycleReconcilePending;
          delete worker.providerStopPending;
          delete worker.providerStopClaimed;
        }
        if (existingEvent === undefined) this.state.auditEvents.push({
          ...event,
          ...(event.error === undefined ? {} : { error: this.redaction.text(event.error) }),
        });
        if (securityAudit !== undefined) this.appendSecurityAuditToState(securityAudit, new Date(event.occurredAt));
        await this.persist();
      } catch (error) {
        this.state = previousState;
        this.rebuildIndexes();
        throw error;
      }
      return { assignment: structuredClone(assignment), transitioned: true };
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

  async assignmentsForSessions(sessionIds: readonly string[]): Promise<Array<Assignment | undefined>> {
    return this.withFreshState(() => sessionIds.map((sessionId) => {
      const assignment = this.state.assignments.find((candidate) => candidate.sessionId === sessionId);
      return assignment === undefined ? undefined : structuredClone(assignment);
    }));
  }

  async resultsForSessions(sessionIds: readonly string[]): Promise<Array<CapturedResult | undefined>> {
    return this.withFreshState(() => sessionIds.map((sessionId) => {
      const result = this.state.capturedResults?.find((candidate) => candidate.sessionId === sessionId);
      return result === undefined ? undefined : structuredClone(result);
    }));
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
      if (assignment.attribution.agent !== input.attribution.agent
        || assignment.attribution.task !== input.attribution.task) {
        throw new Error("Result attribution does not match its assignment");
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
      const worker = this.state.workers.find(({ id }) => id === input.sessionId);
      if (worker === undefined) throw new Error(`Missing lifecycle worker for result: ${input.assignmentId}`);
      if (!DurableStore.isTerminal(worker.status)) {
        worker.status = input.claim.status === "succeeded" ? "succeeded"
          : input.claim.status === "cancelled" ? "canceled" : "failed";
        worker.result = structuredClone(input);
        worker.completedAt = input.capturedAt;
        worker.stopReason = input.claim.status === "succeeded" ? "succeeded"
          : input.claim.status === "cancelled" ? "user_requested"
            : input.claim.status === "malformed" ? "artifact_error" : "execution_error";
        delete worker.preCancelStatus;
        delete worker.lifecycleReconcilePending;
        delete worker.cancellationDeliveryPending;
      }
      await this.persist();
      return { result: structuredClone(input), duplicate: false };
    });
  }

  private async load(): Promise<void> {
    await assertPrivateStatePath(this.path);
    try {
      if (existsSync(this.path)) validateOwnerOnlyFile(this.path);
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
    await assertPrivateStatePath(this.path);
    stateSchema.parse(this.state);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    preparePrivateDirectory(dirname(this.path));
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
      secureCreatedFile(this.path);
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
    const previous = processLockQueues.get(this.path) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const tail = previous.then(() => queued);
    processLockQueues.set(this.path, tail);
    await previous;
    let release: (() => Promise<void>) | undefined;
    try {
      await assertPrivateStatePath(this.path);
      release = await lockfile.lock(this.path, {
        realpath: false,
        stale: 10_000,
        update: 2_000,
        retries: { retries: 50, minTimeout: 50, maxTimeout: 200 },
      });
      return await operation();
    } finally {
      if (release !== undefined) await release();
      releaseQueue();
      if (processLockQueues.get(this.path) === tail) processLockQueues.delete(this.path);
    }
  }

  private async withFreshState<T>(query: () => T): Promise<T> {
    return this.withLock(async () => {
      await this.load();
      return query();
    });
  }

  private async updateWorker(workerId: string, update: (worker: Worker) => void): Promise<Worker> {
    return this.withLock(async () => {
      await this.load();
      const worker = this.workersById.get(workerId);
      if (worker === undefined) throw new BatchQueryError("not_found", `Unknown session ID: ${workerId}`);
      update(worker);
      await this.persist();
      return structuredClone(worker);
    });
  }

  static isTerminal(status: WorkerStatus): status is TerminalWorkerStatus {
    return status === "succeeded" || status === "failed" || status === "canceled";
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

function validateStopReason(status: TerminalWorkerStatus, reason: string | undefined): void {
  if (reason !== undefined && status !== "unknown_outcome" && !STOP_REASONS_BY_STATUS[status].has(reason)) {
    throw new BatchQueryError("invalid_request", `${status} cannot use stop reason ${JSON.stringify(reason)}`);
  }
}

import { createHash } from "node:crypto";
import type { AgentAdapter, RunHandle } from "./agent-adapter.js";
import {
  DurableStore,
  type Assignment,
  type Batch,
  type LaunchAuditEvent,
  type Session,
  type Worker,
  type WorkerAttribution,
} from "./store.js";
import {
  assertBoundedText,
  assertIdentifier,
  assertDataOperand,
  childEnvironment,
  MAX_ATTRIBUTION_BYTES,
  MAX_IDEMPOTENCY_KEY_BYTES,
  reasonCode,
  SecurityError,
  type WorkspaceAuthorizer,
  type WorkspaceGrant,
} from "./security.js";

export type LaunchBoundary =
  | "after_acceptance"
  | "after_launch_started"
  | "before_adapter_launch"
  | "after_adapter_launch"
  | "after_launch_recorded";

export interface AsynchronousLaunchRequest {
  idempotencyKey: string;
  clientId: string;
  batchName: string;
  attribution: WorkerAttribution;
  prompt: string;
  workspaceId: string;
  workspacePath?: string;
}

export interface LaunchAcceptance {
  sessionId: string;
  batchId: string;
  assignmentId: string;
  status: Assignment["status"];
  acceptedAt: string;
}

export interface AsynchronousBatchLaunchRequest {
  idempotencyKey: string;
  clientId: string;
  batchName: string;
  assignments: Omit<AsynchronousLaunchRequest, "clientId" | "batchName">[];
}

export class LaunchService {
  private dispatchTimer: NodeJS.Timeout | undefined;
  private dispatching: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly store: DurableStore,
    private readonly adapter: AgentAdapter,
    private readonly workspaceAuthorizer: WorkspaceAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly injectCrash: (boundary: LaunchBoundary) => void = () => undefined,
    private readonly retryDelayMs = 1_000,
  ) {}

  async launch(request: AsynchronousLaunchRequest): Promise<LaunchAcceptance> {
    if (this.stopped) throw new Error("Launch service is stopped");
    const accepted = await this.accept(request);
    this.scheduleDispatch(0);
    return accepted;
  }

  async launchBatch(request: AsynchronousBatchLaunchRequest): Promise<LaunchAcceptance[]> {
    if (this.stopped) throw new Error("Launch service is stopped");
    const accepted = await this.acceptBatch(request);
    this.scheduleDispatch(0);
    return accepted;
  }

  async acceptBatch(request: AsynchronousBatchLaunchRequest): Promise<LaunchAcceptance[]> {
    if (this.stopped) throw new Error("Launch service is stopped");
    if (request.assignments.length === 0 || request.assignments.length > 100) {
      throw new Error("A launch batch requires between 1 and 100 assignments");
    }
    if (new Set(request.assignments.map(({ idempotencyKey }) => idempotencyKey)).size !== request.assignments.length) {
      throw new Error("Batch assignment idempotency keys must be unique");
    }
    const clientId = this.store.redactText(assertBoundedText(request.clientId, "clientId", 256));
    const batchName = this.store.redactText(assertBoundedText(request.batchName, "batchName", 256));
    assertIdentifier(request.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_BYTES);
    const grants: WorkspaceGrant[] = [];
    for (const item of request.assignments) {
      const fullRequest = { ...item, clientId: request.clientId, batchName: request.batchName };
      for (const [name, value] of Object.entries(fullRequest)) {
        if (typeof value === "string" && value.length === 0) throw new Error(`${name} must not be empty`);
      }
      if (item.attribution.agent.length === 0 || item.attribution.task.length === 0) {
        throw new Error("attribution requires non-empty agent and task values");
      }
      assertIdentifier(item.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_BYTES);
      assertIdentifier(item.workspaceId, "workspaceId");
      if (this.store.redactText(item.idempotencyKey) !== item.idempotencyKey
        || this.store.redactText(item.workspaceId) !== item.workspaceId) {
        throw new SecurityError("INVALID_ARGUMENT", "Launch identities must not contain credentials");
      }
      assertIdentifier(item.attribution.agent, "attribution.agent", MAX_ATTRIBUTION_BYTES);
      assertBoundedText(item.attribution.task, "attribution.task", MAX_ATTRIBUTION_BYTES);
      assertBoundedText(item.prompt, "prompt");
      grants.push(await this.workspaceAuthorizer.authorize(item.workspaceId));
    }
    const acceptedAt = this.now().toISOString();
    const batchScope = scopedKey(clientId, request.idempotencyKey);
    const batchId = stableId("batch", batchScope);
    const sessions = request.assignments.map((item) => ({
      id: stableId("session", scopedKey(clientId, item.idempotencyKey)), clientId,
      createdAt: acceptedAt, lastSeenAt: acceptedAt,
    }));
    const batch: Batch = {
      id: batchId, name: batchName, sessionId: sessions[0]!.id,
      createdAt: acceptedAt, updatedAt: acceptedAt,
    };
    const assignments = request.assignments.map((item, index): Assignment => {
      const fullRequest: AsynchronousLaunchRequest = {
        ...item, clientId: request.clientId, batchName: request.batchName,
      };
      return {
        id: stableId("assignment", scopedKey(clientId, item.idempotencyKey)),
        idempotencyKey: scopedKey(clientId, item.idempotencyKey),
        requestFingerprint: fingerprint(fullRequest), batchId, sessionId: sessions[index]!.id,
        status: "accepted", attribution: this.store.redactValue(item.attribution) as WorkerAttribution,
        prompt: this.store.redactText(item.prompt), workspaceId: item.workspaceId,
        workspacePath: assertDataOperand(grants[index]!.canonicalPath, "workspace path"),
        attemptId: stableId("attempt", scopedKey(clientId, item.idempotencyKey)), attempt: 1,
        acceptedAt, updatedAt: acceptedAt,
      };
    });
    const workers = assignments.map((assignment, position): Worker => ({
      id: assignment.sessionId,
      batchId,
      sessionId: assignment.sessionId,
      status: "requested",
      attribution: assignment.attribution,
      startedAt: acceptedAt,
      position,
    }));
    const stored = await this.store.acceptLaunchBatch({
      assignments, sessions, batch, workers,
      events: assignments.map(({ id }) => event(id, "launch_accepted", acceptedAt)),
      securityAudits: assignments.map((assignment, index) => this.auditAssignmentInput(
        assignment,
        "allowed",
        "launch_accepted",
        grants[index]!.projectId,
      )),
    });
    this.injectCrash("after_acceptance");
    return stored.assignments.map(acceptance);
  }

  async accept(request: AsynchronousLaunchRequest): Promise<LaunchAcceptance> {
    let grant: WorkspaceGrant;
    let prompt: string;
    let clientId: string;
    let batchName: string;
    let attribution: WorkerAttribution;
    try {
      for (const [name, value] of Object.entries(request)) {
        if (typeof value === "string" && value.length === 0) throw new SecurityError("INVALID_ARGUMENT", `${name} must not be empty`);
      }
      if (request.attribution === undefined
        || request.attribution.agent.length === 0
        || request.attribution.task.length === 0) {
        throw new SecurityError("INVALID_ARGUMENT", "attribution requires non-empty agent and task values");
      }
      assertIdentifier(request.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_BYTES);
      assertIdentifier(request.workspaceId, "workspaceId");
      if (this.store.redactText(request.idempotencyKey) !== request.idempotencyKey
        || this.store.redactText(request.workspaceId) !== request.workspaceId) {
        throw new SecurityError("INVALID_ARGUMENT", "Launch identities must not contain credentials");
      }
      assertIdentifier(request.attribution.agent, "attribution.agent", MAX_ATTRIBUTION_BYTES);
      assertBoundedText(request.attribution.task, "attribution.task", MAX_ATTRIBUTION_BYTES);
      prompt = this.store.redactText(assertBoundedText(request.prompt, "prompt"));
      clientId = this.store.redactText(assertBoundedText(request.clientId, "clientId", 256));
      batchName = this.store.redactText(assertBoundedText(request.batchName, "batchName", 256));
      attribution = this.store.redactValue(request.attribution) as WorkerAttribution;
      grant = await this.workspaceAuthorizer.authorize(request.workspaceId);
    } catch (error) {
      await this.audit(request, "denied", reasonCode(error));
      const message = this.store.safeError(error);
      const sanitizedCause = new Error(message);
      throw error instanceof SecurityError
        ? new SecurityError(error.code, message, error.retryable, { cause: sanitizedCause })
        : new Error(message, { cause: sanitizedCause });
    }
    const acceptedAt = this.now().toISOString();
    const key = scopedKey(clientId, request.idempotencyKey);
    const assignmentId = stableId("assignment", key);
    const attemptId = stableId("attempt", key);
    const session: Session = {
      id: stableId("session", key), clientId,
      createdAt: acceptedAt, lastSeenAt: acceptedAt,
    };
    const batch: Batch = {
      id: stableId("batch", key), name: batchName, sessionId: session.id,
      createdAt: acceptedAt, updatedAt: acceptedAt,
    };
    const assignment: Assignment = {
      id: assignmentId,
      idempotencyKey: key,
      requestFingerprint: fingerprint({ ...request, prompt, clientId, batchName, attribution }),
      batchId: batch.id,
      sessionId: session.id,
      status: "accepted",
      attribution,
      prompt,
      workspaceId: request.workspaceId,
      workspacePath: assertDataOperand(grant.canonicalPath, "workspace path"),
      attemptId,
      attempt: 1,
      acceptedAt,
      updatedAt: acceptedAt,
    };
    const worker = {
      id: session.id,
      batchId: batch.id,
      sessionId: session.id,
      status: "requested" as const,
      attribution,
      startedAt: acceptedAt,
      position: 0,
    };
    const accepted = await this.store.acceptLaunch({
      assignment, session, batch, worker,
      event: event(assignmentId, "launch_accepted", acceptedAt),
      securityAudit: this.auditInput(request, "allowed", "launch_accepted", assignmentId, grant.projectId),
    });
    this.injectCrash("after_acceptance");
    return acceptance(accepted.assignment);
  }

  /** Stops scheduled work and waits for an in-flight background dispatch. */
  async close(): Promise<void> {
    await this.stop();
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching !== undefined) return this.dispatching;
    this.dispatching = this.dispatchAllPending();
    try {
      await this.dispatching;
    } finally {
      this.dispatching = undefined;
    }
  }

  private async dispatchAllPending(): Promise<void> {
    let retryableFailure: unknown;
    for (const assignment of await this.store.pendingAssignments()) {
      try {
        await this.dispatch(assignment);
      } catch (error) {
        retryableFailure = error;
      }
    }
    if (retryableFailure !== undefined) {
      throw retryableFailure instanceof Error ? retryableFailure : new Error("Retryable dispatch failure");
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.dispatchTimer !== undefined) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = undefined;
    }
    try {
      await this.dispatching;
    } finally {
      if (this.dispatchTimer !== undefined) clearTimeout(this.dispatchTimer);
      this.dispatchTimer = undefined;
    }
  }

  private scheduleDispatch(delayMs: number): void {
    if (this.stopped || this.dispatchTimer !== undefined || this.dispatching !== undefined) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = undefined;
      const dispatching = this.dispatchPending();
      void dispatching
        .then(
          () => undefined,
          () => {
            this.dispatching = undefined;
            if (!this.stopped) this.scheduleDispatch(this.retryDelayMs);
          },
        );
    }, delayMs);
  }

  private async dispatch(assignment: Assignment): Promise<void> {
    await this.store.withLaunchDispatchLock(assignment.id, async () => {
      assignment = await this.store.assignmentForResult(assignment.id);
      if (assignment.status !== "accepted" && assignment.status !== "launching") return;
      let grant: WorkspaceGrant;
      try {
        if (assignment.workspaceId === undefined) throw new SecurityError("INVALID_ARGUMENT", "Launch has no workspace identity");
        grant = await this.workspaceAuthorizer.authorize(assignment.workspaceId);
        await grant.revalidate();
        if (grant.canonicalPath !== assignment.workspacePath) {
          throw new SecurityError("INTEGRITY_FAILURE", "Workspace identity changed before launch");
        }
      } catch (error) {
        if (error instanceof SecurityError && error.retryable) {
          await this.auditAssignment(assignment, "denied", reasonCode(error));
          throw error;
        }
        const failedAt = this.now().toISOString();
        await this.store.recordLaunchEvent(
          assignment.id,
          "failed",
          event(assignment.id, "launch_failed", failedAt, { error: this.store.safeError(error) }),
          this.auditAssignmentInput(assignment, "denied", reasonCode(error)),
        );
        return;
      }
      if (assignment.status === "accepted") {
        const startedAt = this.now().toISOString();
        const reserved = await this.store.recordLaunchEvent(
          assignment.id,
          "launching",
          event(assignment.id, "launch_reserved", startedAt),
        );
        if (!reserved.transitioned) return;
        assignment = reserved.assignment;
      }
      this.injectCrash("after_launch_started");
      this.injectCrash("before_adapter_launch");
      let handle: RunHandle | undefined;
      try {
        await this.auditAssignment(assignment, "allowed", "launch_intent", grant.projectId);
        handle = assignment.status === "launching"
          ? validRunHandle(await this.adapter.findByIdempotencyKey(assignment.idempotencyKey))
          : undefined;
        handle ??= await this.adapter.launch({
          idempotencyKey: assignment.idempotencyKey,
          prompt: assignment.prompt,
          workspacePath: assertDataOperand(grant.canonicalPath, "workspace path"),
          environment: childEnvironment(),
          revalidateWorkspace: () => grant.revalidate(),
        });
        handle = validRunHandle(handle);
      } catch (error) {
        if (error instanceof InjectedCrash) throw error;
        let recovered: RunHandle | undefined;
        try {
          recovered = validRunHandle(await this.adapter.findByIdempotencyKey(assignment.idempotencyKey));
        } catch (lookupError) {
          if (!(lookupError instanceof MalformedRunHandleError)) throw lookupError;
          await this.recordLaunchFailure(
            assignment,
            "Provider returned a malformed run handle",
            "INVALID_PROVIDER_RESPONSE",
            grant.projectId,
          );
          return;
        }
        if (recovered !== undefined) {
          const launchedAt = this.now().toISOString();
          await this.store.recordLaunchEvent(
            assignment.id,
            "launched",
            event(assignment.id, "execution_started", launchedAt, { runId: recovered.runId }),
            this.auditAssignmentInput(assignment, "allowed", "launch_started", grant.projectId),
          );
          return;
        }
        if (error instanceof MalformedRunHandleError) {
          await this.recordLaunchFailure(assignment, error.message, "INVALID_PROVIDER_RESPONSE", grant.projectId);
          return;
        }
        await this.recordLaunchFailure(
          assignment,
          this.store.safeError(error),
          hasErrorCode(error, "LAUNCH_REJECTED") ? error.code : reasonCode(error),
          grant.projectId,
        );
        return;
      }
      if (handle === undefined) {
        await this.recordLaunchFailure(
          assignment,
          "Provider returned a malformed run handle",
          "INVALID_PROVIDER_RESPONSE",
          grant.projectId,
        );
        return;
      }
      this.injectCrash("after_adapter_launch");
      const launchedAt = this.now().toISOString();
      await this.store.recordLaunchEvent(
        assignment.id,
        "launched",
        event(assignment.id, "execution_started", launchedAt, { runId: handle.runId }),
        this.auditAssignmentInput(assignment, "allowed", "launch_started", grant.projectId),
      );
      this.injectCrash("after_launch_recorded");
    });
  }

  private audit(
    request: AsynchronousLaunchRequest,
    decision: "allowed" | "denied" | "failed",
    reason: string,
    assignmentId?: string,
    projectId?: string,
  ): Promise<unknown> {
    return this.store.appendSecurityAudit(this.auditInput(request, decision, reason, assignmentId, projectId));
  }

  private auditInput(
    request: AsynchronousLaunchRequest,
    decision: "allowed" | "denied" | "failed",
    reason: string,
    assignmentId?: string,
    projectId?: string,
  ) {
    return {
      requesterId: request.clientId || "invalid-requester", operation: "sessions_launch", decision,
      reasonCode: reason, correlationId: request.idempotencyKey || "invalid-correlation",
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(projectId === undefined ? {} : { projectId }),
      ...(assignmentId === undefined ? {} : { assignmentId }),
    };
  }

  private auditAssignment(
    assignment: Assignment,
    decision: "allowed" | "denied" | "failed",
    reason: string,
    projectId?: string,
  ): Promise<unknown> {
    return this.store.appendSecurityAudit(this.auditAssignmentInput(assignment, decision, reason, projectId));
  }

  private auditAssignmentInput(
    assignment: Assignment,
    decision: "allowed" | "denied" | "failed",
    reason: string,
    projectId?: string,
  ) {
    return {
      requesterId: assignment.sessionId, operation: "sessions_launch", decision,
      reasonCode: reason, correlationId: assignment.idempotencyKey, assignmentId: assignment.id,
      ...(assignment.workspaceId === undefined ? {} : { workspaceId: assignment.workspaceId }),
      ...(projectId === undefined ? {} : { projectId }),
    };
  }

  private async recordLaunchFailure(
    assignment: Assignment,
    error: string,
    reason: string,
    projectId?: string,
  ): Promise<void> {
    await this.store.recordLaunchEvent(
      assignment.id,
      "failed",
      event(assignment.id, "launch_failed", this.now().toISOString(), { error, errorCode: reason }),
      this.auditAssignmentInput(assignment, "failed", reason, projectId),
    );
  }
}

function hasErrorCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

export class InjectedCrash extends Error {}
class MalformedRunHandleError extends Error {}

function stableId(kind: string, key: string): string {
  return `${kind}_${createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 24)}`;
}

function scopedKey(clientId: string, key: string): string {
  return `${clientId}\0${key}`;
}

function fingerprint(request: AsynchronousLaunchRequest): string {
  const canonical = JSON.stringify({
    idempotencyKey: request.idempotencyKey,
    clientId: request.clientId,
    batchName: request.batchName,
    attribution: { agent: request.attribution.agent, task: request.attribution.task },
    prompt: request.prompt,
    workspaceId: request.workspaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function event(
  assignmentId: string,
  type: LaunchAuditEvent["type"],
  occurredAt: string,
  detail: Partial<Pick<LaunchAuditEvent, "runId" | "error" | "errorCode">> = {},
): LaunchAuditEvent {
  return { id: `${assignmentId}:${type}`, assignmentId, type, occurredAt, ...detail };
}

function acceptance(assignment: Assignment): LaunchAcceptance {
  return {
    sessionId: assignment.sessionId,
    batchId: assignment.batchId,
    assignmentId: assignment.id,
    status: assignment.status,
    acceptedAt: assignment.acceptedAt,
  };
}

function validRunHandle(value: unknown): RunHandle | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || typeof (value as { runId?: unknown }).runId !== "string"
    || (value as { runId: string }).runId.length === 0) {
    throw new MalformedRunHandleError("Provider returned a malformed run handle");
  }
  return { runId: (value as { runId: string }).runId };
}

import { createHash } from "node:crypto";
import type { AgentAdapter } from "./agent-adapter.js";
import {
  DurableStore,
  type Assignment,
  type Batch,
  type LaunchAuditEvent,
  type Session,
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
}

export interface LaunchAcceptance {
  sessionId: string;
  batchId: string;
  assignmentId: string;
  status: Assignment["status"];
  acceptedAt: string;
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
    const assignmentId = stableId("assignment", request.idempotencyKey);
    const attemptId = stableId("attempt", request.idempotencyKey);
    const session: Session = {
      id: stableId("session", request.idempotencyKey),
      clientId,
      createdAt: acceptedAt, lastSeenAt: acceptedAt,
    };
    const batch: Batch = {
      id: stableId("batch", request.idempotencyKey), name: batchName, sessionId: session.id,
      createdAt: acceptedAt, updatedAt: acceptedAt,
    };
    const assignment: Assignment = {
      id: assignmentId,
      idempotencyKey: request.idempotencyKey,
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
      attribution: request.attribution,
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
    this.stopped = true;
    if (this.dispatchTimer !== undefined) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = undefined;
    }
    await this.dispatching?.catch(() => undefined);
    if (this.dispatchTimer !== undefined) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = undefined;
    }
  }

  async dispatchPending(): Promise<void> {
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
      this.dispatching = this.dispatchPending();
      void this.dispatching
        .then(
          () => { this.dispatching = undefined; },
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
      const recovering = assignment.status === "launching";
      let grant: WorkspaceGrant;
      try {
        if (assignment.workspaceId === undefined) {
          throw new SecurityError("INVALID_ARGUMENT", "Launch has no workspace identity");
        }
        grant = await this.workspaceAuthorizer.authorize(assignment.workspaceId);
        await grant.revalidate();
        if (grant.canonicalPath !== assignment.workspacePath) {
          throw new SecurityError("INTEGRITY_FAILURE", "Workspace identity changed before launch");
        }
      } catch (error) {
        await this.auditAssignment(assignment, "denied", reasonCode(error));
        if (error instanceof SecurityError && error.retryable) throw error;
        if (assignment.status === "accepted") {
          const reserved = await this.store.recordLaunchEvent(
            assignment.id,
            "launching",
            event(assignment.id, "launch_reserved", this.now().toISOString()),
          );
          if (!reserved.transitioned) return;
        }
        await this.store.recordLaunchEvent(
          assignment.id,
          "failed",
          event(assignment.id, "launch_failed", this.now().toISOString(), { error: this.store.safeError(error) }),
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
      }
      this.injectCrash("after_launch_started");
      this.injectCrash("before_adapter_launch");
      let handle;
      try {
        handle = recovering
          ? await this.adapter.findByIdempotencyKey(assignment.idempotencyKey)
          : undefined;
        if (handle === undefined) await this.auditAssignment(assignment, "allowed", "launch_intent", grant.projectId);
        handle ??= await this.adapter.launch({
          idempotencyKey: assignment.idempotencyKey,
          prompt: assignment.prompt,
          workspacePath: assertDataOperand(grant.canonicalPath, "workspace path"),
          environment: childEnvironment(),
          revalidateWorkspace: () => grant.revalidate(),
        });
      } catch (error) {
        if (error instanceof InjectedCrash) throw error;
        let recovered;
        try {
          recovered = await this.adapter.findByIdempotencyKey(assignment.idempotencyKey);
        } catch (recoveryError) {
          await this.auditAssignment(assignment, "failed", reasonCode(recoveryError), grant.projectId);
          throw recoveryError;
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
        await this.auditAssignment(assignment, "failed", reasonCode(error), grant.projectId);
        const message = this.store.safeError(error);
        const failedAt = this.now().toISOString();
        await this.store.recordLaunchEvent(
          assignment.id,
          "failed",
          event(assignment.id, "launch_failed", failedAt, { error: message }),
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
}

export class InjectedCrash extends Error {}

function stableId(kind: string, key: string): string {
  return `${kind}_${createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 24)}`;
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
  detail: Pick<LaunchAuditEvent, "runId" | "error"> = {},
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

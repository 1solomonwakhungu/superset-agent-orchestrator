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
  workspacePath: string;
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

  constructor(
    private readonly store: DurableStore,
    private readonly adapter: AgentAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly injectCrash: (boundary: LaunchBoundary) => void = () => undefined,
    private readonly retryDelayMs = 1_000,
  ) {}

  async launch(request: AsynchronousLaunchRequest): Promise<LaunchAcceptance> {
    const accepted = await this.accept(request);
    this.scheduleDispatch(0);
    return accepted;
  }

  async accept(request: AsynchronousLaunchRequest): Promise<LaunchAcceptance> {
    for (const [name, value] of Object.entries(request)) {
      if (typeof value === "string" && value.length === 0) throw new Error(`${name} must not be empty`);
    }
    if (request.attribution === undefined
      || request.attribution.agent.length === 0
      || request.attribution.task.length === 0) {
      throw new Error("attribution requires non-empty agent and task values");
    }
    const acceptedAt = this.now().toISOString();
    const assignmentId = stableId("assignment", request.idempotencyKey);
    const attemptId = stableId("attempt", request.idempotencyKey);
    const session: Session = {
      id: stableId("session", request.idempotencyKey), clientId: request.clientId,
      createdAt: acceptedAt, lastSeenAt: acceptedAt,
    };
    const batch: Batch = {
      id: stableId("batch", request.idempotencyKey), name: request.batchName, sessionId: session.id,
      createdAt: acceptedAt, updatedAt: acceptedAt,
    };
    const assignment: Assignment = {
      id: assignmentId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint(request),
      batchId: batch.id,
      sessionId: session.id,
      status: "accepted",
      attribution: request.attribution,
      prompt: request.prompt,
      workspaceId: request.workspaceId,
      workspacePath: request.workspacePath,
      attemptId,
      attempt: 1,
      acceptedAt,
      updatedAt: acceptedAt,
    };
    const accepted = await this.store.acceptLaunch({
      assignment, session, batch,
      event: event(assignmentId, "launch_accepted", acceptedAt),
    });
    this.injectCrash("after_acceptance");
    return acceptance(accepted.assignment);
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching !== undefined) return this.dispatching;
    for (const assignment of await this.store.pendingAssignments()) await this.dispatch(assignment);
  }

  private scheduleDispatch(delayMs: number): void {
    if (this.dispatchTimer !== undefined || this.dispatching !== undefined) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = undefined;
      this.dispatching = this.dispatchPending();
      void this.dispatching
        .then(
          () => { this.dispatching = undefined; },
          () => {
            this.dispatching = undefined;
            this.scheduleDispatch(this.retryDelayMs);
          },
        );
    }, delayMs);
  }

  private async dispatch(assignment: Assignment): Promise<void> {
    const startedAt = this.now().toISOString();
    const reserved = await this.store.recordLaunchEvent(
      assignment.id,
      "launching",
      event(assignment.id, "launch_reserved", startedAt),
    );
    if (reserved.status !== "launching") return;
    this.injectCrash("after_launch_started");
    this.injectCrash("before_adapter_launch");
    let handle;
    try {
      handle = await this.adapter.launch({
        idempotencyKey: assignment.idempotencyKey,
        prompt: assignment.prompt,
        workspacePath: assignment.workspacePath,
      });
    } catch (error) {
      if (error instanceof InjectedCrash) throw error;
      const recovered = await this.adapter.findByIdempotencyKey(assignment.idempotencyKey);
      if (recovered !== undefined) {
        const launchedAt = this.now().toISOString();
        await this.store.recordLaunchEvent(
          assignment.id,
          "launched",
          event(assignment.id, "execution_started", launchedAt, { runId: recovered.runId }),
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
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
    );
    this.injectCrash("after_launch_recorded");
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
    workspacePath: request.workspacePath,
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

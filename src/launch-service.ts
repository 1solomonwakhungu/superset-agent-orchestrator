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
    for (const item of request.assignments) {
      const fullRequest = { ...item, clientId: request.clientId, batchName: request.batchName };
      for (const [name, value] of Object.entries(fullRequest)) {
        if (typeof value === "string" && value.length === 0) throw new Error(`${name} must not be empty`);
      }
      if (item.attribution.agent.length === 0 || item.attribution.task.length === 0) {
        throw new Error("attribution requires non-empty agent and task values");
      }
    }
    const acceptedAt = this.now().toISOString();
    const batchScope = scopedKey(request.clientId, request.idempotencyKey);
    const batchId = stableId("batch", batchScope);
    const sessions = request.assignments.map((item) => ({
      id: stableId("session", scopedKey(request.clientId, item.idempotencyKey)), clientId: request.clientId,
      createdAt: acceptedAt, lastSeenAt: acceptedAt,
    }));
    const batch: Batch = {
      id: batchId, name: request.batchName, sessionId: sessions[0]!.id,
      createdAt: acceptedAt, updatedAt: acceptedAt,
    };
    const assignments = request.assignments.map((item, index): Assignment => {
      const fullRequest: AsynchronousLaunchRequest = {
        ...item, clientId: request.clientId, batchName: request.batchName,
      };
      return {
        id: stableId("assignment", scopedKey(request.clientId, item.idempotencyKey)),
        idempotencyKey: scopedKey(request.clientId, item.idempotencyKey),
        requestFingerprint: fingerprint(fullRequest), batchId, sessionId: sessions[index]!.id,
        status: "accepted", attribution: item.attribution, prompt: item.prompt,
        workspaceId: item.workspaceId, workspacePath: item.workspacePath,
        attemptId: stableId("attempt", scopedKey(request.clientId, item.idempotencyKey)), attempt: 1,
        acceptedAt, updatedAt: acceptedAt,
      };
    });
    const workers = assignments.map((assignment, index) => ({
      id: assignment.sessionId,
      batchId,
      sessionId: assignment.sessionId,
      status: "requested" as const,
      attribution: assignment.attribution,
      startedAt: acceptedAt,
      position: index,
    }));
    const stored = await this.store.acceptLaunchBatch({
      assignments, sessions, batch, workers,
      events: assignments.map(({ id }) => event(id, "launch_accepted", acceptedAt)),
    });
    this.injectCrash("after_acceptance");
    return stored.assignments.map(acceptance);
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
    const key = scopedKey(request.clientId, request.idempotencyKey);
    const assignmentId = stableId("assignment", key);
    const attemptId = stableId("attempt", key);
    const session: Session = {
      id: stableId("session", key), clientId: request.clientId,
      createdAt: acceptedAt, lastSeenAt: acceptedAt,
    };
    const batch: Batch = {
      id: stableId("batch", key), name: request.batchName, sessionId: session.id,
      createdAt: acceptedAt, updatedAt: acceptedAt,
    };
    const assignment: Assignment = {
      id: assignmentId,
      idempotencyKey: key,
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
    });
    this.injectCrash("after_acceptance");
    return acceptance(accepted.assignment);
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
    for (const assignment of await this.store.pendingAssignments()) await this.dispatch(assignment);
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
      let handle = assignment.status === "launching"
        ? await this.adapter.findByIdempotencyKey(assignment.idempotencyKey)
        : undefined;
      try {
        handle ??= await this.adapter.launch({
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
        if (!hasErrorCode(error, "LAUNCH_REJECTED")) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const failedAt = this.now().toISOString();
        await this.store.recordLaunchEvent(
          assignment.id,
          "failed",
          event(assignment.id, "launch_failed", failedAt, { error: message, errorCode: "LAUNCH_REJECTED" }),
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
    });
  }
}

function hasErrorCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

export class InjectedCrash extends Error {}

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
    workspacePath: request.workspacePath,
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

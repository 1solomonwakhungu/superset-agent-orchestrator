import { createHash } from "node:crypto";
import type { AgentAdapter, RunHandle } from "./agent-adapter.js";
import type { DurableStore, LaunchIntent, WorkerAttribution } from "./store.js";
import {
  assertBoundedText,
  assertDataOperand,
  childEnvironment,
  reasonCode,
  redactText,
  safeErrorMessage,
  type WorkspaceAuthorizer,
  type WorkspaceGrant,
} from "./security.js";

export interface AttributedLaunchRequest {
  idempotencyKey: string;
  prompt: string;
  workspaceId: string;
  resume?: { adapter: string; token: string };
  sessionId: string;
  batchId: string;
  workerId: string;
  attribution: WorkerAttribution;
}

export interface LaunchFailpoints {
  afterReservation?(): void;
  afterExternalAcceptance?(handle: RunHandle): void;
}

export class LaunchCoordinator {
  constructor(
    private readonly store: DurableStore,
    private readonly adapter: AgentAdapter,
    private readonly workspaceAuthorizer: WorkspaceAuthorizer,
    private readonly failpoints: LaunchFailpoints = {},
  ) {}

  async launch(request: AttributedLaunchRequest): Promise<LaunchIntent> {
    let grant: WorkspaceGrant;
    let prompt: string;
    try {
      prompt = redactText(assertBoundedText(request.prompt, "prompt"));
      grant = await this.workspaceAuthorizer.authorize(request.workspaceId);
    } catch (error) {
      await this.audit(request, "denied", reasonCode(error));
      throw error;
    }
    const requestHash = LaunchCoordinator.requestHash(request);
    const reservation = await this.store.reserveLaunch({
      idempotencyKey: request.idempotencyKey,
      requestHash,
      sessionId: request.sessionId,
      batchId: request.batchId,
      workerId: request.workerId,
      attribution: request.attribution,
    });
    const intent = reservation.intent;
    if (intent.status === "bound") return intent;
    if (reservation.created) this.failpoints.afterReservation?.();

    const recovered = await this.adapter.findByIdempotencyKey(request.idempotencyKey);
    if (recovered !== undefined) return this.bind(intent, recovered);
    if (!reservation.created && intent.status !== "reserved") {
      throw new Error(`Launch ${request.idempotencyKey} remains ${intent.status}; backend acceptance is unresolved`);
    }

    await this.store.updateLaunch(request.idempotencyKey, "dispatching");
    try {
      await grant.revalidate();
    } catch (error) {
      await this.audit(request, "denied", reasonCode(error), grant.projectId);
      await this.store.updateLaunch(request.idempotencyKey, "reserved", { diagnostic: safeErrorMessage(error) });
      throw error;
    }
    try {
      await this.audit(request, "allowed", "launch_intent", grant.projectId);
    } catch (error) {
      await this.store.updateLaunch(request.idempotencyKey, "reserved", { diagnostic: safeErrorMessage(error) });
      throw error;
    }
    try {
      const handle = await this.adapter.launch({
        idempotencyKey: request.idempotencyKey,
        prompt,
        workspacePath: assertDataOperand(grant.canonicalPath, "workspace path"),
        environment: childEnvironment(),
        revalidateWorkspace: () => grant.revalidate(),
        ...(request.resume === undefined ? {} : { resume: request.resume }),
      });
      this.failpoints.afterExternalAcceptance?.(handle);
      return await this.bind(intent, handle);
    } catch (error) {
      await this.store.updateLaunch(request.idempotencyKey, "unknown_outcome", {
        diagnostic: safeErrorMessage(error),
      });
      throw error;
    }
  }

  async reconcile(): Promise<LaunchIntent[]> {
    const reconciled: LaunchIntent[] = [];
    for (const intent of this.store.launchIntents()) {
      if (intent.status === "bound") continue;
      const handle = await this.adapter.findByIdempotencyKey(intent.idempotencyKey);
      if (handle !== undefined) reconciled.push(await this.bind(intent, handle));
    }
    return reconciled;
  }

  private audit(
    request: AttributedLaunchRequest,
    decision: "allowed" | "denied",
    reason: string,
    projectId?: string,
  ): Promise<unknown> {
    return this.store.appendSecurityAudit({
      requesterId: request.sessionId || "invalid-requester",
      operation: "sessions_launch",
      decision,
      reasonCode: reason,
      correlationId: request.idempotencyKey || "invalid-correlation",
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(projectId === undefined ? {} : { projectId }),
    });
  }

  private bind(intent: LaunchIntent, handle: RunHandle): Promise<LaunchIntent> {
    return this.store.updateLaunch(intent.idempotencyKey, "bound", { runId: handle.runId });
  }

  static requestHash(request: AttributedLaunchRequest): string {
    const canonical = JSON.stringify({
      sessionId: request.sessionId,
      batchId: request.batchId,
      workerId: request.workerId,
      attribution: request.attribution,
      prompt: request.prompt,
      workspaceId: request.workspaceId,
      resume: request.resume ?? null,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }
}

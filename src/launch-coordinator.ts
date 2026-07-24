import { createHash } from "node:crypto";
import type { AgentAdapter, LaunchRequest, RunHandle } from "./agent-adapter.js";
import type { DurableStore, LaunchIntent, WorkerAttribution } from "./store.js";

export interface AttributedLaunchRequest extends LaunchRequest {
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
    private readonly failpoints: LaunchFailpoints = {},
  ) {}

  async launch(request: AttributedLaunchRequest): Promise<LaunchIntent> {
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
      const handle = await this.adapter.launch(request);
      this.failpoints.afterExternalAcceptance?.(handle);
      return await this.bind(intent, handle);
    } catch (error) {
      await this.store.updateLaunch(request.idempotencyKey, "unknown_outcome", {
        diagnostic: error instanceof Error ? error.message : String(error),
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
      workspacePath: request.workspacePath,
      resume: request.resume ?? null,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }
}

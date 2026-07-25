import type {
  AgentAdapter,
  LaunchRequest,
  ResumeMetadata,
  RunHandle,
  RunResult,
  RunState,
} from "./agent-adapter.js";
import type { ConcurrencyScheduler, ConcurrencyScope } from "./concurrency-scheduler.js";

export type ScopeResolver = (request: Readonly<LaunchRequest>) => ConcurrencyScope;

export class ConcurrencyLimitedAgentAdapter implements AgentAdapter {
  private readonly releases = new Map<string, () => void>();

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly scheduler: ConcurrencyScheduler,
    private readonly resolveScope: ScopeResolver,
  ) {}

  findByIdempotencyKey(idempotencyKey: string): Promise<RunHandle | undefined> {
    return this.adapter.findByIdempotencyKey(idempotencyKey);
  }

  async launch(request: LaunchRequest): Promise<RunHandle> {
    const release = await this.scheduler.acquire({
      id: request.idempotencyKey,
      ...this.resolveScope(request),
    });
    try {
      const handle = await this.adapter.launch(request);
      const existing = this.releases.get(handle.runId);
      if (existing !== undefined) {
        release();
      } else {
        this.releases.set(handle.runId, release);
      }
      return handle;
    } catch (error) {
      release();
      throw error;
    }
  }

  async status(handle: RunHandle): Promise<RunState> {
    const state = await this.adapter.status(handle);
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") {
      this.release(handle.runId);
    }
    return state;
  }

  async result(handle: RunHandle): Promise<RunResult | undefined> {
    const result = await this.adapter.result(handle);
    if (result !== undefined) this.release(handle.runId);
    return result;
  }

  async cancel(handle: RunHandle, reason?: string): Promise<void> {
    await this.adapter.cancel(handle, reason);
    this.release(handle.runId);
  }

  resumeMetadata(handle: RunHandle): Promise<ResumeMetadata | undefined> {
    return this.adapter.resumeMetadata(handle);
  }

  private release(runId: string): void {
    this.releases.get(runId)?.();
    this.releases.delete(runId);
  }
}

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
export type RecoveryScopeResolver = (
  idempotencyKey: string,
  handle: Readonly<RunHandle>,
) => ConcurrencyScope | Promise<ConcurrencyScope>;

export class ConcurrencyLimitedAgentAdapter implements AgentAdapter {
  private readonly releases = new Map<string, () => void>();
  private readonly recoveries = new Map<string, Promise<RunHandle | undefined>>();
  private readonly recoveringRuns = new Set<string>();
  private readonly terminalRuns = new Set<string>();

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly scheduler: ConcurrencyScheduler,
    private readonly resolveScope: ScopeResolver,
    private readonly resolveRecoveryScope: RecoveryScopeResolver,
  ) {}

  findByIdempotencyKey(idempotencyKey: string): Promise<RunHandle | undefined> {
    const existing = this.recoveries.get(idempotencyKey);
    if (existing !== undefined) return existing;
    const recovery = this.recover(idempotencyKey);
    this.recoveries.set(idempotencyKey, recovery);
    void recovery.then(
      () => this.recoveries.delete(idempotencyKey),
      () => this.recoveries.delete(idempotencyKey),
    );
    return recovery;
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
      this.markTerminalDuringRecovery(handle.runId);
      this.release(handle.runId);
    }
    return state;
  }

  async result(handle: RunHandle): Promise<RunResult | undefined> {
    const result = await this.adapter.result(handle);
    if (result !== undefined) {
      this.markTerminalDuringRecovery(handle.runId);
      this.release(handle.runId);
    }
    return result;
  }

  async cancel(handle: RunHandle, reason?: string): Promise<void> {
    await this.adapter.cancel(handle, reason);
    this.markTerminalDuringRecovery(handle.runId);
    this.release(handle.runId);
  }

  resumeMetadata(handle: RunHandle): Promise<ResumeMetadata | undefined> {
    return this.adapter.resumeMetadata(handle);
  }

  private async recover(idempotencyKey: string): Promise<RunHandle | undefined> {
    const handle = await this.adapter.findByIdempotencyKey(idempotencyKey);
    if (handle === undefined || this.releases.has(handle.runId)) return handle;
    this.recoveringRuns.add(handle.runId);
    try {
      const state = await this.adapter.status(handle);
      if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") return handle;
      const release = await this.scheduler.acquire({
        id: idempotencyKey,
        ...await this.resolveRecoveryScope(idempotencyKey, handle),
      });
      const current = await this.adapter.status(handle);
      if (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled") {
        this.terminalRuns.add(handle.runId);
      }
      if (this.terminalRuns.has(handle.runId) || this.releases.has(handle.runId)) release();
      else this.releases.set(handle.runId, release);
      return handle;
    } finally {
      this.recoveringRuns.delete(handle.runId);
      this.terminalRuns.delete(handle.runId);
    }
  }

  private markTerminalDuringRecovery(runId: string): void {
    if (this.recoveringRuns.has(runId)) this.terminalRuns.add(runId);
  }

  private release(runId: string): void {
    this.releases.get(runId)?.();
    this.releases.delete(runId);
  }
}

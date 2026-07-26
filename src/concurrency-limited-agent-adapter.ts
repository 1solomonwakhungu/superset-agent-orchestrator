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
) => ConcurrencyScope;

interface HeldPermit {
  idempotencyKey: string;
  release: () => void;
}

export class ConcurrencyLimitedAgentAdapter implements AgentAdapter {
  private readonly releases = new Map<string, HeldPermit>();
  private readonly unresolvedLaunches = new Map<string, () => void>();
  private readonly unresolvedRecoveries = new Map<string, () => void>();
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
      ...this.resolveScope(request),
      id: request.idempotencyKey,
    });
    try {
      const handle = await this.adapter.launch(request);
      const existing = this.releases.get(handle.runId);
      if (existing !== undefined) {
        if (existing.idempotencyKey !== request.idempotencyKey) {
          throw new Error(`Run ${handle.runId} is already bound to another idempotency key`);
        }
        release();
      } else {
        this.releases.set(handle.runId, { idempotencyKey: request.idempotencyKey, release });
      }
      return handle;
    } catch (error) {
      this.unresolvedLaunches.set(request.idempotencyKey, release);
      throw error;
    }
  }

  async status(handle: RunHandle): Promise<RunState> {
    const state = await this.adapter.status(handle);
    if (state.runId !== handle.runId) {
      throw new Error(`Status returned run ${state.runId} for requested run ${handle.runId}`);
    }
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
    const unresolvedRelease = this.unresolvedLaunches.get(idempotencyKey);
    const retainedRecoveryRelease = this.unresolvedRecoveries.get(idempotencyKey);
    const recoveryRelease = unresolvedRelease === undefined && retainedRecoveryRelease === undefined
      ? this.scheduler.acquireExisting({ ...this.resolveRecoveryScope(idempotencyKey), id: idempotencyKey })
      : retainedRecoveryRelease;
    let handle: RunHandle | undefined;
    try {
      handle = await this.adapter.findByIdempotencyKey(idempotencyKey);
    } catch (error) {
      if (recoveryRelease !== undefined) this.unresolvedRecoveries.set(idempotencyKey, recoveryRelease);
      throw error;
    }
    if (handle === undefined) {
      unresolvedRelease?.();
      recoveryRelease?.();
      this.unresolvedLaunches.delete(idempotencyKey);
      this.unresolvedRecoveries.delete(idempotencyKey);
      return undefined;
    }
    if (unresolvedRelease !== undefined) {
      this.unresolvedLaunches.delete(idempotencyKey);
      const existing = this.releases.get(handle.runId);
      if (existing !== undefined) {
        if (existing.idempotencyKey !== idempotencyKey) throw new Error(`Run ${handle.runId} is already bound to another idempotency key`);
        unresolvedRelease();
      } else this.releases.set(handle.runId, { idempotencyKey, release: unresolvedRelease });
      return this.inspectRecoveredRun(handle);
    }
    const existing = this.releases.get(handle.runId);
    if (existing !== undefined) {
      recoveryRelease?.();
      this.unresolvedRecoveries.delete(idempotencyKey);
      if (existing.idempotencyKey !== idempotencyKey) throw new Error(`Run ${handle.runId} is already bound to another idempotency key`);
      return handle;
    }
    this.recoveringRuns.add(handle.runId);
    try {
      if (recoveryRelease === undefined) throw new Error("Recovery permit was not reserved");
      this.unresolvedRecoveries.delete(idempotencyKey);
      if (this.terminalRuns.has(handle.runId)) recoveryRelease();
      else this.releases.set(handle.runId, { idempotencyKey, release: recoveryRelease });
      return await this.inspectRecoveredRun(handle);
    } finally {
      this.recoveringRuns.delete(handle.runId);
      this.terminalRuns.delete(handle.runId);
    }
  }

  private async inspectRecoveredRun(handle: RunHandle): Promise<RunHandle> {
    const state = await this.adapter.status(handle);
    if (state.runId !== handle.runId) {
      throw new Error(`Status returned run ${state.runId} for requested run ${handle.runId}`);
    }
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") {
      this.release(handle.runId);
    }
    return handle;
  }

  private markTerminalDuringRecovery(runId: string): void {
    if (this.recoveringRuns.has(runId)) this.terminalRuns.add(runId);
  }

  private release(runId: string): void {
    this.releases.get(runId)?.release();
    this.releases.delete(runId);
  }
}

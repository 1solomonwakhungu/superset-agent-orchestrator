import type { AgentAdapter } from "./agent-adapter.js";
import { normalize } from "./result-capture.js";
import {
  BatchQueryError,
  DurableStore,
  type CancellationReason,
  type TerminalWorkerStatus,
  type WorkerStatus,
} from "./store.js";

/** Hard ceiling on any single bounded wait, so a client can never park an MCP call indefinitely. */
export const MAX_LIFECYCLE_WAIT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
export const PROVIDER_OPERATION_TIMEOUT_MS = 5_000;
const PROVIDER_UNAVAILABLE_MESSAGE = "The backend lifecycle operation is temporarily unavailable";

export type LifecycleErrorCode =
  | "SESSION_NOT_FOUND"
  | "BATCH_NOT_FOUND"
  | "CANCEL_UNSUPPORTED"
  | "PROVIDER_UNAVAILABLE";

export interface CancellationAccepted {
  sessionId: string;
  status: WorkerStatus;
  stopReason?: string;
  /** True when this call performed the transition rather than observing an existing one. */
  changed: boolean;
}

export interface CancellationRefused {
  sessionId: string;
  error: LifecycleErrorCode;
  message: string;
  /** Status left in the durable store; unchanged for every refusal that is not a provider failure. */
  status?: WorkerStatus;
}

export type CancellationResult = CancellationAccepted | CancellationRefused;

export interface WaitItem {
  batchId: string;
  timedOut: boolean;
  complete: boolean;
  settled: number;
  total: number;
  counts: Record<WorkerStatus, number>;
}

export interface WaitFailure {
  batchId: string;
  error: "BATCH_NOT_FOUND";
  message: string;
}

export type WaitResult = WaitItem | WaitFailure;

export interface ExpiredWorker {
  sessionId: string;
  deadlineAt: string;
  status: TerminalWorkerStatus;
  /** Set when the provider was asked to stop the run before the session was expired. */
  providerStopError?: string;
}

export function isCancellationRefused(result: CancellationResult): result is CancellationRefused {
  return "error" in result;
}

/**
 * Owns cancellation, deadlines, and bounded waiting on top of the durable store.
 *
 * Every state transition goes through the store's serialized single-writer path, so the first
 * terminal outcome appended wins any race and later evidence is retained without regression.
 * The service never invents capability: a backend that does not support cancellation produces
 * CANCEL_UNSUPPORTED and leaves durable state untouched.
 */
export class LifecycleService {
  constructor(
    private readonly store: DurableStore,
    private readonly adapter: AgentAdapter,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly monotonicNow: () => number = performance.now.bind(performance),
    private readonly wallClockNow: () => Date = () => new Date(),
  ) {}

  /**
   * Requests cancellation for one session.
   *
   * Ordering is deliberate: capability is checked before any mutation, intent is persisted before the
   * provider is called, and the provider's own observation decides the terminal outcome. A session that
   * was never bound to an execution is canceled locally because there is nothing to stop.
   */
  async cancelSession(sessionId: string, reason: CancellationReason = "user_requested", detail?: string): Promise<CancellationResult> {
    const current = await this.store.worker(sessionId);
    if (current === undefined) {
      return { sessionId, error: "SESSION_NOT_FOUND", message: `Unknown session ID: ${sessionId}` };
    }
    if (DurableStore.isTerminal(current.status)) {
      return {
        sessionId,
        status: current.status,
        ...(current.stopReason === undefined ? {} : { stopReason: current.stopReason }),
        changed: false,
      };
    }
    if (current.status === "canceling") {
      // Repeated cancellation is idempotent and preserves the first recorded reason.
      return {
        sessionId,
        status: "canceling",
        ...(current.stopReason === undefined ? {} : { stopReason: current.stopReason }),
        changed: false,
      };
    }
    if (this.adapter.cancellation !== "supported") {
      return {
        sessionId,
        error: "CANCEL_UNSUPPORTED",
        message: "The configured backend does not expose supported cancellation",
        status: current.status,
      };
    }
    const intent = await this.store.requestWorkerCancellation(sessionId, reason, {
      ...(detail === undefined ? {} : { detail }),
      at: this.wallClockNow(),
    });
    if (!intent.claimed) {
      // A concurrent caller already owns this cancellation, or the session settled first. Report, do not duplicate.
      return {
        sessionId,
        status: intent.worker.status,
        ...(intent.worker.stopReason === undefined ? {} : { stopReason: intent.worker.stopReason }),
        changed: false,
      };
    }
    if (intent.local) {
      return {
        sessionId,
        status: intent.worker.status,
        ...(intent.worker.stopReason === undefined ? {} : { stopReason: intent.worker.stopReason }),
        changed: true,
      };
    }
    const handle = { runId: intent.worker.runId! };
    try {
      const outcome = await this.providerCall((signal) => this.adapter.cancel(handle, detail ?? reason, signal));
      if (outcome !== undefined && outcome.status === "unsupported") {
        const restored = await this.store.clearWorkerCancellation(sessionId);
        return {
          sessionId,
          error: "CANCEL_UNSUPPORTED",
          message: "The backend rejected cancellation as unsupported",
          status: restored.status,
        };
      }
      return await this.settleFromProvider(sessionId, handle, true);
    } catch (error) {
      // Delivery is unknown, so cancellation intent stays recorded and the session remains canceling.
      return {
        sessionId,
        error: "PROVIDER_UNAVAILABLE",
        message: PROVIDER_UNAVAILABLE_MESSAGE,
        status: "canceling",
      };
    }
  }

  /**
   * Cancels every session in a batch. Sessions are processed serially so the durable single-writer
   * lock is never contended by this service against itself, and the returned order matches batch order.
   */
  async cancelBatch(batchId: string, reason: CancellationReason = "user_requested", detail?: string): Promise<CancellationResult[]> {
    const workers = await this.store.workersInBatch(batchId);
    return Promise.all(workers.map((worker) => this.cancelSession(worker.id, reason, detail)));
  }

  /**
   * Expires every nonterminal session whose deadline has passed, best-effort stopping the underlying run
   * first. A provider failure never blocks expiry: the deadline is an orchestrator-owned fact.
   */
  async enforceDeadlines(now = this.wallClockNow()): Promise<ExpiredWorker[]> {
    const overdue = await this.store.overdueWorkers(now);
    const outcomes = await Promise.all(overdue.map(async (worker): Promise<ExpiredWorker | undefined> => {
      // The deadline is claimed before the provider is touched, so concurrent sweeps expire and report
      // each session exactly once. Stopping the run afterwards is best-effort cleanup.
      const { worker: settled, claimed } = await this.store.expireWorker(worker.id, { at: now });
      if (!claimed || !DurableStore.isTerminal(settled.status)) return undefined;
      let providerStopError: string | undefined;
      if (this.adapter.cancellation === "supported" && settled.runId !== undefined) {
        try {
          await this.providerCall((signal) => this.adapter.cancel({ runId: settled.runId! }, "deadline_exceeded", signal));
          await this.settleFromProvider(worker.id, { runId: settled.runId });
        } catch (error) {
          providerStopError = PROVIDER_UNAVAILABLE_MESSAGE;
        }
      }
      return {
        sessionId: worker.id,
        deadlineAt: settled.deadlineAt!,
        status: settled.status,
        ...(providerStopError === undefined ? {} : { providerStopError }),
      };
    }));
    return outcomes.filter((outcome): outcome is ExpiredWorker => outcome !== undefined);
  }

  /** Advances accepted asynchronous cancellations from the provider's latest durable observation. */
  async reconcileCancellations(): Promise<CancellationResult[]> {
    return Promise.all((await this.store.cancelingWorkers()).map(async (worker): Promise<CancellationResult> => {
      try {
        return await this.settleFromProvider(worker.id, { runId: worker.runId! });
      } catch (error) {
        return {
          sessionId: worker.id,
          error: "PROVIDER_UNAVAILABLE",
          message: PROVIDER_UNAVAILABLE_MESSAGE,
          status: "canceling",
        };
      }
    }));
  }

  /** Retains terminal provider evidence that arrives after an orchestrator deadline won the race. */
  async reconcileTimedOutResults(): Promise<CancellationResult[]> {
    return Promise.all((await this.store.workersPendingLifecycleReconciliation()).map(async (worker): Promise<CancellationResult> => {
      try {
        return await this.settleFromProvider(worker.id, { runId: worker.runId! });
      } catch {
        return {
          sessionId: worker.id,
          error: "PROVIDER_UNAVAILABLE",
          message: PROVIDER_UNAVAILABLE_MESSAGE,
          status: worker.status,
        };
      }
    }));
  }

  /**
   * Waits at most `timeoutMs` for batch progress and always returns counts, so a timeout yields exact
   * partial state instead of an error. `until` selects the satisfaction rule per batch.
   */
  async waitForBatches(
    batchIds: string[],
    options: { timeoutMs?: number; until?: "any_terminal" | "all_terminal"; pollIntervalMs?: number } = {},
  ): Promise<WaitResult[]> {
    const timeoutMs = options.timeoutMs ?? MAX_LIFECYCLE_WAIT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_LIFECYCLE_WAIT_MS) {
      throw new RangeError(`timeoutMs must be an integer between 0 and ${MAX_LIFECYCLE_WAIT_MS}`);
    }
    const until = options.until ?? "all_terminal";
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const started = this.monotonicNow();

    while (true) {
      const items = await Promise.all(batchIds.map(async (batchId): Promise<WaitResult> => {
        try {
          const status = await this.store.batchStatus(batchId, { limit: 1 });
          const { total, settled, complete, counts } = status.summary;
          const satisfied = until === "all_terminal" ? complete : settled > 0;
          return { batchId, timedOut: !satisfied, complete, settled, total, counts };
        } catch (error) {
          if (error instanceof BatchQueryError && error.code === "not_found") {
            return { batchId, error: "BATCH_NOT_FOUND", message: error.message };
          }
          throw error;
        }
      }));

      const allSatisfied = items.every((item) => "error" in item || !item.timedOut);
      const elapsed = this.monotonicNow() - started;
      if (allSatisfied || elapsed >= timeoutMs) return items;
      await this.sleep(Math.max(1, Math.min(pollIntervalMs, timeoutMs - elapsed)));
    }
  }

  /** Reads the provider's own view once and, if it is terminal, records it as the winning outcome. */
  private async settleFromProvider(
    sessionId: string,
    handle: { runId: string },
    intentClaimed = false,
  ): Promise<CancellationResult> {
    const observed = await this.providerCall((signal) => this.adapter.status(handle, signal));
    if (observed.runId !== handle.runId) {
      throw new Error("Provider returned a different execution identity");
    }
    if (observed.status === "queued" || observed.status === "running") {
      const worker = await this.store.worker(sessionId);
      return {
        sessionId,
        status: worker?.status ?? "canceling",
        ...(worker?.stopReason === undefined ? {} : { stopReason: worker.stopReason }),
        changed: intentClaimed,
      };
    }
    const result = await this.providerCall((signal) => this.adapter.result(handle, signal));
    // `cancelled` keeps the reason already persisted with the intent; `succeeded` is classified by the
    // store so a completion that beat cancellation becomes succeeded_before_cancellation.
    const stopReason = observed.status === "failed" ? "execution_error" : undefined;
    const claim = result === undefined
      ? normalize({ kind: "stopped_without_result", status: observed.status })
      : result.status === observed.status
        ? normalize({ kind: "adapter_result", result })
        : normalize({
          kind: "malformed",
          error: `Adapter result status ${JSON.stringify(result.status)} did not match observed status ${JSON.stringify(observed.status)}`,
        });
    const terminal = terminalStatusFor(observed.status);
    const options = {
      result: claim,
      ...(stopReason === undefined ? {} : { stopReason }),
      at: this.wallClockNow(),
    };
    const { worker: settled, claimed } = await this.store.settleWorkerCancellation(sessionId, terminal, options);
    return {
      sessionId,
      status: settled.status,
      ...(settled.stopReason === undefined ? {} : { stopReason: settled.stopReason }),
      changed: claimed,
    };
  }


  private async providerCall<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_OPERATION_TIMEOUT_MS);
    timeout.unref();
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => {
          reject(new Error("Provider lifecycle operation timed out"));
        }, { once: true })),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function terminalStatusFor(status: "succeeded" | "failed" | "cancelled"): TerminalWorkerStatus {
  return status === "cancelled" ? "canceled" : status;
}

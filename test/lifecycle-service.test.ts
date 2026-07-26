import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter, RunHandle } from "../src/agent-adapter.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LifecycleService, isCancellationRefused, type CancellationResult } from "../src/lifecycle-service.js";
import { DurableStore, type AgentResultClaim } from "../src/store.js";

async function harness(run: (store: DurableStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-lifecycle-"));
  try {
    await run(new DurableStore(join(directory, "state.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const stub = (overrides: Partial<AgentAdapter>): AgentAdapter => ({
  findByIdempotencyKey: async () => undefined,
  launch: async () => { throw new Error("not launched in this test"); },
  status: async () => { throw new Error("not observed in this test"); },
  result: async () => undefined,
  cancel: async () => undefined,
  resumeMetadata: async () => undefined,
  ...overrides,
});

const accepted = (result: CancellationResult) => {
  assert.equal(isCancellationRefused(result), false, `expected acceptance, got ${JSON.stringify(result)}`);
  return result as Extract<CancellationResult, { status: string }>;
};
const refused = (result: CancellationResult) => {
  assert.equal(isCancellationRefused(result), true, `expected refusal, got ${JSON.stringify(result)}`);
  return result as Extract<CancellationResult, { error: string }>;
};

async function launchedRun(adapter: FakeAgentAdapter, key: string): Promise<RunHandle> {
  return adapter.launch({ idempotencyKey: key, prompt: "work", workspacePath: "/tmp/workspace" });
}

test("unsupported cancellation is refused honestly and leaves durable state untouched", async () => harness(async (store) => {
  const created = await store.createBatch("unsupported", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  const service = new LifecycleService(store, stub({ cancellation: "unsupported" }));

  const outcome = refused(await service.cancelSession(id));
  assert.equal(outcome.error, "CANCEL_UNSUPPORTED");
  assert.equal(outcome.message, "The configured backend does not expose supported cancellation");
  assert.equal(outcome.status, "requested");

  const worker = await store.worker(id);
  assert.equal(worker!.status, "requested");
  assert.equal(worker!.stopReason, undefined);
  assert.equal(worker!.cancelRequestedAt, undefined);
}));

test("a backend that rejects a cancel it advertised is rolled back to its prior state", async () => harness(async (store) => {
  const created = await store.createBatch("dishonest", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "unsupported" as const }),
  }));

  const outcome = refused(await service.cancelSession(id));
  assert.equal(outcome.error, "CANCEL_UNSUPPORTED");
  assert.equal(outcome.message, "The backend rejected cancellation as unsupported");
  assert.equal(outcome.status, "requested");

  const worker = await store.worker(id);
  assert.equal(worker!.status, "requested");
  assert.equal(worker!.cancelRequestedAt, undefined);
  assert.equal(worker!.stopReason, undefined);
}));

test("a session that was never dispatched is canceled locally without a provider call", async () => harness(async (store) => {
  const created = await store.createBatch("undispatched", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  const adapter = new FakeAgentAdapter([]);
  const service = new LifecycleService(store, adapter);

  const outcome = accepted(await service.cancelSession(id, "superseded"));
  assert.equal(outcome.status, "canceled");
  assert.equal(outcome.stopReason, "superseded");
  assert.equal(adapter.cancellations.length, 0);
  assert.equal((await store.worker(id))!.completedAt !== undefined, true);
}));

test("cancellation uses a run bound after its initial read instead of canceling locally", async () => harness(async (store) => {
  const created = await store.createBatch("bind-race", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  const cancellations: RunHandle[] = [];
  const readWorker = store.worker.bind(store);
  let firstRead = true;
  store.worker = async (workerId) => {
    const worker = await readWorker(workerId);
    if (firstRead) {
      firstRead = false;
      await store.bindWorkerRun(id, "run-bound-during-cancel");
    }
    return worker;
  };
  const adapter = stub({
    cancellation: "supported",
    cancel: async (handle) => { cancellations.push(handle); return { status: "accepted" as const }; },
    status: async (handle) => ({ ...handle, status: "cancelled" as const, updatedAt: "2026-07-25T00:00:00.000Z" }),
    result: async () => ({ status: "cancelled" as const }),
  });

  const outcome = accepted(await new LifecycleService(store, adapter).cancelSession(id));
  assert.equal(outcome.status, "canceled");
  assert.deepEqual(cancellations, [{ runId: "run-bound-during-cancel" }]);
}));

test("a confirmed cancel keeps the partial output the run produced", async () => harness(async (store) => {
  const adapter = new FakeAgentAdapter([{ statuses: ["running", "succeeded"], result: { status: "succeeded", output: "never reached" } }]);
  const handle = await launchedRun(adapter, "partial");
  const created = await store.createBatch("partial", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, handle.runId);
  const service = new LifecycleService(store, adapter);

  const outcome = accepted(await service.cancelSession(id));
  assert.equal(outcome.status, "canceled");
  assert.equal(outcome.stopReason, "user_requested");

  const claim = (await store.worker(id))!.result as AgentResultClaim;
  assert.equal(claim.status, "cancelled");
  assert.equal(claim.completeness, "missing");
  assert.deepEqual(adapter.cancellations, [{ runId: handle.runId, reason: "user_requested" }]);
}));

test("completion that beat the cancel wins the race as succeeded_before_cancellation", async () => harness(async (store) => {
  const adapter = new FakeAgentAdapter([{ statuses: ["running", "succeeded"], result: { status: "succeeded", output: "finished first" } }]);
  const handle = await launchedRun(adapter, "race");
  // Drive the scripted run to its terminal state before cancellation is requested.
  assert.equal((await adapter.status(handle)).status, "running");
  assert.equal((await adapter.status(handle)).status, "succeeded");

  const created = await store.createBatch("race", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, handle.runId);
  const service = new LifecycleService(store, adapter);

  const outcome = accepted(await service.cancelSession(id));
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.stopReason, "succeeded_before_cancellation");
  assert.equal(outcome.changed, true);
  assert.equal(adapter.cancellations.length, 0, "an already-settled run is never reported as canceled");

  const claim = (await store.worker(id))!.result as AgentResultClaim;
  assert.equal(claim.completeness, "complete");
  assert.equal(claim.output, "finished first");
}));

test("cancelling an already terminal session is a no-op observation", async () => harness(async (store) => {
  const created = await store.createBatch("terminal", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.recordWorkerTerminal(id, "succeeded", { result: { output: "already done" } });
  const adapter = new FakeAgentAdapter([]);

  const outcome = accepted(await new LifecycleService(store, adapter).cancelSession(id));
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.stopReason, "succeeded");
  assert.equal(outcome.changed, false);
  assert.equal(adapter.cancellations.length, 0);
}));

test("repeated cancellation is idempotent and preserves the first reason", async () => harness(async (store) => {
  const created = await store.createBatch("idempotent", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  let cancelCalls = 0;
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => { cancelCalls += 1; return { status: "accepted" as const }; },
    status: async (handle) => ({ ...handle, status: "running" as const, updatedAt: "2026-07-25T00:00:00.000Z" }),
  }));

  assert.equal(accepted(await service.cancelSession(id, "policy_revoked")).status, "canceling");
  const second = accepted(await service.cancelSession(id, "user_requested"));
  assert.equal(second.status, "canceling");
  assert.equal(second.stopReason, "policy_revoked");
  assert.equal(second.changed, false);
  assert.equal(cancelCalls, 1);
}));

test("an accepted asynchronous cancellation is reconciled to its provider outcome", async () => harness(async (store) => {
  const created = await store.createBatch("async-cancel", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  let statusCalls = 0;
  await store.bindWorkerRun(id, "run-1");
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async (handle) => ({
      ...handle,
      status: statusCalls++ === 0 ? "running" as const : "cancelled" as const,
      updatedAt: "2026-07-25T00:00:00.000Z",
    }),
    result: async () => ({ status: "cancelled" as const, output: "partial" }),
  }));

  assert.equal(accepted(await service.cancelSession(id, "policy_revoked")).status, "canceling");
  const [outcome] = await service.reconcileCancellations();
  assert.equal(accepted(outcome!).status, "canceled");
  assert.equal(accepted(outcome!).stopReason, "policy_revoked");
  assert.equal((await store.worker(id))!.status, "canceled");
  assert.deepEqual((await store.worker(id))!.lateObservations, undefined);
}));

test("cancellation reconciliation isolates provider failures and retries later", async () => harness(async (store) => {
  const created = await store.createBatch("async-retry", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  let statusCalls = 0;
  await store.bindWorkerRun(id, "run-1");
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => { throw new Error("provider unavailable"); },
    status: async (handle) => {
      if (statusCalls++ === 0) throw new Error("still unavailable");
      return { ...handle, status: "failed" as const, updatedAt: "2026-07-25T00:00:00.000Z" };
    },
    result: async () => ({ status: "failed" as const, error: "stopped late", retryable: false }),
  }));

  assert.equal(refused(await service.cancelSession(id)).status, "canceling");
  assert.equal(refused((await service.reconcileCancellations())[0]!).error, "PROVIDER_UNAVAILABLE");
  assert.equal((await store.worker(id))!.status, "canceling");
  assert.equal(accepted((await service.reconcileCancellations())[0]!).status, "failed");
}));

test("concurrent cancellation reconciliation records one terminal transition", async () => harness(async (store) => {
  const created = await store.createBatch("async-race", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.requestWorkerCancellation(id);
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    status: async (handle) => ({ ...handle, status: "cancelled" as const, updatedAt: "2026-07-25T00:00:00.000Z" }),
    result: async () => ({ status: "cancelled" as const }),
  }));

  const outcomes = (await Promise.all([service.reconcileCancellations(), service.reconcileCancellations()])).flat();
  assert.equal(outcomes.filter((outcome) => accepted(outcome).changed).length, 1);
  assert.equal((await store.worker(id))!.lateObservations, undefined);
}));

test("concurrent cancels of one session issue exactly one provider stop", async () => harness(async (store) => {
  const created = await store.createBatch("concurrent", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  const adapter = new FakeAgentAdapter([{ statuses: ["running", "succeeded"], result: { status: "succeeded", output: "x" } }]);
  const handle = await launchedRun(adapter, "concurrent-run");
  await store.bindWorkerRun(id, handle.runId);
  const service = new LifecycleService(store, adapter);

  const outcomes = await Promise.all(Array.from({ length: 8 }, () => service.cancelSession(id)));
  assert.equal(outcomes.every((outcome) => !isCancellationRefused(outcome)), true);
  assert.equal(adapter.cancellations.length, 1, "only the caller that claimed the intent stops the run");
  assert.equal(outcomes.filter((outcome) => accepted(outcome).changed).length, 1);

  const worker = await store.worker(id);
  assert.equal(worker!.status, "canceled");
  assert.equal(worker!.stopReason, "user_requested");
  assert.equal(worker!.lateObservations, undefined);
}));

test("a terminal outcome racing a cancel produces exactly one winner", async () => harness(async (store) => {
  const created = await store.createBatch("terminal-race", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    // The run completes underneath us while the stop command is in flight.
    cancel: async () => {
      await store.recordWorkerTerminal(id, "succeeded", { result: { output: "won the race" } });
      return { status: "accepted" as const };
    },
    status: async (handle) => ({ ...handle, status: "cancelled" as const, updatedAt: "2026-07-25T00:00:00.000Z" }),
    result: async () => ({ status: "cancelled" as const, reason: "user_requested" }),
  }));

  const outcome = accepted(await service.cancelSession(id));
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.stopReason, "succeeded_before_cancellation");

  const worker = await store.worker(id);
  assert.equal(worker!.status, "succeeded");
  assert.deepEqual(worker!.result, { output: "won the race" });
  assert.deepEqual(worker!.lateObservations?.map(({ status, retainedResult }) => ({ status, retainedResult })), [
    { status: "canceled", retainedResult: false },
  ]);
}));

test("concurrent deadline sweeps expire each session exactly once", async () => harness(async (store) => {
  const created = await store.createBatch("deadline-race", "client", [
    { agent: "a", task: "one" },
    { agent: "b", task: "two" },
  ]);
  const deadline = new Date("2026-07-25T01:00:00.000Z");
  for (const { id } of created.sessions) await store.setWorkerDeadline(id, deadline);
  const service = new LifecycleService(store, new FakeAgentAdapter([]));

  const sweeps = await Promise.all(Array.from({ length: 4 },
    () => service.enforceDeadlines(new Date("2026-07-25T01:00:01.000Z"))));
  const expired = sweeps.flat().map(({ sessionId }) => sessionId);
  assert.equal(expired.length, 2, `expected two expirations, got ${JSON.stringify(expired)}`);
  assert.deepEqual([...new Set(expired)].sort(), created.sessions.map(({ id }) => id).sort());
}));

test("an unreachable provider reports PROVIDER_UNAVAILABLE and retains cancellation intent", async () => harness(async (store) => {
  const created = await store.createBatch("provider", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => { throw new Error("socket hang up"); },
  }));

  const outcome = refused(await service.cancelSession(id));
  assert.equal(outcome.error, "PROVIDER_UNAVAILABLE");
  assert.equal(outcome.message, "The backend lifecycle operation is temporarily unavailable");
  assert.equal(outcome.status, "canceling");
  assert.equal((await store.worker(id))!.status, "canceling");
}));

test("cancelling an unknown session is reported without inventing state", async () => harness(async (store) => {
  const outcome = refused(await new LifecycleService(store, new FakeAgentAdapter([])).cancelSession("missing"));
  assert.equal(outcome.error, "SESSION_NOT_FOUND");
  assert.equal(outcome.status, undefined);
}));

test("batch cancellation returns one exact outcome per session in batch order", async () => harness(async (store) => {
  const created = await store.createBatch("batch", "client", [
    { agent: "a", task: "one" },
    { agent: "b", task: "two" },
    { agent: "c", task: "three" },
  ]);
  const [first, second, third] = created.sessions.map(({ id }) => id) as [string, string, string];
  await store.recordWorkerTerminal(first, "succeeded", { result: { output: "done" } });
  const adapter = new FakeAgentAdapter([{ statuses: ["running", "succeeded"], result: { status: "succeeded", output: "x" } }]);
  const handle = await launchedRun(adapter, "batch-run");
  await store.bindWorkerRun(second, handle.runId);
  const service = new LifecycleService(store, adapter);

  const outcomes = await service.cancelBatch(created.batch.id, "orchestrator_shutdown");
  assert.deepEqual(outcomes.map((outcome) => (outcome as { sessionId: string }).sessionId), [first, second, third]);
  assert.equal(accepted(outcomes[0]!).status, "succeeded");
  assert.equal(accepted(outcomes[1]!).status, "canceled");
  assert.equal(accepted(outcomes[2]!).status, "canceled");
  assert.equal(accepted(outcomes[2]!).stopReason, "orchestrator_shutdown");

  const status = await store.batchStatus(created.batch.id);
  assert.equal(status.summary.complete, true);
  assert.equal(status.summary.counts.canceled, 2);
}));

test("cancelling an unknown batch surfaces BATCH_NOT_FOUND", async () => harness(async (store) => {
  await assert.rejects(
    new LifecycleService(store, new FakeAgentAdapter([])).cancelBatch("missing"),
    /Unknown batch ID: missing/,
  );
}));

test("an expired deadline is a failed/deadline_exceeded outcome that stops the run", async () => harness(async (store) => {
  const created = await store.createBatch("deadline", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  const adapter = new FakeAgentAdapter([{ statuses: ["running", "succeeded"], result: { status: "succeeded", output: "x" } }]);
  const handle = await launchedRun(adapter, "deadline-run");
  await store.bindWorkerRun(id, handle.runId);
  await store.setWorkerDeadline(id, new Date("2026-07-25T01:00:00.000Z"));
  const service = new LifecycleService(store, adapter);

  assert.deepEqual(await service.enforceDeadlines(new Date("2026-07-25T00:59:59.999Z")), []);
  const expired = await service.enforceDeadlines(new Date("2026-07-25T01:00:00.000Z"));
  assert.deepEqual(expired, [{ sessionId: id, deadlineAt: "2026-07-25T01:00:00.000Z", status: "failed" }]);
  assert.deepEqual(adapter.cancellations, [{ runId: handle.runId, reason: "deadline_exceeded" }]);

  const worker = await store.worker(id);
  assert.equal(worker!.status, "failed");
  assert.equal(worker!.stopReason, "deadline_exceeded");
}));

test("deadline claim rechecks a concurrently extended deadline", async () => harness(async (store) => {
  const created = await store.createBatch("deadline-extended", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  const now = new Date("2026-07-25T01:00:01.000Z");
  await store.setWorkerDeadline(id, new Date("2026-07-25T01:00:00.000Z"));
  assert.equal((await store.overdueWorkers(now)).length, 1);
  await store.setWorkerDeadline(id, new Date("2026-07-25T02:00:00.000Z"));

  const { worker, claimed } = await store.expireWorker(id, { at: now });
  assert.equal(claimed, false);
  assert.equal(worker.status, "requested");
  assert.equal(worker.deadlineAt, "2026-07-25T02:00:00.000Z");
}));

test("deadline enforcement is idempotent and never expires a terminal session", async () => harness(async (store) => {
  const created = await store.createBatch("deadline-terminal", "client", [
    { agent: "a", task: "one" },
    { agent: "b", task: "two" },
  ]);
  const [first, second] = created.sessions.map(({ id }) => id) as [string, string];
  const deadline = new Date("2026-07-25T01:00:00.000Z");
  await store.setWorkerDeadline(first, deadline);
  await store.setWorkerDeadline(second, deadline);
  await store.recordWorkerTerminal(first, "succeeded", { result: { output: "beat the clock" } });
  const service = new LifecycleService(store, new FakeAgentAdapter([]));

  const expired = await service.enforceDeadlines(new Date("2026-07-25T02:00:00.000Z"));
  assert.deepEqual(expired.map(({ sessionId }) => sessionId), [second]);
  assert.deepEqual(await service.enforceDeadlines(new Date("2026-07-25T03:00:00.000Z")), []);
  assert.equal((await store.worker(first))!.status, "succeeded");
}));

test("a deadline still expires the session when the provider stop fails", async () => harness(async (store) => {
  const created = await store.createBatch("deadline-provider", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-25T01:00:00.000Z"));
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => { throw new Error("provider offline"); },
  }));

  const expired = await service.enforceDeadlines(new Date("2026-07-25T01:00:01.000Z"));
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.status, "failed");
  assert.equal(expired[0]!.providerStopError, "The backend lifecycle operation is temporarily unavailable");
  assert.equal((await store.worker(id))!.stopReason, "deadline_exceeded");
}));

test("a result arriving after a terminal transition is retained without regressing state", async () => harness(async (store) => {
  const created = await store.createBatch("late", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.setWorkerDeadline(id, new Date("2026-07-25T01:00:00.000Z"));
  await store.expireWorker(id, { at: new Date("2026-07-25T01:00:01.000Z") });

  await store.recordWorkerTerminal(id, "succeeded", {
    result: { output: "arrived later" },
    at: new Date("2026-07-25T01:00:05.000Z"),
  });

  const worker = await store.worker(id);
  assert.equal(worker!.status, "failed");
  assert.equal(worker!.stopReason, "deadline_exceeded");
  assert.equal(worker!.completedAt, "2026-07-25T01:00:01.000Z");
  assert.deepEqual(worker!.result, { output: "arrived later" });
  assert.deepEqual(worker!.lateObservations, [
    { observedAt: "2026-07-25T01:00:05.000Z", status: "succeeded", retainedResult: true },
  ]);
}));

test("deadline reconciliation retains a later provider result without regressing timeout", async () => harness(async (store) => {
  const created = await store.createBatch("late-provider", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-25T01:00:00.000Z"));
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async (handle) => ({ ...handle, status: "succeeded" as const, updatedAt: "2026-07-25T01:00:02.000Z" }),
    result: async () => ({ status: "succeeded" as const, output: "arrived after timeout" }),
  }));

  await service.enforceDeadlines(new Date("2026-07-25T01:00:01.000Z"));
  await service.reconcileTimedOutResults();

  const worker = await store.worker(id);
  assert.equal(worker!.status, "failed");
  assert.equal(worker!.stopReason, "deadline_exceeded");
  assert.equal((worker!.result as AgentResultClaim).output, "arrived after timeout");
  assert.equal(worker!.lateObservations?.length, 1);
  assert.equal(worker!.lateObservations[0]!.status, "succeeded");
  assert.equal(worker!.lateObservations[0]!.retainedResult, true);
  assert.equal(worker!.lifecycleReconcilePending, undefined);
}));

test("provider execution identity mismatch cannot settle a session", async () => harness(async (store) => {
  const created = await store.createBatch("identity", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async () => ({ runId: "foreign-run", status: "cancelled" as const, updatedAt: "2026-07-25T00:00:00.000Z" }),
  }));

  const outcome = refused(await service.cancelSession(id));
  assert.equal(outcome.error, "PROVIDER_PROTOCOL_ERROR");
  assert.equal((await store.worker(id))!.status, "canceling");
}));

test("a provider call that never settles is aborted within the configured bound", async () => harness(async (store) => {
  const created = await store.createBatch("provider-timeout", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  let aborted = false;
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async (_handle, _reason, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    }),
  }), undefined, undefined, undefined, 5);

  const outcome = refused(await service.cancelSession(id));
  assert.equal(outcome.error, "PROVIDER_UNAVAILABLE");
  assert.equal(outcome.status, "canceling");
  assert.equal(aborted, true);
}));

test("a late observation never overwrites the result the winning outcome already captured", async () => harness(async (store) => {
  const created = await store.createBatch("late-overwrite", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.recordWorkerTerminal(id, "canceled", { result: { output: "partial" }, at: new Date("2026-07-25T01:00:00.000Z") });
  await store.recordWorkerTerminal(id, "succeeded", { result: { output: "later" }, at: new Date("2026-07-25T01:00:09.000Z") });

  const worker = await store.worker(id);
  assert.equal(worker!.status, "canceled");
  assert.deepEqual(worker!.result, { output: "partial" });
  assert.deepEqual(worker!.lateObservations, [
    { observedAt: "2026-07-25T01:00:09.000Z", status: "succeeded", retainedResult: false },
  ]);
}));

test("a zero timeout returns exact partial counts instead of blocking", async () => harness(async (store) => {
  const created = await store.createBatch("wait", "client", [{ agent: "a", task: "one" }, { agent: "b", task: "two" }]);
  let now = 0;
  const service = new LifecycleService(store, new FakeAgentAdapter([]), async (ms) => { now += ms; }, () => now);

  const [item] = await service.waitForBatches([created.batch.id], { timeoutMs: 0 });
  assert.deepEqual(item, {
    batchId: created.batch.id,
    timedOut: true,
    complete: false,
    settled: 0,
    total: 2,
    counts: { requested: 2, running: 0, canceling: 0, succeeded: 0, failed: 0, canceled: 0, unknown_outcome: 0 },
  });
}));

test("a bounded wait exhausts its budget exactly once and reports the timeout", async () => harness(async (store) => {
  const created = await store.createBatch("wait-budget", "client", [{ agent: "a", task: "one" }]);
  let now = 0;
  let slept = 0;
  const service = new LifecycleService(store, new FakeAgentAdapter([]), async (ms) => { slept += ms; now += ms; }, () => now);

  const [item] = await service.waitForBatches([created.batch.id], { timeoutMs: 100, pollIntervalMs: 30 });
  assert.equal((item as { timedOut: boolean }).timedOut, true);
  assert.equal(slept, 100, "the wait sleeps its full budget and no longer");
  assert.equal(now >= 100, true);
}));

test("any_terminal returns as soon as one session settles", async () => harness(async (store) => {
  const created = await store.createBatch("wait-any", "client", [{ agent: "a", task: "one" }, { agent: "b", task: "two" }]);
  await store.recordWorkerTerminal(created.sessions[0]!.id, "succeeded", { result: { output: "done" } });
  let now = 0;
  const service = new LifecycleService(store, new FakeAgentAdapter([]), async (ms) => { now += ms; }, () => now);

  const [item] = await service.waitForBatches([created.batch.id], { timeoutMs: 30_000, until: "any_terminal" });
  assert.equal((item as { timedOut: boolean }).timedOut, false);
  assert.equal((item as { settled: number }).settled, 1);
  assert.equal((item as { complete: boolean }).complete, false);
  assert.equal(now, 0, "a satisfied wait never sleeps");
}));

test("all_terminal waits until every session settles and reports completion", async () => harness(async (store) => {
  const created = await store.createBatch("wait-all", "client", [{ agent: "a", task: "one" }, { agent: "b", task: "two" }]);
  const [first, second] = created.sessions.map(({ id }) => id) as [string, string];
  await store.recordWorkerTerminal(first, "succeeded", { result: { output: "done" } });
  let now = 0;
  const service = new LifecycleService(store, new FakeAgentAdapter([]), async (ms) => { now += ms; }, () => now);

  const [pending] = await service.waitForBatches([created.batch.id], { timeoutMs: 60, pollIntervalMs: 20 });
  assert.equal((pending as { timedOut: boolean }).timedOut, true);

  await store.recordWorkerTerminal(second, "canceled", { stopReason: "user_requested" });
  const [settled] = await service.waitForBatches([created.batch.id], { timeoutMs: 60, pollIntervalMs: 20 });
  assert.equal((settled as { timedOut: boolean }).timedOut, false);
  assert.equal((settled as { complete: boolean }).complete, true);
}));

test("a wait mixing known and unknown batches reports both without failing", async () => harness(async (store) => {
  const created = await store.createBatch("wait-mixed", "client", [{ agent: "a", task: "one" }]);
  await store.recordWorkerTerminal(created.sessions[0]!.id, "succeeded", { result: { output: "done" } });
  let now = 0;
  const service = new LifecycleService(store, new FakeAgentAdapter([]), async (ms) => { now += ms; }, () => now);

  const items = await service.waitForBatches([created.batch.id, "missing"], { timeoutMs: 100 });
  assert.equal((items[0] as { complete: boolean }).complete, true);
  assert.deepEqual(items[1], { batchId: "missing", error: "BATCH_NOT_FOUND", message: "Unknown batch ID: missing" });
}));

test("a wait containing only unknown batches returns without sleeping", async () => harness(async (store) => {
  const service = new LifecycleService(store, new FakeAgentAdapter([]), async () => {
    assert.fail("an all-error result is already resolved");
  });

  assert.deepEqual(await service.waitForBatches(["missing-a", "missing-b"]), [
    { batchId: "missing-a", error: "BATCH_NOT_FOUND", message: "Unknown batch ID: missing-a" },
    { batchId: "missing-b", error: "BATCH_NOT_FOUND", message: "Unknown batch ID: missing-b" },
  ]);
}));

test("wait rejects durations outside the hard cap", async () => harness(async (store) => {
  const service = new LifecycleService(store, new FakeAgentAdapter([]));
  await assert.rejects(service.waitForBatches(["batch"], { timeoutMs: 30_001 }), /between 0 and 30000/);
  await assert.rejects(service.waitForBatches(["batch"], { timeoutMs: -1 }), /between 0 and 30000/);
  await assert.rejects(service.waitForBatches(["batch"], { timeoutMs: 1.5 }), /between 0 and 30000/);
}));

test("a session is never attributed to two executions", async () => harness(async (store) => {
  const created = await store.createBatch("binding", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.bindWorkerRun(id, "run-1");
  await assert.rejects(store.bindWorkerRun(id, "run-2"), /already bound to another run/);
  assert.equal((await store.worker(id))!.runId, "run-1");
}));

test("a locally canceled session cannot later be bound to an execution", async () => harness(async (store) => {
  const created = await store.createBatch("binding-cancel", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  const service = new LifecycleService(store, new FakeAgentAdapter([]));

  assert.equal(accepted(await service.cancelSession(id)).status, "canceled");
  await assert.rejects(store.bindWorkerRun(id, "late-run"), /Cannot bind a terminal worker/);
  assert.equal((await store.worker(id))!.runId, undefined);
}));

test("cancellation requires a stop reason the state machine allows", async () => harness(async (store) => {
  const created = await store.createBatch("reason", "client", [{ agent: "codex", task: "work" }]);
  await assert.rejects(
    store.requestWorkerCancellation(created.sessions[0]!.id, "deadline_exceeded" as never),
    /Unsupported cancellation reason/,
  );
}));

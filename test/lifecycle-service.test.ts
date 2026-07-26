import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter, RunHandle } from "../src/agent-adapter.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LifecycleService, isCancellationRefused, type CancellationResult } from "../src/lifecycle-service.js";
import { DurableStore, type AgentResultClaim } from "../src/store.js";

async function harness(run: (store: DurableStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-lifecycle-"));
  const path = join(directory, "state.json");
  try {
    await run(new DurableStore(path), path);
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
  return adapter.launch({
    idempotencyKey: key,
    prompt: "work",
    workspacePath: "/tmp/workspace",
    environment: {},
    revalidateWorkspace: async () => undefined,
  });
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
  assert.ok(((await store.worker(id))!.lateObservations?.length ?? 0) <= 1);
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

test("restart reconciliation retains a later provider result without regressing timeout", async () => harness(async (store, path) => {
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
  const restarted = new DurableStore(path);
  await new LifecycleService(restarted, stub({
    cancellation: "supported",
    status: async (handle) => ({ ...handle, status: "succeeded" as const, updatedAt: "2026-07-25T01:00:02.000Z" }),
    result: async () => ({ status: "succeeded" as const, output: "arrived after timeout" }),
  })).reconcileTimedOutResults();

  const worker = await restarted.worker(id);
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

test("malformed cancel and status payloads retain durable cancellation intent", async () => harness(async (store) => {
  const created = await store.createBatch("malformed-protocol", "client", [
    { agent: "codex", task: "cancel" },
    { agent: "codex", task: "status" },
  ]);
  const [cancelId, statusId] = created.sessions.map(({ id }) => id) as [string, string];
  await store.bindWorkerRun(cancelId, "run-cancel");
  await store.bindWorkerRun(statusId, "run-status");

  const malformedCancel = stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted", extra: true }) as never,
  });
  const cancelOutcome = refused(await new LifecycleService(store, malformedCancel).cancelSession(cancelId));
  assert.equal(cancelOutcome.error, "PROVIDER_PROTOCOL_ERROR");
  assert.equal((await store.worker(cancelId))!.status, "canceling");
  assert.equal((await store.worker(cancelId))!.cancellationDeliveryPending, true);

  const malformedStatus = stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" }),
    status: async () => ({ runId: "run-status", status: "running", updatedAt: "invalid" }) as never,
  });
  const statusOutcome = refused(await new LifecycleService(store, malformedStatus).cancelSession(statusId));
  assert.equal(statusOutcome.error, "PROVIDER_PROTOCOL_ERROR");
  assert.equal((await store.worker(statusId))!.status, "canceling");
  assert.equal((await store.worker(statusId))!.cancellationDeliveryPending, undefined);
}));

test("a valid terminal status preserves malformed result evidence without inventing output", async () => harness(async (store) => {
  const created = await store.createBatch("malformed-result", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" }),
    status: async (handle) => ({ ...handle, status: "cancelled", updatedAt: "2026-07-25T00:00:00.000Z" }),
    result: async () => ({ status: "cancelled", output: 42 }) as never,
  }));

  assert.equal(accepted(await service.cancelSession(id)).status, "canceled");
  assert.deepEqual((await store.worker(id))!.result, {
    status: "malformed",
    completeness: "malformed",
    error: "Provider result response was malformed",
  });
}));

test("a reconstructed service deterministically completes pending cancellation without redelivery", async () => harness(async (store, path) => {
  const created = await store.createBatch("restart-cancel", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  let cancelCalls = 0;
  let terminal = false;
  const adapter = stub({
    cancellation: "supported",
    cancel: async () => { cancelCalls += 1; return { status: "accepted" }; },
    status: async (handle) => ({
      ...handle,
      status: terminal ? "cancelled" : "running",
      updatedAt: "2026-07-25T00:00:00.000Z",
    }),
    result: async () => ({ status: "cancelled", reason: "user_requested", output: "partial" }),
  });

  assert.equal(accepted(await new LifecycleService(store, adapter).cancelSession(id)).status, "canceling");
  terminal = true;
  const restarted = new DurableStore(path);
  const [outcome] = await new LifecycleService(restarted, adapter).reconcileCancellations();

  assert.equal(accepted(outcome!).status, "canceled");
  assert.equal(cancelCalls, 1, "a delivered cancellation is not sent again after restart");
  assert.equal((await restarted.worker(id))!.status, "canceled");
  assert.equal(((await restarted.worker(id))!.result as AgentResultClaim).output, "partial");
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

test("terminal provider status settles cancellation when result retrieval fails", async () => harness(async (store) => {
  const created = await store.createBatch("missing-result", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  let resultCalls = 0;
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async (handle) => ({ ...handle, status: "cancelled" as const, updatedAt: "2026-07-26T00:00:00.000Z" }),
    result: async () => {
      if (resultCalls++ === 0) throw new Error("result endpoint offline");
      return { status: "cancelled" as const, output: "eventual cancellation result" };
    },
  }));

  const outcome = accepted(await service.cancelSession(id));
  assert.equal(outcome.status, "canceled");
  const worker = await store.worker(id);
  assert.equal(worker?.status, "canceled");
  assert.equal((worker?.result as AgentResultClaim).status, "malformed");
  assert.equal((worker?.result as AgentResultClaim).completeness, "malformed");
  assert.equal(worker?.lifecycleReconcilePending, true);
  await service.reconcileTimedOutResults();
  const reconciled = await store.worker(id);
  assert.equal((reconciled?.result as AgentResultClaim).output, "eventual cancellation result");
  assert.equal(reconciled?.lifecycleReconcilePending, undefined);
}));

test("cancellation reports a deadline that wins before delivery is claimed", async () => harness(async (store) => {
  const created = await store.createBatch("delivery-deadline-race", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  store.claimCancellationDelivery = async (workerId) => {
    await store.expireWorker(workerId, { at: new Date("2026-07-26T00:00:01.000Z") });
    return false;
  };

  const outcome = accepted(await new LifecycleService(store, stub({ cancellation: "supported" })).cancelSession(id));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.stopReason, "deadline_exceeded");
}));

test("deadline reconciliation keeps terminal status when result retrieval fails", async () => harness(async (store) => {
  const created = await store.createBatch("deadline-result", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async (handle) => ({ ...handle, status: "failed" as const, updatedAt: "2026-07-26T00:00:02.000Z" }),
    result: async () => { throw new Error("result endpoint offline"); },
  }));

  await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  const worker = await store.worker(id);
  assert.equal(worker?.status, "failed");
  assert.equal(worker?.stopReason, "deadline_exceeded");
  assert.equal((worker?.result as AgentResultClaim).status, "malformed");
}));

test("malformed provider status and cancel outcomes fail as protocol errors", async () => harness(async (store) => {
  const created = await store.createBatch("protocol", "client", [
    { agent: "codex", task: "status" },
    { agent: "codex", task: "cancel" },
  ]);
  const [statusId, cancelId] = created.sessions.map(({ id }) => id) as [string, string];
  await store.bindWorkerRun(statusId, "run-status");
  await store.bindWorkerRun(cancelId, "run-cancel");

  const badStatus = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async () => ({ runId: "run-status", status: "finished" as never, updatedAt: "not-a-date" }),
  }));
  assert.equal(refused(await badStatus.cancelSession(statusId)).error, "PROVIDER_PROTOCOL_ERROR");
  assert.equal((await store.worker(statusId))?.status, "canceling");

  const badCancel = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "maybe" as never }),
  }));
  assert.equal(refused(await badCancel.cancelSession(cancelId)).error, "PROVIDER_PROTOCOL_ERROR");
  assert.equal((await store.worker(cancelId))?.status, "canceling");
}));

test("malformed terminal result becomes audited malformed evidence", async () => harness(async (store) => {
  const created = await store.createBatch("malformed-result", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async (handle) => ({ ...handle, status: "succeeded" as const, updatedAt: "2026-07-26T00:00:00.000Z" }),
    result: async () => ({ status: "succeeded", output: 42 } as never),
  }));

  assert.equal(accepted(await service.cancelSession(id)).status, "succeeded");
  const worker = await store.worker(id);
  assert.equal(worker?.status, "succeeded");
  assert.equal((worker?.result as AgentResultClaim).status, "malformed");
}));

test("provider fan-out is bounded and preserves batch result order", async () => harness(async (store) => {
  const assignments = Array.from({ length: 32 }, (_, index) => ({ agent: "codex", task: `work-${index}` }));
  const created = await store.createBatch("bounded", "client", assignments);
  for (const [index, worker] of created.sessions.entries()) await store.bindWorkerRun(worker.id, `run-${index}`);
  let active = 0;
  let maximum = 0;
  const adapter = stub({
    cancellation: "supported",
    cancel: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { status: "accepted" as const };
    },
    status: async ({ runId }) => ({ runId, status: "cancelled" as const, updatedAt: "2026-07-26T00:00:00.000Z" }),
    result: async () => ({ status: "cancelled" as const }),
  });

  const outcomes = await new LifecycleService(store, adapter).cancelBatch(created.batch.id);
  assert.ok(maximum <= 4, `maximum provider concurrency was ${maximum}`);
  assert.deepEqual(outcomes.map(({ sessionId }) => sessionId), created.sessions.map(({ id }) => id));
}));

test("provider concurrency is bounded across overlapping lifecycle operations", async () => harness(async (store) => {
  const first = await store.createBatch("overlap-a", "client", Array.from({ length: 16 }, (_, index) => ({ agent: "a", task: `${index}` })));
  const second = await store.createBatch("overlap-b", "client", Array.from({ length: 16 }, (_, index) => ({ agent: "b", task: `${index}` })));
  for (const [index, worker] of [...first.sessions, ...second.sessions].entries()) {
    await store.bindWorkerRun(worker.id, `overlap-${index}`);
  }
  let active = 0;
  let maximum = 0;
  const adapter = stub({
    cancellation: "supported",
    cancel: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { status: "accepted" as const };
    },
    status: async ({ runId }) => ({ runId, status: "cancelled" as const, updatedAt: "2026-07-26T00:00:00.000Z" }),
    result: async () => ({ status: "cancelled" as const }),
  });
  const service = new LifecycleService(store, adapter);
  await Promise.all([service.cancelBatch(first.batch.id), service.cancelBatch(second.batch.id)]);
  assert.ok(maximum <= 4, `maximum shared provider concurrency was ${maximum}`);
}));

test("concurrent reconciliation claims one active cancellation delivery", async () => harness(async (store) => {
  const created = await store.createBatch("delivery-claim", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.requestWorkerCancellation(id);
  let stops = 0;
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => {
      stops += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: "accepted" as const };
    },
    status: async ({ runId }) => ({ runId, status: "running" as const, updatedAt: "2026-07-26T00:00:00.000Z" }),
  }));
  await Promise.all([service.reconcileCancellations(), service.reconcileCancellations()]);
  assert.equal(stops, 1);
}));

test("claim recovery is explicit and never revokes a live delivery claim", async () => harness(async (store) => {
  const created = await store.createBatch("claim-recovery", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.requestWorkerCancellation(id);
  assert.equal(await store.claimCancellationDelivery(id), true);
  await store.cancelingWorkers();
  assert.equal(await store.claimCancellationDelivery(id), false);
  await store.recoverLifecycleDeliveryClaims();
  assert.equal(await store.claimCancellationDelivery(id), true);
}));

test("restart claim recovery restores cancellation before general reconciliation", async () => harness(async (store, path) => {
  const created = await store.createBatch("restart-claim", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1", { pid: 999_999, processStartedAt: "missing" });
  await store.requestWorkerCancellation(id);
  await store.claimCancellationDelivery(id);
  const restarted = new DurableStore(path, () => false);
  await restarted.recoverLifecycleDeliveryClaims();
  await restarted.reconcile();
  const worker = await restarted.worker(id);
  assert.equal(worker?.status, "canceling");
  assert.equal(worker?.cancellationDeliveryPending, true);
}));

test("delivered cancellation remains reconcilable when its local process exits", async () => harness(async (store, path) => {
  const created = await store.createBatch("delivered-restart", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1", { pid: 999_999, processStartedAt: "missing" });
  await store.requestWorkerCancellation(id);
  await store.markCancellationDelivered(id);
  const restarted = new DurableStore(path, () => false);
  await restarted.reconcile();
  assert.equal((await restarted.worker(id))?.status, "canceling");
  const service = new LifecycleService(restarted, stub({
    cancellation: "supported",
    status: async ({ runId }) => ({ runId, status: "cancelled" as const, updatedAt: "2026-07-26T00:00:00.000Z" }),
    result: async () => ({ status: "cancelled" as const }),
  }));
  assert.equal(accepted((await service.reconcileCancellations())[0]!).status, "canceled");
}));

test("synchronous provider failures release shared concurrency slots", async () => harness(async (store) => {
  const created = await store.createBatch("sync-failure", "client", Array.from({ length: 12 }, (_, index) => ({ agent: "a", task: `${index}` })));
  for (const [index, worker] of created.sessions.entries()) await store.bindWorkerRun(worker.id, `sync-${index}`);
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: () => { throw new Error("sync failure"); },
  }), undefined, undefined, undefined, 25);
  const outcomes = await service.cancelBatch(created.batch.id);
  assert.equal(outcomes.length, 12);
  assert.ok(outcomes.every((outcome) => isCancellationRefused(outcome)));
}));

test("an ignored abort retains its shared provider slot until the operation settles", async () => harness(async (store) => {
  const created = await store.createBatch("ignored-abort", "client", Array.from({ length: 9 }, (_, index) => ({ agent: "a", task: `${index}` })));
  for (const [index, worker] of created.sessions.entries()) await store.bindWorkerRun(worker.id, `run-${index}`);
  let release: (() => void) | undefined;
  let active = 0;
  let maximum = 0;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await blocker;
      active -= 1;
      return { status: "accepted" as const };
    },
  }), undefined, undefined, undefined, 5);
  const cancellation = service.cancelBatch(created.batch.id);
  for (let attempt = 0; attempt < 200 && active < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(maximum, 4);
  assert.equal(active, 4);
  release?.();
  await cancellation;
  assert.ok(maximum <= 4);
}));

test("an eventually consistent late result remains pending and is retained", async () => harness(async (store) => {
  const created = await store.createBatch("late-result-retry", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  let resultCalls = 0;
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async ({ runId }) => ({ runId, status: "succeeded" as const, updatedAt: "2026-07-26T00:00:02.000Z" }),
    result: async () => {
      if (resultCalls++ === 0) return undefined;
      return { status: "succeeded" as const, output: "eventual result" };
    },
  }));
  await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  assert.equal((await store.worker(id))?.lifecycleReconcilePending, true);
  await service.reconcileTimedOutResults();
  const worker = await store.worker(id);
  assert.equal((worker?.result as AgentResultClaim).output, "eventual result");
  assert.equal(worker?.lifecycleReconcilePending, undefined);
}));

test("an unavailable cancellation result remains restart-reconcilable", async () => harness(async (store, path) => {
  const created = await store.createBatch("cancel-result-retry", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  const first = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async ({ runId }) => ({ runId, status: "cancelled" as const, updatedAt: "2026-07-26T00:00:02.000Z" }),
    result: async () => { throw new Error("not ready"); },
  }));

  assert.equal(accepted(await first.cancelSession(id)).status, "canceled");
  assert.equal((await store.worker(id))?.lifecycleReconcilePending, true);
  const restarted = new DurableStore(path);
  await new LifecycleService(restarted, stub({
    cancellation: "supported",
    status: async ({ runId }) => ({ runId, status: "cancelled" as const, updatedAt: "2026-07-26T00:00:03.000Z" }),
    result: async () => ({ status: "cancelled" as const, output: "eventual partial result" }),
  })).reconcileTimedOutResults();

  const worker = await restarted.worker(id);
  assert.equal((worker?.result as AgentResultClaim).output, "eventual partial result");
  assert.equal(worker?.lifecycleReconcilePending, undefined);
}));

test("identical unavailable result observations do not grow durable history", async () => harness(async (store) => {
  const created = await store.createBatch("bounded-result-history", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async ({ runId }) => ({ runId, status: "succeeded" as const, updatedAt: "2026-07-26T00:00:02.000Z" }),
    result: async () => { throw new Error("still unavailable"); },
  }));

  await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  for (let attempt = 0; attempt < 10; attempt += 1) await service.reconcileTimedOutResults();
  const worker = await store.worker(id);
  assert.equal(worker?.lifecycleReconcilePending, true);
  assert.equal(worker?.lateObservations?.length, 1);
}));

test("a transient terminal status and result mismatch is reconciled later", async () => harness(async (store) => {
  const created = await store.createBatch("result-replica-lag", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  let resultCalls = 0;
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async ({ runId }) => ({ runId, status: "succeeded" as const, updatedAt: "2026-07-26T00:00:02.000Z" }),
    result: async () => resultCalls++ === 0
      ? { status: "failed" as const, error: "stale replica", retryable: false }
      : { status: "succeeded" as const, output: "consistent result" },
  }));

  await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  assert.equal((await store.worker(id))?.lifecycleReconcilePending, true);
  await service.reconcileTimedOutResults();
  const worker = await store.worker(id);
  assert.equal((worker?.result as AgentResultClaim).output, "consistent result");
  assert.equal(worker?.lifecycleReconcilePending, undefined);
}));

test("a deadline racing an in-flight cancellation delivers one provider stop", async () => harness(async (store) => {
  const created = await store.createBatch("cancel-deadline-race", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  let cancelCalls = 0;
  let releaseCancel: (() => void) | undefined;
  let cancellationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { cancellationStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseCancel = resolve; });
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => {
      cancelCalls += 1;
      cancellationStarted?.();
      await blocked;
      return { status: "accepted" as const };
    },
    status: async ({ runId }) => ({ runId, status: "running" as const, updatedAt: "2026-07-26T00:00:01.000Z" }),
  }));

  const cancellation = service.cancelSession(id);
  await started;
  await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  releaseCancel?.();
  await cancellation;
  const worker = await store.worker(id);
  assert.equal(cancelCalls, 1);
  assert.equal(worker?.providerStopPending, undefined);
  assert.equal(worker?.providerStopClaimed, undefined);
}));

test("an unsupported cancellation racing a deadline releases the delivery claim", async () => harness(async (store) => {
  const created = await store.createBatch("unsupported-deadline-race", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  let releaseCancel: (() => void) | undefined;
  let cancellationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { cancellationStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseCancel = resolve; });
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => {
      cancellationStarted?.();
      await blocked;
      return { status: "unsupported" as const };
    },
    status: async ({ runId }) => ({ runId, status: "running" as const, updatedAt: "2026-07-26T00:00:01.000Z" }),
  }));

  const cancellation = service.cancelSession(id);
  await started;
  await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  releaseCancel?.();
  await cancellation;
  const worker = await store.worker(id);
  assert.equal(worker?.cancellationDeliveryClaimed, undefined);
  assert.equal(worker?.providerStopPending, undefined);
  assert.equal(worker?.providerStopUnsupported, true);
}));

test("restart transfers a deadline-raced cancellation claim to provider stop recovery", async () => harness(async (store, path) => {
  const created = await store.createBatch("cancel-deadline-restart", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.requestWorkerCancellation(id);
  assert.equal(await store.claimCancellationDelivery(id), true);
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  await store.expireWorker(id, { at: new Date("2026-07-26T00:00:01.000Z") });

  const restarted = new DurableStore(path);
  await restarted.recoverLifecycleDeliveryClaims();
  const worker = await restarted.worker(id);
  assert.equal(worker?.cancellationDeliveryClaimed, undefined);
  assert.equal(worker?.providerStopPending, true);
}));

test("a delivered cancellation satisfies later deadline stop cleanup", async () => harness(async (store) => {
  const created = await store.createBatch("cancel-delivered-deadline", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.requestWorkerCancellation(id);
  assert.equal(await store.claimCancellationDelivery(id), true);
  await store.markCancellationDelivered(id);
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));

  await new LifecycleService(store, stub({ cancellation: "supported" }))
    .enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  const worker = await store.worker(id);
  assert.equal(worker?.providerStopPending, undefined);
  assert.equal(worker?.providerStopClaimed, undefined);
}));

test("alternating reconciliation failures retain bounded audit history", async () => harness(async (store) => {
  const created = await store.createBatch("bounded-alternating-history", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  let resultCalls = 0;
  const service = new LifecycleService(store, stub({
    cancellation: "supported",
    cancel: async () => ({ status: "accepted" as const }),
    status: async ({ runId }) => ({ runId, status: "succeeded" as const, updatedAt: "2026-07-26T00:00:02.000Z" }),
    result: async () => { throw new Error(resultCalls++ % 2 === 0 ? "offline" : "overloaded"); },
  }));

  await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  for (let attempt = 0; attempt < 40; attempt += 1) await service.reconcileTimedOutResults();
  assert.ok(((await store.worker(id))?.lateObservations?.length ?? 0) <= 32);
}));

test("a stale failed reconciliation cannot reopen a completed reconciliation", async () => harness(async (store) => {
  const created = await store.createBatch("stale-reconciliation", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  await store.expireWorker(id, { at: new Date("2026-07-26T00:00:01.000Z") });
  await store.settleWorkerCancellation(id, "succeeded", {
    result: { status: "succeeded", completeness: "complete", output: "authoritative" },
  });
  await store.settleWorkerCancellation(id, "succeeded", {
    result: { status: "malformed", completeness: "malformed", error: "stale failure" },
    keepReconciliationPending: true,
  });

  const worker = await store.worker(id);
  assert.equal(worker?.lifecycleReconcilePending, undefined);
  assert.equal((worker?.result as AgentResultClaim).output, "authoritative");
}));

test("bounded deadline sweeps drain more than 250 overdue sessions", async () => harness(async (store) => {
  const sessions = [];
  for (let batch = 0; batch < 2; batch += 1) {
    const created = await store.createBatch(`large-deadline-${batch}`, "client", Array.from(
      { length: 130 },
      (_, index) => ({ agent: "codex", task: `${batch}-${index}` }),
    ));
    sessions.push(...created.sessions);
  }
  const deadline = new Date("2026-07-26T00:00:00.000Z");
  for (const { id } of sessions) await store.setWorkerDeadline(id, deadline);

  const service = new LifecycleService(store, new FakeAgentAdapter([]));
  const first = await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  assert.equal(await service.hasOverdueDeadlines(new Date("2026-07-26T00:00:01.000Z")), true);
  const second = await service.enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  assert.equal(first.length, 250);
  assert.equal(second.length, 10);
  assert.equal(await service.hasOverdueDeadlines(new Date("2026-07-26T00:00:01.000Z")), false);
  assert.equal((await store.overdueWorkers(new Date("2026-07-26T00:00:01.000Z"))).length, 0);
}));

test("unknown outcomes do not satisfy all_terminal waits", async () => harness(async (store) => {
  const created = await store.createBatch("lost-wait", "client", [{ agent: "codex", task: "work" }]);
  await store.recordWorkerTerminal(created.sessions[0]!.id, "unknown_outcome");
  const [item] = await new LifecycleService(store, new FakeAgentAdapter([])).waitForBatches(
    [created.batch.id],
    { timeoutMs: 0, until: "all_terminal" },
  );
  assert.equal("timedOut" in item! ? item.timedOut : false, true);
}));

test("deadline expiry moves cancellation delivery to restart-safe stop reconciliation", async () => harness(async (store, path) => {
  const created = await store.createBatch("deadline-restart", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.bindWorkerRun(id, "run-1");
  await store.requestWorkerCancellation(id);
  await store.setWorkerDeadline(id, new Date("2026-07-26T00:00:00.000Z"));
  const offline = stub({ cancellation: "supported", cancel: async () => { throw new Error("offline"); } });
  await new LifecycleService(store, offline).enforceDeadlines(new Date("2026-07-26T00:00:01.000Z"));
  const worker = await new DurableStore(path).worker(id);
  assert.equal(worker?.status, "failed");
  assert.equal(worker?.cancellationDeliveryPending, undefined);
  assert.equal(worker?.providerStopPending, true);
}));

test("terminal sessions refuse deadline mutation", async () => harness(async (store) => {
  const created = await store.createBatch("terminal-deadline", "client", [{ agent: "codex", task: "work" }]);
  const id = created.sessions[0]!.id;
  await store.recordWorkerTerminal(id, "succeeded", { result: { output: "done" } });
  await assert.rejects(store.setWorkerDeadline(id, new Date("2026-07-27T00:00:00.000Z")), /terminal session/);
  assert.equal((await store.worker(id))?.deadlineAt, undefined);
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

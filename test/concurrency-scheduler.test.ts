import assert from "node:assert/strict";
import test from "node:test";
import {
  ConcurrencyError,
  ConcurrencyScheduler,
  type AdmissionRequest,
} from "../src/concurrency-scheduler.js";
import { ConcurrencyLimitedAgentAdapter } from "../src/concurrency-limited-agent-adapter.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";

const base: AdmissionRequest = {
  id: "first",
  hostId: "local",
  projectId: "orchestrator",
  agentId: "codex",
  workspaceId: "workspace-1",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("enforces every configured scope and exposes a fair queue", async () => {
  const scheduler = new ConcurrencyScheduler({
    global: 5, perHost: 1, perProject: 1, perAgent: 1, perWorkspace: 1,
  });
  const firstRelease = await scheduler.acquire(base);
  const second = scheduler.acquire({ ...base, id: "second", workspaceId: "workspace-2" });
  const third = scheduler.acquire({ ...base, id: "third", workspaceId: "workspace-3" });

  assert.deepEqual(scheduler.snapshot().queued.map(({ id, position }) => ({ id, position })), [
    { id: "second", position: 1 },
    { id: "third", position: 2 },
  ]);
  assert.deepEqual(scheduler.snapshot().queued[0]?.blockedBy, ["host", "project", "agent"]);

  firstRelease();
  const secondRelease = await second;
  assert.equal(scheduler.snapshot().queued[0]?.id, "third");
  secondRelease();
  (await third)();
});

test("holds one permit across retries and complete batch operations", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const retryStarted = deferred();
  const finishRetry = deferred();
  let attempts = 0;
  const retried = scheduler.run(base, async () => {
    attempts += 1;
    await retryStarted.promise;
    attempts += 1;
    await finishRetry.promise;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const batch = scheduler.run({ ...base, id: "batch", workspaceId: "workspace-2" }, async () => undefined);

  retryStarted.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal(scheduler.snapshot().queued[0]?.id, "batch");

  finishRetry.resolve();
  await retried;
  await batch;
  assert.equal(scheduler.snapshot().active, 0);
});

test("cancellation removes queued work and releases running capacity", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const runningAbort = new AbortController();
  const queuedAbort = new AbortController();
  const running = scheduler.run({ ...base, signal: runningAbort.signal }, async () => {
    await new Promise<void>((resolve) => runningAbort.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = scheduler.acquire({ ...base, id: "queued", workspaceId: "workspace-2", signal: queuedAbort.signal });
  queuedAbort.abort();
  await assert.rejects(queued, (error: unknown) => error instanceof ConcurrencyError && error.code === "CANCELLED");
  assert.equal(scheduler.snapshot().queued.length, 0);

  runningAbort.abort();
  await running;
  assert.equal(scheduler.snapshot().active, 0);
});

test("rejects overload structurally when queuing is disabled or full", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1, overload: "reject" });
  const release = await scheduler.acquire(base);
  await assert.rejects(
    scheduler.acquire({ ...base, id: "rejected", workspaceId: "workspace-2" }),
    (error: unknown) => error instanceof ConcurrencyError
      && error.code === "CONCURRENCY_LIMIT"
      && error.retryable
      && error.detail.limits?.includes("global") === true,
  );
  release();

  const bounded = new ConcurrencyScheduler({ global: 1, maxQueued: 1 });
  const boundedRelease = await bounded.acquire(base);
  const queued = bounded.acquire({ ...base, id: "queued", workspaceId: "workspace-2" });
  await assert.rejects(
    bounded.acquire({ ...base, id: "overflow", workspaceId: "workspace-3" }),
    (error: unknown) => error instanceof ConcurrencyError && error.detail.queueDepth === 1,
  );
  boundedRelease();
  (await queued)();
});

test("admits same-tick work up to available capacity before rejecting overload", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 2, overload: "reject" });
  const first = scheduler.acquire(base);
  const second = scheduler.acquire({ ...base, id: "second", workspaceId: "workspace-2" });
  const rejected = scheduler.acquire({ ...base, id: "third", workspaceId: "workspace-3" });

  assert.equal(scheduler.snapshot().active, 2);
  await assert.rejects(
    rejected,
    (error: unknown) => error instanceof ConcurrencyError && error.code === "CONCURRENCY_LIMIT",
  );
  (await first)();
  (await second)();
});

test("resource and rate-limit hooks back off the FIFO head without bypass", async () => {
  let checks = 0;
  const scheduler = new ConcurrencyScheduler(
    { global: 2 },
    [() => {
      checks += 1;
      return checks === 1 ? { ready: false, retryAfterMs: 5, reason: "provider_rate_limit" } : { ready: true };
    }],
  );
  const first = scheduler.acquire(base);
  const second = scheduler.acquire({ ...base, id: "second", workspaceId: "workspace-2" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(scheduler.snapshot().queued.map(({ id }) => id), ["first", "second"]);
  assert.deepEqual(scheduler.snapshot().queued[0]?.blockedBy, ["provider_rate_limit"]);
  const firstRelease = await first;
  const secondRelease = await second;
  firstRelease();
  secondRelease();
  assert.ok(checks >= 3);
});

test("pressure rejects structurally when waiting is disabled", async () => {
  for (const policy of [{ overload: "reject" as const }, { maxQueued: 0 }]) {
    const scheduler = new ConcurrencyScheduler(policy, [() => ({
      ready: false, retryAfterMs: 60_000, reason: "memory_pressure",
    })]);
    await assert.rejects(
      scheduler.acquire(base),
      (error: unknown) => error instanceof ConcurrencyError
        && error.code === "CONCURRENCY_LIMIT"
        && error.detail.limits?.includes("memory_pressure") === true,
    );
    assert.equal(scheduler.snapshot().queued.length, 0);
  }
});

test("cancellation during a pressure check does not remove the next request", async () => {
  let finishCheck = (_decision: { ready: boolean }): void => undefined;
  const check = new Promise<{ ready: boolean }>((resolve) => { finishCheck = resolve; });
  let checks = 0;
  const scheduler = new ConcurrencyScheduler({}, [() => {
    checks += 1;
    return checks === 1 ? check : { ready: true };
  }]);
  const abort = new AbortController();
  const cancelledAdmission = scheduler.acquire({ ...base, signal: abort.signal });
  const next = scheduler.acquire({ ...base, id: "next", workspaceId: "workspace-2" });

  abort.abort();
  finishCheck({ ready: false });
  await assert.rejects(
    cancelledAdmission,
    (error: unknown) => error instanceof ConcurrencyError && error.code === "CANCELLED",
  );
  const release = await next;
  assert.equal(scheduler.snapshot().active, 1);
  release();
});

test("cancellation unblocks the queue when a pressure hook does not settle", async () => {
  const never = new Promise<{ ready: boolean }>(() => undefined);
  let checks = 0;
  const scheduler = new ConcurrencyScheduler({}, [() => {
    checks += 1;
    return checks === 1 ? never : { ready: true };
  }]);
  const abort = new AbortController();
  const cancelledAdmission = scheduler.acquire({ ...base, signal: abort.signal });
  const next = scheduler.acquire({ ...base, id: "next", workspaceId: "workspace-2" });

  abort.abort();
  await assert.rejects(
    cancelledAdmission,
    (error: unknown) => error instanceof ConcurrencyError && error.code === "CANCELLED",
  );
  const release = await next;
  release();
});

test("agent adapter holds capacity until terminal status and releases on cancellation", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["queued", "succeeded"], result: { status: "succeeded", output: "first" } },
    { statuses: ["queued", "cancelled"], result: { status: "cancelled" } },
  ]);
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => ({
    hostId: "local", projectId: "project", agentId: "codex", workspaceId: "workspace",
  }), () => ({
    hostId: "local", projectId: "project", agentId: "codex", workspaceId: "workspace",
  }));
  const first = await adapter.launch({ idempotencyKey: "first", prompt: "first", workspacePath: "/first" });
  const secondPromise = adapter.launch({ idempotencyKey: "second", prompt: "second", workspacePath: "/second" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delegate.launches.length, 1);
  assert.equal(scheduler.snapshot().queued[0]?.id, "second");

  assert.equal((await adapter.status(first)).status, "queued");
  assert.equal(delegate.launches.length, 1);
  assert.equal((await adapter.status(first)).status, "succeeded");
  const second = await secondPromise;
  assert.equal(delegate.launches.length, 2);
  await adapter.cancel(second, "operator request");
  assert.equal(scheduler.snapshot().active, 0);
});

test("recovered running retries reacquire capacity without duplicate permits", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "running", "running", "succeeded"], result: { status: "succeeded", output: "recovered" } },
  ]);
  const scope = {
    hostId: "local", projectId: "project", agentId: "codex", workspaceId: "workspace",
  };
  const original = await delegate.launch({ idempotencyKey: "recovered", prompt: "first", workspacePath: "/first" });
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => scope, () => scope);

  const [first, duplicate] = await Promise.all([
    adapter.findByIdempotencyKey("recovered"),
    adapter.findByIdempotencyKey("recovered"),
  ]);
  assert.deepEqual(first, original);
  assert.deepEqual(duplicate, original);
  assert.equal(scheduler.snapshot().active, 1);

  const queued = scheduler.acquire({ ...base, id: "new-work", workspaceId: "workspace-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot().queued[0]?.id, "new-work");
  assert.equal((await adapter.status(original)).status, "running");
  assert.equal((await adapter.status(original)).status, "succeeded");
  (await queued)();
});

test("does not consume capacity for recovered terminal runs", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["succeeded"], result: { status: "succeeded", output: "complete" } },
  ]);
  const handle = await delegate.launch({ idempotencyKey: "complete", prompt: "first", workspacePath: "/first" });
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);

  assert.deepEqual(await adapter.findByIdempotencyKey("complete"), handle);
  assert.equal(scheduler.snapshot().active, 0);
});

test("recovery releases capacity when a queued run becomes terminal", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "complete" } },
  ]);
  const handle = await delegate.launch({ idempotencyKey: "recovered", prompt: "first", workspacePath: "/first" });
  const blocker = await scheduler.acquire(base);
  const scope = {
    hostId: base.hostId,
    projectId: base.projectId,
    agentId: base.agentId,
    workspaceId: base.workspaceId,
  };
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => scope, () => scope);
  const recovery = adapter.findByIdempotencyKey("recovered");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot().queued[0]?.id, "recovered");

  assert.equal((await delegate.status(handle)).status, "succeeded");
  blocker();
  assert.deepEqual(await recovery, handle);
  assert.equal(scheduler.snapshot().active, 0);
});

test("copies admission scope so caller mutation cannot leak capacity", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const mutable = { ...base };
  const release = await scheduler.acquire(mutable);
  mutable.id = "changed";
  mutable.workspaceId = "changed";
  release();
  assert.equal(scheduler.snapshot().active, 0);
});

test("rejects an invalid overload mode at runtime", () => {
  assert.throws(
    () => new ConcurrencyScheduler({ overload: "invalid" as "queue" }),
    /overload must be either/,
  );
});

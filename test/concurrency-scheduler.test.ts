import assert from "node:assert/strict";
import test from "node:test";
import {
  ConcurrencyError,
  ConcurrencyScheduler,
  type AdmissionRequest,
} from "../src/concurrency-scheduler.js";
import { ConcurrencyLimitedAgentAdapter } from "../src/concurrency-limited-agent-adapter.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import type { LaunchRequest } from "../src/agent-adapter.js";

const base: AdmissionRequest = {
  id: "first",
  hostId: "local",
  projectId: "orchestrator",
  agentId: "codex",
  workspaceId: "workspace-1",
};

const launchRequest = (idempotencyKey: string, prompt: string, workspacePath: string): LaunchRequest => ({
  idempotencyKey,
  prompt,
  workspacePath,
  environment: {},
  revalidateWorkspace: async () => undefined,
});

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

test("preserves FIFO order under sustained contention", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1, maxQueued: 100 });
  const order: number[] = [];
  await Promise.all(Array.from({ length: 100 }, (_, index) => scheduler.run({
    ...base,
    id: `stress-${index}`,
    workspaceId: `workspace-${index}`,
  }, async () => {
    order.push(index);
    await new Promise((resolve) => setImmediate(resolve));
  })));
  assert.deepEqual(order, Array.from({ length: 100 }, (_, index) => index));
  assert.equal(scheduler.snapshot().active, 0);
  assert.equal(scheduler.snapshot().queued.length, 0);
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

test("bounded exhaustion rejects excess work and drains every admitted resource", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 2, maxQueued: 3 });
  const releases = await Promise.all([
    scheduler.acquire({ ...base, id: "active-1", workspaceId: "active-1" }),
    scheduler.acquire({ ...base, id: "active-2", workspaceId: "active-2" }),
  ]);
  const queued = Array.from({ length: 3 }, (_, index) => scheduler.acquire({
    ...base, id: `queued-${index}`, workspaceId: `queued-${index}`,
  }));
  await assert.rejects(
    scheduler.acquire({ ...base, id: "overflow", workspaceId: "overflow" }),
    (error: unknown) => error instanceof ConcurrencyError
      && error.code === "CONCURRENCY_LIMIT"
      && error.detail.queueDepth === 3,
  );
  assert.equal(scheduler.snapshot().active, 2);
  assert.equal(scheduler.snapshot().queued.length, 3);

  releases.forEach((release) => release());
  const firstWave = await Promise.all(queued.slice(0, 2));
  firstWave.forEach((release) => release());
  (await queued[2]!)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot().active, 0);
  assert.equal(scheduler.snapshot().queued.length, 0);
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
  let decidePressure: (decision: { ready: boolean; retryAfterMs: number; reason: string }) => void = () => undefined;
  const firstDecision = new Promise<{ ready: boolean; retryAfterMs: number; reason: string }>((resolve) => {
    decidePressure = resolve;
  });
  const scheduler = new ConcurrencyScheduler(
    { global: 2 },
    [() => {
      checks += 1;
      return checks === 1 ? firstDecision : { ready: true };
    }],
  );
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = scheduler.acquire({ ...base, signal: firstAbort.signal });
  const second = scheduler.acquire({ ...base, id: "second", workspaceId: "workspace-2", signal: secondAbort.signal });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(scheduler.snapshot().queued.map(({ id }) => id), ["first", "second"]);
  decidePressure({ ready: false, retryAfterMs: 60_000, reason: "provider_rate_limit" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduler.snapshot().queued[0]?.blockedBy, ["provider_rate_limit"]);
  firstAbort.abort();
  secondAbort.abort();
  await assert.rejects(first, (error: unknown) => error instanceof ConcurrencyError && error.code === "CANCELLED");
  await assert.rejects(second, (error: unknown) => error instanceof ConcurrencyError && error.code === "CANCELLED");
  assert.equal(scheduler.snapshot().queued.length, 0);
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
  let finishCheck: (decision: { ready: boolean }) => void = () => undefined;
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

test("a non-settling pressure hook times out with a structural reason", async () => {
  const scheduler = new ConcurrencyScheduler(
    { overload: "reject", pressureHookTimeoutMs: 5 },
    [() => new Promise(() => undefined)],
  );
  await assert.rejects(
    scheduler.acquire(base),
    (error: unknown) => error instanceof ConcurrencyError
      && error.detail.limits?.includes("pressure_hook_timeout") === true,
  );
});

test("snapshot counts arbitrary scope identifiers safely", async () => {
  const scheduler = new ConcurrencyScheduler();
  const release = await scheduler.acquire({ ...base, hostId: "__proto__" });
  assert.equal(scheduler.snapshot().activeByHost.__proto__, 1);
  release();
});

test("agent adapter holds capacity until terminal status, including after cancellation", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["queued", "succeeded"], result: { status: "succeeded", output: "first" } },
    { statuses: ["queued", "cancelled"], result: { status: "cancelled" } },
  ]);
  delegate.cancel = async () => ({ status: "accepted" });
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => ({
    hostId: "local", projectId: "project", agentId: "codex", workspaceId: "workspace",
  }), () => ({
    hostId: "local", projectId: "project", agentId: "codex", workspaceId: "workspace",
  }));
  const first = await adapter.launch(launchRequest("first", "first", "/first"));
  const secondPromise = adapter.launch(launchRequest("second", "second", "/second"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delegate.launches.length, 1);
  assert.equal(scheduler.snapshot().queued[0]?.id, "second");

  assert.equal((await adapter.status(first)).status, "queued");
  assert.equal(delegate.launches.length, 1);
  assert.equal((await adapter.status(first)).status, "succeeded");
  const second = await secondPromise;
  assert.equal(delegate.launches.length, 2);
  await adapter.cancel(second, "operator request");
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal((await adapter.status(second)).status, "queued");
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal((await adapter.status(second)).status, "cancelled");
  assert.equal(scheduler.snapshot().active, 0);
});

test("retains an indeterminate launch permit until lookup resolves the outcome", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "accepted" } },
  ]);
  const launch = delegate.launch.bind(delegate);
  delegate.launch = async (request) => {
    await launch(request);
    throw new Error("transport failed after acceptance");
  };
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);

  await assert.rejects(
    adapter.launch(launchRequest("uncertain", "first", "/first")),
    /transport failed/,
  );
  const queued = scheduler.acquire({ ...base, id: "new-work", workspaceId: "workspace-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot().queued[0]?.id, "new-work");

  const recovered = await adapter.findByIdempotencyKey("uncertain");
  assert.ok(recovered);
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal((await adapter.status(recovered)).status, "succeeded");
  (await queued)();
});

test("releases an indeterminate launch permit when lookup proves absence", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([]);
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);

  await assert.rejects(
    adapter.launch(launchRequest("rejected", "first", "/first")),
    /No fake run script/,
  );
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal(await adapter.findByIdempotencyKey("rejected"), undefined);
  assert.equal(scheduler.snapshot().active, 0);
});

test("recovered running retries reacquire capacity without duplicate permits", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "running", "succeeded"], result: { status: "succeeded", output: "recovered" } },
  ]);
  const scope = {
    hostId: "local", projectId: "project", agentId: "codex", workspaceId: "workspace",
  };
  const original = await delegate.launch(launchRequest("recovered", "first", "/first"));
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

test("recovery reserves capacity before a delayed backend lookup", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "cancelled"], result: { status: "cancelled" } },
  ]);
  const handle = await delegate.launch(launchRequest("recovered", "first", "/first"));
  const lookup = deferred();
  const find = delegate.findByIdempotencyKey.bind(delegate);
  delegate.findByIdempotencyKey = async (key) => {
    await lookup.promise;
    return find(key);
  };
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);
  const recovery = adapter.findByIdempotencyKey("recovered");
  const fresh = scheduler.acquire({ ...base, id: "fresh", workspaceId: "fresh" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal(scheduler.snapshot().queued[0]?.id, "fresh");
  lookup.resolve();
  assert.deepEqual(await recovery, handle);
  await adapter.cancel(handle);
  assert.equal((await adapter.status(handle)).status, "cancelled");
  (await fresh)();
});

test("recovery accounts existing runs without deadlocking above the configured limit", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "cancelled"], result: { status: "cancelled" } },
    { statuses: ["running", "cancelled"], result: { status: "cancelled" } },
  ]);
  const one = await delegate.launch(launchRequest("one", "one", "/one"));
  const two = await delegate.launch(launchRequest("two", "two", "/two"));
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);
  assert.deepEqual(await adapter.findByIdempotencyKey("one"), one);
  assert.deepEqual(await adapter.findByIdempotencyKey("two"), two);
  assert.equal(scheduler.snapshot().active, 2);
  await adapter.cancel(one);
  await adapter.cancel(two);
});

test("rejects a recovered run ID bound to a different idempotency key", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 2 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "cancelled"], result: { status: "cancelled" } },
  ]);
  const handle = await delegate.launch(launchRequest("one", "one", "/one"));
  const find = delegate.findByIdempotencyKey.bind(delegate);
  delegate.findByIdempotencyKey = async (key) => key === "two" ? handle : find(key);
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);
  assert.deepEqual(await adapter.findByIdempotencyKey("one"), handle);
  await assert.rejects(adapter.findByIdempotencyKey("two"), /another idempotency key/);
  await adapter.cancel(handle);
});

test("does not consume capacity for recovered terminal runs", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["succeeded"], result: { status: "succeeded", output: "complete" } },
  ]);
  const handle = await delegate.launch(launchRequest("complete", "first", "/first"));
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);

  assert.deepEqual(await adapter.findByIdempotencyKey("complete"), handle);
  assert.equal(scheduler.snapshot().active, 0);
});

test("recovery retains over-limit capacity until the run becomes terminal", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "complete" } },
  ]);
  const handle = await delegate.launch(launchRequest("recovered", "first", "/first"));
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
  assert.equal(scheduler.snapshot().active, 2);

  blocker();
  assert.deepEqual(await recovery, handle);
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal((await adapter.status(handle)).status, "succeeded");
  assert.equal(scheduler.snapshot().active, 0);
});

test("recovery retains capacity when status is indeterminate", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "complete" } },
  ]);
  const handle = await delegate.launch(launchRequest("recovered", "first", "/first"));
  delegate.status = async () => { throw new Error("status unavailable"); };
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);

  await assert.rejects(adapter.findByIdempotencyKey("recovered"), /status unavailable/);
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal(scheduler.snapshot().activeByWorkspace[base.workspaceId], 1);
  assert.deepEqual(handle, { runId: "fake-1" });
});

test("status identity mismatch fails closed without releasing capacity", async () => {
  const scheduler = new ConcurrencyScheduler({ global: 1 });
  const delegate = new FakeAgentAdapter([
    { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "complete" } },
  ]);
  const adapter = new ConcurrencyLimitedAgentAdapter(delegate, scheduler, () => base, () => base);
  const handle = await adapter.launch(launchRequest("first", "first", "/first"));
  delegate.status = async () => ({ runId: "other-run", status: "succeeded", updatedAt: "2000-01-01T00:00:00.000Z" });

  await assert.rejects(adapter.status(handle), /other-run.*fake-1/);
  assert.equal(scheduler.snapshot().active, 1);
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

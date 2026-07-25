import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchCoordinator, type AttributedLaunchRequest } from "../src/launch-coordinator.js";
import { DurableStore } from "../src/store.js";

const authorizer = {
  authorize: async (workspaceId: string) => ({
    workspaceId, projectId: "project-test", canonicalPath: "/worktrees/per-331", revalidate: async () => undefined,
  }),
};

const request: AttributedLaunchRequest = {
  idempotencyKey: "tenant-a:assignment-17:attempt-1",
  sessionId: "session-1",
  batchId: "batch-1",
  workerId: "worker-1",
  attribution: { agent: "codex", task: "PER-331 implementation" },
  prompt: "Implement PER-331",
  workspaceId: "workspace-per-331",
};

const script = { statuses: ["running", "succeeded"] as const, result: { status: "succeeded", output: "complete" } as const };

async function harness(run: (path: string, store: DurableStore, adapter: FakeAgentAdapter) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-idempotency-"));
  const path = join(directory, "state.json");
  const store = new DurableStore(path);
  const adapter = new FakeAgentAdapter([script]);
  try {
    await store.reconcile();
    await run(path, store, adapter);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("repeated requests return one bound run with exact attribution", async () => {
  await harness(async (_path, store, adapter) => {
    const coordinator = new LaunchCoordinator(store, adapter, authorizer);
    const first = await coordinator.launch(request);
    const repeated = await coordinator.launch(request);

    assert.equal(adapter.launches.length, 1);
    assert.equal(first.runId, "fake-1");
    assert.deepEqual(repeated, first);
    assert.deepEqual(first.attribution, request.attribution);
    assert.equal(first.sessionId, request.sessionId);
    assert.equal(first.batchId, request.batchId);
    assert.equal(first.workerId, request.workerId);
  });
});

test("same idempotency key with different semantic input is rejected", async () => {
  await harness(async (_path, store, adapter) => {
    const coordinator = new LaunchCoordinator(store, adapter, authorizer);
    await coordinator.launch(request);
    await assert.rejects(coordinator.launch({ ...request, prompt: "Different task" }), /different launch request/);
    assert.equal(adapter.launches.length, 1);
  });
});

test("crash after durable reservation retries without losing attribution", async () => {
  await harness(async (path, store, adapter) => {
    const crashing = new LaunchCoordinator(store, adapter, authorizer, { afterReservation: () => { throw new Error("crash after reservation"); } });
    await assert.rejects(crashing.launch(request), /crash after reservation/);
    assert.equal(adapter.launches.length, 0);

    const restartedStore = new DurableStore(path);
    await restartedStore.reconcile();
    const recovered = await new LaunchCoordinator(restartedStore, adapter, authorizer).launch(request);
    assert.equal(adapter.launches.length, 1);
    assert.equal(recovered.status, "bound");
    assert.deepEqual(recovered.attribution, request.attribution);
  });
});

test("crash after external acceptance discovers and binds the same run", async () => {
  await harness(async (path, store, adapter) => {
    const crashing = new LaunchCoordinator(store, adapter, authorizer, {
      afterExternalAcceptance: () => { throw new Error("crash after external acceptance"); },
    });
    await assert.rejects(crashing.launch(request), /crash after external acceptance/);
    assert.equal(adapter.launches.length, 1);
    assert.equal(store.launchIntents()[0]?.status, "unknown_outcome");

    const restartedStore = new DurableStore(path);
    await restartedStore.reconcile();
    const [recovered] = await new LaunchCoordinator(restartedStore, adapter, authorizer).reconcile();
    assert.equal(adapter.launches.length, 1);
    assert.equal(recovered?.runId, "fake-1");
    assert.deepEqual(recovered?.attribution, request.attribution);
  });
});

test("unknown outcome is not retried when backend absence is not proven", async () => {
  await harness(async (_path, store, adapter) => {
    const coordinator = new LaunchCoordinator(store, adapter, authorizer, {
      afterExternalAcceptance: () => { throw new Error("connection reset"); },
    });
    await assert.rejects(coordinator.launch(request), /connection reset/);

    const recovered = await new LaunchCoordinator(store, adapter, authorizer).launch(request);
    assert.equal(adapter.launches.length, 1);
    assert.equal(recovered.runId, "fake-1");
  });
});

test("unknown outcome remains unresolved when backend cannot rediscover acceptance", async () => {
  await harness(async (path, store, adapter) => {
    const crashing = new LaunchCoordinator(store, adapter, authorizer, {
      afterExternalAcceptance: () => { throw new Error("connection reset"); },
    });
    await assert.rejects(crashing.launch(request), /connection reset/);

    const restartedStore = new DurableStore(path);
    await restartedStore.reconcile();
    const blindAdapter = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "findByIdempotencyKey") return async () => undefined;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      new LaunchCoordinator(restartedStore, blindAdapter, authorizer).launch(request),
      /remains unknown_outcome/,
    );
    assert.equal(adapter.launches.length, 1);
  });
});

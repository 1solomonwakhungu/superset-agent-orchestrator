import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import {
  InjectedCrash,
  LaunchService,
  type AsynchronousLaunchRequest,
  type LaunchBoundary,
} from "../src/launch-service.js";
import { DurableStore, type DurableState } from "../src/store.js";

const request: AsynchronousLaunchRequest = {
  idempotencyKey: "customer-operation-42",
  clientId: "desktop-client",
  batchName: "PER-338",
  attribution: { agent: "codex", task: "implement durable launch" },
  prompt: "Implement the assignment",
  workspaceId: "workspace-per-338",
  workspacePath: "/workspace/per-338",
};

const script = {
  statuses: ["queued", "succeeded"] as const,
  result: { status: "succeeded", output: "done" } as const,
};

async function withStore(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-launch-"));
  try {
    await run(join(directory, "state.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("returns stable IDs only after durable acceptance and before adapter launch", async () => {
  await withStore(async (path) => {
    const adapter = new FakeAgentAdapter([script]);
    const accepted = await new LaunchService(new DurableStore(path), adapter).accept(request);
    const persisted = JSON.parse(await readFile(path, "utf8")) as DurableState;

    assert.equal(adapter.launches.length, 0);
    assert.match(accepted.sessionId, /^session_[a-f0-9]{24}$/);
    assert.match(accepted.batchId, /^batch_[a-f0-9]{24}$/);
    assert.match(accepted.assignmentId, /^assignment_[a-f0-9]{24}$/);
    assert.equal(accepted.status, "accepted");
    assert.equal(persisted.assignments[0]?.id, accepted.assignmentId);
    assert.equal(persisted.auditEvents[0]?.type, "launch_accepted");
  });
});

test("asynchronous launch returns after acceptance without waiting for the adapter", async () => {
  await withStore(async (path) => {
    let releaseLaunch: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const adapter = {
      findByIdempotencyKey: async () => undefined,
      launch: async () => new Promise<{ runId: string }>((resolve) => {
        releaseLaunch = () => resolve({ runId: "provider-1" });
        markEntered?.();
      }),
      status: async () => { throw new Error("not used"); },
      result: async () => undefined,
      cancel: async () => undefined,
      resumeMetadata: async () => undefined,
    };
    const service = new LaunchService(new DurableStore(path), adapter);

    const accepted = await service.launch(request);
    assert.equal(accepted.status, "accepted");
    await entered;
    assert.ok(releaseLaunch);
    assert.equal((JSON.parse(await readFile(path, "utf8")) as DurableState).assignments[0]?.status, "launching");

    releaseLaunch();
    let status: string | undefined;
    for (let attempt = 0; attempt < 100 && status !== "launched"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (JSON.parse(await readFile(path, "utf8")) as DurableState).assignments[0]?.status;
    }
    assert.equal(status, "launched");
  });
});

test("repeated idempotency keys return one acceptance and launch one provider run", async () => {
  await withStore(async (path) => {
    const adapter = new FakeAgentAdapter([script]);
    const first = new LaunchService(new DurableStore(path), adapter);
    const accepted = await Promise.all(Array.from({ length: 8 }, () => first.accept(request)));
    assert.equal(new Set(accepted.map(({ assignmentId }) => assignmentId)).size, 1);

    await Promise.all([
      new LaunchService(new DurableStore(path), adapter).dispatchPending(),
      new LaunchService(new DurableStore(path), adapter).dispatchPending(),
    ]);
    await new LaunchService(new DurableStore(path), adapter).dispatchPending();

    const state = JSON.parse(await readFile(path, "utf8")) as DurableState;
    assert.equal(adapter.launches.length, 1);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.batches.length, 1);
    assert.equal(state.assignments.length, 1);
    assert.equal(state.assignments[0]?.status, "launched");
    assert.deepEqual(state.auditEvents.map(({ type }) => type), [
      "launch_accepted", "launch_reserved", "execution_started",
    ]);
  });
});

test("rejects reuse of an idempotency key for different work", async () => {
  await withStore(async (path) => {
    const service = new LaunchService(new DurableStore(path), new FakeAgentAdapter([script]));
    await service.accept(request);
    await assert.rejects(service.accept({ ...request, prompt: "Different work" }), /already used for a different launch/);
  });
});

test("rejects invalid nested attribution before durable acceptance", async () => {
  await withStore(async (path) => {
    const service = new LaunchService(new DurableStore(path), new FakeAgentAdapter([script]));
    await assert.rejects(service.accept({ ...request, attribution: { agent: "", task: "work" } }), /attribution/);
    await assert.rejects(
      service.accept({ ...request, attribution: undefined } as unknown as AsynchronousLaunchRequest),
      /attribution/,
    );
    await assert.rejects(readFile(path, "utf8"), /ENOENT/);
  });
});

test("canonical fingerprints accept equivalent requests with reordered properties", async () => {
  await withStore(async (path) => {
    const service = new LaunchService(new DurableStore(path), new FakeAgentAdapter([script]));
    const first = await service.accept(request);
    const reordered = {
      workspacePath: request.workspacePath,
      workspaceId: request.workspaceId,
      prompt: request.prompt,
      attribution: { task: request.attribution.task, agent: request.attribution.agent },
      batchName: request.batchName,
      clientId: request.clientId,
      idempotencyKey: request.idempotencyKey,
    };
    assert.equal((await service.accept(reordered)).assignmentId, first.assignmentId);
  });
});

test("retries transient background dispatch failure without another launch request", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([script]);
    const pending = store.pendingAssignments.bind(store);
    let attempts = 0;
    store.pendingAssignments = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient storage error");
      return pending();
    };
    const service = new LaunchService(store, adapter, () => new Date(), () => undefined, 5);
    const accepted = await service.launch(request);

    let launched = false;
    for (let attempt = 0; attempt < 100 && !launched; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const state = JSON.parse(await readFile(path, "utf8")) as DurableState;
      launched = state.assignments[0]?.status === "launched";
    }
    assert.equal(launched, true);
    assert.equal(adapter.launches.length, 1);
    assert.ok(attempts >= 2);
  });
});

test("recovers without duplicate work after crashes across every launch boundary", async () => {
  const boundaries: LaunchBoundary[] = [
    "after_acceptance",
    "after_launch_started",
    "before_adapter_launch",
    "after_adapter_launch",
    "after_launch_recorded",
  ];

  for (const boundary of boundaries) {
    await withStore(async (path) => {
      const adapter = new FakeAgentAdapter([script]);
      let crashed = false;
      const crash = (current: LaunchBoundary): void => {
        if (!crashed && current === boundary) {
          crashed = true;
          throw new InjectedCrash(boundary);
        }
      };
      const interrupted = new LaunchService(new DurableStore(path), adapter, () => new Date(), crash);

      if (boundary === "after_acceptance") {
        await assert.rejects(interrupted.accept(request), InjectedCrash);
      } else {
        await interrupted.accept(request);
        await assert.rejects(interrupted.dispatchPending(), InjectedCrash);
      }

      const restarted = new LaunchService(new DurableStore(path), adapter);
      const retried = await restarted.accept(request);
      await restarted.dispatchPending();
      const state = JSON.parse(await readFile(path, "utf8")) as DurableState;

      assert.equal(retried.assignmentId, state.assignments[0]?.id, boundary);
      assert.equal(adapter.launches.length, 1, boundary);
      assert.equal(state.assignments.length, 1, boundary);
      assert.equal(state.assignments[0]?.status, "launched", boundary);
      assert.equal(state.auditEvents.filter(({ type }) => type === "execution_started").length, 1, boundary);
    });
  }
});

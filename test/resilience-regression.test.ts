import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter } from "../src/agent-adapter.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchService, type AsynchronousLaunchRequest } from "../src/launch-service.js";
import { DurableStore } from "../src/store.js";

const request: AsynchronousLaunchRequest = {
  idempotencyKey: "per-348-race", clientId: "test", batchName: "PER-348",
  attribution: { agent: "fake", task: "race" }, prompt: "synthetic",
  workspaceId: "fixture", workspacePath: "/tmp/per-348-fixture",
};

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "per-348-race-"));
  try { await run(join(directory, "state.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("concurrent dispatchers atomically claim one provider launch", async () => {
  await fixture(async (path) => {
    let launches = 0;
    let enterLaunch: (() => void) | undefined;
    let releaseLaunch: (() => void) | undefined;
    const launchEntered = new Promise<void>((resolve) => { enterLaunch = resolve; });
    const launchReleased = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const adapter: AgentAdapter = {
      findByIdempotencyKey: async () => undefined,
      launch: async () => {
        launches += 1;
        enterLaunch?.();
        await launchReleased;
        return { runId: `run-${launches}` };
      },
      status: async () => { throw new Error("unused"); }, result: async () => undefined,
      cancel: async () => undefined, resumeMetadata: async () => undefined,
    };
    await new LaunchService(new DurableStore(path), adapter).accept(request);
    const first = new LaunchService(new DurableStore(path), adapter).dispatchPending();
    await launchEntered;
    const second = new LaunchService(new DurableStore(path), adapter).dispatchPending();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(launches, 1, "the second dispatcher must wait outside the provider boundary");
    releaseLaunch?.();
    await Promise.all([first, second]);
    assert.equal(launches, 1);
    const pending = await new DurableStore(path).pendingAssignments();
    assert.equal(pending.length, 0);
  });
});

test("forged and mismatched launch events cannot mutate state", async () => {
  await fixture(async (path) => {
    const store = new DurableStore(path);
    const accepted = await new LaunchService(store, {
      findByIdempotencyKey: async () => undefined,
      launch: async () => ({ runId: "unused" }), status: async () => { throw new Error("unused"); },
      result: async () => undefined, cancel: async () => undefined, resumeMetadata: async () => undefined,
    }).accept(request);
    const before = await readFile(path, "utf8");
    const at = "2026-07-24T20:00:00.000Z";
    await assert.rejects(store.recordLaunchEvent(accepted.assignmentId, "launching", {
      id: "wrong-aggregate", assignmentId: "other", type: "launch_reserved", occurredAt: at,
    }), /does not match/);
    await assert.rejects(store.recordLaunchEvent(accepted.assignmentId, "launching", {
      id: "wrong-type", assignmentId: accepted.assignmentId, type: "execution_started", occurredAt: at,
    }), /type does not match/);
    assert.equal((await store.pendingAssignments())[0]?.status, "accepted");
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("clock rollback cannot strand an accepted launch or regress its materialized time", async () => {
  await fixture(async (path) => {
    const times = [new Date("2026-07-24T20:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"), new Date("2019-01-01T00:00:00.000Z")];
    const adapter = new FakeAgentAdapter([{
      statuses: ["succeeded"], result: { status: "succeeded", output: "done" },
    }]);
    const service = new LaunchService(new DurableStore(path), adapter, () => times.shift() ?? new Date(0));
    const accepted = await service.accept(request);
    await service.dispatchPending();

    const assignment = await new DurableStore(path).assignmentForResult(accepted.assignmentId);
    assert.equal(adapter.launches.length, 1);
    assert.equal(assignment.status, "launched");
    assert.equal(assignment.updatedAt, accepted.acceptedAt);
  });
});

test("conflicting audit event IDs cannot mutate an assignment without evidence", async () => {
  await fixture(async (path) => {
    const store = new DurableStore(path);
    const service = new LaunchService(store, new FakeAgentAdapter([{
      statuses: ["succeeded"], result: { status: "succeeded", output: "done" },
    }]));
    const first = await service.accept(request);
    const second = await service.accept({ ...request, idempotencyKey: "second" });
    const occurredAt = "2026-07-24T20:00:00.000Z";
    await store.recordLaunchEvent(first.assignmentId, "launching", {
      id: "shared", assignmentId: first.assignmentId, type: "launch_reserved", occurredAt,
    });
    await assert.rejects(store.recordLaunchEvent(second.assignmentId, "launching", {
      id: "shared", assignmentId: second.assignmentId, type: "launch_reserved", occurredAt,
    }), /conflicts with existing evidence/);
    assert.equal((await store.assignmentForResult(second.assignmentId)).status, "accepted");
  });
});

test("acceptance evidence must identify the accepted assignment and event type", async () => {
  await fixture(async (path) => {
    const store = new DurableStore(path);
    const service = new LaunchService(store, new FakeAgentAdapter([{
      statuses: ["succeeded"], result: { status: "succeeded", output: "done" },
    }]));
    await service.accept(request);
    const state = store.snapshot();
    const input = {
      assignment: { ...state.assignments[0]!, id: "forged-assignment", idempotencyKey: "forged-key" },
      session: { ...state.sessions[0]!, id: "forged-session" },
      batch: { ...state.batches[0]!, id: "forged-batch" },
      event: { ...state.auditEvents[0]!, id: "forged-event" },
    };

    await assert.rejects(store.acceptLaunch(input), /does not match its target/);
    await assert.rejects(store.acceptLaunch({
      ...input,
      event: { ...input.event, assignmentId: input.assignment.id, type: "launch_reserved" },
    }), /must have type launch_accepted/);
    assert.equal(store.snapshot().assignments.length, 1);
  });
});

test("concurrent duplicate cancellation produces one terminal cancellation", async () => {
  const adapter = new FakeAgentAdapter([{
    statuses: ["running", "succeeded"],
    result: { status: "succeeded", output: "too late" },
  }]);
  const handle = await adapter.launch({
    idempotencyKey: "cancel-race", prompt: "synthetic", workspacePath: "/tmp/fixture",
  });
  await Promise.all([adapter.cancel(handle, "operator"), adapter.cancel(handle, "duplicate")]);

  assert.deepEqual(await adapter.result(handle), { status: "cancelled", reason: "operator" });
  assert.deepEqual(adapter.cancellations, [{ runId: handle.runId, reason: "operator" }]);
});

test("cancellation arriving after terminal completion is inert", async () => {
  const adapter = new FakeAgentAdapter([{
    statuses: ["running", "succeeded"],
    result: { status: "succeeded", output: "authoritative" },
  }]);
  const handle = await adapter.launch({
    idempotencyKey: "late-cancel", prompt: "synthetic", workspacePath: "/tmp/fixture",
  });
  await adapter.status(handle);
  await adapter.status(handle);
  await adapter.cancel(handle, "late");

  assert.deepEqual(await adapter.result(handle), { status: "succeeded", output: "authoritative" });
  assert.deepEqual(adapter.cancellations, []);
});

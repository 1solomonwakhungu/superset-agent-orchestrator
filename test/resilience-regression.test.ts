import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter } from "../src/agent-adapter.js";
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
    const adapter: AgentAdapter = {
      findByIdempotencyKey: async () => undefined,
      launch: async () => ({ runId: `run-${++launches}` }),
      status: async () => { throw new Error("unused"); }, result: async () => undefined,
      cancel: async () => undefined, resumeMetadata: async () => undefined,
    };
    await new LaunchService(new DurableStore(path), adapter).accept(request);
    await Promise.all([
      new LaunchService(new DurableStore(path), adapter).dispatchPending(),
      new LaunchService(new DurableStore(path), adapter).dispatchPending(),
    ]);
    assert.equal(launches, 1);
    const pending = await new DurableStore(path).pendingAssignments();
    assert.equal(pending.length, 0);
  });
});

test("forged, mismatched, and stale launch events cannot mutate state", async () => {
  await fixture(async (path) => {
    const store = new DurableStore(path);
    const accepted = await new LaunchService(store, {
      findByIdempotencyKey: async () => undefined,
      launch: async () => ({ runId: "unused" }), status: async () => { throw new Error("unused"); },
      result: async () => undefined, cancel: async () => undefined, resumeMetadata: async () => undefined,
    }).accept(request);
    const at = "2026-07-24T20:00:00.000Z";
    await assert.rejects(store.recordLaunchEvent(accepted.assignmentId, "launching", {
      id: "wrong-aggregate", assignmentId: "other", type: "launch_reserved", occurredAt: at,
    }), /does not match/);
    await assert.rejects(store.recordLaunchEvent(accepted.assignmentId, "launching", {
      id: "wrong-type", assignmentId: accepted.assignmentId, type: "execution_started", occurredAt: at,
    }), /type does not match/);
    await assert.rejects(store.recordLaunchEvent(accepted.assignmentId, "launching", {
      id: "stale", assignmentId: accepted.assignmentId, type: "launch_reserved", occurredAt: "2020-01-01T00:00:00.000Z",
    }), /Stale/);
    assert.equal((await store.pendingAssignments())[0]?.status, "accepted");
  });
});

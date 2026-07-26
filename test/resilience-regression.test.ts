import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter } from "../src/agent-adapter.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchService, type AsynchronousLaunchRequest, type LaunchBoundary } from "../src/launch-service.js";
import { childEnvironment } from "../src/security.js";
import { DurableStore } from "../src/store.js";

const workspacePath = "/tmp/per-348-fixture";
const authorizer = {
  authorize: async (workspaceId: string) => ({
    workspaceId, projectId: "project-per-348", canonicalPath: workspacePath,
    revalidate: async () => undefined,
  }),
};

const request: AsynchronousLaunchRequest = {
  idempotencyKey: "per-348-race", clientId: "test", batchName: "PER-348",
  attribution: { agent: "fake", task: "race" }, prompt: "synthetic",
  workspaceId: "fixture",
};

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "per-348-race-"));
  try { await run(join(directory, "state.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function runWorker(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures/launch-process-worker.ts"), ...args], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("process death at every launch boundary recovers without a duplicate provider run", async () => {
  const boundaries: LaunchBoundary[] = [
    "after_acceptance", "after_launch_started", "before_adapter_launch",
    "after_adapter_launch", "after_launch_recorded",
  ];
  for (const boundary of boundaries) {
    await fixture(async (statePath) => {
      const providerPath = `${statePath}.provider`;
      const crashed = await runWorker(["crash", statePath, providerPath, boundary]);
      assert.equal(crashed.signal, "SIGKILL", boundary);
      assert.deepEqual(await runWorker(["recover", statePath, providerPath]), { code: 0, signal: null }, boundary);
      const state = JSON.parse(await readFile(statePath, "utf8")) as { assignments: { status: string }[] };
      assert.equal(state.assignments.length, 1, boundary);
      assert.equal(state.assignments[0]?.status, "launched", boundary);
      assert.deepEqual(JSON.parse(await readFile(providerPath, "utf8")), { runId: "synthetic-run" }, boundary);
    });
  }
});

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
    await new LaunchService(new DurableStore(path), adapter, authorizer).accept(request);
    const first = new LaunchService(new DurableStore(path), adapter, authorizer).dispatchPending();
    await launchEntered;
    const second = new LaunchService(new DurableStore(path), adapter, authorizer).dispatchPending();
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
    }, authorizer).accept(request);
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
    const service = new LaunchService(
      new DurableStore(path), adapter, authorizer, () => times.shift() ?? new Date(0),
    );
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
    }]), authorizer);
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
    }]), authorizer);
    await service.accept(request);
    const state = store.snapshot();
    const input = {
      assignment: { ...state.assignments[0]!, id: "forged-assignment", idempotencyKey: "forged-key" },
      session: { ...state.sessions[0]!, id: "forged-session" },
      batch: { ...state.batches[0]!, id: "forged-batch" },
      worker: { ...state.workers[0]!, id: "forged-session", sessionId: "forged-session", batchId: "forged-batch" },
      event: { ...state.auditEvents[0]!, id: "forged-event" },
      securityAudit: {
        requesterId: "forged-session", operation: "sessions_launch", decision: "allowed" as const,
        reasonCode: "launch_accepted", correlationId: "forged-key", workspaceId: "fixture",
        projectId: "project-per-348", assignmentId: "forged-assignment",
      },
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
    environment: childEnvironment(), revalidateWorkspace: async () => undefined,
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
    environment: childEnvironment(), revalidateWorkspace: async () => undefined,
  });
  await adapter.status(handle);
  await adapter.status(handle);
  await adapter.cancel(handle, "late");

  assert.deepEqual(await adapter.result(handle), { status: "succeeded", output: "authoritative" });
  assert.deepEqual(adapter.cancellations, []);
});

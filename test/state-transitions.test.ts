import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchService } from "../src/launch-service.js";
import {
  DurableStore,
  type CapturedResult,
  type LaunchAuditEvent,
  type LaunchStatus,
} from "../src/store.js";
import { steadyClock, withTemporaryDirectory } from "./support/deterministic.js";

/**
 * State-machine coverage: which transitions the durable core permits, which it
 * refuses, and which are idempotent no-ops. Every case is offline and uses an
 * injected clock so the assertions are exact rather than approximate.
 */

const ATTRIBUTION = { agent: "codex", task: "migrate" } as const;
const HEX64 = "b".repeat(64);
const LAUNCH_STATES: LaunchStatus[] = ["reserved", "dispatching", "unknown_outcome", "bound"];
const authorizer = {
  authorize: async (workspaceId: string) => ({
    workspaceId, projectId: "project-test", canonicalPath: `/tmp/${workspaceId}`, revalidate: async () => undefined,
  }),
};

function intentInput(key: string) {
  return {
    idempotencyKey: key,
    requestHash: HEX64,
    sessionId: "session-1",
    batchId: "batch-1",
    workerId: "worker-1",
    attribution: ATTRIBUTION,
  };
}

function auditEvent(assignmentId: string, type: LaunchAuditEvent["type"], occurredAt: string, runId?: string): LaunchAuditEvent {
  return { id: `${assignmentId}:${type}`, assignmentId, type, occurredAt, ...(runId === undefined ? {} : { runId }) };
}

async function launchedAssignment(directory: string, name: string) {
  const store = new DurableStore(join(directory, `${name}.json`));
  const clock = steadyClock();
  const service = new LaunchService(store, new FakeAgentAdapter([]), authorizer, clock);
  const accepted = await service.accept({
    idempotencyKey: `${name}-key`,
    clientId: "client-1",
    batchName: name,
    attribution: ATTRIBUTION,
    prompt: "Do the work",
    workspaceId: name,
  });
  await store.recordLaunchEvent(accepted.assignmentId, "launching", auditEvent(accepted.assignmentId, "launch_reserved", clock().toISOString()));
  const { assignment: launched } = await store.recordLaunchEvent(
    accepted.assignmentId,
    "launched",
    auditEvent(accepted.assignmentId, "execution_started", clock().toISOString(), "run-1"),
  );
  return { store, assignment: launched, clock };
}

function capturedResult(assignment: Awaited<ReturnType<typeof launchedAssignment>>["assignment"]): CapturedResult {
  return {
    deliveryId: "delivery-1",
    deliveryFingerprint: HEX64,
    assignmentId: assignment.id,
    batchId: assignment.batchId,
    sessionId: assignment.sessionId,
    workspaceId: assignment.workspaceId as string,
    workspacePath: assignment.workspacePath,
    attemptId: assignment.attemptId as string,
    attempt: assignment.attempt as number,
    runId: assignment.runId as string,
    attribution: { ...ATTRIBUTION },
    claim: { status: "succeeded", completeness: "complete", output: "done" },
    verifiedArtifacts: [],
    capturedAt: "2026-07-01T01:00:00.000Z",
  };
}

test("launch intents advance forward and freeze once bound", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const store = new DurableStore(join(directory, "intents.json"));
    const clock = steadyClock();

    const reserved = await store.reserveLaunch(intentInput("key-1"), clock());
    assert.equal(reserved.created, true);
    assert.equal(reserved.intent.status, "reserved");
    assert.equal(reserved.intent.runId, undefined);

    const dispatching = await store.updateLaunch("key-1", "dispatching", {}, clock());
    assert.equal(dispatching.status, "dispatching");

    const unknown = await store.updateLaunch("key-1", "unknown_outcome", { diagnostic: "adapter timed out" }, clock());
    assert.equal(unknown.status, "unknown_outcome");
    assert.equal(unknown.diagnostic, "adapter timed out");

    const bound = await store.updateLaunch("key-1", "bound", { runId: "run-1" }, clock());
    assert.equal(bound.status, "bound");
    assert.equal(bound.runId, "run-1");

    for (const status of LAUNCH_STATES.filter((state) => state !== "bound")) {
      await assert.rejects(
        () => store.updateLaunch("key-1", status, {}, clock()),
        new RegExp(`Invalid launch transition: bound -> ${status}`),
        `bound must not regress to ${status}`,
      );
    }
    await assert.rejects(
      () => store.updateLaunch("key-1", "bound", { runId: "run-2" }, clock()),
      /A bound launch cannot be rebound/,
      "a bound run ID is immutable",
    );

    const rebound = await store.updateLaunch("key-1", "bound", { runId: "run-1" }, clock());
    assert.equal(rebound.runId, "run-1", "re-asserting the same binding is a safe no-op");
    assert.equal(store.launchIntents().length, 1);
  });
});

test("reserving an unchanged intent is idempotent and a changed one is refused", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const store = new DurableStore(join(directory, "reservations.json"));
    const clock = steadyClock();

    const first = await store.reserveLaunch(intentInput("key-1"), clock());
    const second = await store.reserveLaunch(intentInput("key-1"), clock());
    assert.equal(second.created, false);
    assert.deepEqual(second.intent, first.intent, "a repeat reservation returns the original record unchanged");

    await assert.rejects(
      () => store.reserveLaunch({ ...intentInput("key-1"), requestHash: "c".repeat(64) }, clock()),
      /Idempotency key was already used for a different launch request/,
    );
    await assert.rejects(() => store.updateLaunch("absent-key", "bound", { runId: "run-1" }, clock()), /Unknown launch idempotency key/);
    assert.equal(store.launchIntents().length, 1);
  });
});

test("assignments advance accepted to launching to launched and then stop accepting events", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const { store, assignment, clock } = await launchedAssignment(directory, "lifecycle");
    assert.equal(assignment.status, "launched");
    assert.equal(assignment.runId, "run-1");

    const afterTerminal = await store.recordLaunchEvent(
      assignment.id,
      "failed",
      auditEvent(assignment.id, "launch_failed", clock().toISOString()),
    );
    assert.equal(afterTerminal.assignment.status, "launched", "a launched assignment is terminal for launch bookkeeping");
    assert.equal(afterTerminal.assignment.error, undefined);

    const events = store.snapshot().auditEvents.map(({ type }) => type);
    assert.deepEqual(events, ["launch_accepted", "launch_reserved", "execution_started"],
      "no audit event is written for a refused transition");
    await assert.rejects(
      () => store.recordLaunchEvent("assignment-absent", "failed", auditEvent("assignment-absent", "launch_failed", clock().toISOString())),
      /Unknown assignment/,
    );
  });
});

test("a failed launch is terminal and never silently relaunches", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const store = new DurableStore(join(directory, "failed.json"));
    const clock = steadyClock();
    const service = new LaunchService(store, new FakeAgentAdapter([]), authorizer, clock);
    const accepted = await service.accept({
      idempotencyKey: "failed-key",
      clientId: "client-1",
      batchName: "failed",
      attribution: ATTRIBUTION,
      prompt: "Do the work",
      workspaceId: "failed",
    });
    await store.recordLaunchEvent(
      accepted.assignmentId,
      "launching",
      auditEvent(accepted.assignmentId, "launch_reserved", clock().toISOString()),
    );

    const { assignment: failed } = await store.recordLaunchEvent(accepted.assignmentId, "failed", {
      ...auditEvent(accepted.assignmentId, "launch_failed", clock().toISOString()),
      error: "adapter refused the launch",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "adapter refused the launch");

    const { assignment: retried } = await store.recordLaunchEvent(
      accepted.assignmentId,
      "launched",
      auditEvent(accepted.assignmentId, "execution_started", clock().toISOString(), "run-9"),
    );
    assert.equal(retried.status, "failed", "a failed assignment does not become launched");
    assert.equal(retried.runId, undefined);
    assert.deepEqual(await store.pendingAssignments(), [], "terminal assignments leave the dispatch queue");
  });
});

test("result capture requires a launched assignment with matching identities", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const { store, assignment } = await launchedAssignment(directory, "capture");
    const valid = capturedResult(assignment);

    for (const [field, wrong] of [
      ["batchId", "batch-other"],
      ["sessionId", "session-other"],
      ["workspaceId", "workspace-other"],
      ["workspacePath", "/tmp/other"],
      ["attemptId", "attempt-other"],
      ["attempt", 2],
      ["runId", "run-other"],
    ] as const) {
      await assert.rejects(
        () => store.captureResult({ ...valid, [field]: wrong }),
        new RegExp(`Result ${field} does not match its assignment`),
        `mismatched ${field}`,
      );
    }
    await assert.rejects(
      () => store.captureResult({ ...valid, assignmentId: "assignment-absent" }),
      /Unknown assignment/,
    );
    assert.deepEqual(store.snapshot().capturedResults, [], "a refused result is never persisted");

    const stored = await store.captureResult(valid);
    assert.equal(stored.duplicate, false);
    const repeated = await store.captureResult(valid);
    assert.equal(repeated.duplicate, true);
    assert.equal(store.snapshot().capturedResults?.length, 1);
  });
});

test("conflicting deliveries and attempts are refused rather than overwritten", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const { store, assignment } = await launchedAssignment(directory, "conflicts");
    const valid = capturedResult(assignment);
    await store.captureResult(valid);

    await assert.rejects(
      () => store.captureResult({ ...valid, deliveryFingerprint: "d".repeat(64) }),
      /conflicts with its first payload/,
      "the same delivery ID may not change its payload",
    );
    await assert.rejects(
      () => store.captureResult({ ...valid, deliveryId: "delivery-2", deliveryFingerprint: "d".repeat(64) }),
      /already has a different authoritative result/,
      "an attempt may not gain a second authoritative result",
    );

    const redelivered = await store.captureResult({ ...valid, deliveryId: "delivery-2" });
    assert.equal(redelivered.duplicate, true, "an identical redelivery resolves to the stored result");
    assert.equal(store.snapshot().capturedResults?.length, 1);
  });
});

test("results are refused before an assignment reaches launched", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const store = new DurableStore(join(directory, "premature.json"));
    const clock = steadyClock();
    const service = new LaunchService(store, new FakeAgentAdapter([]), authorizer, clock);
    const accepted = await service.accept({
      idempotencyKey: "premature-key",
      clientId: "client-1",
      batchName: "premature",
      attribution: ATTRIBUTION,
      prompt: "Do the work",
      workspaceId: "premature",
    });
    // Bind a run ID while the assignment is still only launching, so identity
    // matches and the status guard is the assertion under test.
    const { assignment: launching } = await store.recordLaunchEvent(
      accepted.assignmentId,
      "launching",
      auditEvent(accepted.assignmentId, "launch_reserved", clock().toISOString(), "run-1"),
    );
    assert.equal(launching.status, "launching");

    await assert.rejects(
      () => store.captureResult(capturedResult(launching)),
      /Results require a launched assignment/,
    );
    assert.deepEqual(store.snapshot().capturedResults, []);
  });
});

test("reconciliation moves absent running workers to unknown outcome exactly once", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const path = join(directory, "reconcile.json");
    const store = new DurableStore(path, () => false);
    const created = await store.createBatch("reconcile", "client-1", [
      { agent: "codex", task: "one" },
      { agent: "codex", task: "two" },
    ], undefined, new Date("2026-07-01T00:00:00.000Z"));

    const snapshot = store.snapshot();
    const [running, terminal] = snapshot.workers;
    assert.ok(running && terminal);
    running.status = "running";
    running.pid = 4242;
    running.processStartedAt = "Wed Jul  1 00:00:00 2026";
    terminal.status = "succeeded";
    terminal.completedAt = "2026-07-01T00:10:00.000Z";
    await writeState(path, snapshot);

    const reloaded = new DurableStore(path, () => false);
    const first = await reloaded.reconcile(new Date("2026-07-01T01:00:00.000Z"));
    assert.equal(first.runningWorkers, 0, "an absent process cannot remain running");
    assert.equal(first.diagnosticsAdded, 2, "one unknown outcome and one missing result");

    const workers = reloaded.snapshot().workers;
    assert.equal(workers.find(({ id }) => id === running.id)?.status, "unknown_outcome");
    assert.equal(workers.find(({ id }) => id === running.id)?.completedAt, "2026-07-01T01:00:00.000Z");
    assert.equal(workers.find(({ id }) => id === terminal.id)?.status, "succeeded", "terminal workers are left alone");

    const second = await reloaded.reconcile(new Date("2026-07-01T02:00:00.000Z"));
    assert.equal(second.diagnosticsAdded, 0, "diagnostics are keyed and never duplicated");
    assert.deepEqual(
      reloaded.diagnostics().map(({ kind }) => kind).sort(),
      ["missing_result", "unknown_outcome"],
    );
    assert.deepEqual(reloaded.diagnostics("unknown_outcome").map(({ workerId }) => workerId), [running.id]);
    assert.equal(created.sessions.length, 2);
  });
});

test("a live process keeps its worker running across reconciliation", async () => {
  await withTemporaryDirectory("orchestrator-transitions", async (directory) => {
    const path = join(directory, "alive.json");
    const store = new DurableStore(path, () => true);
    await store.createBatch("alive", "client-1", [{ agent: "codex", task: "one" }], undefined, new Date("2026-07-01T00:00:00.000Z"));
    const snapshot = store.snapshot();
    const worker = snapshot.workers[0];
    assert.ok(worker);
    worker.status = "running";
    worker.pid = 4242;
    worker.processStartedAt = "Wed Jul  1 00:00:00 2026";
    await writeState(path, snapshot);

    const reloaded = new DurableStore(path, () => true);
    const summary = await reloaded.reconcile(new Date("2026-07-01T01:00:00.000Z"));
    assert.equal(summary.runningWorkers, 1);
    assert.equal(summary.diagnosticsAdded, 0);
  });
});

async function writeState(path: string, state: unknown): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

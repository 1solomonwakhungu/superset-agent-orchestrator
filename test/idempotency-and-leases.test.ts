import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchService } from "../src/launch-service.js";
import { OrchestratorStorage } from "../src/storage.js";
import { DurableStore, type CapturedResult } from "../src/store.js";
import { steadyClock, terminateWorkers, withTemporaryDirectory } from "./support/deterministic.js";

/**
 * Concurrency and exclusivity. These are the focused race tests: they contend
 * for the same durable file and the same registry row from several writers at
 * once, and assert an exact single-winner outcome rather than a probable one.
 * `npm run test:race` repeats this file to expose ordering-dependent defects.
 */

const ATTRIBUTION = { agent: "codex", task: "migrate" } as const;
const HEX64 = "e".repeat(64);
const CONTENDERS = 8;
const AT = "2026-07-01T00:00:00.000Z";

test("concurrent identical batch creations produce exactly one batch", async () => {
  await withTemporaryDirectory("orchestrator-race", async (directory) => {
    const path = join(directory, "state.json");
    const assignments = [{ agent: "codex", task: "one" }, { agent: "opencode", task: "two" }];
    const outcomes = await contendForBatchCreation(path, false);

    assert.ok(outcomes.every((outcome) => outcome.ok));
    const created = outcomes.filter((outcome) => outcome.ok && !outcome.duplicate);
    assert.equal(created.length, 1, "exactly one caller may create the batch");
    const batchIds = new Set(outcomes.flatMap((outcome) => outcome.ok ? [outcome.batchId] : []));
    assert.equal(batchIds.size, 1, "every caller observes the same batch identity");
    for (const outcome of outcomes) {
      assert.equal(outcome.ok, true);
      if (!outcome.ok) continue;
      assert.deepEqual(
        outcome.attributions,
        assignments,
        "duplicates return the original attributed sessions",
      );
    }

    const verifier = new DurableStore(path);
    await verifier.reconcile(new Date(AT));
    const snapshot = verifier.snapshot();
    assert.equal(snapshot.batches.length, 1);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.workers.length, assignments.length);
  });
});

test("concurrent conflicting batch creations reject every loser without corrupting state", async () => {
  await withTemporaryDirectory("orchestrator-race", async (directory) => {
    const path = join(directory, "state.json");
    const outcomes = await contendForBatchCreation(path, true);
    const fulfilled = outcomes.filter((outcome) => outcome.ok);
    assert.equal(fulfilled.length, 1, "only the first distinct request may win the key");
    for (const outcome of outcomes.filter((candidate) => !candidate.ok)) {
      assert.equal(outcome.code, "idempotency_conflict");
    }

    const verifier = new DurableStore(path);
    await verifier.reconcile(new Date(AT));
    assert.equal(verifier.snapshot().batches.length, 1);
    assert.equal(verifier.snapshot().workers.length, 1);
  });
});

test("concurrent launch reservations bind exactly one run", async () => {
  await withTemporaryDirectory("orchestrator-race", async (directory) => {
    const path = join(directory, "state.json");
    const stores = Array.from({ length: CONTENDERS }, () => new DurableStore(path));
    const input = {
      idempotencyKey: "launch-key",
      requestHash: HEX64,
      sessionId: "session-1",
      batchId: "batch-1",
      workerId: "worker-1",
      attribution: ATTRIBUTION,
    };

    const reservations = await Promise.all(stores.map((store) => store.reserveLaunch(input, new Date(AT))));
    assert.equal(reservations.filter(({ created }) => created).length, 1);
    await stores[0]!.updateLaunch("launch-key", "dispatching", {}, new Date(AT));

    const binds = await Promise.allSettled(stores.map((store) =>
      store.updateLaunch("launch-key", "bound", { runId: "run-1" }, new Date(AT))));
    assert.equal(binds.filter((outcome) => outcome.status === "fulfilled").length, CONTENDERS,
      "re-asserting the same binding is safe from every writer");

    const conflicting = await Promise.allSettled(stores.map((store, index) =>
      store.updateLaunch("launch-key", "bound", { runId: `run-${index + 2}` }, new Date(AT))));
    assert.equal(conflicting.filter((outcome) => outcome.status === "fulfilled").length, 0,
      "a bound run ID cannot be replaced by any writer");

    const verifier = new DurableStore(path);
    await verifier.reconcile(new Date(AT));
    const intents = verifier.launchIntents();
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.runId, "run-1");
  });
});

test("concurrent result deliveries store exactly one authoritative result", async () => {
  await withTemporaryDirectory("orchestrator-race", async (directory) => {
    const path = join(directory, "state.json");
    const store = new DurableStore(path);
    const clock = steadyClock();
    const service = new LaunchService(store, new FakeAgentAdapter([]), clock);
    const accepted = await service.accept({
      idempotencyKey: "capture-key",
      clientId: "client-1",
      batchName: "capture",
      attribution: ATTRIBUTION,
      prompt: "Do the work",
      workspaceId: "workspace-1",
      workspacePath: "/tmp/capture",
    });
    await store.recordLaunchEvent(accepted.assignmentId, "launching", {
      id: `${accepted.assignmentId}:launch_reserved`, assignmentId: accepted.assignmentId,
      type: "launch_reserved", occurredAt: clock().toISOString(),
    });
    const { assignment } = await store.recordLaunchEvent(accepted.assignmentId, "launched", {
      id: `${accepted.assignmentId}:execution_started`, assignmentId: accepted.assignmentId,
      type: "execution_started", occurredAt: clock().toISOString(), runId: "run-1",
    });

    const result: CapturedResult = {
      deliveryId: "delivery-1",
      deliveryFingerprint: HEX64,
      assignmentId: assignment.id,
      batchId: assignment.batchId,
      sessionId: assignment.sessionId,
      workspaceId: assignment.workspaceId as string,
      workspacePath: assignment.workspacePath,
      attemptId: assignment.attemptId as string,
      attempt: assignment.attempt as number,
      runId: "run-1",
      attribution: { ...ATTRIBUTION },
      claim: { status: "succeeded", completeness: "complete", output: "done" },
      verifiedArtifacts: [],
      capturedAt: AT,
    };

    const writers = Array.from({ length: CONTENDERS }, () => new DurableStore(path));
    const outcomes = await Promise.all(writers.map((writer) => writer.captureResult(result)));
    assert.equal(outcomes.filter(({ duplicate }) => !duplicate).length, 1);

    const verifier = new DurableStore(path);
    await verifier.reconcile(new Date(AT));
    assert.equal(verifier.snapshot().capturedResults?.length, 1);
  });
});

test("concurrent launch bookkeeping records one execution start", async () => {
  await withTemporaryDirectory("orchestrator-race", async (directory) => {
    const path = join(directory, "state.json");
    const store = new DurableStore(path);
    const clock = steadyClock();
    const service = new LaunchService(store, new FakeAgentAdapter([]), clock);
    const accepted = await service.accept({
      idempotencyKey: "events-key",
      clientId: "client-1",
      batchName: "events",
      attribution: ATTRIBUTION,
      prompt: "Do the work",
      workspaceId: "workspace-1",
      workspacePath: "/tmp/events",
    });
    await store.recordLaunchEvent(accepted.assignmentId, "launching", {
      id: `${accepted.assignmentId}:launch_reserved`, assignmentId: accepted.assignmentId,
      type: "launch_reserved", occurredAt: AT,
    });

    const writers = Array.from({ length: CONTENDERS }, () => new DurableStore(path));
    await Promise.all(writers.map((writer) => writer.recordLaunchEvent(accepted.assignmentId, "launched", {
      id: `${accepted.assignmentId}:execution_started`, assignmentId: accepted.assignmentId,
      type: "execution_started", occurredAt: AT, runId: "run-1",
    })));

    const verifier = new DurableStore(path);
    await verifier.reconcile(new Date(AT));
    const events = verifier.snapshot().auditEvents;
    assert.equal(events.filter(({ type }) => type === "execution_started").length, 1,
      "audit events are keyed, so replays never duplicate history");
    assert.equal(verifier.snapshot().assignments[0]?.status, "launched");
  });
});

test("concurrent acceptances of one idempotency key create one assignment", async () => {
  await withTemporaryDirectory("orchestrator-race", async (directory) => {
    const path = join(directory, "state.json");
    const request = {
      idempotencyKey: "accept-key",
      clientId: "client-1",
      batchName: "accept",
      attribution: ATTRIBUTION,
      prompt: "Do the work",
      workspaceId: "workspace-1",
      workspacePath: "/tmp/accept",
    };
    const services = Array.from({ length: CONTENDERS }, () =>
      new LaunchService(new DurableStore(path), new FakeAgentAdapter([]), steadyClock()));

    const acceptances = await Promise.all(services.map((service) => service.accept(request)));
    assert.equal(new Set(acceptances.map(({ assignmentId }) => assignmentId)).size, 1);
    assert.equal(new Set(acceptances.map(({ sessionId }) => sessionId)).size, 1);

    const verifier = new DurableStore(path);
    await verifier.reconcile(new Date(AT));
    assert.equal(verifier.snapshot().assignments.length, 1);
    assert.equal(verifier.snapshot().sessions.length, 1);

    await assert.rejects(
      () => services[0]!.accept({ ...request, prompt: "Different work" }),
      /was already used for a different launch/,
    );
  });
});

test("registry migration targets are validated before any schema change", async () => {
  await withTemporaryDirectory("orchestrator-lease", async (directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      for (const target of [4, -1, 1.5, Number.NaN]) {
        assert.throws(() => storage.migrate(target), /Unsupported schema version/, `target ${target}`);
      }
      assert.throws(() => storage.migrate(1), /Use rollback\(\) to move to an older schema/);
      assert.throws(() => storage.rollback(-1, join(directory, "backup.sqlite")), /non-negative integer/);
      assert.throws(() => storage.rollback(3, join(directory, "backup.sqlite")), /must be below current version/);
      assert.throws(() => storage.backup(join(directory, "registry.sqlite")), /must differ from the live registry/);
    } finally {
      storage.close();
    }

    const memory = new OrchestratorStorage(":memory:");
    try {
      assert.equal(memory.schemaVersion(), 3);
      assert.throws(() => memory.backup(join(directory, "memory-backup.sqlite")), /unavailable for an in-memory registry/);
    } finally {
      memory.close();
    }
  });
});

type BatchContentionOutcome =
  | { type: "result"; ok: true; duplicate: boolean; batchId: string; attributions: Array<{ agent: string; task: string }> }
  | { type: "result"; ok: false; code?: string; error: string };

async function contendForBatchCreation(path: string, conflicting: boolean): Promise<BatchContentionOutcome[]> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = Array.from({ length: CONTENDERS }, (_, index) => new Worker(
    new URL("fixtures/concurrent-durable-store-worker.ts", import.meta.url),
    { execArgv: ["--import", "tsx"], workerData: { path, index, conflicting, gate } },
  ));
  try {
    const ready = workers.map((worker, index) => workerMessage(worker, index, "ready"));
    const results = workers.map((worker, index) => workerMessage<BatchContentionOutcome>(worker, index, "result"));
    await Promise.all(ready);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, CONTENDERS);
    const outcomes = await Promise.all(results);
    await Promise.all(workers.map((worker, index) => workerExit(worker, index)));
    return outcomes;
  } finally {
    await terminateWorkers(workers);
  }
}

function workerMessage<T extends { type: string }>(worker: Worker, index: number, type: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`batch contender ${index} timed out waiting for ${type}`)), 10_000);
    const onMessage = (message: T): void => {
      if (message.type !== type) return;
      clearTimeout(timer);
      worker.off("error", onError);
      resolve(message);
    };
    const onError = (error: Error): void => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      reject(error);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
  });
}

function workerExit(worker: Worker, index: number): Promise<void> {
  if (worker.threadId === -1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`batch contender ${index} did not exit`)), 10_000);
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`batch contender ${index} exited with code ${code}`));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

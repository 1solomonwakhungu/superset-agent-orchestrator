import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchService } from "../src/launch-service.js";
import { OrchestratorStorage } from "../src/storage.js";
import { BatchQueryError, DurableStore, type CapturedResult } from "../src/store.js";
import { steadyClock, withTemporaryDirectory } from "./support/deterministic.js";

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
const LATER = "2026-08-01T00:00:00.000Z";

test("concurrent identical batch creations produce exactly one batch", async () => {
  await withTemporaryDirectory("orchestrator-race", async (directory) => {
    const path = join(directory, "state.json");
    const stores = Array.from({ length: CONTENDERS }, () => new DurableStore(path));
    const assignments = [{ agent: "codex", task: "one" }, { agent: "opencode", task: "two" }];

    const outcomes = await Promise.all(stores.map((store) =>
      store.createBatch("contended", "client-1", assignments, "shared-key", new Date(AT))));

    const created = outcomes.filter(({ duplicate }) => !duplicate);
    assert.equal(created.length, 1, "exactly one caller may create the batch");
    const batchIds = new Set(outcomes.map(({ batch }) => batch.id));
    assert.equal(batchIds.size, 1, "every caller observes the same batch identity");
    for (const outcome of outcomes) {
      assert.deepEqual(
        outcome.sessions.map(({ attribution }) => attribution),
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
    const stores = Array.from({ length: CONTENDERS }, () => new DurableStore(path));

    const outcomes = await Promise.allSettled(stores.map((store, index) =>
      store.createBatch("contended", "client-1", [{ agent: "codex", task: `task-${index}` }], "shared-key", new Date(AT))));

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "only the first distinct request may win the key");
    for (const outcome of outcomes.filter((candidate) => candidate.status === "rejected")) {
      const reason: unknown = outcome.reason;
      assert.ok(reason instanceof BatchQueryError && reason.code === "idempotency_conflict");
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
    const assignment = await store.recordLaunchEvent(accepted.assignmentId, "launched", {
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

test("simultaneous worker threads prove the database writer-lease constraint", async () => {
  await withTemporaryDirectory("orchestrator-lease", async (directory) => {
    const path = join(directory, "registry.sqlite");
    const owner = new OrchestratorStorage(path);
    try {
      seedLeaseFixture(owner);
      owner.close();
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const outcomes = await Promise.all(Array.from({ length: CONTENDERS }, (_, index) =>
        contendForWriterLease(path, `lease-${index}`, barrier, CONTENDERS)));
      assert.equal(outcomes.filter((outcome) => outcome === "acquired").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome === "refused").length, CONTENDERS - 1);

      const verifier = new OrchestratorStorage(path);
      try {
        const active = verifier.database
          .prepare("SELECT id FROM workspace_leases WHERE mode = 'writer' AND released_at IS NULL").all();
        assert.equal(active.length, 1);
      } finally {
        verifier.close();
      }
    } finally {
      try { owner.close(); } catch { /* already closed before worker contention */ }
    }
  });
});

test("expiry alone never releases a writer lease", async () => {
  await withTemporaryDirectory("orchestrator-lease", async (directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      seedLeaseFixture(storage);
      insertLease(storage, "lease-expired", "writer", null, AT, "2026-07-01T00:00:01.000Z");

      assert.throws(
        () => insertLease(storage, "lease-successor", "writer", null),
        /UNIQUE/,
        "an expired but unreleased writer still blocks admission, so recovery fails closed",
      );

      storage.database.prepare("UPDATE workspace_leases SET released_at = ? WHERE id = 'lease-expired'").run(LATER);
      insertLease(storage, "lease-successor", "writer", null);
      assert.equal(storage.database
        .prepare("SELECT COUNT(*) count FROM workspace_leases WHERE mode = 'writer' AND released_at IS NULL")
        .get()?.count, 1);
    } finally {
      storage.close();
    }
  });
});

test("cleanup preserves every unreleased lease, including an expired writer", async () => {
  await withTemporaryDirectory("orchestrator-lease", async (directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      seedLeaseFixture(storage);
      for (const index of [1, 2, 3]) insertLease(storage, `reader-${index}`, "read-only", null);
      assert.equal(storage.database.prepare("SELECT COUNT(*) count FROM workspace_leases").get()?.count, 3);

      assert.throws(() => insertLease(storage, "invalid-mode", "read_write", null), /CHECK/);
      assert.throws(
        () => insertLease(storage, "unknown-batch", "writer", null, AT, LATER, "batch-absent"),
        /FOREIGN KEY/,
        "a lease cannot outlive or precede its batch",
      );

      insertLease(storage, "expired-writer", "writer", null, AT, "2026-07-01T00:00:01.000Z");
      insertLease(storage, "released-reader", "read-only", LATER);
      const summary = storage.cleanup(new Date("2026-07-02T00:00:00.000Z"));
      assert.equal(summary.leasesDeleted, 1, "cleanup reclaims released leases but cannot infer writer death from expiry");
      assert.equal(storage.database.prepare("SELECT COUNT(*) count FROM workspace_leases").get()?.count, 4);
      assert.equal(
        storage.database.prepare("SELECT COUNT(*) count FROM workspace_leases WHERE id = 'expired-writer'").get()?.count,
        1,
      );
    } finally {
      storage.close();
    }
  });
});

test("registry migration targets are validated before any schema change", async () => {
  await withTemporaryDirectory("orchestrator-lease", async (directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      for (const target of [3, -1, 1.5, Number.NaN]) {
        assert.throws(() => storage.migrate(target), /Unsupported schema version/, `target ${target}`);
      }
      assert.throws(() => storage.migrate(1), /Use rollback\(\) to move to an older schema/);
      assert.throws(() => storage.rollback(-1, join(directory, "backup.sqlite")), /non-negative integer/);
      assert.throws(() => storage.rollback(2, join(directory, "backup.sqlite")), /must be below current version/);
      assert.throws(() => storage.backup(join(directory, "registry.sqlite")), /must differ from the live registry/);
    } finally {
      storage.close();
    }

    const memory = new OrchestratorStorage(":memory:");
    try {
      assert.equal(memory.schemaVersion(), 2);
      assert.throws(() => memory.backup(join(directory, "memory-backup.sqlite")), /unavailable for an in-memory registry/);
    } finally {
      memory.close();
    }
  });
});

function seedLeaseFixture(storage: OrchestratorStorage): void {
  storage.database.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("batch-1", "overnight", "solomon", "running", "{}", AT, AT, null);
  storage.database.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("assignment-1", "batch-1", "lease", "prompt", "workspace-1", "PR", AT, null);
  storage.database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("session-1", "assignment-1", "superset", "backend-1", 1, "running", AT, AT, null);
}

function insertLease(
  storage: OrchestratorStorage,
  id: string,
  mode: string,
  releasedAt: string | null,
  acquiredAt = AT,
  expiresAt = LATER,
  batchId = "batch-1",
): void {
  storage.database.prepare("INSERT INTO workspace_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, "workspace-1", mode, "session-1", batchId, acquiredAt, expiresAt, releasedAt);
}

async function contendForWriterLease(
  path: string,
  leaseId: string,
  barrier: SharedArrayBuffer,
  contenders: number,
): Promise<string> {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const barrier = new Int32Array(workerData.barrier);
    const db = new DatabaseSync(workerData.path, { timeout: 5000 });
    const arrived = Atomics.add(barrier, 0, 1) + 1;
    if (arrived === workerData.contenders) {
      Atomics.store(barrier, 1, 1);
      Atomics.notify(barrier, 1, workerData.contenders);
    }
    while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0);
    try {
      db.prepare("INSERT INTO workspace_leases VALUES (?, 'workspace-1', 'writer', 'session-1', 'batch-1', ?, ?, NULL)")
        .run(workerData.leaseId, workerData.at, workerData.later);
      parentPort.postMessage("acquired");
    } catch (error) {
      parentPort.postMessage(String(error).includes("UNIQUE") ? "refused" : { error: String(error) });
    } finally {
      db.close();
    }
  `, { eval: true, workerData: { path, leaseId, barrier, contenders, at: AT, later: LATER } });
  const outcome = await new Promise<string | { error: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`writer contender ${leaseId} timed out`));
    }, 5_000);
    worker.once("message", (message: string | { error: string }) => {
      clearTimeout(timer);
      resolve(message);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`writer contender ${leaseId} exited with code ${code}`));
      }
    });
  });
  if (typeof outcome !== "string") throw new Error(outcome.error);
  return outcome;
}

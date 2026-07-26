import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OrchestratorStorage, WorkspaceWriterBusyError } from "../src/storage.js";
import { WorkspaceSafetyTool } from "../src/workspace-safety.js";

const run = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(projectRoot, "src");

/**
 * Runs writer admission in a separate operating-system process, which is the only
 * way to prove the lock and the durable transaction exclude racing servers rather
 * than merely racing calls inside one Node.js process.
 */
const WORKER = `
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [mode, sourceDirectory, databasePath, lockDirectory, workspaceId, startAt] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(sourceDirectory, name)).href);
const { OrchestratorStorage } = await load("storage.ts");
const { WorkspaceSafetyTool } = await load("workspace-safety.ts");

const storage = new OrchestratorStorage(databasePath);
const tool = new WorkspaceSafetyTool(storage, {
  lockDirectory,
  serverInstanceId: \`server-\${process.pid}\`,
  lockStaleMs: 750,
});

// Spin to the shared barrier so every worker attempts admission at the same instant.
while (Date.now() < Number(startAt)) {}

try {
  let lease;
  let attempts = 0;
  do {
    attempts += 1;
    try {
      lease = tool.acquireWriter({ workspaceId, ownerBatchId: "batch-1", ttlMs: 750 });
    } catch (error) {
      if (mode !== "retry-release" || error.code !== "WORKSPACE_WRITER_BUSY" || attempts >= 500) throw error;
      await delay(10);
    }
  } while (!lease);
  if (mode === "retry-release") {
    await delay(25);
    tool.releaseWriter(lease);
    process.stdout.write(JSON.stringify({ ok: true, generation: lease.generation, pid: process.pid, attempts }));
    tool.close();
    storage.close();
    process.exit(0);
  }
  const bound = tool.bindProcess(lease, process.pid);
  process.stdout.write(JSON.stringify({ ok: true, generation: bound.generation, pid: process.pid }));
  if (mode === "crash") {
    // Terminate without release or cleanup, exactly like a killed owner.
    process.exit(9);
  }
  tool.releaseWriter(bound);
  tool.close();
  storage.close();
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? error.constructor.name }));
  tool.close();
  storage.close();
}
`;

interface WorkerOutcome {
  ok: boolean;
  code?: string;
  generation?: number;
  pid?: number;
  attempts?: number;
}

interface Fixture {
  directory: string;
  databasePath: string;
  lockDirectory: string;
  workerPath: string;
  storage: OrchestratorStorage;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "lease-concurrency-"));
  const databasePath = join(directory, "registry.sqlite");
  const workerPath = join(directory, "writer-worker.mjs");
  await writeFile(workerPath, WORKER, "utf8");
  const storage = new OrchestratorStorage(databasePath);
  storage.database.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("batch-1", "overnight", "solomon", "active", "{}",
      "2026-07-24T00:00:00.000Z", "2026-07-24T00:00:00.000Z", null);
  try {
    await body({ directory, databasePath, lockDirectory: join(directory, "locks"), workerPath, storage });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function spawnWorker(fixture: Fixture, mode: "release" | "crash" | "retry-release",
  startAt: number): Promise<WorkerOutcome> {
  const { stdout } = await run(process.execPath,
    ["--import", "tsx", fixture.workerPath, mode, sourceDirectory, fixture.databasePath,
      fixture.lockDirectory, "ws", String(startAt)],
    { cwd: projectRoot }).catch((error: { stdout?: string; code?: number }) => {
      if (typeof error.stdout === "string" && error.stdout.length > 0) return { stdout: error.stdout };
      throw error;
    });
  return JSON.parse(stdout) as WorkerOutcome;
}

test("simultaneous acquisitions from separate processes yield exactly one writer", async () => {
  await withFixture(async (fixture) => {
    const startAt = Date.now() + 2_000;
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => spawnWorker(fixture, "crash", startAt)));

    const admitted = outcomes.filter((outcome) => outcome.ok);
    assert.equal(admitted.length, 1, `expected one writer, got ${JSON.stringify(outcomes)}`);
    assert.equal(admitted[0]?.generation, 1);
    for (const denied of outcomes.filter((outcome) => !outcome.ok)) {
      assert.equal(denied.code, "WORKSPACE_WRITER_BUSY");
    }

    // Exactly one generation was allocated: losers never consumed a generation.
    assert.equal(fixture.storage.database.prepare(
      "SELECT COUNT(*) count FROM workspace_leases").get()?.count, 1);
    assert.equal(fixture.storage.lastAllocatedGeneration("ws"), 1);
    assert.equal(fixture.storage.database.prepare(
      "SELECT COUNT(*) count FROM events WHERE event_type = 'lease_acquired'").get()?.count, 1);
    assert.equal(fixture.storage.database.prepare(
      "SELECT COUNT(*) count FROM events WHERE event_type = 'policy_denied'").get()?.count, 4);
  });
});

test("a crashed owner keeps its lease until process absence is proven", async () => {
  await withFixture(async (fixture) => {
    const crashed = await spawnWorker(fixture, "crash", Date.now());
    assert.equal(crashed.ok, true);

    const tool = new WorkspaceSafetyTool(fixture.storage, {
      lockDirectory: fixture.lockDirectory,
      serverInstanceId: "server-restarted",
      lockStaleMs: 750,
    });
    try {
      // The dead owner still holds authority: the workspace is not admissible.
      assert.equal(tool.inspect("ws").admissible, false);
      assert.equal(fixture.storage.workspaceLeaseStatus("ws")?.state, "active");
      assert.equal(fixture.storage.workspaceLeaseStatus("ws")?.processId, crashed.pid);
      assert.throws(() => tool.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 30_000 }),
        WorkspaceWriterBusyError);

      // Wait past the lease TTL and the abandoned lock's staleness window.
      await delay(1_500);
      const report = tool.inspect("ws");
      assert.equal(report.ownerProcess, "absent");
      assert.equal(report.lockHeldElsewhere, false);

      tool.recoverWorkspace("ws", "operator");
      assert.equal(fixture.storage.workspaceLeaseStatus("ws")?.state, "released");
      const replacement = tool.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 30_000 });
      assert.equal(replacement.generation, 2);

      const events = fixture.storage.database.prepare(
        "SELECT event_type FROM events ORDER BY sequence").all()
        .map((row) => (row as { event_type: string }).event_type);
      assert.deepEqual(events, ["lease_acquired", "lease_process_bound", "policy_denied",
        "lease_recovered", "lease_acquired"]);
    } finally {
      tool.close();
    }
  });
});

test("contending processes eventually reacquire in distinct monotonic generations", async () => {
  await withFixture(async (fixture) => {
    const startAt = Date.now() + 1_000;
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => spawnWorker(fixture, "retry-release", startAt)));

    assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
    assert.deepEqual(outcomes.map(({ generation }) => generation).sort((a, b) => a! - b!), [1, 2, 3, 4]);
    assert.equal(outcomes.some(({ attempts }) => attempts! > 1), true);
    assert.equal(fixture.storage.lastAllocatedGeneration("ws"), 4);
    assert.equal(fixture.storage.database.prepare(
      "SELECT COUNT(*) count FROM workspace_leases WHERE state = 'released'").get()?.count, 4);
  });
});

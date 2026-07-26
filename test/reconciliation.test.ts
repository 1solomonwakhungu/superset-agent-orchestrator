import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore, type DurableState } from "../src/store.js";

const timestamp = "2026-07-24T10:00:00.000Z";

function fixture(): DurableState {
  return {
    version: 1,
    sessions: [{ id: "session-1", clientId: "lost-client", createdAt: timestamp, lastSeenAt: timestamp }],
    batches: [{ id: "batch-1", name: "overnight", sessionId: "session-1", createdAt: timestamp, updatedAt: timestamp }],
    workers: [
      {
        id: "worker-live",
        batchId: "batch-1",
        sessionId: "session-1",
        pid: 101,
        processStartedAt: "live-token",
        status: "running",
        attribution: { agent: "codex", task: "implement" },
        startedAt: timestamp,
      },
      {
        id: "worker-dead",
        batchId: "batch-1",
        sessionId: "session-1",
        pid: 202,
        processStartedAt: "dead-token",
        status: "running",
        attribution: { agent: "codex", task: "verify" },
        startedAt: timestamp,
      },
      {
        id: "worker-complete",
        batchId: "batch-1",
        sessionId: "session-1",
        status: "succeeded",
        attribution: { agent: "reviewer", task: "review" },
        startedAt: timestamp,
        completedAt: timestamp,
        result: { summary: "verified" },
      },
      {
        id: "worker-orphan",
        batchId: "missing-batch",
        sessionId: "missing-session",
        status: "failed",
        attribution: { agent: "tester", task: "test" },
        startedAt: timestamp,
      },
    ],
    diagnostics: [],
    assignments: [],
    auditEvents: [],
    launchIntents: [],
  };
}

async function withState(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-restart-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify(fixture()), { encoding: "utf8", mode: 0o600 });
  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("server restart recovers durable identities without relaunching workers", async () => {
  await withState(async (path) => {
    const processChecks: number[] = [];
    const store = new DurableStore(path, (pid) => {
      processChecks.push(pid);
      return pid === 101;
    });

    const summary = await store.reconcile(new Date("2026-07-24T11:00:00.000Z"));

    assert.deepEqual(processChecks, [101, 202]);
    assert.deepEqual(summary, {
      sessionsRecovered: 1,
      batchesRecovered: 1,
      workersRecovered: 4,
      runningWorkers: 1,
      diagnosticsAdded: 3,
      reconciledAt: "2026-07-24T11:00:00.000Z",
    });
    assert.equal(store.snapshot().workers.find(({ id }) => id === "worker-live")?.status, "running");
    assert.equal(store.snapshot().workers.find(({ id }) => id === "worker-dead")?.status, "unknown_outcome");
  });
});

test("reopened batches retain worker and response attribution after client loss", async () => {
  await withState(async (path) => {
    const restartedStore = new DurableStore(path, (pid) => pid === 101);
    await restartedStore.reconcile();

    const recovered = restartedStore.reopenBatch("overnight");
    assert.equal(recovered?.batch.id, "batch-1");
    assert.equal(recovered?.session?.clientId, "lost-client");
    assert.deepEqual(
      recovered?.workers.find(({ id }) => id === "worker-complete"),
      fixture().workers.find(({ id }) => id === "worker-complete"),
    );
  });
});

test("reconciliation diagnostics are durable and idempotent across repeated restarts", async () => {
  await withState(async (path) => {
    const firstRestart = new DurableStore(path, (pid) => pid === 101);
    await firstRestart.reconcile(new Date("2026-07-24T11:00:00.000Z"));
    const secondRestart = new DurableStore(path, (pid) => pid === 101);
    const summary = await secondRestart.reconcile(new Date("2026-07-24T12:00:00.000Z"));

    assert.equal(summary.diagnosticsAdded, 0);
    assert.deepEqual(
      secondRestart.diagnostics().map(({ kind, workerId }) => [kind, workerId]).sort(),
      [
        ["missing_result", "worker-orphan"],
        ["orphan", "worker-orphan"],
        ["unknown_outcome", "worker-dead"],
      ],
    );
    const persisted = JSON.parse(await readFile(path, "utf8")) as DurableState;
    assert.equal(persisted.sessions[0]?.id, "session-1");
    assert.equal(persisted.batches[0]?.id, "batch-1");
  });
});

test("corrupt state fails safely instead of discarding durable identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-corrupt-"));
  const path = join(directory, "state.json");
  await writeFile(path, "not-json", { encoding: "utf8", mode: 0o600 });
  try {
    await assert.rejects(new DurableStore(path).reconcile(), /Cannot load orchestrator state/);
    assert.equal(await readFile(path, "utf8"), "not-json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("running state without a process identity fails safely", async () => {
  await withState(async (path) => {
    const state = fixture();
    delete state.workers[0]?.processStartedAt;
    await writeFile(path, JSON.stringify(state), "utf8");

    await assert.rejects(new DurableStore(path).reconcile(), /Running workers require a PID and process start token/);
  });
});

test("valid JSON with stale cross-record identities fails without rewriting state", async () => {
  await withState(async (path) => {
    const state = fixture();
    state.batches[0]!.sessionId = "stale-session-generation";
    const corrupt = JSON.stringify(state);
    await writeFile(path, corrupt, "utf8");

    await assert.rejects(new DurableStore(path).reconcile(), /inconsistent durable identity|(?:missing|unknown) session/);
    assert.equal(await readFile(path, "utf8"), corrupt);
  });
});

test("PID reuse is fenced by the persisted process start token", async () => {
  await withState(async (path) => {
    const observed: Array<[number, string | undefined]> = [];
    const store = new DurableStore(path, (pid, processStartedAt) => {
      observed.push([pid, processStartedAt]);
      return pid === 101 && processStartedAt === "new-generation";
    });

    await store.reconcile(new Date("2026-07-24T11:00:00.000Z"));

    assert.deepEqual(observed, [[101, "live-token"], [202, "dead-token"]]);
    assert.equal(store.snapshot().workers.find(({ id }) => id === "worker-live")?.status, "unknown_outcome");
  });
});

test("startup recovers a durable state lock left by a killed server", async () => {
  await withState(async (path) => {
    await mkdir(`${path}.lock`);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, staleTime, staleTime);
    const store = new DurableStore(path, () => false);

    const summary = await store.reconcile();

    assert.equal(summary.sessionsRecovered, 1);
    assert.equal(store.snapshot().sessions[0]?.id, "session-1");
  });
});

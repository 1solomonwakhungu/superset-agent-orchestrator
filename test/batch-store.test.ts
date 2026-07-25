import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BatchQueryError, DurableStore, type DurableState, type QueryMeasurement } from "../src/store.js";

const timestamp = "2026-07-24T20:00:00.000Z";

async function temporaryStore(observations: QueryMeasurement[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-batch-"));
  const path = join(directory, "state.json");
  const store = new DurableStore(path, () => true, (measurement) => observations.push(measurement), () => 10);
  await store.reconcile(new Date(timestamp));
  return { directory, path, store };
}

test("durably accepts and returns 120 sessions without waiting or scanning unrelated batches", async () => {
  const observations: QueryMeasurement[] = [];
  const fixture = await temporaryStore(observations);
  try {
    const assignments = Array.from({ length: 120 }, (_, index) => ({ agent: `agent-${index}`, task: `task-${index}` }));
    const created = await fixture.store.createBatch("large", "client-1", assignments, "request-1", new Date(timestamp));
    assert.equal(created.sessions.length, 120);
    assert.equal(created.sessions.every(({ status }) => status === "requested"), true);
    assert.equal(new Set(created.sessions.map(({ id }) => id)).size, 120);

    await fixture.store.createBatch("unrelated", "client-1", assignments.slice(0, 30), "request-2", new Date(timestamp));
    const first = await fixture.store.getBatch(created.batch.id);
    assert.deepEqual(first.sessions.map(({ attribution }) => attribution), assignments.slice(0, 100));
    assert.ok(first.nextCursor);
    const second = await fixture.store.getBatch(created.batch.id, { cursor: first.nextCursor });
    assert.deepEqual(second.sessions.map(({ attribution }) => attribution), assignments.slice(100));
    assert.deepEqual(observations.map(({ examined }) => examined), [100, 20]);

    const restarted = new DurableStore(fixture.path);
    await restarted.reconcile(new Date(timestamp));
    const duplicate = await restarted.createBatch("large", "client-1", assignments, "request-1");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.batch.id, created.batch.id);
    assert.deepEqual(duplicate.sessions.map(({ id }) => id), created.sessions.map(({ id }) => id));
    await assert.rejects(
      restarted.createBatch("changed", "client-1", [{ agent: "other", task: "other" }], "request-1"),
      (error) => error instanceof BatchQueryError && error.code === "idempotency_conflict",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("ID queries preserve caller order, report unknown IDs, and reject duplicates", async () => {
  const observations: QueryMeasurement[] = [];
  const fixture = await temporaryStore(observations);
  try {
    const created = await fixture.store.createBatch("ids", "client", [
      { agent: "one", task: "first" }, { agent: "two", task: "second" }, { agent: "three", task: "third" },
    ]);
    const ids = created.sessions.map(({ id }) => id);
    const page = await fixture.store.getBatch(created.batch.id, { ids: [ids[2]!, "unknown", ids[0]!] });
    assert.deepEqual(page.sessions.map(({ id }) => id), [ids[2], ids[0]]);
    assert.deepEqual(page.unknownIds, ["unknown"]);
    assert.equal(observations.at(-1)?.examined, 3);
    await assert.rejects(
      fixture.store.getBatch(created.batch.id, { ids: [ids[0]!, ids[0]!] }),
      (error) => error instanceof BatchQueryError && error.code === "duplicate_ids",
    );
    await assert.rejects(
      fixture.store.getBatch("missing"),
      (error) => error instanceof BatchQueryError && error.code === "not_found",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("mixed states expose completed results independently with exact attribution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-results-"));
  const path = join(directory, "state.json");
  const state: DurableState = {
    version: 1,
    sessions: [{ id: "owner", clientId: "client", createdAt: timestamp, lastSeenAt: timestamp }],
    batches: [{ id: "batch", name: "mixed", sessionId: "owner", createdAt: timestamp, updatedAt: timestamp }],
    workers: [
      { id: "requested", batchId: "batch", sessionId: "owner", position: 0, status: "requested", attribution: { agent: "a", task: "pending" }, startedAt: timestamp },
      { id: "success", batchId: "batch", sessionId: "owner", position: 1, status: "succeeded", attribution: { agent: "b", task: "done" }, startedAt: timestamp, completedAt: timestamp, result: { value: 1 } },
      { id: "failure", batchId: "batch", sessionId: "owner", position: 2, status: "failed", attribution: { agent: "c", task: "failed" }, startedAt: timestamp, completedAt: timestamp, result: { error: "boom" } },
      { id: "unknown", batchId: "batch", sessionId: "owner", position: 3, status: "unknown_outcome", attribution: { agent: "d", task: "lost" }, startedAt: timestamp, completedAt: timestamp },
    ],
    diagnostics: [],
    assignments: [],
    auditEvents: [],
    launchIntents: [],
  };
  await writeFile(path, JSON.stringify(state), "utf8");
  const store = new DurableStore(path);
  try {
    await store.reconcile(new Date(timestamp));
    const status = await store.batchStatus("batch");
    assert.deepEqual(status.summary, {
      total: 4, settled: 3, complete: false, partiallyComplete: true,
      counts: { requested: 1, running: 0, canceling: 0, succeeded: 1, failed: 1, canceled: 0, unknown_outcome: 1 },
    });
    const results = await store.batchResults("batch");
    assert.deepEqual(results.results.map(({ sessionId, batchId, attribution, result }) => ({ sessionId, batchId, attribution, result })), [
      { sessionId: "success", batchId: "batch", attribution: { agent: "b", task: "done" }, result: { value: 1 } },
      { sessionId: "failure", batchId: "batch", attribution: { agent: "c", task: "failed" }, result: { error: "boom" } },
    ]);
    assert.deepEqual(results.unavailable, [
      { sessionId: "requested", status: "requested" }, { sessionId: "unknown", status: "unknown_outcome" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cursors are batch-bound and ordering remains deterministic without positions", async () => {
  const fixture = await temporaryStore();
  try {
    const first = await fixture.store.createBatch("first", "client", Array.from({ length: 3 }, (_, index) => ({ agent: "a", task: String(index) })));
    const second = await fixture.store.createBatch("second", "client", [{ agent: "b", task: "x" }]);
    const page = await fixture.store.getBatch(first.batch.id, { limit: 1 });
    assert.ok(page.nextCursor);
    const cursor = page.nextCursor!;
    await assert.rejects(
      fixture.store.getBatch(second.batch.id, { cursor }),
      (error) => error instanceof BatchQueryError && error.code === "invalid_cursor",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

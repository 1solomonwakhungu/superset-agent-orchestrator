import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestratorStorage } from "../src/storage.js";

test("repositories persist and retrieve every durable entity transactionally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-repositories-"));
  const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
  const at = "2026-07-24T20:00:00.000Z";
  try {
    storage.transaction(() => {
      storage.repositories.batches.insert({ id: "batch", name: "overnight", requester: "solomon", status: "running", policy: { concurrency: 1 }, createdAt: at, updatedAt: at, terminalAt: null });
      storage.repositories.assignments.insert({ id: "assignment", batchId: "batch", label: "storage", prompt: "implement", workspaceId: "workspace", expectedOutput: "PR", createdAt: at, payloadPurgedAt: null });
      storage.repositories.sessions.insert({ id: "session", assignmentId: "assignment", backend: "superset", backendSessionId: "backend", attempt: 1, state: "running", createdAt: at, updatedAt: at, terminalAt: null });
      storage.repositories.results.insert({ id: "result", sessionId: "session", body: "complete", artifacts: ["pr"], stopReason: "completed", capturedAt: at, payloadPurgedAt: null });
      storage.repositories.events.append({ id: "event", aggregateType: "session", aggregateId: "session", eventType: "result.captured", actor: "system", data: { resultId: "result" }, occurredAt: at });
      storage.repositories.workspaceLeases.insert({ id: "lease", workspaceId: "workspace", mode: "writer", ownerSessionId: "session", ownerBatchId: "batch", acquiredAt: at, expiresAt: "2026-07-25T20:00:00.000Z", releasedAt: null });
      storage.repositories.idempotency.insert({ scope: "launch", key: "key", requestHash: "hash", response: { sessionId: "session" }, resourceType: "session", resourceId: "session", createdAt: at, expiresAt: "2026-07-25T20:00:00.000Z" });
    });

    assert.deepEqual(storage.repositories.batches.get("batch")?.policy, { concurrency: 1 });
    assert.equal(storage.repositories.assignments.listByBatch("batch")[0]?.id, "assignment");
    assert.equal(storage.repositories.sessions.listByAssignment("assignment")[0]?.id, "session");
    assert.deepEqual(storage.repositories.results.getBySession("session")?.artifacts, ["pr"]);
    assert.deepEqual(storage.repositories.events.list("session", "session")[0]?.data, { resultId: "result" });
    assert.equal(storage.repositories.workspaceLeases.activeWriter("workspace")?.id, "lease");
    assert.deepEqual(storage.repositories.idempotency.get("launch", "key")?.response, { sessionId: "session" });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository transaction rolls back entities and events together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-transaction-"));
  const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
  const at = "2026-07-24T20:00:00.000Z";
  try {
    assert.throws(() => storage.transaction(() => {
      storage.repositories.batches.insert({ id: "batch", name: "overnight", requester: "solomon", status: "running", policy: {}, createdAt: at, updatedAt: at, terminalAt: null });
      storage.repositories.events.append({ id: "event", aggregateType: "batch", aggregateId: "batch", eventType: "batch.created", actor: "system", data: {}, occurredAt: at });
      throw new Error("fail after writes");
    }), /fail after writes/);
    assert.equal(storage.repositories.batches.get("batch"), undefined);
    assert.equal(storage.repositories.events.get("event"), undefined);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository reads fail closed on malformed durable JSON", async () => {
  const storage = new OrchestratorStorage(":memory:");
  try {
    storage.database.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("batch", "name", "requester", "running", "{", "now", "now", null);
    assert.throws(() => storage.repositories.batches.get("batch"), /Corrupt batch policy_json/);
  } finally { storage.close(); }
});

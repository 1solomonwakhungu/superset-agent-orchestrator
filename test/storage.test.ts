import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, OrchestratorStorage } from "../src/storage.js";

async function temporaryDirectory(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-storage-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function seed(storage: OrchestratorStorage, terminalAt = "2026-05-01T00:00:00.000Z"): void {
  const db = storage.database;
  db.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "batch-1", "overnight", "solomon", "completed", "{}", terminalAt, terminalAt, terminalAt,
  );
  db.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "assignment-1", "batch-1", "storage", "secret prompt", "workspace-1", "PR", terminalAt, null,
  );
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "session-1", "assignment-1", "superset", "backend-1", 1, "completed", terminalAt, terminalAt, terminalAt,
  );
  db.prepare("INSERT INTO results VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "result-1", "session-1", "exact answer", "[]", "completed", terminalAt, null,
  );
  storage.appendEvent({ aggregateType: "session", aggregateId: "session-1", eventType: "session.completed", actor: "adapter" });
}

test("creates and migrates an empty product-owned registry", async () => {
  await temporaryDirectory((directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      assert.equal(storage.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.deepEqual(storage.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
        .map((row) => (row as { name: string }).name),
      ["assignments", "batches", "events", "idempotency_records", "results", "schema_migrations", "sessions", "sqlite_sequence", "workspace_leases"]);
      assert.equal(storage.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    } finally { storage.close(); }
  });
});

test("migrates a prior schema without losing attribution or history", async () => {
  await temporaryDirectory((directory) => {
    const path = join(directory, "registry.sqlite");
    const prior = new OrchestratorStorage(path);
    prior.rollback(1, join(directory, "before-rollback.sqlite"));
    seed(prior);
    prior.close();
    const upgraded = new OrchestratorStorage(path);
    try {
      assert.equal(upgraded.schemaVersion(), 2);
      assert.equal(upgraded.database.prepare("SELECT requester FROM batches WHERE id = 'batch-1'").get()?.requester, "solomon");
      assert.equal(upgraded.database.prepare("SELECT event_type FROM events").get()?.event_type, "session.completed");
    } finally { upgraded.close(); }
  });
});

test("requires a verified backup before rollback and can migrate forward again", async () => {
  await temporaryDirectory((directory) => {
    const path = join(directory, "registry.sqlite");
    const backup = join(directory, "rollback-backup.sqlite");
    const storage = new OrchestratorStorage(path);
    try {
      storage.rollback(1, backup);
      assert.equal(storage.schemaVersion(), 1);
      storage.migrate();
      assert.equal(storage.schemaVersion(), 2);
      const restored = new DatabaseSync(backup, { readOnly: true });
      assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      restored.close();
    } finally { storage.close(); }
  });
});

test("enforces foreign keys, unique writer leases, and append-only events", async () => {
  await temporaryDirectory((directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      seed(storage);
      assert.throws(() => storage.database.prepare("DELETE FROM batches WHERE id = 'batch-1'").run(), /FOREIGN KEY/);
      storage.database.prepare("INSERT INTO workspace_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "lease-1", "workspace-1", "writer", "session-1", "batch-1", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", null,
      );
      assert.throws(() => storage.database.prepare("INSERT INTO workspace_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "lease-2", "workspace-1", "writer", "session-1", "batch-1", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", null,
      ), /UNIQUE/);
      assert.throws(() => storage.database.prepare("UPDATE events SET actor = 'other'").run(), /append-only/);
      assert.throws(() => storage.database.prepare("DELETE FROM events").run(), /append-only/);
    } finally { storage.close(); }
  });
});

test("cleanup redacts payloads but preserves attribution and immutable history", async () => {
  await temporaryDirectory((directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      seed(storage);
      storage.database.prepare("INSERT INTO idempotency_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "launch", "key-1", "hash", "{}", "session", "session-1", "2026-05-01T00:00:00.000Z", "2026-05-08T00:00:00.000Z",
      );
      storage.database.prepare("INSERT INTO workspace_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "lease-1", "workspace-1", "writer", "session-1", "batch-1", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", null,
      );
      assert.deepEqual(storage.cleanup(new Date("2026-07-24T00:00:00.000Z")), {
        assignmentsRedacted: 1, resultsRedacted: 1, idempotencyDeleted: 1, leasesDeleted: 1,
      });
      assert.equal(storage.database.prepare("SELECT prompt FROM assignments").get()?.prompt, null);
      assert.equal(storage.database.prepare("SELECT body FROM results").get()?.body, null);
      assert.equal(storage.database.prepare("SELECT requester FROM batches").get()?.requester, "solomon");
      assert.deepEqual(storage.database.prepare("SELECT event_type FROM events ORDER BY sequence").all()
        .map((row) => (row as { event_type: string }).event_type), ["session.completed", "retention.cleanup_completed"]);
    } finally { storage.close(); }
  });
});

test("exports a portable snapshot and creates a verified online backup", async () => {
  await temporaryDirectory(async (directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    const exportPath = join(directory, "export.json");
    const backupPath = join(directory, "backup.sqlite");
    try {
      seed(storage);
      storage.exportJson(exportPath);
      storage.backup(backupPath);
      const exported = JSON.parse(await readFile(exportPath, "utf8")) as { schemaVersion: number; tables: { sessions: unknown[] } };
      assert.equal(exported.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(exported.tables.sessions.length, 1);
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      assert.equal(backup.prepare("SELECT body FROM results").get()?.body, "exact answer");
      backup.close();
    } finally { storage.close(); }
  });
});

test("corruption fails closed without replacing the original bytes", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "registry.sqlite");
    const corrupt = Buffer.from("not a sqlite database");
    await writeFile(path, corrupt);
    assert.throws(() => new OrchestratorStorage(path), /Cannot open orchestrator registry/);
    assert.deepEqual(await readFile(path), corrupt);
  });
});

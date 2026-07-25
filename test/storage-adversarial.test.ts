import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { OrchestratorStorage } from "../src/storage.js";

async function fixture(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "per-348-storage-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("a forged current migration version with missing schema fails closed", async () => {
  await fixture((directory) => {
    const path = join(directory, "registry.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    database.prepare("INSERT INTO schema_migrations VALUES (2, ?)").run(new Date().toISOString());
    database.close();
    assert.throws(() => new OrchestratorStorage(path), /noncontiguous|incomplete/);
  });
});

test("migration object conflicts roll back the whole migration", async () => {
  await fixture((directory) => {
    const path = join(directory, "registry.sqlite");
    const storage = new OrchestratorStorage(path);
    storage.rollback(1, join(directory, "backup.sqlite"));
    storage.database.exec("CREATE TABLE workspace_leases(id TEXT PRIMARY KEY) STRICT");
    assert.throws(() => storage.migrate(), /already exists/);
    assert.equal(storage.schemaVersion(), 1);
    assert.equal(storage.database.prepare("SELECT name FROM sqlite_schema WHERE name = 'idempotency_records'").get(), undefined);
    storage.close();
  });
});

test("retention never revokes an unreleased writer solely because its lease expired", async () => {
  await fixture((directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    storage.database.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("batch", "fixture", "test", "running", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null);
    storage.database.prepare("INSERT INTO workspace_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("lease", "workspace", "writer", null, "batch", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", null);
    const summary = storage.cleanup(new Date("2026-07-24T00:00:00.000Z"));
    assert.equal(summary.leasesDeleted, 0);
    assert.equal(storage.database.prepare("SELECT id FROM workspace_leases").get()?.id, "lease");
    storage.close();
  });
});

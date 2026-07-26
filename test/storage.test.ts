import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { CURRENT_SCHEMA_VERSION, OrchestratorStorage } from "../src/storage.js";
import { terminateWorkers } from "./support/deterministic.js";

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

const permissions = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const assertOwnedByEffectiveUser = async (path: string): Promise<void> => {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid !== undefined) assert.equal((await stat(path)).uid, effectiveUid);
};

function concurrentExportWorker(database: string, output: string): { worker: Worker; ready: Promise<void>; result: Promise<{ ok: boolean; error?: string }> } {
  const worker = new Worker(new URL("fixtures/concurrent-storage-export-worker.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    workerData: { database, output },
  });
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("message", (message) => message === "ready" ? resolve() : reject(new Error(`unexpected worker message: ${String(message)}`)));
    worker.once("error", reject);
  });
  const result = ready.then(() => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  }));
  return { worker, ready, result };
}

test("creates and migrates an empty product-owned registry", async () => {
  await temporaryDirectory((directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      assert.equal(storage.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.deepEqual(storage.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
        .map((row) => (row as { name: string }).name),
      ["assignments", "batches", "events", "idempotency_records", "results", "schema_migrations", "sessions", "sqlite_sequence", "workspace_fencing", "workspace_leases"]);
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
      assert.equal(upgraded.schemaVersion(), CURRENT_SCHEMA_VERSION);
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
      assert.equal(storage.schemaVersion(), CURRENT_SCHEMA_VERSION);
      const restored = new DatabaseSync(backup, { readOnly: true });
      assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      restored.close();
    } finally { storage.close(); }
  });
});

test("enforces foreign keys and append-only events", async () => {
  await temporaryDirectory((directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      seed(storage);
      assert.throws(() => storage.database.prepare("DELETE FROM batches WHERE id = 'batch-1'").run(), /FOREIGN KEY/);
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
      const lease = storage.acquireWriterLease({ workspaceId: "workspace-1", ownerSessionId: "session-1",
        ownerBatchId: "batch-1", ttlMs: 1, now: new Date("2026-05-01T00:00:00.000Z") });
      assert.deepEqual(storage.cleanup(new Date("2026-07-24T00:00:00.000Z")), {
        assignmentsRedacted: 1, resultsRedacted: 1, idempotencyDeleted: 1, leasesDeleted: 0,
      });
      assert.equal(storage.workspaceLeaseStatus("workspace-1")?.state, "active");
      assert.equal(storage.database.prepare("SELECT prompt FROM assignments").get()?.prompt, null);
      assert.equal(storage.database.prepare("SELECT body FROM results").get()?.body, null);
      assert.equal(storage.database.prepare("SELECT requester FROM batches").get()?.requester, "solomon");
      assert.equal(storage.database.prepare("SELECT id FROM workspace_leases").get()?.id, lease.leaseId);
      assert.deepEqual(storage.database.prepare("SELECT event_type FROM events ORDER BY sequence").all()
        .map((row) => (row as { event_type: string }).event_type),
      ["session.completed", "lease_acquired", "retention.cleanup_completed"]);
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
    await chmod(path, 0o600);
    assert.throws(() => new OrchestratorStorage(path), /Cannot open orchestrator registry/);
    assert.deepEqual(await readFile(path), corrupt);
  });
});

test("startup and integrity checks reject altered schema definitions", async () => {
  await temporaryDirectory((directory) => {
    const path = join(directory, "registry.sqlite");
    const storage = new OrchestratorStorage(path);
    storage.close();
    const mutation = new DatabaseSync(path);
    mutation.exec("DROP TRIGGER events_no_update; CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT 1; END;");
    mutation.close();
    const report = OrchestratorStorage.checkIntegrity(path);
    assert.equal(report.ok, false);
    assert.match(report.schemaErrors.join("\n"), /definition mismatch for trigger events_no_update/);
    assert.throws(() => new OrchestratorStorage(path), /schema validation failed/);
  });
});

test("read-only export rejects an older schema without upgrading it", async () => {
  await temporaryDirectory((directory) => {
    const path = join(directory, "registry.sqlite");
    const storage = new OrchestratorStorage(path);
    storage.rollback(1, join(directory, "backup.sqlite"));
    storage.close();
    assert.throws(() => OrchestratorStorage.exportJson(path, join(directory, "export.json")), /expected schema version 3, found 1/);
    const source = new DatabaseSync(path, { readOnly: true });
    assert.equal(source.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version, 1);
    assert.equal(source.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name = 'workspace_leases'").get()?.count, 0);
    source.close();
  });
});

test("startup rejects an altered prior schema before applying migrations", async () => {
  await temporaryDirectory((directory) => {
    const path = join(directory, "registry.sqlite");
    const storage = new OrchestratorStorage(path);
    storage.rollback(1, join(directory, "backup.sqlite"));
    storage.close();
    const mutation = new DatabaseSync(path);
    mutation.exec("DROP TRIGGER events_no_delete; CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT 1; END;");
    mutation.close();
    assert.throws(() => new OrchestratorStorage(path), /schema validation failed before migration/);
    const source = new DatabaseSync(path, { readOnly: true });
    assert.equal(source.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version, 1);
    assert.equal(source.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name = 'workspace_leases'").get()?.count, 0);
    source.close();
  });
});

test("startup rejects prior foreign key corruption before applying migrations", async () => {
  await temporaryDirectory((directory) => {
    const path = join(directory, "registry.sqlite");
    const storage = new OrchestratorStorage(path);
    storage.rollback(1, join(directory, "backup.sqlite"));
    storage.close();
    const mutation = new DatabaseSync(path);
    mutation.exec("PRAGMA foreign_keys = OFF");
    mutation.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "orphan", "missing-batch", "storage", null, "workspace-1", null, "2026-07-26T00:00:00.000Z", null,
    );
    mutation.close();
    assert.throws(() => new OrchestratorStorage(path), /foreign key validation failed before migration/);
    const source = new DatabaseSync(path, { readOnly: true });
    assert.equal(source.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version, 1);
    assert.equal(source.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name = 'workspace_leases'").get()?.count, 0);
    source.close();
  });
});

test("rejects invalid retention durations before opening storage", () => {
  for (const resultRetentionDays of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new OrchestratorStorage(":memory:", { resultRetentionDays }), /finite non-negative/);
  }
  for (const idempotencyRetentionDays of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new OrchestratorStorage(":memory:", { idempotencyRetentionDays }), /finite non-negative/);
  }
});

test("invalid retention configuration does not touch a file-backed path", async () => {
  await temporaryDirectory(async (directory) => {
    const registryDirectory = join(directory, "untouched");
    const path = join(registryDirectory, "registry.sqlite");
    assert.throws(() => new OrchestratorStorage(path, { resultRetentionDays: -1 }), /finite non-negative/);
    await assert.rejects(stat(registryDirectory), /ENOENT/);
  });
});

test("rollback refuses a logically invalid backup before changing the schema", async () => {
  await temporaryDirectory((directory) => {
    const path = join(directory, "registry.sqlite");
    const storage = new OrchestratorStorage(path);
    try {
      storage.database.exec("PRAGMA foreign_keys = OFF");
      storage.database.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "orphan", "missing-batch", "storage", null, "workspace-1", null, "2026-07-26T00:00:00.000Z", null,
      );
      assert.throws(() => storage.rollback(1, join(directory, "invalid-backup.sqlite")), /Backup integrity check failed/);
      assert.equal(storage.schemaVersion(), CURRENT_SCHEMA_VERSION);
      assert.equal(storage.database.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name = 'workspace_leases'").get()?.count, 1);
    } finally { storage.close(); }
  });
});

test("registry, sidecars, backups, and exports stay owner-only under a permissive umask", async () => {
  await temporaryDirectory(async (directory) => {
    const previousUmask = process.umask(0o022);
    try {
      const registryDirectory = join(directory, "private-registry");
      const backupDirectory = join(directory, "private-backup");
      const exportDirectory = join(directory, "private-export");
      const path = join(registryDirectory, "registry.sqlite");
      const storage = new OrchestratorStorage(path);
      try {
        seed(storage);
        const backupPath = join(backupDirectory, "backup.sqlite");
        const exportPath = join(exportDirectory, "export.json");
        storage.backup(backupPath);
        OrchestratorStorage.exportJson(path, exportPath);
        assert.equal(await permissions(registryDirectory), 0o700);
        assert.equal(await permissions(backupDirectory), 0o700);
        assert.equal(await permissions(exportDirectory), 0o700);
        assert.equal(await permissions(path), 0o600);
        assert.equal(await permissions(`${path}-wal`), 0o600);
        assert.equal(await permissions(`${path}-shm`), 0o600);
        assert.equal(await permissions(backupPath), 0o600);
        assert.equal(await permissions(exportPath), 0o600);
        for (const artifact of [registryDirectory, backupDirectory, exportDirectory, path, `${path}-wal`, `${path}-shm`, backupPath, exportPath]) {
          await assertOwnedByEffectiveUser(artifact);
        }
      } finally { storage.close(); }
    } finally { process.umask(previousUmask); }
  });
});

test("preexisting permissive parents are never chmodded and fail closed", async () => {
  await temporaryDirectory(async (directory) => {
    const registryDirectory = join(directory, "permissive-registry");
    const outputDirectory = join(directory, "permissive-output");
    await mkdir(registryDirectory, { mode: 0o755 });
    await mkdir(outputDirectory, { mode: 0o755 });
    await chmod(registryDirectory, 0o755);
    await chmod(outputDirectory, 0o755);
    const path = join(registryDirectory, "registry.sqlite");
    assert.throws(() => new OrchestratorStorage(path), /must already be owner-only/);
    assert.equal(await permissions(registryDirectory), 0o755);
    await assert.rejects(stat(path), /ENOENT/);

    const privateDirectory = join(directory, "private-registry");
    const privatePath = join(privateDirectory, "registry.sqlite");
    const storage = new OrchestratorStorage(privatePath);
    try {
      assert.throws(() => storage.backup(join(outputDirectory, "backup.sqlite")), /must already be owner-only/);
      assert.throws(() => OrchestratorStorage.exportJson(privatePath, join(outputDirectory, "export.json")), /must already be owner-only/);
      assert.equal(await permissions(outputDirectory), 0o755);
      await assert.rejects(stat(join(outputDirectory, "backup.sqlite")), /ENOENT/);
      await assert.rejects(stat(join(outputDirectory, "export.json")), /ENOENT/);
    } finally { storage.close(); }
  });
});

test("existing permissive registry files fail closed inside a private directory and symlinks fail closed", async () => {
  await temporaryDirectory(async (directory) => {
    const registryDirectory = join(directory, "registry");
    const path = join(registryDirectory, "registry.sqlite");
    const initial = new OrchestratorStorage(path);
    initial.close();
    await chmod(path, 0o644);
    assert.throws(() => new OrchestratorStorage(path), /must already be owner-only/);
    assert.equal(await permissions(registryDirectory), 0o700);
    assert.equal(await permissions(path), 0o644);
    const linkPath = join(directory, "registry-link.sqlite");
    await import("node:fs/promises").then(({ symlink }) => symlink(path, linkPath));
    assert.throws(() => new OrchestratorStorage(linkPath), /regular non-symlink file/);
  });
});

test("reserved, aliased, and dangling output paths fail closed", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "registry.sqlite");
    const storage = new OrchestratorStorage(path);
    try {
      assert.throws(() => storage.exportJson(path), /Destination must differ/);
      assert.throws(() => storage.exportJson(`${path}-wal`), /SQLite sidecars/);
      assert.throws(() => storage.backup(`${path}-journal`), /SQLite sidecars/);
      const alias = join(directory, "registry-alias.sqlite");
      await import("node:fs/promises").then(({ link }) => link(path, alias));
      assert.throws(() => storage.exportJson(alias), /aliases the live registry/);
      const walAlias = join(directory, "wal-alias.sqlite");
      await import("node:fs/promises").then(({ link }) => link(`${path}-wal`, walAlias));
      const sourceMode = await permissions(`${path}-wal`);
      assert.throws(() => storage.exportJson(walAlias), /SQLite sidecar/);
      assert.throws(() => storage.backup(walAlias), /SQLite sidecar/);
      assert.equal(await permissions(`${path}-wal`), sourceMode);
      assert.equal(await permissions(walAlias), sourceMode);
      const dangling = join(directory, "dangling-export.json");
      await import("node:fs/promises").then(({ symlink }) => symlink(join(directory, "missing"), dangling));
      assert.throws(() => storage.exportJson(dangling), /non-symlink/);
    } finally { storage.close(); }
  });
});

test("preexisting backup and export destinations remain byte-for-byte and mode-for-mode unchanged", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "registry.sqlite");
    const storage = new OrchestratorStorage(path);
    try {
      const backupPath = join(directory, "existing-backup.sqlite");
      const exportPath = join(directory, "existing-export.json");
      const original = Buffer.from("unrelated existing bytes");
      await writeFile(backupPath, original, { mode: 0o640 });
      await writeFile(exportPath, original, { mode: 0o640 });
      await chmod(backupPath, 0o640);
      await chmod(exportPath, 0o640);
      assert.throws(() => storage.backup(backupPath), /already exists/);
      assert.throws(() => OrchestratorStorage.exportJson(path, exportPath), /already exists/);
      for (const destination of [backupPath, exportPath]) {
        assert.deepEqual(await readFile(destination), original);
        assert.equal(await permissions(destination), 0o640);
      }
    } finally { storage.close(); }
  });
});

test("concurrent static exports publish exactly one owner-only valid output", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "registry.sqlite");
    const outputDirectory = join(directory, "exports");
    const output = join(outputDirectory, "snapshot.json");
    const storage = new OrchestratorStorage(path);
    seed(storage);
    storage.close();
    await mkdir(outputDirectory, { mode: 0o700 });
    const first = concurrentExportWorker(path, output);
    const second = concurrentExportWorker(path, output);
    let results: Array<{ ok: boolean; error?: string }>;
    try {
      await Promise.all([first.ready, second.ready]);
      first.worker.postMessage("start");
      second.worker.postMessage("start");
      results = await Promise.all([first.result, second.result]);
    } finally {
      await terminateWorkers([first.worker, second.worker]);
    }
    assert.equal(results.filter(({ ok }) => ok).length, 1);
    assert.equal(results.filter(({ ok }) => !ok).length, 1);
    assert.match(results.find(({ ok }) => !ok)?.error ?? "", /EEXIST|already exists/);
    assert.equal(await permissions(output), 0o600);
    const exported = JSON.parse(await readFile(output, "utf8")) as { format: string; schemaVersion: number; tables: { batches: unknown[] } };
    assert.equal(exported.format, "superset-agent-orchestrator-export");
    assert.equal(exported.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(exported.tables.batches.length, 1);
  });
});

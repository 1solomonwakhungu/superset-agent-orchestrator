import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OrchestratorStorage } from "../src/storage.js";

const execute = promisify(execFile);

test("storage CLI exports state and reports full integrity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-storage-cli-"));
  const database = join(directory, "registry.sqlite");
  const output = join(directory, "export.json");
  const storage = new OrchestratorStorage(database);
  storage.close();
  try {
    const integrity = await execute(process.execPath, ["dist/src/storage-cli.js", "integrity-check", "--database", database]);
    assert.equal(JSON.parse(integrity.stdout).ok, true);
    await execute(process.execPath, ["dist/src/storage-cli.js", "export", "--database", database, "--output", output]);
    assert.equal(JSON.parse(await readFile(output, "utf8")).format, "superset-agent-orchestrator-export");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("integrity command fails closed without modifying corrupt state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-corrupt-cli-"));
  const database = join(directory, "registry.sqlite");
  const original = Buffer.from("not sqlite");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(database, original));
  try {
    await assert.rejects(execute(process.execPath, ["dist/src/storage-cli.js", "integrity-check", "--database", database]));
    assert.deepEqual(await readFile(database), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

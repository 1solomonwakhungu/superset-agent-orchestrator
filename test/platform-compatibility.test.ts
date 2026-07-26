import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/store.js";
import { SecurityError } from "../src/security.js";
import { runProcess, SupersetDiscoveryError } from "../src/superset-discovery.js";

test("durable state supports nested paths with spaces and non-ASCII characters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator portability "));
  const stateDirectory = join(directory, "nested state", "unicode-\u03bb");
  const statePath = join(stateDirectory, "state file.json");
  try {
    const store = new DurableStore(statePath);
    await store.createBatch("portable-one", "portable-client", [{ agent: "fake", task: "one" }]);
    await store.createBatch("portable-two", "portable-client", [{ agent: "fake", task: "two" }]);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { sessions: unknown[] };
    assert.equal(persisted.sessions.length, 2);
    assert.deepEqual((await readdir(stateDirectory)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real process runner preserves literal arguments and separates output", async () => {
  const literal = "space ; $HOME [brackets]";
  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic')",
    literal,
  ], 5_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, literal);
  assert.equal(result.stderr, "diagnostic");
});

test("real process runner reports missing executables and timeouts", async () => {
  await assert.rejects(
    runProcess(join(tmpdir(), `missing-orchestrator-command-${process.pid}`), [], 1_000),
    (error: unknown) => error instanceof SecurityError && error.code === "POLICY_DENIED",
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 50),
    (error: unknown) => error instanceof SupersetDiscoveryError && error.code === "TIMED_OUT",
  );
});

test("process identity is stable for the current process and absent for an impossible PID", () => {
  const first = DurableStore.processStartedAt(process.pid);
  assert.ok(first);
  assert.equal(DurableStore.processStartedAt(process.pid), first);
  assert.equal(DurableStore.processStartedAt(999_999), undefined);
});

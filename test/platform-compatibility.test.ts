import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/store.js";
import { SecurityError } from "../src/security.js";
import {
  runProcess,
  SupersetDiscoveryAdapter,
  SupersetDiscoveryError,
} from "../src/superset-discovery.js";

const NODE_FIXTURE_DIRECTORY = await mkdtemp(join(tmpdir(), "orchestrator-portable-node-"));
const NODE_EXECUTABLE = join(NODE_FIXTURE_DIRECTORY, "node");
await copyFile(process.execPath, NODE_EXECUTABLE);
await chmod(NODE_EXECUTABLE, 0o700);
test.after(async () => rm(NODE_FIXTURE_DIRECTORY, { recursive: true, force: true }));

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
  const result = await runProcess(NODE_EXECUTABLE, [
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
    runProcess(NODE_EXECUTABLE, ["-e", "setInterval(() => {}, 1000)"], 50),
    (error: unknown) => error instanceof SupersetDiscoveryError && error.code === "TIMED_OUT",
  );
});

test("a discovery timeout terminates descendant processes", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-discovery-timeout-"));
  const ready = join(directory, "descendant-started");
  const marker = join(directory, "descendant-survived");
  const fixture = join(directory, "parent.mjs");
  const descendant = `
    require("node:fs").writeFileSync(${JSON.stringify(ready)}, "started");
    setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 500);
  `;
  await writeFile(fixture, `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `);

  try {
    const result = runProcess(NODE_EXECUTABLE, [fixture], 300);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await access(ready).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await access(ready);
    await assert.rejects(
      result,
      (error: unknown) => error instanceof SupersetDiscoveryError && error.code === "TIMED_OUT",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed parallel discovery command terminates sibling process trees", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-discovery-siblings-"));
  const fixture = join(directory, "discovery.mjs");
  const workspaceReady = join(directory, "workspace-started");
  const agentReady = join(directory, "agent-started");
  const workspaceMarker = join(directory, "workspace-survived");
  const agentMarker = join(directory, "agent-survived");
  await writeFile(fixture, `
    import { existsSync } from "node:fs";
    import { spawn } from "node:child_process";
    const command = process.argv[2];
    const files = {
      workspaces: [${JSON.stringify(workspaceReady)}, ${JSON.stringify(workspaceMarker)}],
      agents: [${JSON.stringify(agentReady)}, ${JSON.stringify(agentMarker)}],
    };
    if (command === "projects") {
      while (!existsSync(${JSON.stringify(workspaceReady)}) || !existsSync(${JSON.stringify(agentReady)})) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      process.exit(7);
    }
    const [ready, marker] = files[command];
    const descendant = \`require("node:fs").writeFileSync(\${JSON.stringify(ready)}, "started"); setTimeout(() => require("node:fs").writeFileSync(\${JSON.stringify(marker)}, "survived"), 500);\`;
    spawn(process.execPath, ["-e", descendant], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `);

  const adapter = new SupersetDiscoveryAdapter({
    executable: NODE_EXECUTABLE,
    timeoutMs: 5_000,
    runner: async (executable, args, timeoutMs, signal) => {
      if (args[0] === "--version") return { stdout: "superset 1.0.0", stderr: "", exitCode: 0 };
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({
            running: true,
            healthy: true,
            pid: process.pid,
            port: 3210,
            endpoint: "http://127.0.0.1:3210",
            hostId: "local",
            organizationId: "org",
            hostName: "fixture",
            uptimeSec: 1,
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return runProcess(executable, [fixture, ...args], timeoutMs, signal);
    },
  });

  try {
    await assert.rejects(
      adapter.discover(),
      (error: unknown) => error instanceof SupersetDiscoveryError &&
        error.code === "UNAVAILABLE" && error.message.includes("projects"),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    await assert.rejects(access(workspaceMarker), { code: "ENOENT" });
    await assert.rejects(access(agentMarker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("process identity is stable for the current process and absent for an impossible PID", () => {
  const first = DurableStore.processStartedAt(process.pid);
  assert.ok(first);
  assert.equal(DurableStore.processStartedAt(process.pid), first);
  assert.equal(DurableStore.processStartedAt(999_999), undefined);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const harnessSource = join(repositoryRoot, "scripts", "run-real-superset-codex-e2e.mjs");

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "per-349-"));
  const main = join(directory, "main");
  const worktree = join(directory, "isolated");
  const executable = join(directory, "superset-fake.mjs");
  const reportPath = join(directory, "report.json");
  await execFileAsync("git", ["init", "-q", main]);
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: main });
  await execFileAsync("git", ["config", "user.name", "PER-349 test"], { cwd: main });
  await writeFile(join(main, "fixture.txt"), "fixture\n");
  await execFileAsync("git", ["add", "fixture.txt"], { cwd: main });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: main });
  await execFileAsync("git", ["worktree", "add", "-q", worktree, "-b", "per-349-fixture"], { cwd: main });
  await mkdir(join(worktree, "scripts"));
  const harness = join(worktree, "scripts", "run-real-superset-codex-e2e.mjs");
  await copyFile(harnessSource, harness);
  await execFileAsync("git", ["add", "scripts/run-real-superset-codex-e2e.mjs"], { cwd: worktree });
  await execFileAsync("git", ["commit", "-qm", "add harness"], { cwd: worktree });
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
const workspace = { id: "workspace-fixture", name: "isolated", type: "worktree", projectId: "project-fixture", worktreePath: ${JSON.stringify(worktree)}, worktreeExists: true };
if (args[0] === "--version") console.log("superset-fake 1.16.1");
else if (args.join(" ") === "workspaces list --local --json") console.log(JSON.stringify([workspace]));
else if (args.join(" ") === "agents list --local --json") console.log(JSON.stringify([{ id: "preset-instance", presetId: "codex", command: "codex" }]));
else if (args[0] === "agents" && args[1] === "create") console.log(JSON.stringify({ sessionId: "session-fixture" }));
else process.exitCode = 2;
`);
  await chmod(executable, 0o700);
  t.after(async () => {
    await execFileAsync("git", ["worktree", "remove", "--force", worktree], { cwd: main }).catch(() => {});
  });
  return { executable, harness, main, reportPath, worktree };
}

async function invoke(fixture, args, environment = {}) {
  const { stdout = "", stderr = "" } = await execFileAsync(process.execPath, [fixture.harness, ...args], {
    cwd: fixture.worktree,
    env: {
      ...process.env,
      SUPERSET_ORCHESTRATOR_EXECUTABLE: fixture.executable,
      SUPERSET_REAL_E2E_WORKSPACE_ID: "workspace-fixture",
      SUPERSET_REAL_E2E_WORKSPACE_PATH: fixture.worktree,
      SUPERSET_REAL_E2E_REPORT: fixture.reportPath,
      ...environment,
    },
  });
  assert.equal(stderr, "");
  assert.equal(stdout.trim(), fixture.reportPath);
  return JSON.parse(await readFile(fixture.reportPath, "utf8"));
}

test("preflight executes against an isolated linked worktree with relay disabled", async (t) => {
  const fixture = await createFixture(t);
  const report = await invoke(fixture, ["--preflight"]);
  assert.equal(report.classification, "passed");
  assert.equal(report.target.linkedGitWorktree, true);
  assert.equal(report.target.workspaceId, "workspace-fixture");
  assert.deepEqual(report.failures, []);
  assert.equal(report.scenarios.find(({ name }) => name === "local-workspace-discovery-under-relay-outage").observed.targetWorkspaceId, "workspace-fixture");
  assert.equal(report.scenarios.find(({ name }) => name === "workspace-isolation").status, "passed");
});

test("real launch records receipt and fail-closed unsupported lifecycle outcomes", async (t) => {
  const fixture = await createFixture(t);
  const report = await invoke(fixture, [], { SUPERSET_REAL_E2E: "1", SUPERSET_REAL_E2E_SENTINEL: "PER_349_EXACT_SENTINEL" });
  assert.equal(report.classification, "blocked");
  assert.equal(report.scenarios.find(({ name }) => name === "codex-launch-under-relay-outage").observed.sessionId, "session-fixture");
  assert.equal(report.scenarios.find(({ name }) => name === "exact-sentinel-result").status, "unsupported");
  assert.equal(report.scenarios.find(({ name }) => name === "cancel-or-unsupported-cancel").outcome, "unsupported");
  assert.equal(report.scenarios.find(({ name }) => name === "restart-recovery").status, "unsupported");
  assert.doesNotMatch(JSON.stringify(report), /PER_349_EXACT_SENTINEL/);
});

test("real launch remains opt-in", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(invoke(fixture, []));
  const report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
  assert.equal(report.classification, "failed");
  assert.match(report.failures[0].message, /SUPERSET_REAL_E2E=1/);
});

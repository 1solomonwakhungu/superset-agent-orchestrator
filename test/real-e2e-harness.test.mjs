import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const harnessSource = join(repositoryRoot, "scripts", "run-real-superset-codex-e2e.mjs");

async function createFixture(t, { version = "1.16.1", launchBehavior = "receipt" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "per-349-"));
  const main = join(directory, "main");
  const worktree = join(directory, "isolated");
  const executable = join(directory, "superset-fake.mjs");
  const codexExecutable = join(directory, "codex");
  const codexLog = join(directory, "codex-invocations.jsonl");
  const orphanMarker = join(directory, "orphan-marker");
  const spawnMarker = join(directory, "spawn-marker");
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
if (args[0] === "--version") console.log("superset-fake ${version}");
else if (args.join(" ") === "workspaces list --local --json") console.log(JSON.stringify([workspace]));
else if (args.join(" ") === "agents list --local --json") console.log(JSON.stringify([{ id: "preset-instance", presetId: "codex", command: "codex" }]));
else if (args[0] === "agents" && args[1] === "create") {
  if (${JSON.stringify(launchBehavior)} === "hang") {
    const { spawn } = await import("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(orphanMarker)}, "orphan"), 800)`) }]);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(spawnMarker)}, "spawned"));
    setTimeout(() => {}, 60_000);
  } else console.log(JSON.stringify({ sessionId: "session-fixture" }));
}
else process.exitCode = 2;
`);
  await chmod(executable, 0o700);
  await writeFile(codexExecutable, `#!/usr/bin/env node
const { appendFileSync } = await import("node:fs");
appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(process.argv.slice(2)) + "\\n", { mode: 0o600 });
if (process.argv[2] === "--version" && process.argv.length === 3) console.log("codex-fake 1.0.0");
else process.exitCode = 2;
`);
  await chmod(codexExecutable, 0o700);
  t.after(async () => {
    await execFileAsync("git", ["worktree", "remove", "--force", worktree], { cwd: main }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  return { codexLog, directory, executable, harness, main, orphanMarker, reportPath, spawnMarker, worktree };
}

async function invoke(fixture, args, environment = {}) {
  const { stdout = "", stderr = "" } = await execFileAsync(process.execPath, [fixture.harness, ...args], {
    cwd: fixture.worktree,
    env: {
      ...process.env,
      PATH: `${fixture.directory}:${process.env.PATH ?? ""}`,
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
  const report = await invoke(fixture, ["--preflight"], { SUPERSET_REAL_E2E_PREFLIGHT: "1" });
  assert.equal(report.classification, "passed");
  assert.equal(report.target.linkedGitWorktree, true);
  assert.equal(report.target.workspaceId, "workspace-fixture");
  assert.deepEqual(report.failures, []);
  assert.equal(report.scenarios.find(({ name }) => name === "local-workspace-discovery-under-relay-outage").observed.targetWorkspaceId, "workspace-fixture");
  assert.equal(report.scenarios.find(({ name }) => name === "workspace-isolation").status, "passed");
  assert.deepEqual(JSON.parse((await readFile(fixture.codexLog, "utf8")).trim()), ["--version"]);
  assert.equal(report.scenarios.find(({ name }) => name === "codex-live-tool-check-no-model-start").observed.modelStarted, false);
});

test("real launch records receipt and fail-closed unsupported lifecycle outcomes", async (t) => {
  const fixture = await createFixture(t);
  const report = await invoke(fixture, [], { SUPERSET_REAL_E2E: "1", SUPERSET_REAL_E2E_SENTINEL: "PER_349_EXACT_SENTINEL" });
  assert.equal(report.classification, "blocked");
  assert.equal(report.scenarios.find(({ name }) => name === "codex-launch-under-relay-outage").observed.sessionId, "session-fixture");
  assert.equal(report.scenarios.find(({ name }) => name === "codex-launch-under-relay-outage").observed.attributionSource, "explicit-command-arguments");
  assert.equal(report.scenarios.find(({ name }) => name === "exact-sentinel-result").status, "unsupported");
  assert.equal(report.scenarios.find(({ name }) => name === "cancel-or-unsupported-cancel").outcome, "unsupported");
  assert.equal(report.scenarios.find(({ name }) => name === "restart-recovery").status, "unsupported");
  assert.equal(report.scenarios.find(({ name }) => name === "workspace-state-at-launch-receipt").status, "passed");
  assert.equal(report.scenarios.find(({ name }) => name === "post-completion-workspace-isolation").status, "unsupported");
  assert.equal(report.scenarios.some(({ name }) => name === "workspace-isolation"), false);
  assert.doesNotMatch(JSON.stringify(report), /PER_349_EXACT_SENTINEL/);
});

test("preflight and real launch each require an explicit opt-in", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(invoke(fixture, ["--preflight"]));
  let report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
  assert.match(report.failures[0].message, /SUPERSET_REAL_E2E_PREFLIGHT=1/);
  await assert.rejects(invoke(fixture, []));
  report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
  assert.equal(report.classification, "failed");
  assert.match(report.failures[0].message, /SUPERSET_REAL_E2E=1/);
});

test("rejects unvetted Superset CLI versions", async (t) => {
  const fixture = await createFixture(t, { version: "1.17.0" });
  await assert.rejects(invoke(fixture, ["--preflight"], { SUPERSET_REAL_E2E_PREFLIGHT: "1" }));
  const report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
  assert.equal(report.classification, "failed");
  assert.match(report.failures[0].message, /1\.16\.1 is required; detected 1\.17\.0/);
});

test("rejects reports inside the authorized worktree", async (t) => {
  const fixture = await createFixture(t);
  const reportPath = join(fixture.worktree, "fixture.txt");
  await assert.rejects(invoke(fixture, ["--preflight"], {
    SUPERSET_REAL_E2E_PREFLIGHT: "1",
    SUPERSET_REAL_E2E_REPORT: reportPath,
  }));
  assert.equal(await readFile(reportPath, "utf8"), "fixture\n");
  const status = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: fixture.worktree });
  assert.equal(status.stdout, "");
});

test("fails closed when the configured live Codex tool is unavailable", async (t) => {
  const fixture = await createFixture(t);
  await rm(join(fixture.directory, "codex"));
  await symlink(process.execPath, join(fixture.directory, "node"));
  const git = (await execFileAsync("which", ["git"])).stdout.trim();
  await symlink(git, join(fixture.directory, "git"));
  await assert.rejects(invoke(fixture, ["--preflight"], {
    PATH: fixture.directory,
    SUPERSET_REAL_E2E_PREFLIGHT: "1",
  }));
  const report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
  assert.equal(report.classification, "failed");
  assert.match(report.failures[0].message, /Required live tool is unavailable: codex/);
  assert.equal(report.scenarios.some(({ name }) => name === "workspace-isolation"), false);
});

test("bounds launch time, kills descendants, redacts secrets, and leaves no harness temp files", async (t) => {
  const fixture = await createFixture(t, { launchBehavior: "hang" });
  const secret = "PER_349_NEVER_PERSIST_THIS";
  const temporaryEntriesBefore = await readdir(tmpdir());
  await assert.rejects(invoke(fixture, [], {
    SUPERSET_REAL_E2E: "1",
    SUPERSET_REAL_E2E_LAUNCH_TIMEOUT_MS: "100",
    SUPERSET_REAL_E2E_SECRET: secret,
    SUPERSET_REAL_E2E_SENTINEL: secret,
  }));
  const serialized = await readFile(fixture.reportPath, "utf8");
  const report = JSON.parse(serialized);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(report.scenarios.find(({ name }) => name === "codex-launch-under-relay-outage").timedOut, true);
  assert.match(report.failures[0].message, /exceeded its 100ms timeout/);
  assert.equal(await readFile(fixture.spawnMarker, "utf8"), "spawned");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  await assert.rejects(access(fixture.orphanMarker));
  const temporaryEntriesAfter = await readdir(tmpdir());
  assert.deepEqual(
    temporaryEntriesAfter.filter((name) => name.startsWith("superset-real-e2e-")).sort(),
    temporaryEntriesBefore.filter((name) => name.startsWith("superset-real-e2e-")).sort(),
  );
});

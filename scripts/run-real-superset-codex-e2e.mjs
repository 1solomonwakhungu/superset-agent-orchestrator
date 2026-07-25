#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resourceUsage } from "node:process";
import { fileURLToPath } from "node:url";

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const preflightOnly = process.argv.includes("--preflight");
const executable = process.env.SUPERSET_ORCHESTRATOR_EXECUTABLE ?? "superset";
const workspaceId = process.env.SUPERSET_REAL_E2E_WORKSPACE_ID;
const expectedPathInput = process.env.SUPERSET_REAL_E2E_WORKSPACE_PATH;
const outputPath = resolve(process.env.SUPERSET_REAL_E2E_REPORT ?? join(root, "artifacts", "real-e2e-report.json"));
const sentinel = process.env.SUPERSET_REAL_E2E_SENTINEL ?? `PER_349_${randomUUID().replaceAll("-", "").toUpperCase()}`;
const startedUsage = resourceUsage();
const report = {
  schemaVersion: 1,
  runId: randomUUID(),
  mode: preflightOnly ? "preflight" : "real",
  startedAt: new Date().toISOString(),
  completedAt: null,
  environment: { platform: process.platform, architecture: process.arch, node: process.version, executable },
  target: {},
  capabilities: { launch: "supported", result: "unsupported", cancel: "unsupported", backendRecovery: "unsupported" },
  scenarios: [],
  resources: {},
  failures: [],
  classification: "blocked",
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const safeError = (error) => error instanceof Error ? error.message : String(error);

function childEnvironment(relayOutage = false) {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR"];
  const environment = Object.fromEntries(allowed.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  if (relayOutage) {
    environment.HTTP_PROXY = "http://127.0.0.1:9";
    environment.HTTPS_PROXY = "http://127.0.0.1:9";
    environment.NO_PROXY = "127.0.0.1,localhost,::1";
  }
  return environment;
}

async function run(name, command, args, options = {}) {
  const began = performance.now();
  const directory = await mkdtemp(join(tmpdir(), "superset-real-e2e-"));
  const stdoutPath = join(directory, "stdout");
  const stdoutFile = await open(stdoutPath, "wx", 0o600);
  let result;
  try {
    result = await new Promise((resolveResult, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd ?? root,
        env: childEnvironment(options.relayOutage),
        shell: false,
        stdio: ["ignore", stdoutFile.fd, "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 20_000);
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolveResult({ exitCode: exitCode ?? -1, signal, stderr });
      });
    });
    await stdoutFile.close();
    result.stdout = await readFile(stdoutPath, "utf8");
  } finally {
    await stdoutFile.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
  const evidence = {
    name,
    status: result.exitCode === 0 ? "passed" : "failed",
    durationMs: Math.round((performance.now() - began) * 100) / 100,
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    observed: options.observed?.(result) ?? undefined,
  };
  report.scenarios.push(evidence);
  if (result.exitCode !== 0) throw new Error(`${name} failed with exit code ${result.exitCode}`);
  return { ...result, evidence };
}

async function gitSnapshot(path, label) {
  const status = await run(`${label}-git-status`, "git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: path });
  const head = await run(`${label}-git-head`, "git", ["rev-parse", "HEAD"], { cwd: path });
  return { status: status.stdout, head: head.stdout.trim() };
}

async function gitIdentity(path) {
  const topLevel = await run("target-git-top-level", "git", ["rev-parse", "--show-toplevel"], { cwd: path });
  const gitDirectory = await run("target-git-directory", "git", ["rev-parse", "--absolute-git-dir"], { cwd: path });
  const commonDirectory = await run("target-git-common-directory", "git", ["rev-parse", "--git-common-dir"], { cwd: path });
  const canonicalTopLevel = await realpath(topLevel.stdout.trim());
  const canonicalGitDirectory = await realpath(gitDirectory.stdout.trim());
  const commonPath = commonDirectory.stdout.trim();
  const canonicalCommonDirectory = await realpath(isAbsolute(commonPath) ? commonPath : resolve(path, commonPath));
  return { canonicalTopLevel, canonicalGitDirectory, canonicalCommonDirectory };
}

function exactOne(values, description) {
  if (values.length !== 1) throw new Error(`Expected exactly one ${description}; found ${values.length}`);
  return values[0];
}

async function main() {
  if (!workspaceId || !expectedPathInput) {
    throw new Error("SUPERSET_REAL_E2E_WORKSPACE_ID and SUPERSET_REAL_E2E_WORKSPACE_PATH are required");
  }
  if (!preflightOnly && process.env.SUPERSET_REAL_E2E !== "1") {
    throw new Error("Set SUPERSET_REAL_E2E=1 to authorize the real Codex launch");
  }

  const expectedPath = await realpath(expectedPathInput);
  const version = await run("superset-version", executable, ["--version"], {
    observed: ({ stdout }) => ({ version: stdout.trim() }),
  });
  const workspacesResult = await run("local-workspace-discovery-under-relay-outage", executable,
    ["workspaces", "list", "--local", "--json"], { relayOutage: true });
  const presetsResult = await run("local-preset-discovery-under-relay-outage", executable,
    ["agents", "list", "--local", "--json"], { relayOutage: true });
  const workspaces = JSON.parse(workspacesResult.stdout);
  const presets = JSON.parse(presetsResult.stdout);
  const workspace = exactOne(workspaces.filter(({ id }) => id === workspaceId), "target workspace");
  const codexPreset = exactOne(presets.filter(({ presetId }) => presetId === "codex"), "Codex preset");
  const actualPath = await realpath(workspace.worktreePath);
  if (actualPath !== expectedPath) throw new Error("Target workspace path does not match the authorized path");
  if (workspace.type !== "worktree" || !workspace.worktreeExists) throw new Error("Target must be an existing isolated worktree");
  if (root !== actualPath && !root.startsWith(`${actualPath}/`)) {
    throw new Error("Harness repository is outside the authorized workspace");
  }

  const identity = await gitIdentity(actualPath);
  if (identity.canonicalTopLevel !== actualPath) {
    throw new Error("Authorized workspace path is not the enclosing Git worktree root");
  }
  if (identity.canonicalGitDirectory === identity.canonicalCommonDirectory) {
    throw new Error("Authorized workspace is a shared main checkout, not an isolated linked Git worktree");
  }

  workspacesResult.evidence.observed = {
    targetWorkspaceId: workspace.id,
    targetProjectId: workspace.projectId,
    targetType: workspace.type,
    targetWorktreeExists: workspace.worktreeExists,
    discoveredWorkspaceCount: workspaces.length,
  };
  presetsResult.evidence.observed = {
    codexPresetId: codexPreset.presetId,
    codexPresetInstanceId: codexPreset.id,
    discoveredPresetCount: presets.length,
  };

  report.environment.supersetCli = version.stdout.trim();
  report.target = {
    workspaceId,
    workspaceName: workspace.name,
    workspaceType: workspace.type,
    projectId: workspace.projectId,
    canonicalPathSha256: sha256(actualPath),
    codexPresetId: codexPreset.presetId,
    codexPresetInstanceId: codexPreset.id,
    codexConfiguredCommand: codexPreset.command,
    sentinelSha256: sha256(sentinel),
    gitDirectorySha256: sha256(identity.canonicalGitDirectory),
    gitCommonDirectorySha256: sha256(identity.canonicalCommonDirectory),
    linkedGitWorktree: true,
  };

  const before = await gitSnapshot(root, "before");
  report.target.gitHead = before.head;
  report.target.initialStatusSha256 = sha256(before.status);
  if (before.status !== "") throw new Error("Real test requires a clean target repository");

  if (!preflightOnly) {
    const prompt = `Return exactly ${sentinel} and nothing else. Do not use tools, edit files, or inspect the workspace.`;
    const launch = await run("codex-launch-under-relay-outage", executable, [
      "agents", "create", "--workspace", workspaceId, "--agent", "codex", "--prompt", prompt, "--json",
    ], { relayOutage: true, timeoutMs: 30_000 });
    const receipt = JSON.parse(launch.stdout);
    const sessionId = receipt.sessionId ?? receipt.id ?? receipt.terminalId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("Superset launch receipt did not contain a stable session identifier");
    }
    launch.evidence.sessionId = sessionId;
    launch.evidence.workspaceId = workspaceId;
    launch.evidence.presetId = "codex";
    launch.evidence.promptSha256 = sha256(prompt);
    launch.evidence.observed = { sessionId, workspaceId, presetId: "codex" };
    report.scenarios.push({
      name: "exact-sentinel-result", status: "unsupported", code: "UNSUPPORTED_OPERATION",
      reason: "Superset 1.16.1 exposes no supported public command for terminal-agent status or final result retrieval",
    });
    report.scenarios.push({
      name: "cancel-or-unsupported-cancel", status: "passed", outcome: "unsupported", code: "UNSUPPORTED_OPERATION",
      reason: "Superset 1.16.1 exposes no supported public agent cancellation command",
    });
    report.scenarios.push({
      name: "restart-recovery", status: "unsupported", code: "UNSUPPORTED_OPERATION",
      reason: "The public Superset CLI cannot rediscover terminal-agent sessions after an orchestrator restart",
    });
  }

  const after = await gitSnapshot(root, "after");
  report.target.finalStatusSha256 = sha256(after.status);
  report.scenarios.push({
    name: "workspace-isolation",
    status: before.head === after.head && before.status === after.status ? "passed" : "failed",
    beforeHead: before.head,
    afterHead: after.head,
    beforeStatusSha256: sha256(before.status),
    afterStatusSha256: sha256(after.status),
    linkedGitWorktree: true,
    commandTargetWorkspaceId: workspaceId,
  });
  if (before.head !== after.head || before.status !== after.status) throw new Error("Target repository changed during the real-system test");
  report.classification = preflightOnly ? "passed" : "blocked";
}

try {
  await main();
} catch (error) {
  report.failures.push({ stage: report.scenarios.at(-1)?.name ?? "preflight", message: safeError(error) });
  report.classification = "failed";
} finally {
  const endedUsage = resourceUsage();
  report.completedAt = new Date().toISOString();
  report.resources = {
    userCpuTimeMicros: endedUsage.userCPUTime - startedUsage.userCPUTime,
    systemCpuTimeMicros: endedUsage.systemCPUTime - startedUsage.systemCPUTime,
    maxRssKiB: endedUsage.maxRSS,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${outputPath}\n`);
  if (report.classification === "failed") process.exitCode = 1;
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resourceUsage } from "node:process";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const preflightOnly = process.argv.includes("--preflight");
const executable = process.env.SUPERSET_ORCHESTRATOR_EXECUTABLE ?? "superset";
const workspaceId = process.env.SUPERSET_REAL_E2E_WORKSPACE_ID;
const expectedPathInput = process.env.SUPERSET_REAL_E2E_WORKSPACE_PATH;
const runId = randomUUID();
const outputPath = resolve(process.env.SUPERSET_REAL_E2E_REPORT ?? join(tmpdir(), "superset-real-e2e", `${runId}.json`));
const sentinel = process.env.SUPERSET_REAL_E2E_SENTINEL ?? `PER_349_${randomUUID().replaceAll("-", "").toUpperCase()}`;
const supportedSupersetCliVersion = "1.16.1";
function boundedTimeout(name, fallback, maximum) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 100 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer from 100 through ${maximum}`);
  }
  return Number(value);
}

const commandTimeoutMs = boundedTimeout("SUPERSET_REAL_E2E_COMMAND_TIMEOUT_MS", 20_000, 20_000);
const launchTimeoutMs = boundedTimeout("SUPERSET_REAL_E2E_LAUNCH_TIMEOUT_MS", 30_000, 30_000);
const maxOutputBytes = 1024 * 1024;
let reportPathAllowed = true;
const startedUsage = resourceUsage();
const report = {
  schemaVersion: 1,
  runId,
  mode: preflightOnly ? "preflight" : "real",
  startedAt: new Date().toISOString(),
  completedAt: null,
  environment: { platform: process.platform, architecture: process.arch, node: process.version, executable: basename(executable) },
  target: {},
  capabilities: { launch: "supported", result: "unsupported", cancel: "unsupported", backendRecovery: "unsupported" },
  scenarios: [],
  resources: {},
  failures: [],
  classification: "blocked",
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sensitiveValues = [sentinel, expectedPathInput, process.env.SUPERSET_REAL_E2E_SECRET]
  .filter((value) => typeof value === "string" && value.length > 0);
const safeError = (error) => sensitiveValues.reduce(
  (message, value) => message.replaceAll(value, "[REDACTED]"),
  error instanceof Error ? error.message : String(error),
);

async function resolveExecutable(command, environment = childEnvironment()) {
  if (command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    await access(candidate, constants.X_OK);
    return candidate;
  }
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error(`Required live tool is unavailable: ${command}`);
}

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
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  const result = await new Promise((resolveResult, reject) => {
      let settled = false;
      let timedOut = false;
      let outputExceeded = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const child = spawn(command, args, {
        cwd: options.cwd ?? root,
        env: childEnvironment(options.relayOutage),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const terminate = () => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      };
      const append = (stream, chunk) => {
        const combined = Buffer.concat([stream === "stdout" ? stdout : stderr, chunk]);
        if (combined.length > maxOutputBytes) {
          outputExceeded = true;
          terminate();
          return;
        }
        if (stream === "stdout") stdout = combined;
        else stderr = combined;
      };
      child.stdout.on("data", (chunk) => append("stdout", chunk));
      child.stderr.on("data", (chunk) => append("stderr", chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolveResult({
            exitCode: exitCode ?? -1,
            signal,
            stderr: stderr.toString("utf8"),
            stdout: stdout.toString("utf8"),
            timedOut,
            outputExceeded,
          });
        }
      });
    });
  const evidence = {
    name,
    status: result.exitCode === 0 ? "passed" : "failed",
    durationMs: Math.round((performance.now() - began) * 100) / 100,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputExceeded: result.outputExceeded,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    observed: options.observed?.(result) ?? undefined,
  };
  report.scenarios.push(evidence);
  if (result.timedOut) throw new Error(`${name} exceeded its ${timeoutMs}ms timeout`);
  if (result.outputExceeded) throw new Error(`${name} exceeded the ${maxOutputBytes}-byte output limit`);
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

function pathIsInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function canonicalizePotentialPath(path) {
  const missingSegments = [];
  let existingPath = path;
  while (true) {
    try {
      return join(await realpath(existingPath), ...missingSegments);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existingPath);
      if (parent === existingPath) throw error;
      missingSegments.unshift(basename(existingPath));
      existingPath = parent;
    }
  }
}

async function main() {
  if (!workspaceId || !expectedPathInput) {
    throw new Error("SUPERSET_REAL_E2E_WORKSPACE_ID and SUPERSET_REAL_E2E_WORKSPACE_PATH are required");
  }
  const authorizationVariable = preflightOnly ? "SUPERSET_REAL_E2E_PREFLIGHT" : "SUPERSET_REAL_E2E";
  if (process.env[authorizationVariable] !== "1") {
    throw new Error(`Set ${authorizationVariable}=1 to authorize this real-system ${preflightOnly ? "preflight" : "launch"}`);
  }

  const expectedPath = await realpath(expectedPathInput);
  const canonicalOutputPath = await canonicalizePotentialPath(outputPath);
  if (pathIsInside(expectedPath, canonicalOutputPath)) {
    reportPathAllowed = false;
    throw new Error("SUPERSET_REAL_E2E_REPORT must be outside the authorized worktree");
  }
  const supersetExecutable = await resolveExecutable(executable);
  const version = await run("superset-live-tool-check", supersetExecutable, ["--version"], {
    timeoutMs: 5_000,
    observed: () => ({ available: true, executable: basename(supersetExecutable) }),
  });
  const detectedVersion = version.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (detectedVersion !== supportedSupersetCliVersion) {
    throw new Error(`Superset CLI ${supportedSupersetCliVersion} is required; detected ${detectedVersion ?? "no semantic version"}`);
  }
  const workspacesResult = await run("local-workspace-discovery-under-relay-outage", supersetExecutable,
    ["workspaces", "list", "--local", "--json"], { relayOutage: true });
  const presetsResult = await run("local-preset-discovery-under-relay-outage", supersetExecutable,
    ["agents", "list", "--local", "--json"], { relayOutage: true });
  const workspaces = JSON.parse(workspacesResult.stdout);
  const presets = JSON.parse(presetsResult.stdout);
  const workspace = exactOne(workspaces.filter(({ id }) => id === workspaceId), "target workspace");
  const codexPreset = exactOne(presets.filter(({ presetId }) => presetId === "codex"), "Codex preset");
  if (codexPreset.command !== "codex") {
    throw new Error("Codex preset must use the exact live `codex` command with no wrapper or model-start arguments");
  }
  const codexExecutable = await resolveExecutable(codexPreset.command);
  await run("codex-live-tool-check-no-model-start", codexExecutable, ["--version"], {
    timeoutMs: 5_000,
    observed: () => ({ available: true, executable: basename(codexExecutable), modelStarted: false }),
  });
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

  report.environment.supersetCliVersion = detectedVersion;
  report.target = {
    workspaceId,
    workspaceName: workspace.name,
    workspaceType: workspace.type,
    projectId: workspace.projectId,
    canonicalPathSha256: sha256(actualPath),
    codexPresetId: codexPreset.presetId,
    codexPresetInstanceId: codexPreset.id,
    codexConfiguredCommand: "codex",
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
    const launch = await run("codex-launch-under-relay-outage", supersetExecutable, [
      "agents", "create", "--workspace", workspaceId, "--agent", "codex", "--prompt", prompt, "--json",
    ], { relayOutage: true, timeoutMs: launchTimeoutMs });
    const receipt = JSON.parse(launch.stdout);
    const sessionId = receipt.sessionId ?? receipt.id ?? receipt.terminalId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("Superset launch receipt did not contain a stable session identifier");
    }
    launch.evidence.sessionId = sessionId;
    launch.evidence.workspaceId = workspaceId;
    launch.evidence.presetId = "codex";
    launch.evidence.promptSha256 = sha256(prompt);
    launch.evidence.observed = {
      sessionId,
      workspaceId,
      presetId: "codex",
      attributionSource: "explicit-command-arguments",
    };
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

  const after = await gitSnapshot(root, preflightOnly ? "after" : "launch-receipt");
  report.target.finalStatusSha256 = sha256(after.status);
  report.scenarios.push({
    name: preflightOnly ? "workspace-isolation" : "workspace-state-at-launch-receipt",
    status: before.head === after.head && before.status === after.status ? "passed" : "failed",
    beforeHead: before.head,
    afterHead: after.head,
    beforeStatusSha256: sha256(before.status),
    afterStatusSha256: sha256(after.status),
    linkedGitWorktree: true,
    commandTargetWorkspaceId: workspaceId,
  });
  if (before.head !== after.head || before.status !== after.status) throw new Error("Target repository changed during the real-system test");
  if (!preflightOnly) {
    report.scenarios.push({
      name: "post-completion-workspace-isolation",
      status: "unsupported",
      code: "UNSUPPORTED_OPERATION",
      reason: "Superset CLI 1.16.1 returns an asynchronous launch receipt and exposes no supported completion API",
    });
  }
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
  if (reportPathAllowed) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${outputPath}\n`);
  }
  if (report.classification === "failed") process.exitCode = 1;
}

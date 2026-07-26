#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const [scenarioPath, statePath, command] = process.argv.slice(2);
if (!command || !scenarioPath || !statePath) process.exit(64);

const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
if (scenario.ignoreSigtermCommands?.includes(command)) process.on("SIGTERM", () => undefined);
const discoveryResponse = handleDiscovery(process.argv.slice(4));
if (discoveryResponse !== undefined) {
  process.stdout.write(`${typeof discoveryResponse === "string" ? discoveryResponse : JSON.stringify(discoveryResponse)}\n`);
  process.exit(0);
}
const payload = JSON.parse(await readStdin());
const release = await lockfile.lock(statePath, {
  realpath: false,
  stale: 30_000,
  retries: { retries: 100, factor: 1.2, minTimeout: 5, maxTimeout: 100 },
});
let response;
let failure;
let fault;
try {
  const state = await loadState();
  const call = {
    sequence: state.calls.length + 1,
    command,
    payload,
    argv: process.argv.slice(2),
    environment: Object.fromEntries((scenario.captureEnvironment ?? []).map((name) => [name, process.env[name]])),
  };
  state.calls.push(call);
  if (command === "launch" && scenario.launchError) {
    failure = [70, { code: "LAUNCH_REJECTED", message: scenario.launchError }];
  } else if (command === "cancel" && scenario.cancelUnsupported) {
    failure = [69, { code: "CANCEL_UNSUPPORTED", message: "Cancellation is unsupported" }];
  } else {
    try {
      response = handle(command, payload, state);
    } catch (error) {
      if (!(error instanceof ProviderFailure)) throw error;
      failure = [error.exitCode, error.detail];
    }
  }
  fault = selectFault(state.calls);
  if (failure) call.failure = failure[1];
  else call.response = response;
  if (fault) call.fault = { id: fault.id, action: fault.action };
  await saveState(state);
} finally {
  await release();
}

if (fault?.action === "hang" || scenario.hangCommands?.includes(command)) {
  await new Promise(() => globalThis.setInterval(() => undefined, 60_000));
}
if (fault?.action === "malformed" || scenario.malformedCommands?.includes(command)) {
  if (scenario.malformedStderr) process.stderr.write(`${scenario.malformedStderr}\n`);
  process.stdout.write("not-json\n");
  process.exit(0);
}
if (failure) fail(...failure);
process.stdout.write(`${JSON.stringify(response)}\n`);

function handle(command, payload, state) {
  switch (command) {
    case "launch": {
      const existing = Object.values(state.runs).find((run) => run.idempotencyKey === payload.idempotencyKey);
      if (existing) return { runId: existing.runId };
      const index = Object.keys(state.runs).length;
      const script = scenario.scripts?.[index] ?? scenario.defaultScript;
      if (!script) throw new ProviderFailure(70, "No fake script available");
      const runId = `fake-${String(index + 1).padStart(3, "0")}`;
      state.runs[runId] = { runId, idempotencyKey: payload.idempotencyKey, script, position: 0, cancelled: null };
      return { runId };
    }
    case "find": {
      const run = Object.values(state.runs).find((candidate) => candidate.idempotencyKey === payload.idempotencyKey);
      return run ? { runId: run.runId } : null;
    }
    case "status": {
      const run = requireRun(state, payload.runId);
      const status = run.cancelled ? "cancelled" : run.script.statuses[run.position];
      if (!run.cancelled && run.position < run.script.statuses.length - 1) run.position += 1;
      return { runId: run.runId, status, updatedAt: "2000-01-01T00:00:00.000Z" };
    }
    case "result": {
      const run = requireRun(state, payload.runId);
      const status = run.cancelled ? "cancelled" : run.script.statuses[run.position];
      return status === "queued" || status === "running" ? null : (run.cancelled ?? run.script.result ?? null);
    }
    case "cancel": {
      const run = requireRun(state, payload.runId);
      const status = run.cancelled ? "cancelled" : run.script.statuses[run.position];
      if (status !== "queued" && status !== "running") {
        throw new ProviderFailure(65, { code: "CANCEL_UNSUPPORTED", message: "A terminal run cannot be canceled" });
      }
      run.cancelled = { status: "cancelled", ...(payload.reason ? { reason: payload.reason } : {}) };
      return { cancelled: true };
    }
    case "resume":
      return requireRun(state, payload.runId).script.resume ?? null;
    default:
      throw new ProviderFailure(64, `Unknown command: ${command}`);
  }
}

function handleDiscovery(args) {
  const key = args.join(" ");
  const root = dirname(scenarioPath);
  const host = {
    running: true, healthy: true, pid: process.pid, port: 48707,
    endpoint: "http://127.0.0.1:48707", organizationId: "fake-org",
    hostId: "fake-host", hostName: "fake-superset", uptimeSec: 1,
  };
  if (key === "--version") return "1.0.0";
  if (key === "status --json") return host;
  if (key === "projects list --local --json") return [{
    id: "fake-project", name: "Fake project", slug: "fake-project",
    repoCloneUrl: null, githubRepositoryId: null, setUp: "yes", path: root,
  }];
  if (key === "workspaces list --local --json") return Array.from({ length: 100 }, (_, index) => ({
    id: `workspace-${index}`, organizationId: host.organizationId, projectId: "fake-project",
    hostId: host.hostId, name: `Workspace ${index}`, branch: "main", type: "main",
    createdByUserId: null, taskId: null, createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z", worktreePath: root, worktreeExists: true,
    projectName: "Fake project", hostName: host.hostName,
  }));
  if (key === "agents list --local --json") return [{
    id: "fake-agent", presetId: "fake-agent", iconId: null, label: "Fake agent",
    command: "fake-agent", args: [], promptTransport: "stdin", promptArgs: [], env: {}, order: 0,
  }];
  return undefined;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { runs: {}, calls: [] };
  }
}

async function saveState(state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, statePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function selectFault(calls) {
  const commandOccurrence = calls.filter((call) => call.command === command).length;
  const fault = scenario.faults?.find((candidate) =>
    candidate.command === command && candidate.occurrence === commandOccurrence);
  if (fault === undefined) return undefined;
  if (typeof fault.id !== "string" || fault.id.length === 0
    || (fault.action !== "hang" && fault.action !== "malformed")) {
    throw new Error("Invalid fake fault specification");
  }
  return fault;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function requireRun(state, runId) {
  const run = state.runs[runId];
  if (!run) throw new ProviderFailure(66, `Unknown run: ${runId}`);
  return run;
}

class ProviderFailure extends Error {
  constructor(exitCode, detail) {
    super(typeof detail === "string" ? detail : detail.message);
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

function fail(code, message) {
  process.stderr.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  process.exitCode = code;
  process.exit();
}

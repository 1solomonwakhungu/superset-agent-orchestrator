#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";

const [scenarioPath, statePath, command] = process.argv.slice(2);
if (!command || !scenarioPath || !statePath) process.exit(64);

const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
const payload = JSON.parse(await readStdin());
const release = await lockfile.lock(statePath, {
  realpath: false,
  stale: 30_000,
  retries: { retries: 100, factor: 1.2, minTimeout: 5, maxTimeout: 100 },
});
let response;
let failure;
try {
  const state = await loadState();
  state.calls.push({
    sequence: state.calls.length + 1,
    command,
    payload,
    argv: process.argv.slice(2),
    environment: Object.fromEntries((scenario.captureEnvironment ?? []).map((name) => [name, process.env[name]])),
  });
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
  await saveState(state);
} finally {
  await release();
}

if (scenario.hangCommands?.includes(command)) await new Promise(() => undefined);
if (scenario.malformedCommands?.includes(command)) {
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
      run.cancelled = { status: "cancelled", ...(payload.reason ? { reason: payload.reason } : {}) };
      return { cancelled: true };
    }
    case "resume":
      return requireRun(state, payload.runId).script.resume ?? null;
    default:
      throw new ProviderFailure(64, `Unknown command: ${command}`);
  }
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
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, statePath);
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

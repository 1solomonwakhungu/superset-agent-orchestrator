#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const [command, encodedPayload] = process.argv.slice(2);
const scenarioPath = process.env.FAKE_SUPERSET_SCENARIO;
const statePath = process.env.FAKE_SUPERSET_STATE;
if (!command || !encodedPayload || !scenarioPath || !statePath) process.exit(64);

const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
const payload = JSON.parse(encodedPayload);
const state = await loadState();
state.calls.push({ sequence: state.calls.length + 1, command, payload });
await saveState(state);
if (scenario.hangCommands?.includes(command)) await new Promise(() => undefined);
if (scenario.malformedCommands?.includes(command)) {
  process.stdout.write("not-json\n");
  process.exit(0);
}
if (command === "launch" && scenario.launchError) {
  fail(70, { code: "LAUNCH_REJECTED", message: scenario.launchError });
}
if (command === "cancel" && scenario.cancelUnsupported) {
  fail(69, { code: "CANCEL_UNSUPPORTED", message: "Cancellation is unsupported" });
}

let response;
switch (command) {
  case "launch": {
    const existing = Object.values(state.runs).find((run) => run.idempotencyKey === payload.idempotencyKey);
    if (existing) {
      response = { runId: existing.runId };
      break;
    }
    const index = Object.keys(state.runs).length;
    const script = scenario.scripts?.[index] ?? scenario.defaultScript;
    if (!script) fail(70, "No fake script available");
    const runId = `fake-${String(index + 1).padStart(3, "0")}`;
    state.runs[runId] = { runId, idempotencyKey: payload.idempotencyKey, script, position: 0, cancelled: null };
    await saveState(state);
    response = { runId };
    break;
  }
  case "find": {
    const run = Object.values(state.runs).find((candidate) => candidate.idempotencyKey === payload.idempotencyKey);
    response = run ? { runId: run.runId } : null;
    break;
  }
  case "status": {
    const run = requireRun(state, payload.runId);
    const status = run.cancelled ? "cancelled" : run.script.statuses[run.position];
    if (!run.cancelled && run.position < run.script.statuses.length - 1) run.position += 1;
    await saveState(state);
    response = { runId: run.runId, status, updatedAt: "2000-01-01T00:00:00.000Z" };
    break;
  }
  case "result": {
    const run = requireRun(state, payload.runId);
    const status = run.cancelled ? "cancelled" : run.script.statuses[run.position];
    response = status === "queued" || status === "running" ? null : (run.cancelled ?? run.script.result ?? null);
    break;
  }
  case "cancel": {
    const run = requireRun(state, payload.runId);
    run.cancelled = { status: "cancelled", ...(payload.reason ? { reason: payload.reason } : {}) };
    await saveState(state);
    response = { cancelled: true };
    break;
  }
  case "resume":
    response = requireRun(state, payload.runId).script.resume ?? null;
    break;
  default:
    fail(64, `Unknown command: ${command}`);
}
process.stdout.write(`${JSON.stringify(response)}\n`);

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { runs: {}, calls: [] };
  }
}

async function saveState(state) {
  await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

function requireRun(state, runId) {
  const run = state.runs[runId];
  if (!run) fail(66, `Unknown run: ${runId}`);
  return run;
}

function fail(code, message) {
  process.stderr.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  process.exitCode = code;
  process.exit();
}

import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { DurableStore } from "../../src/store.js";

interface WorkerInput {
  path: string;
  index: number;
  conflicting: boolean;
  gate: SharedArrayBuffer;
}

assert.ok(parentPort);
const input = workerData as WorkerInput;
const gate = new Int32Array(input.gate);
const store = new DurableStore(input.path);
const assignments = input.conflicting
  ? [{ agent: "codex", task: `task-${input.index}` }]
  : [{ agent: "codex", task: "one" }, { agent: "opencode", task: "two" }];

parentPort.postMessage({ type: "ready" });
while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);

try {
  const outcome = await store.createBatch(
    "contended",
    "client-1",
    assignments,
    "shared-key",
    new Date("2026-07-01T00:00:00.000Z"),
  );
  parentPort.postMessage({
    type: "result",
    ok: true,
    duplicate: outcome.duplicate,
    batchId: outcome.batch.id,
    attributions: outcome.sessions.map(({ attribution }) => attribution),
  });
} catch (error) {
  parentPort.postMessage({
    type: "result",
    ok: false,
    code: error instanceof Error && "code" in error ? error.code : undefined,
    error: error instanceof Error ? error.message : String(error),
  });
}

import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { OrchestratorStorage } from "../../src/storage.js";

interface WorkerInput {
  database: string;
  output: string;
}

assert.ok(parentPort);
const input = workerData as WorkerInput;
parentPort.postMessage("ready");
parentPort.once("message", (message: unknown) => {
  assert.equal(message, "start");
  try {
    OrchestratorStorage.exportJson(input.database, input.output);
    parentPort?.postMessage({ ok: true });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

import { readFile, writeFile } from "node:fs/promises";
import type { AgentAdapter, LaunchRequest, RunHandle } from "../../src/agent-adapter.js";
import { LaunchService, type AsynchronousLaunchRequest, type LaunchBoundary } from "../../src/launch-service.js";
import { DurableStore } from "../../src/store.js";

const [mode, statePath, providerPath, boundary] = process.argv.slice(2) as [string, string, string, LaunchBoundary?];

const request: AsynchronousLaunchRequest = {
  idempotencyKey: "per-348-process-death",
  clientId: "process-fixture",
  batchName: "PER-348",
  attribution: { agent: "synthetic", task: "process-death" },
  prompt: "synthetic",
  workspaceId: "fixture",
  workspacePath: "/tmp/per-348-process-fixture",
};

async function existingRun(): Promise<RunHandle | undefined> {
  try {
    return JSON.parse(await readFile(providerPath, "utf8")) as RunHandle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const adapter: AgentAdapter = {
  findByIdempotencyKey: existingRun,
  launch: async (launchRequest: LaunchRequest) => {
    assertMatchingKey(launchRequest.idempotencyKey);
    const existing = await existingRun();
    if (existing !== undefined) return existing;
    const handle = { runId: "synthetic-run" };
    await writeFile(providerPath, JSON.stringify(handle), { flag: "wx" });
    return handle;
  },
  status: async () => { throw new Error("unused"); },
  result: async () => undefined,
  cancel: async () => undefined,
  resumeMetadata: async () => undefined,
};

const crash = (current: LaunchBoundary): void => {
  if (current === boundary) process.kill(process.pid, "SIGKILL");
};
const service = new LaunchService(new DurableStore(statePath, undefined, undefined, undefined, 2_000), adapter, () => new Date(), crash);

if (mode === "crash") await service.launch(request);
else if (mode === "recover") await service.dispatchPending();
else throw new Error(`Unknown fixture mode: ${mode}`);

function assertMatchingKey(idempotencyKey: string): void {
  if (idempotencyKey !== `${request.clientId}\0${request.idempotencyKey}`) {
    throw new Error("Unexpected idempotency key");
  }
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LaunchRequest } from "../src/agent-adapter.js";
import {
  SupersetLocalMcpAdapter,
  type SupersetLocalToolCaller,
} from "../src/superset-local-mcp-adapter.js";

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    idempotencyKey: "client:per-394",
    prompt: "Finish PER-394",
    workspacePath: "/workspace/per-394",
    workspaceId: "workspace-per-394",
    agentPresetId: "opencode-medium",
    environment: {},
    revalidateWorkspace: async () => undefined,
    ...overrides,
  };
}

test("launches once, persists the terminal binding, and recovers it after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superset-live-adapter-"));
  try {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: SupersetLocalToolCaller = async (name, args) => {
      calls.push({ name, args });
      return { sessionId: "terminal-394" };
    };
    const options = {
      serverPath: "/unused/local-server.mjs",
      statePath: join(directory, "runs.json"),
      callTool,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    };
    const adapter = new SupersetLocalMcpAdapter(options);

    assert.deepEqual(await adapter.launch(request()), { runId: "terminal-394" });
    assert.deepEqual(await adapter.launch(request()), { runId: "terminal-394" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      name: "agents_create",
      args: {
        workspace_id: "workspace-per-394",
        agent: "opencode-medium",
        prompt: "Finish PER-394",
      },
    });

    const restarted = new SupersetLocalMcpAdapter(options);
    assert.deepEqual(await restarted.findByIdempotencyKey("client:per-394"), {
      runId: "terminal-394",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports ordinary progress without an attention flag", async () => {
  const adapter = new SupersetLocalMcpAdapter({
    serverPath: "/unused/local-server.mjs",
    statePath: join(tmpdir(), "unused-live-runs.json"),
    now: () => new Date("2026-07-27T12:00:00.000Z"),
    callTool: async () => [{ sessionId: "terminal-2", status: "starting", response: null }],
  });
  assert.deepEqual(await adapter.status({ runId: "terminal-2" }), {
    runId: "terminal-2",
    status: "running",
    updatedAt: "2026-07-27T12:00:00.000Z",
  });
  await assert.rejects(adapter.status({ runId: "terminal-other" }), /unexpected shape/);
});

test("maps live Superset responses into running, success, and failure outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superset-live-response-"));
  try {
    let response: Record<string, unknown> = {
      sessionId: "terminal-1",
      status: "waiting_for_input",
      response: null,
      pendingQuestion: { question: "Need input" },
    };
    const adapter = new SupersetLocalMcpAdapter({
      serverPath: "/unused/local-server.mjs",
      statePath: join(directory, "runs.json"),
      now: () => new Date("2026-07-27T12:00:00.000Z"),
      callTool: async () => [response],
    });

    assert.deepEqual(await adapter.status({ runId: "terminal-1" }), {
      runId: "terminal-1",
      status: "running",
      updatedAt: "2026-07-27T12:00:00.000Z",
      attention: "waiting_for_input",
    });
    assert.equal(await adapter.result({ runId: "terminal-1" }), undefined);

    response = {
      sessionId: "terminal-1",
      status: "completed",
      response: "Verified and pushed PR 96",
    };
    assert.deepEqual(await adapter.result({ runId: "terminal-1" }), {
      status: "succeeded",
      output: "Verified and pushed PR 96",
    });

    response = {
      sessionId: "terminal-1",
      status: "stopped",
      response: null,
    };
    assert.deepEqual(await adapter.result({ runId: "terminal-1" }), {
      status: "failed",
      error: "Superset stopped the agent without a readable final response",
      retryable: true,
    });
    assert.deepEqual(await adapter.cancel(), { status: "unsupported" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a live launch without exact workspace and agent identities", async () => {
  const adapter = new SupersetLocalMcpAdapter({
    serverPath: "/unused/local-server.mjs",
    statePath: join(tmpdir(), "unused-live-runs.json"),
    callTool: async () => {
      throw new Error("must not be called");
    },
  });

  const missingWorkspace = request();
  delete missingWorkspace.workspaceId;
  await assert.rejects(adapter.launch(missingWorkspace), /requires workspaceId and agentPresetId/);

  const missingAgent = request();
  delete missingAgent.agentPresetId;
  await assert.rejects(adapter.launch(missingAgent), /requires workspaceId and agentPresetId/);
});

test("persists a pending intent before agents_create and refuses to relaunch an unknown outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superset-live-pending-"));
  try {
    const statePath = join(directory, "runs.json");
    let observedPending: unknown;
    const crashing = new SupersetLocalMcpAdapter({
      serverPath: "/unused/local-server.mjs",
      statePath,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
      callTool: async () => {
        observedPending = (JSON.parse(await readFile(statePath, "utf8")) as { pending?: unknown }).pending;
        // Superset may have accepted the launch; the reply is lost.
        throw new Error("connection reset");
      },
    });
    await assert.rejects(crashing.launch(request()), /connection reset/);
    assert.deepEqual(Object.keys(observedPending as object), ["client:per-394"]);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      runs: object;
      pending: Record<string, { status: string; workspaceId: string; agentPresetId: string }>;
    };
    assert.deepEqual(persisted.runs, {});
    assert.equal(persisted.pending["client:per-394"]!.status, "pending");
    assert.equal(persisted.pending["client:per-394"]!.workspaceId, "workspace-per-394");

    let retried = 0;
    const restarted = new SupersetLocalMcpAdapter({
      serverPath: "/unused/local-server.mjs",
      statePath,
      callTool: async () => {
        retried += 1;
        return { sessionId: "terminal-duplicate" };
      },
    });
    assert.equal(await restarted.findByIdempotencyKey("client:per-394"), undefined);
    await assert.rejects(restarted.launch(request()), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "LAUNCH_REJECTED");
      assert.match(error.message, /unknown outcome/);
      return true;
    });
    assert.equal(retried, 0);

    // Other keys are unaffected by one unresolved intent.
    assert.deepEqual(await restarted.launch(request({ idempotencyKey: "client:other" })), {
      runId: "terminal-duplicate",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed without crashing when the state lock is lost during agents_create", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superset-live-compromised-"));
  try {
    const statePath = join(directory, "runs.json");
    const adapter = new SupersetLocalMcpAdapter({
      serverPath: "/unused/local-server.mjs",
      statePath,
      callTool: async () => {
        // Another process reclaimed the lock (for example after a long system sleep).
        await rm(`${statePath}.lock`, { recursive: true, force: true });
        await new Promise((resolve) => setTimeout(resolve, 2_600));
        return { sessionId: "terminal-unbound" };
      },
    });
    await assert.rejects(adapter.launch(request()), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.match(error.message, /session terminal-unbound, but the live Superset run-state lock was lost/);
      return true;
    });
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      runs: object;
      pending?: Record<string, unknown>;
    };
    assert.deepEqual(persisted.runs, {});
    assert.deepEqual(Object.keys(persisted.pending ?? {}), ["client:per-394"]);
    // The adapter stays usable once the lock is free again.
    assert.equal(await adapter.findByIdempotencyKey("client:per-394"), undefined);
    await assert.rejects(adapter.launch(request()), /unknown outcome/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the intent when agents_create answers without a session ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superset-live-noid-"));
  try {
    const statePath = join(directory, "runs.json");
    const adapter = new SupersetLocalMcpAdapter({
      serverPath: "/unused/local-server.mjs",
      statePath,
      callTool: async () => ({ kind: "terminal" }),
    });
    await assert.rejects(adapter.launch(request()), /returned no session ID/);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { pending?: Record<string, unknown> };
    assert.ok(persisted.pending?.["client:per-394"] !== undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reclaims a stale cross-process lock left by a crashed holder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superset-live-stale-"));
  try {
    const statePath = join(directory, "runs.json");
    const lockPath = `${statePath}.lock`;
    await mkdir(lockPath);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const adapter = new SupersetLocalMcpAdapter({
      serverPath: "/unused/local-server.mjs",
      statePath,
      callTool: async () => ({ sessionId: "terminal-after-stale" }),
    });
    assert.deepEqual(await adapter.launch(request()), { runId: "terminal-after-stale" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);
const LAUNCH_WORKER = `
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [sourceDirectory, statePath, createdLog, startAt] = process.argv.slice(2);
const { SupersetLocalMcpAdapter } = await import(
  pathToFileURL(join(sourceDirectory, "superset-local-mcp-adapter.ts")).href);
const adapter = new SupersetLocalMcpAdapter({
  serverPath: "/unused/local-server.mjs",
  statePath,
  callTool: async () => {
    appendFileSync(createdLog, process.pid + "\\n");
    await delay(200);
    return { sessionId: "terminal-" + process.pid };
  },
});
await delay(Math.max(0, Number(startAt) - Date.now()));
const handle = await adapter.launch({
  idempotencyKey: "client:shared",
  prompt: "race",
  workspacePath: "/workspace/race",
  workspaceId: "workspace-race",
  agentPresetId: "opencode-medium",
  environment: {},
  revalidateWorkspace: async () => undefined,
});
process.stdout.write(JSON.stringify(handle));
`;

test("separate processes sharing a state file launch one Superset session per key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superset-live-processes-"));
  try {
    const workerPath = join(directory, "worker.mjs");
    const statePath = join(directory, "runs.json");
    const createdLog = join(directory, "created.log");
    await writeFile(workerPath, LAUNCH_WORKER);
    const startAt = Date.now() + 1_500;
    const outcomes = await Promise.all(Array.from({ length: 4 }, async () => {
      const { stdout } = await run(process.execPath, [
        "--import", "tsx", workerPath, join(projectRoot, "src"), statePath, createdLog, String(startAt),
      ], { cwd: projectRoot });
      return JSON.parse(stdout) as { runId: string };
    }));
    const created = (await readFile(createdLog, "utf8")).trim().split("\n");
    assert.equal(created.length, 1, "exactly one process may call agents_create");
    assert.equal(new Set(outcomes.map(({ runId }) => runId)).size, 1);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { runs: Record<string, { runId: string }> };
    assert.equal(persisted.runs["client:shared"]!.runId, outcomes[0]!.runId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

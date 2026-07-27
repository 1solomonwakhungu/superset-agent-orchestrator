import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

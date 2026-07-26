import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { orchestratorErrorSchema } from "../src/tool-contract.js";

const server = resolve("dist/src/server.js");
const fake = resolve("test/fixtures/fake-superset.mjs");
const claimSchema = z.object({
  output: z.string().optional(), error: z.string().optional(), stopReason: z.string().optional(),
}).passthrough();
const resultSchema = z.object({
  claim: claimSchema,
  attribution: z.object({ agent: z.string(), task: z.string() }).passthrough(),
}).passthrough();
const sessionSchema = z.object({ sessionId: z.string(), batchId: z.string() }).passthrough();
const responseSchema = z.object({
  batch_id: z.string().optional(),
  sessions: z.array(sessionSchema).default([]),
  items: z.array(z.object({
    canceled: z.boolean().optional(), workspace_id: z.string().optional(), status: z.string().optional(),
    result: resultSchema.optional(), error: orchestratorErrorSchema.optional(),
  }).passthrough()).default([]),
  error: orchestratorErrorSchema.optional(),
}).passthrough();

test("production MCP server persists attributed completion, failure, cancellation, and restart", async () => {
  await withServer({
    scripts: [
      { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "exact answer" } },
      { statuses: ["failed"], result: { status: "failed", error: "agent failed", retryable: false } },
      { statuses: ["running", "running", "succeeded"], result: { status: "succeeded", output: "too late" } },
    ],
  }, async (harness) => {
    const launched = await launch(harness.client, 3);
    assert.equal(launched.error, undefined, JSON.stringify(launched.error));
    assert.equal(launched.sessions.length, 3);
    assert.equal(new Set(launched.sessions.map(({ batchId }) => batchId)).size, 1);
    const [complete, failed, canceled] = launched.sessions;
    assert.ok(complete && failed && canceled);

    await results(harness.client, [complete.sessionId]);
    const cancelResponse = await call(harness.client, "provider_sessions_cancel", {
      request_id: "cancel", session_ids: [canceled.sessionId], reason: "operator request",
    });
    assert.equal(cancelResponse.items[0]?.canceled, true);
    const terminal = await results(harness.client, launched.sessions.map(({ sessionId }) => sessionId));
    assert.equal(terminal.items[0]?.result?.claim.output, "exact answer");
    assert.equal(terminal.items[0]?.status, "succeeded");
    assert.equal(terminal.items[0]?.result?.attribution.task, "task-0");
    assert.equal(terminal.items[0]?.workspace_id, "workspace-0");
    assert.equal(terminal.items[1]?.result?.claim.error, "agent failed");
    assert.equal(terminal.items[1]?.status, "failed");
    assert.equal(terminal.items[2]?.result?.claim.stopReason, "operator request");
    assert.equal(terminal.items[2]?.status, "canceled");
    const terminalCancel = await call(harness.client, "provider_sessions_cancel", {
      request_id: "late-cancel", session_ids: [complete.sessionId],
    });
    assert.equal(terminalCancel.items[0]?.error?.code, "INVALID_TRANSITION");

    await harness.restart();
    const recovered = await results(harness.client, launched.sessions.map(({ sessionId }) => sessionId));
    assert.deepEqual(recovered.items.map((item) => item.result?.claim), terminal.items.map((item) => item.result?.claim));
    assert.equal((await harness.calls()).filter(({ command }) => command === "launch").length, 3);
  });
});

test("production MCP server deduplicates concurrent semantic batch replays", async () => {
  await withServer({ defaultScript: successScript() }, async (harness) => {
    const first = launchArguments(4);
    const second = { ...launchArguments(4), request_id: "different-correlation" };
    const [left, right] = await Promise.all([
      call(harness.client, "provider_batches_launch", first),
      call(harness.client, "provider_batches_launch", second),
    ]);
    assert.equal(left.batch_id, right.batch_id);
    assert.deepEqual(left.sessions.map(({ sessionId }) => sessionId), right.sessions.map(({ sessionId }) => sessionId));
    assert.equal((await harness.calls()).filter(({ command }) => command === "launch").length, 4);
  });
});

test("production MCP server exposes every provider error once without retries", async () => {
  const cases = [
    [{ launchError: "rejected", defaultScript: successScript() }, "launch", "LAUNCH_REJECTED"],
    [{ cancelUnsupported: true, defaultScript: runningScript() }, "cancel", "CANCEL_UNSUPPORTED"],
    [{ malformedCommands: ["status"], defaultScript: successScript() }, "result", "PROVIDER_PROTOCOL_ERROR"],
    [{ hangCommands: ["status"], defaultScript: successScript() }, "result", "PROVIDER_UNAVAILABLE"],
  ] as const;
  for (const [scenario, operation, code] of cases) {
    await withServer(scenario, async (harness) => {
      const launched = await launch(harness.client, 1);
      if (operation === "launch") {
        const item = (await results(harness.client, [launched.sessions[0]!.sessionId])).items[0];
        assert.equal(item?.error?.code, code, JSON.stringify(item));
        assert.equal(item?.status, "failed");
      } else {
        const sessionId = launched.sessions[0]!.sessionId;
        const response = operation === "cancel"
          ? await call(harness.client, "provider_sessions_cancel", { request_id: "cancel", session_ids: [sessionId] })
          : await results(harness.client, [sessionId]);
        assert.equal(response.items[0]?.error?.code, code);
        assert.deepEqual(
          response.items[0]?.error,
          orchestratorErrorSchema.parse(response.items[0]?.error),
        );
      }
      const command = operation === "launch" ? "launch" : operation === "cancel" ? "cancel" : "status";
      assert.equal((await harness.calls()).filter((call) => call.command === command).length, 1);
    }, 1_000);
  }

  const directory = await mkdtemp(join(tmpdir(), "fake-superset-no-provider-"));
  const statePath = join(directory, "state.json");
  const connection = await connect({
    SUPERSET_ORCHESTRATOR_STATE: statePath,
    SUPERSET_ORCHESTRATOR_ENABLE_PROVIDER_TEST_TOOLS: "1",
  });
  try {
    const unavailable = await call(connection.client, "provider_batches_launch", launchArguments(1));
    assert.equal(unavailable.error?.code, "PROVIDER_UNAVAILABLE");
    assert.equal(unavailable.error?.layer, "provider");
    assert.equal(unavailable.error?.retryable, true);
  } finally {
    await connection.transport.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production MCP server launches one deterministic 100-session batch", async () => {
  await withServer({ defaultScript: successScript() }, async (harness) => {
    const launched = await launch(harness.client, 100);
    assert.equal(launched.sessions.length, 100);
    assert.equal(new Set(launched.sessions.map(({ batchId }) => batchId)).size, 1);
    assert.equal(new Set(launched.sessions.map(({ sessionId }) => sessionId)).size, 100);
    const completed = await results(harness.client, launched.sessions.map(({ sessionId }) => sessionId));
    assert.equal(completed.items.length, 100);
    for (const [index, item] of completed.items.entries()) {
      assert.equal(item.result?.attribution.agent, `agent-${index}`);
      assert.equal(item.result?.attribution.task, `task-${index}`);
      assert.equal(item.result?.claim.output, "ok");
    }
    assert.equal((await harness.calls()).filter(({ command }) => command === "launch").length, 100);
  });
});

function successScript() {
  return { statuses: ["succeeded"], result: { status: "succeeded", output: "ok" } };
}

function runningScript() {
  return { statuses: ["running"], result: null };
}

function launchArguments(count: number) {
  return {
    request_id: "launch", client_id: "integration-client", name: "integration", idempotency_key: "batch-key",
    assignments: Array.from({ length: count }, (_, index) => ({
      label: `task-${index}`, prompt: `prompt-${index}`, workspace_id: `workspace-${index}`,
      agent_preset_id: `agent-${index}`, idempotency_key: `key-${index}`,
    })),
  };
}

async function launch(client: Client, count: number) {
  const response = await call(client, "provider_batches_launch", launchArguments(count));
  assert.equal(response.error, undefined);
  return response;
}

async function results(client: Client, sessionIds: string[]) {
  return call(client, "provider_sessions_results", { request_id: "results", session_ids: sessionIds });
}

async function call(client: Client, name: string, arguments_: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 120_000 });
  return responseSchema.parse(response.structuredContent);
}

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [server], env, stderr: "pipe",
  });
  const client = new Client({ name: "fake-superset-integration", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function withServer(
  scenario: object,
  run: (harness: {
    client: Client;
    restart: () => Promise<void>;
    calls: () => Promise<Array<{ command: string }>>;
  }) => Promise<void>,
  timeoutMs = 10_000,
) {
  const directory = await mkdtemp(join(tmpdir(), "fake-superset-mcp-"));
  const scenarioPath = join(directory, "scenario.json");
  const fakeStatePath = join(directory, "fake-state.json");
  const statePath = join(directory, "orchestrator-state.json");
  const workspaceRoot = join(directory, "workspaces");
  await mkdir(workspaceRoot);
  await Promise.all(Array.from({ length: 100 }, (_, index) => mkdir(join(workspaceRoot, `workspace-${index}`))));
  await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SUPERSET_ORCHESTRATOR_STATE: statePath,
    SUPERSET_ORCHESTRATOR_RECONCILE_MS: "60000",
    SUPERSET_ORCHESTRATOR_ENABLE_PROVIDER_TEST_TOOLS: "1",
    SUPERSET_ORCHESTRATOR_PROVIDER_TEST_WORKSPACE_ROOT: workspaceRoot,
    SUPERSET_ORCHESTRATOR_PROVIDER_EXECUTABLE: process.execPath,
    SUPERSET_ORCHESTRATOR_PROVIDER_ARGS: JSON.stringify([fake, scenarioPath, fakeStatePath]),
    SUPERSET_ORCHESTRATOR_PROVIDER_TIMEOUT_MS: String(timeoutMs),
  };
  let connection = await connect(env);
  const harness = {
    get client() { return connection.client; },
    async restart() {
      await connection.transport.close();
      connection = await connect(env);
    },
    async calls() {
      const state = JSON.parse(await readFile(fakeStatePath, "utf8")) as { calls: Array<{ command: string }> };
      return state.calls;
    },
  };
  try {
    await run(harness);
  } finally {
    await connection.transport.close();
    await rm(directory, { recursive: true, force: true });
  }
}

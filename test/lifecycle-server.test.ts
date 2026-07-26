import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { batchCancelResultSchema } from "../src/tool-contract.js";

async function withServer(run: (client: Client) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-lifecycle-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/server.js")],
    env: {
      ...process.env,
      SUPERSET_ORCHESTRATOR_STATE: join(directory, "state.json"),
      SUPERSET_ORCHESTRATOR_RECONCILE_MS: "60000",
      SUPERSET_ORCHESTRATOR_DEADLINE_MS: "60000",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "lifecycle-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  return response.structuredContent as T;
}

async function createBatch(client: Client, name: string, tasks: string[]) {
  return call<{ batch: { id: string }; sessions: Array<{ sessionId: string }> }>(client, "batches_create", {
    name,
    clientId: "lifecycle-test",
    assignments: tasks.map((task) => ({ agent: "codex", task })),
  });
}

test("the MCP surface publishes the lifecycle tools", async () => withServer(async (client) => {
  const { tools } = await client.listTools();
  const names = new Set(tools.map(({ name }) => name));
  for (const expected of ["sessions_cancel", "batches_cancel", "batches_wait", "sessions_set_deadline", "deadlines_enforce"]) {
    assert.equal(names.has(expected), true, `missing tool ${expected}`);
  }
}));

test("the default backend refuses cancellation honestly over MCP", async () => withServer(async (client) => {
  const created = await createBatch(client, "cancel-unsupported", ["one", "two"]);
  const sessionIds = created.sessions.map(({ sessionId }) => sessionId);

  const cancelled = await call<{ items: Array<{ sessionId: string; error: string; status: string }> }>(
    client, "sessions_cancel", { sessionIds },
  );
  assert.equal(cancelled.items.length, 2);
  for (const item of cancelled.items) {
    assert.equal(item.error, "CANCEL_UNSUPPORTED");
    assert.equal(item.status, "requested");
  }

  const status = await call<{ summary: { counts: Record<string, number> } }>(client, "batches_status", { batchId: created.batch.id });
  assert.equal(status.summary.counts.requested, 2);
  assert.equal(status.summary.counts.canceling, 0);
}));

test("batch cancellation reports unknown batches without failing the call", async () => withServer(async (client) => {
  const created = await createBatch(client, "cancel-batch", ["one"]);
  const cancelled = await call<unknown>(client, "batches_cancel", {
    batchIds: [created.batch.id, "missing-batch"],
  });
  const parsed = batchCancelResultSchema.parse(cancelled);

  const first = parsed.data.items[0]!;
  const second = parsed.data.items[1]!;
  assert.equal("sessions" in first && "error" in first.sessions[0]! ? first.sessions[0].error.code : undefined, "CANCEL_UNSUPPORTED");
  assert.equal("error" in second ? second.error.code : undefined, "BATCH_NOT_FOUND");
}));

test("a bounded wait returns exact partial counts rather than hanging", async () => withServer(async (client) => {
  const created = await createBatch(client, "wait", ["one", "two"]);
  const started = Date.now();
  const waited = await call<{ items: Array<{ batchId: string; timedOut: boolean; total: number; settled: number }> }>(
    client, "batches_wait", { batchIds: [created.batch.id], timeoutMs: 150 },
  );

  assert.equal(waited.items[0]!.timedOut, true);
  assert.equal(waited.items[0]!.total, 2);
  assert.equal(waited.items[0]!.settled, 0);
  assert.equal(Date.now() - started < 5_000, true, "the wait respected its bound");
}));

test("a wait above the hard cap is rejected as an invalid argument", async () => withServer(async (client) => {
  const response = await client.callTool({
    name: "batches_wait",
    arguments: { batchIds: ["batch"], timeoutMs: 30_001 },
  });
  assert.equal(response.isError, true);
}));

test("deadlines expire nonterminal sessions as failed/deadline_exceeded", async () => withServer(async (client) => {
  const created = await createBatch(client, "deadline", ["one"]);
  const sessionIds = created.sessions.map(({ sessionId }) => sessionId);
  const scheduled = await call<{ items: Array<{ sessionId: string; deadlineAt: string }> }>(
    client, "sessions_set_deadline", { sessionIds, deadlineMs: 1 },
  );
  assert.equal(scheduled.items[0]!.deadlineAt.length > 0, true);

  await new Promise((settle) => setTimeout(settle, 25));
  const expired = await call<{ expired: Array<{ sessionId: string; status: string }> }>(client, "deadlines_enforce", {});
  assert.deepEqual(expired.expired.map(({ sessionId, status }) => ({ sessionId, status })), [
    { sessionId: sessionIds[0]!, status: "failed" },
  ]);

  const page = await call<{ sessions: Array<{ status: string }> }>(client, "batches_get", { batchId: created.batch.id });
  assert.equal(page.sessions[0]!.status, "failed");
  assert.deepEqual(await call<{ expired: unknown[] }>(client, "deadlines_enforce", {}), { expired: [] });
}));

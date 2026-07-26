import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  batchCancelResultSchema,
  cancelResultSchema,
  enforceDeadlinesResultSchema,
  jsonSchemaCatalog,
  setDeadlineResultSchema,
  waitResultSchema,
} from "../src/tool-contract.js";

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
    assert.ok(expected in (jsonSchemaCatalog() as { tools: Record<string, unknown> }).tools, `missing contract ${expected}`);
  }
}));

test("the default backend refuses cancellation honestly over MCP", async () => withServer(async (client) => {
  const created = await createBatch(client, "cancel-unsupported", ["one", "two"]);
  const sessionIds = created.sessions.map(({ sessionId }) => sessionId);

  const cancelled = cancelResultSchema.parse(await call<unknown>(
    client, "sessions_cancel", { contract_version: "1.0", session_ids: sessionIds },
  ));
  assert.equal(cancelled.data.items.length, 2);
  for (const item of cancelled.data.items) {
    assert.equal("error" in item ? item.error.code : undefined, "CANCEL_UNSUPPORTED");
  }

  const status = await call<{ summary: { counts: Record<string, number> } }>(client, "batches_status", { batchId: created.batch.id });
  assert.equal(status.summary.counts.requested, 2);
  assert.equal(status.summary.counts.canceling, 0);
}));

test("batch cancellation reports unknown batches without failing the call", async () => withServer(async (client) => {
  const created = await createBatch(client, "cancel-batch", ["one"]);
  const cancelled = await call<unknown>(client, "batches_cancel", {
    contract_version: "1.0", batch_ids: [created.batch.id, "missing-batch"],
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
  const waited = waitResultSchema.parse(await call<unknown>(
    client, "batches_wait", { contract_version: "1.0", batch_ids: [created.batch.id], timeout_ms: 150 },
  ));

  assert.equal("timed_out" in waited.data.items[0]! ? waited.data.items[0].timed_out : false, true);
  assert.equal("counts" in waited.data.items[0]! ? waited.data.items[0].counts.requested : 0, 2);
  assert.equal(Date.now() - started < 5_000, true, "the wait respected its bound");
}));

test("the MCP connection recovers after rejecting a wait above the hard cap", async () => withServer(async (client) => {
  const created = await createBatch(client, "invalid-wait-recovery", ["one"]);
  const response = await client.callTool({
    name: "batches_wait",
    arguments: { contract_version: "1.0", batch_ids: [created.batch.id], timeout_ms: 30_001 },
  });
  assert.equal(response.isError, true);

  const recovered = waitResultSchema.parse(await call<unknown>(
    client, "batches_wait", { contract_version: "1.0", batch_ids: [created.batch.id], timeout_ms: 0 },
  ));
  const item = recovered.data.items[0]!;
  assert.equal("batch_id" in item ? item.batch_id : undefined, created.batch.id);
  assert.equal("timed_out" in item ? item.timed_out : false, true);
  assert.equal("counts" in item ? item.counts.requested : 0, 1);
}));

test("deadlines expire nonterminal sessions as failed/deadline_exceeded", async () => withServer(async (client) => {
  const created = await createBatch(client, "deadline", ["one"]);
  const sessionIds = created.sessions.map(({ sessionId }) => sessionId);
  const scheduled = setDeadlineResultSchema.parse(await call<unknown>(
    client, "sessions_set_deadline", { contract_version: "1.0", session_ids: sessionIds, deadline_ms: 1 },
  ));
  assert.equal("deadline_at" in scheduled.data.items[0]! && scheduled.data.items[0].deadline_at.length > 0, true);

  await new Promise((settle) => setTimeout(settle, 25));
  const expired = enforceDeadlinesResultSchema.parse(await call<unknown>(client, "deadlines_enforce", { contract_version: "1.0" }));
  assert.deepEqual(expired.data.expired.map(({ session_id, state }) => ({ session_id, state })), [
    { session_id: sessionIds[0]!, state: "failed" },
  ]);
  assert.equal(expired.data.has_more, false);

  const page = await call<{ sessions: Array<{ status: string }> }>(client, "batches_get", { batchId: created.batch.id });
  assert.equal(page.sessions[0]!.status, "failed");
  const repeated = enforceDeadlinesResultSchema.parse(await call<unknown>(client, "deadlines_enforce", { contract_version: "1.0" }));
  assert.deepEqual(repeated.data.expired, []);
  assert.equal(repeated.data.has_more, false);

  const terminalDeadline = setDeadlineResultSchema.parse(await call<unknown>(
    client,
    "sessions_set_deadline",
    { contract_version: "1.0", session_ids: sessionIds, deadline_ms: 1_000 },
  ));
  const item = terminalDeadline.data.items[0]!;
  assert.equal("error" in item ? item.error.code : undefined, "INVALID_TRANSITION");
}));

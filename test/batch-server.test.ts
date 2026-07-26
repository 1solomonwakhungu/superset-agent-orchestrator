import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP batch tools create 100 sessions immediately and paginate the remaining results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-batch-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/server.js")],
    env: { ...process.env, SUPERSET_ORCHESTRATOR_STATE: join(directory, "state.json"), SUPERSET_ORCHESTRATOR_RECONCILE_MS: "60000" },
    stderr: "pipe",
  });
  const client = new Client({ name: "batch-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const assignments = Array.from({ length: 105 }, (_, index) => ({ agent: `agent-${index}`, task: `task-${index}` }));
    const createdResponse = await client.callTool({
      name: "batches_create",
      arguments: { name: "mcp", clientId: "test", idempotencyKey: "mcp-request", assignments },
    });
    const created = createdResponse.structuredContent as { batch: { id: string }; sessions: Array<{ sessionId: string; status: string }> };
    assert.equal(created.sessions.length, 105);
    assert.equal(created.sessions.every(({ status }) => status === "requested"), true);

    const firstResponse = await client.callTool({ name: "batches_status", arguments: { batchId: created.batch.id } });
    const first = firstResponse.structuredContent as { sessions: unknown[]; nextCursor: string; summary: { total: number } };
    assert.equal(first.sessions.length, 100);
    assert.equal(first.summary.total, 105);
    const secondResponse = await client.callTool({
      name: "batches_status", arguments: { batchId: created.batch.id, cursor: first.nextCursor },
    });
    const second = secondResponse.structuredContent as { sessions: unknown[] };
    assert.equal(second.sessions.length, 5);
  } finally {
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  }
});

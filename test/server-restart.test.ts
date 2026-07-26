import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DurableState } from "../src/store.js";

test("a replacement MCP client reopens an attributed batch from a killed server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-mcp-restart-"));
  const statePath = join(directory, "state.json");
  const now = "2026-07-24T10:00:00.000Z";
  const state: DurableState = {
    version: 1,
    sessions: [{ id: "session-1", clientId: "original-client", createdAt: now, lastSeenAt: now }],
    batches: [{ id: "batch-1", name: "recover-me", sessionId: "session-1", createdAt: now, updatedAt: now }],
    workers: [{
      id: "worker-1",
      batchId: "batch-1",
      sessionId: "session-1",
      status: "succeeded",
      attribution: { agent: "codex", task: "implementation" },
      startedAt: now,
      completedAt: now,
      result: { answer: 42 },
    }],
    diagnostics: [],
    assignments: [],
    auditEvents: [],
    launchIntents: [],
  };
  await writeFile(statePath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });

  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "..", "dist", "src", "server.js")],
      env: {
        ...process.env,
        SUPERSET_ORCHESTRATOR_STATE: statePath,
        SUPERSET_ORCHESTRATOR_RECONCILE_MS: "60000",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "restart-test", version: "1.0.0" });
    await client.connect(transport);
    return { client, transport };
  };

  try {
    const original = await connect();
    await original.transport.close();

    const replacement = await connect();
    const response = await replacement.client.callTool({ name: "reopen_batch", arguments: { name: "recover-me" } });
    const recovered = response.structuredContent as {
      batch: { id: string };
      session: { clientId: string };
      workers: Array<{ attribution: { agent: string }; result: { answer: number } }>;
    };
    assert.equal(recovered.batch.id, "batch-1");
    assert.equal(recovered.session.clientId, "original-client");
    assert.equal(recovered.workers[0]?.attribution.agent, "codex");
    assert.equal(recovered.workers[0]?.result.answer, 42);
    await replacement.transport.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

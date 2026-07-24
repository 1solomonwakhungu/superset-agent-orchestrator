#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DurableStore } from "./store.js";

const statePath = process.env.SUPERSET_ORCHESTRATOR_STATE
  ?? join(homedir(), ".local", "share", "superset-agent-orchestrator", "state.json");
const store = new DurableStore(statePath);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

async function main(): Promise<void> {
  const reconciliation = await store.reconcile();
  console.error(`Startup reconciliation complete: ${JSON.stringify(reconciliation)}`);
  const reconciliationTimer = setInterval(() => {
    store.reconcile().catch((error: unknown) => {
      console.error(`Background reconciliation failed: ${error instanceof Error ? error.message : error}`);
    });
  }, Number(process.env.SUPERSET_ORCHESTRATOR_RECONCILE_MS ?? 30_000));
  reconciliationTimer.unref();

  const server = new McpServer({ name: "superset-agent-orchestrator", version: "0.1.0" });
  server.registerTool(
    "recent_sessions",
    {
      description: "List durable orchestration sessions after a server or client restart",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    },
    ({ limit }) => result({ sessions: store.recentSessions(limit) }),
  );
  server.registerTool(
    "reopen_batch",
    {
      description: "Reopen the newest durable batch with an exact name, including attributed worker results",
      inputSchema: { name: z.string().min(1) },
    },
    ({ name }) => {
      const recovered = store.reopenBatch(name);
      return recovered
        ? result(recovered)
        : { content: [{ type: "text", text: `No durable batch named ${JSON.stringify(name)}` }], isError: true };
    },
  );
  server.registerTool(
    "recovery_diagnostics",
    {
      description: "List orphan, unknown-outcome, and missing-result diagnostics found during reconciliation",
      inputSchema: {
        kind: z.enum(["orphan", "unknown_outcome", "missing_result"]).optional(),
      },
    },
    ({ kind }) => result({ diagnostics: store.diagnostics(kind) }),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

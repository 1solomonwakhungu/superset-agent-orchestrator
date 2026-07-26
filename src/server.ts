#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RedactionPolicy } from "./security.js";
import { BatchQueryError, DurableStore } from "./store.js";
import { assertRegisteredToolNames, assertSafeToolNames } from "./tool-security.js";

const statePath = process.env.SUPERSET_ORCHESTRATOR_STATE
  ?? join(homedir(), ".local", "share", "superset-agent-orchestrator", "state.json");
const redaction = new RedactionPolicy((process.env.SUPERSET_ORCHESTRATOR_REDACTION_CANARIES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const store = new DurableStore(statePath, undefined, (measurement) => {
  console.error(`Batch query: ${JSON.stringify(measurement)}`);
}, undefined, redaction);

function result(value: unknown) {
  const safe = store.redactValue(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
    structuredContent: safe as Record<string, unknown>,
  };
}

function batchError(error: unknown) {
  const typed = error instanceof BatchQueryError;
  const value = {
    error: { code: typed ? error.code : "internal_error", message: store.safeError(error) },
  };
  return { ...result(value), isError: true };
}

const registeredToolNames: string[] = [];

/** Records a tool name and refuses a destructive or generic capability at registration. */
function tool(name: string): string {
  assertSafeToolNames([name]);
  registeredToolNames.push(name);
  return name;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Unsupported platform ${process.platform}; supported platforms are darwin and linux. See docs/compatibility.md.`,
    );
  }
  const reconciliation = await store.reconcile();
  console.error(`Startup reconciliation complete: ${JSON.stringify(reconciliation)}`);
  const reconciliationTimer = setInterval(() => {
    store.reconcile().catch((error: unknown) => {
      console.error("Background reconciliation failed:", store.safeError(error));
    });
  }, Number(process.env.SUPERSET_ORCHESTRATOR_RECONCILE_MS ?? 30_000));
  reconciliationTimer.unref();

  const server = new McpServer({ name: "superset-agent-orchestrator", version: "0.1.0" });
  const pageSchema = {
    batchId: z.string().min(1),
    sessionIds: z.array(z.string().min(1)).max(250).optional(),
    limit: z.number().int().min(1).max(250).default(100),
    cursor: z.string().min(1).optional(),
  };
  server.registerTool(
    tool("batches_create"),
    {
      description: "Durably accept up to 250 attributed sessions and return stable IDs without waiting for execution",
      inputSchema: {
        name: z.string().min(1), clientId: z.string().min(1), idempotencyKey: z.string().min(1).optional(),
        assignments: z.array(z.object({ agent: z.string().min(1), task: z.string().min(1) })).min(1).max(250),
      },
    },
    async ({ name, clientId, idempotencyKey, assignments }) => {
      try {
        const created = await store.createBatch(name, clientId, assignments, idempotencyKey);
        return result({
          batch: created.batch,
          sessions: created.sessions.map(({ id, batchId, status, attribution }) => ({ sessionId: id, batchId, status, attribution })),
          duplicate: created.duplicate,
        });
      } catch (error) {
        return batchError(error);
      }
    },
  );
  for (const [name, description, query] of [
    ["batches_get", "Get an ordered page of exactly attributed batch sessions", store.getBatch.bind(store)],
    ["batches_status", "Get persisted mixed-state status without polling each agent", store.batchStatus.bind(store)],
    ["batches_results", "Get completed results independently while the rest of a batch continues", store.batchResults.bind(store)],
  ] as const) {
    server.registerTool(tool(name), { description, inputSchema: pageSchema }, async ({ batchId, sessionIds, limit, cursor }) => {
      try {
        return result(await query(batchId, { limit, ...(sessionIds === undefined ? {} : { ids: sessionIds }), ...(cursor === undefined ? {} : { cursor }) }));
      } catch (error) {
        return batchError(error);
      }
    });
  }
  server.registerTool(
    tool("recent_sessions"),
    {
      description: "List durable orchestration sessions after a server or client restart",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    },
    ({ limit }) => result({ sessions: store.recentSessions(limit) }),
  );
  server.registerTool(
    tool("reopen_batch"),
    {
      description: "Reopen the newest durable batch with an exact name, including attributed worker results",
      inputSchema: { name: z.string().min(1) },
    },
    ({ name }) => {
      const recovered = store.reopenBatch(name);
      return recovered
        ? result(recovered)
        : { ...result({ error: { code: "not_found", message: `No durable batch named ${JSON.stringify(name)}` } }), isError: true };
    },
  );
  server.registerTool(
    tool("recovery_diagnostics"),
    {
      description: "List orphan, unknown-outcome, and missing-result diagnostics found during reconciliation",
      inputSchema: {
        kind: z.enum(["orphan", "unknown_outcome", "missing_result"]).optional(),
      },
    },
    ({ kind }) => result({ diagnostics: store.diagnostics(kind) }),
  );

  assertRegisteredToolNames(registeredToolNames);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(store.safeError(error));
  process.exitCode = 1;
});

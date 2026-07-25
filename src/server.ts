#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BatchQueryError, DurableStore } from "./store.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { LifecycleService, MAX_LIFECYCLE_WAIT_MS } from "./lifecycle-service.js";

const statePath = process.env.SUPERSET_ORCHESTRATOR_STATE
  ?? join(homedir(), ".local", "share", "superset-agent-orchestrator", "state.json");
const store = new DurableStore(statePath, undefined, (measurement) => {
  console.error(`Batch query: ${JSON.stringify(measurement)}`);
});
/**
 * The stable Superset surface exposes no supported cancellation or status query today, so the default
 * backend refuses honestly instead of pretending. Swapping in a capable adapter enables the full path.
 */
const unsupportedBackend: AgentAdapter = {
  cancellation: "unsupported",
  findByIdempotencyKey: async () => undefined,
  launch: async () => { throw new Error("Launch adapter is not configured"); },
  status: async () => { throw new Error("Lifecycle status is not supported by the stable Superset API"); },
  result: async () => undefined,
  cancel: async () => ({ status: "unsupported" }),
  resumeMetadata: async () => undefined,
};
const lifecycle = new LifecycleService(store, unsupportedBackend);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function batchError(error: unknown) {
  const typed = error instanceof BatchQueryError;
  const value = {
    error: { code: typed ? error.code : "internal_error", message: error instanceof Error ? error.message : String(error) },
  };
  return { ...result(value), isError: true };
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

  const deadlineTimer = setInterval(() => {
    lifecycle.enforceDeadlines().then((expired) => {
      if (expired.length > 0) console.error(`Deadlines enforced: ${JSON.stringify(expired)}`);
    }).catch((error: unknown) => {
      console.error(`Deadline enforcement failed: ${error instanceof Error ? error.message : error}`);
    });
  }, Number(process.env.SUPERSET_ORCHESTRATOR_DEADLINE_MS ?? 5_000));
  deadlineTimer.unref();

  const server = new McpServer({ name: "superset-agent-orchestrator", version: "0.1.0" });
  const pageSchema = {
    batchId: z.string().min(1),
    sessionIds: z.array(z.string().min(1)).max(250).optional(),
    limit: z.number().int().min(1).max(250).default(100),
    cursor: z.string().min(1).optional(),
  };
  server.registerTool(
    "batches_create",
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
    server.registerTool(name, { description, inputSchema: pageSchema }, async ({ batchId, sessionIds, limit, cursor }) => {
      try {
        return result(await query(batchId, { limit, ...(sessionIds === undefined ? {} : { ids: sessionIds }), ...(cursor === undefined ? {} : { cursor }) }));
      } catch (error) {
        return batchError(error);
      }
    });
  }
  const cancellationReason = z.enum(["user_requested", "orchestrator_shutdown", "superseded", "policy_revoked"])
    .default("user_requested");
  server.registerTool(
    "sessions_cancel",
    {
      description: "Request cancellation for sessions; unsupported backends return CANCEL_UNSUPPORTED without changing state",
      inputSchema: {
        sessionIds: z.array(z.string().min(1)).min(1).max(100),
        reason: cancellationReason,
        detail: z.string().min(1).max(1000).optional(),
      },
    },
    async ({ sessionIds, reason, detail }) => {
      const unique = [...new Set(sessionIds)];
      if (unique.length !== sessionIds.length) {
        return batchError(new BatchQueryError("invalid_request", "sessionIds must be unique"));
      }
      const items = [];
      for (const id of unique) items.push(await lifecycle.cancelSession(id, reason, detail));
      return result({ items });
    },
  );
  server.registerTool(
    "batches_cancel",
    {
      description: "Request cancellation for every nonterminal session in a batch and return item-level outcomes",
      inputSchema: {
        batchIds: z.array(z.string().min(1)).min(1).max(100),
        reason: cancellationReason,
        detail: z.string().min(1).max(1000).optional(),
      },
    },
    async ({ batchIds, reason, detail }) => {
      const unique = [...new Set(batchIds)];
      if (unique.length !== batchIds.length) {
        return batchError(new BatchQueryError("invalid_request", "batchIds must be unique"));
      }
      const items = [];
      for (const batchId of unique) {
        try {
          items.push({ batchId, sessions: await lifecycle.cancelBatch(batchId, reason, detail) });
        } catch (error) {
          items.push({
            batchId,
            error: error instanceof BatchQueryError && error.code === "not_found" ? "BATCH_NOT_FOUND" : "internal_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result({ items });
    },
  );
  server.registerTool(
    "batches_wait",
    {
      description: "Wait at most 30 seconds for aggregate batch progress and return exact partial counts on timeout",
      inputSchema: {
        batchIds: z.array(z.string().min(1)).min(1).max(100),
        timeoutMs: z.number().int().min(0).max(MAX_LIFECYCLE_WAIT_MS).default(MAX_LIFECYCLE_WAIT_MS),
        until: z.enum(["any_terminal", "all_terminal"]).default("all_terminal"),
      },
    },
    async ({ batchIds, timeoutMs, until }) => {
      const unique = [...new Set(batchIds)];
      if (unique.length !== batchIds.length) {
        return batchError(new BatchQueryError("invalid_request", "batchIds must be unique"));
      }
      return result({ items: await lifecycle.waitForBatches(unique, { timeoutMs, until }) });
    },
  );
  server.registerTool(
    "sessions_set_deadline",
    {
      description: "Set an absolute deadline after which nonterminal sessions are expired as failed/deadline_exceeded",
      inputSchema: {
        sessionIds: z.array(z.string().min(1)).min(1).max(100),
        deadlineMs: z.number().int().positive(),
      },
    },
    async ({ sessionIds, deadlineMs }) => {
      const deadline = new Date(Date.now() + deadlineMs);
      const items = [];
      for (const id of [...new Set(sessionIds)]) {
        try {
          const worker = await store.setWorkerDeadline(id, deadline);
          items.push({ sessionId: id, deadlineAt: worker.deadlineAt, status: worker.status });
        } catch (error) {
          items.push({
            sessionId: id,
            error: error instanceof BatchQueryError && error.code === "not_found" ? "SESSION_NOT_FOUND" : "internal_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result({ items });
    },
  );
  server.registerTool(
    "deadlines_enforce",
    {
      description: "Expire every nonterminal session whose deadline has passed and report the exact expirations",
      inputSchema: {},
    },
    async () => result({ expired: await lifecycle.enforceDeadlines() }),
  );
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

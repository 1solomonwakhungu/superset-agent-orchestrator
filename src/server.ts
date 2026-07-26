#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BatchQueryError, DurableStore } from "./store.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { LifecycleService, MAX_LIFECYCLE_WAIT_MS } from "./lifecycle-service.js";
import {
  batchCancelRequestSchema,
  batchCancelResultSchema,
  cancelRequestSchema,
  cancelResultSchema,
  CONTRACT_VERSION,
  errorDefinitions,
  waitRequestSchema,
  waitResultSchema,
  type ErrorCode,
} from "./tool-contract.js";

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

function contractError(code: ErrorCode, message: string) {
  return { code, ...errorDefinitions[code], message };
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
      console.error("Background reconciliation failed:", error);
    });
  }, Number(process.env.SUPERSET_ORCHESTRATOR_RECONCILE_MS ?? 30_000));
  reconciliationTimer.unref();

  let lifecycleSweep: Promise<void> | undefined;
  const deadlineTimer = setInterval(() => {
    if (lifecycleSweep !== undefined) return;
    lifecycleSweep = Promise.all([
      lifecycle.enforceDeadlines(),
      lifecycle.reconcileCancellations(),
      lifecycle.reconcileTimedOutResults(),
    ]).then(([expired]) => {
      if (expired.length > 0) console.error(`Deadlines enforced: ${JSON.stringify(expired)}`);
    }).catch((error: unknown) => {
      console.error(`Lifecycle enforcement failed: ${error instanceof Error ? error.message : error}`);
    }).finally(() => {
      lifecycleSweep = undefined;
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
  server.registerTool(
    "sessions_cancel",
    {
      description: "Request cancellation for sessions; unsupported backends return CANCEL_UNSUPPORTED without changing state",
      inputSchema: cancelRequestSchema.shape,
    },
    async ({ session_ids: sessionIds, reason }) => {
      const items = [];
      for (const id of sessionIds) {
        const outcome = await lifecycle.cancelSession(id, "user_requested", reason);
        items.push("error" in outcome
          ? { session_id: id, error: contractError(outcome.error, outcome.message) }
          : {
            session_id: id,
            state: contractState(outcome.status),
            ...(outcome.stopReason === undefined ? {} : { stop_reason: outcome.stopReason }),
            changed: outcome.changed,
          });
      }
      return result(cancelResultSchema.parse(contractEnvelope({ items })));
    },
  );
  server.registerTool(
    "batches_cancel",
    {
      description: "Request cancellation for every nonterminal session in a batch and return item-level outcomes",
      inputSchema: batchCancelRequestSchema.shape,
    },
    async ({ batch_ids: batchIds, reason }) => {
      const items = [];
      for (const batchId of batchIds) {
        try {
          const sessions = (await lifecycle.cancelBatch(batchId, "user_requested", reason)).map((outcome) => {
            if ("error" in outcome) {
              return { session_id: outcome.sessionId, error: contractError(outcome.error, outcome.message) };
            }
            return {
              session_id: outcome.sessionId,
              state: contractState(outcome.status),
              ...(outcome.stopReason === undefined ? {} : { stop_reason: outcome.stopReason }),
              changed: outcome.changed,
            };
          });
          items.push({ batch_id: batchId, sessions });
        } catch (error) {
          items.push({
            batch_id: batchId,
            error: contractError(
              error instanceof BatchQueryError && error.code === "not_found" ? "BATCH_NOT_FOUND" : "STATE_UNAVAILABLE",
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
      }
      return result(batchCancelResultSchema.parse(contractEnvelope({ items })));
    },
  );
  server.registerTool(
    "batches_wait",
    {
      description: "Wait at most 30 seconds for aggregate batch progress and return exact partial counts on timeout",
      inputSchema: waitRequestSchema.shape,
    },
    async ({ batch_ids: batchIds, timeout_ms: timeoutMs, until }) => {
      const waited = await lifecycle.waitForBatches(batchIds, { timeoutMs, until });
      const items = waited.map((item) => "error" in item
        ? { batch_id: item.batchId, error: contractError(item.error, item.message) }
        : { batch_id: item.batchId, timed_out: item.timedOut, counts: contractCounts(item.counts) });
      return result(waitResultSchema.parse(contractEnvelope({ items })));
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

function contractState(status: import("./store.js").WorkerStatus) {
  if (status === "succeeded") return "completed" as const;
  if (status === "unknown_outcome") return "lost" as const;
  return status;
}

function contractEnvelope(data: unknown) {
  return { contract_version: CONTRACT_VERSION, request_id: randomUUID(), warnings: [], data };
}

function contractCounts(counts: Record<import("./store.js").WorkerStatus, number>) {
  return {
    requested: counts.requested,
    launching: 0,
    running: counts.running,
    canceling: counts.canceling,
    lost: counts.unknown_outcome,
    completed: counts.succeeded,
    failed: counts.failed,
    canceled: counts.canceled,
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

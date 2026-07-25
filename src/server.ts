#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BatchQueryError, DurableStore } from "./store.js";
import { LaunchService } from "./launch-service.js";
import { ResultCaptureService } from "./result-capture.js";
import { SupersetProcessAdapter, SupersetProcessError } from "./superset-process-adapter.js";

const statePath = process.env.SUPERSET_ORCHESTRATOR_STATE
  ?? join(homedir(), ".local", "share", "superset-agent-orchestrator", "state.json");
const store = new DurableStore(statePath, undefined, (measurement) => {
  console.error(`Batch query: ${JSON.stringify(measurement)}`);
});

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

  const server = new McpServer({ name: "superset-agent-orchestrator", version: "0.1.0" });
  const providerExecutable = process.env.SUPERSET_ORCHESTRATOR_PROVIDER_EXECUTABLE;
  const provider = providerExecutable === undefined ? undefined : new SupersetProcessAdapter({
    executable: providerExecutable,
    args: JSON.parse(process.env.SUPERSET_ORCHESTRATOR_PROVIDER_ARGS ?? "[]") as string[],
    timeoutMs: Number(process.env.SUPERSET_ORCHESTRATOR_PROVIDER_TIMEOUT_MS ?? 30_000),
  });
  const launches = provider === undefined ? undefined : new LaunchService(store, provider);
  const capture = provider === undefined ? undefined : new ResultCaptureService(store, provider);
  if (launches !== undefined) await launches.dispatchPending();

  const integrationAssignment = z.object({
    label: z.string().min(1), prompt: z.string().min(1), workspace_id: z.string().min(1),
    agent_preset_id: z.string().min(1), idempotency_key: z.string().min(1),
  }).strict();
  server.registerTool(
    "provider_batches_launch",
    {
      description: "Durably launch one real batch through the configured Superset provider",
      inputSchema: {
        request_id: z.string().min(1), name: z.string().min(1), idempotency_key: z.string().min(1),
        assignments: z.array(integrationAssignment).min(1).max(100),
      },
    },
    async ({ request_id, name, idempotency_key, assignments }) => {
      if (launches === undefined) return providerError(request_id, "PROVIDER_UNAVAILABLE", "No Superset provider is configured");
      try {
        const accepted = await launches.acceptBatch({
          idempotencyKey: idempotency_key, clientId: request_id, batchName: name,
          assignments: assignments.map((assignment) => ({
            idempotencyKey: assignment.idempotency_key,
            attribution: { agent: assignment.agent_preset_id, task: assignment.label },
            prompt: assignment.prompt, workspaceId: assignment.workspace_id,
            workspacePath: assignment.workspace_id,
          })),
        });
        await launches.dispatchPending();
        return result({ request_id, batch_id: accepted[0]!.batchId, sessions: accepted });
      } catch (error) {
        return processFailure(request_id, error);
      }
    },
  );
  server.registerTool(
    "provider_sessions_results",
    {
      description: "Refresh and return exact attributed results for up to 100 sessions",
      inputSchema: { request_id: z.string().min(1), session_ids: z.array(z.string().min(1)).min(1).max(100) },
    },
    async ({ request_id, session_ids }) => {
      if (capture === undefined) return providerError(request_id, "PROVIDER_UNAVAILABLE", "No Superset provider is configured");
      const assignments = await store.assignmentsForSessions(session_ids);
      const items = [];
      for (const [index, assignment] of assignments.entries()) {
        const sessionId = session_ids[index]!;
        if (assignment === undefined) {
          items.push({ session_id: sessionId, error: { code: "SESSION_NOT_FOUND", message: "Unknown session" } });
          continue;
        }
        if (assignment.status === "launched") {
          try {
            await capture.collect(assignment.id, `provider:${assignment.attemptId}`);
          } catch (error) {
            if (error instanceof SupersetProcessError) {
              items.push({ session_id: sessionId, error: { code: error.code, message: error.message } });
              continue;
            }
            throw error;
          }
        }
        const captured = (await store.resultsForSessions([sessionId]))[0];
        items.push({
          session_id: sessionId, assignment_id: assignment.id, batch_id: assignment.batchId,
          status: assignment.status, attribution: assignment.attribution,
          workspace_id: assignment.workspaceId, run_id: assignment.runId,
          ...(captured === undefined ? {} : { result: captured }),
          ...(assignment.error === undefined ? {} : { error: { code: "LAUNCH_REJECTED", message: assignment.error } }),
        });
      }
      return result({ request_id, items });
    },
  );
  server.registerTool(
    "provider_sessions_cancel",
    {
      description: "Cancel configured Superset provider sessions without retries",
      inputSchema: {
        request_id: z.string().min(1), session_ids: z.array(z.string().min(1)).min(1).max(100),
        reason: z.string().min(1).optional(),
      },
    },
    async ({ request_id, session_ids, reason }) => {
      if (provider === undefined) return providerError(request_id, "PROVIDER_UNAVAILABLE", "No Superset provider is configured");
      const assignments = await store.assignmentsForSessions(session_ids);
      const captured = await store.resultsForSessions(session_ids);
      const items = [];
      for (const [index, assignment] of assignments.entries()) {
        const sessionId = session_ids[index]!;
        if (assignment === undefined || assignment.runId === undefined) {
          items.push({ session_id: sessionId, error: { code: "SESSION_NOT_FOUND", message: "Session has no provider execution" } });
          continue;
        }
        if (captured[index] !== undefined) {
          items.push({
            session_id: sessionId,
            error: { code: "INVALID_TRANSITION", message: "A terminal session cannot be canceled" },
          });
          continue;
        }
        try {
          await provider.cancel({ runId: assignment.runId }, reason);
          items.push({ session_id: sessionId, canceled: true });
        } catch (error) {
          const failure = error instanceof SupersetProcessError
            ? { code: error.code, message: error.message }
            : { code: "PROVIDER_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) };
          items.push({ session_id: sessionId, error: failure });
        }
      }
      return result({ request_id, items });
    },
  );
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

function providerError(requestId: string, code: string, message: string) {
  return { ...result({ request_id: requestId, error: { code, message } }), isError: true };
}

function processFailure(requestId: string, error: unknown) {
  return error instanceof SupersetProcessError
    ? providerError(requestId, error.code, error.message)
    : providerError(requestId, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

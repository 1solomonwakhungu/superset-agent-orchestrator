#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertDataOperand, RegisteredWorkspaceAuthorizer, RedactionPolicy, type WorkspaceAuthorizer } from "./security.js";
import { BatchQueryError, DurableStore } from "./store.js";
import { LaunchService } from "./launch-service.js";
import { ResultCaptureService } from "./result-capture.js";
import { SupersetProcessAdapter, SupersetProcessError } from "./superset-process-adapter.js";
import { assertRegisteredToolNames, assertSafeToolNames } from "./tool-security.js";
import { SupersetDiscoveryAdapter } from "./superset-discovery.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { LifecycleService } from "./lifecycle-service.js";
import {
  batchCancelRequestSchema,
  batchCancelResultSchema,
  cancelRequestSchema,
  cancelResultSchema,
  CONTRACT_VERSION,
  errorDefinitions,
  enforceDeadlinesRequestSchema,
  enforceDeadlinesResultSchema,
  setDeadlineRequestSchema,
  setDeadlineResultSchema,
  waitRequestSchema,
  waitResultSchema,
  type ErrorCode,
} from "./tool-contract.js";

const statePath = process.env.SUPERSET_ORCHESTRATOR_STATE
  ?? join(homedir(), ".local", "share", "superset-agent-orchestrator", "state.json");
const redaction = new RedactionPolicy((process.env.SUPERSET_ORCHESTRATOR_REDACTION_CANARIES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const store = new DurableStore(statePath, undefined, (measurement) => {
  console.error(`Batch query: ${JSON.stringify(measurement)}`);
}, undefined, redaction);
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

function contractError(code: ErrorCode, message: string) {
  return { code, ...errorDefinitions[code], message };
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Unsupported platform ${process.platform}; supported platforms are darwin and linux. See docs/compatibility.md.`,
    );
  }
  await store.recoverLifecycleDeliveryClaims();
  const reconciliation = await store.reconcile();
  console.error(`Startup reconciliation complete: ${JSON.stringify(reconciliation)}`);
  const reconciliationTimer = setInterval(() => {
    store.reconcile().catch((error: unknown) => {
      console.error("Background reconciliation failed:", store.safeError(error));
    });
  }, Number(process.env.SUPERSET_ORCHESTRATOR_RECONCILE_MS ?? 30_000));
  reconciliationTimer.unref();

  const providerExecutable = process.env.SUPERSET_ORCHESTRATOR_PROVIDER_EXECUTABLE;
  const provider = providerExecutable === undefined ? undefined : new SupersetProcessAdapter({
    executable: providerExecutable,
    args: JSON.parse(process.env.SUPERSET_ORCHESTRATOR_PROVIDER_ARGS ?? "[]") as string[],
    timeoutMs: Number(process.env.SUPERSET_ORCHESTRATOR_PROVIDER_TIMEOUT_MS ?? 30_000),
  });
  const lifecycle = new LifecycleService(store, provider ?? unsupportedBackend);
  let lifecycleSweep: Promise<void> | undefined;
  const deadlineTimer = setInterval(() => {
    if (lifecycleSweep !== undefined) return;
    lifecycleSweep = lifecycle.enforceDeadlines().then(async (expired) => {
      await lifecycle.reconcileCancellations();
      await lifecycle.reconcileTimedOutResults();
      if (expired.length > 0) console.error(`Deadlines enforced: ${JSON.stringify(store.redactValue(expired))}`);
    }).catch((error: unknown) => {
      console.error("Lifecycle enforcement failed:", store.safeError(error));
    }).finally(() => {
      lifecycleSweep = undefined;
    });
  }, Number(process.env.SUPERSET_ORCHESTRATOR_DEADLINE_MS ?? 5_000));
  deadlineTimer.unref();

  const server = new McpServer({ name: "superset-agent-orchestrator", version: "0.1.0" });
  const integrationToolsEnabled = process.env.SUPERSET_ORCHESTRATOR_ENABLE_PROVIDER_TEST_TOOLS === "1";
  const discovery = providerExecutable === undefined ? undefined : new SupersetDiscoveryAdapter({ executable: providerExecutable });
  const integrationWorkspaceRoot = process.env.SUPERSET_ORCHESTRATOR_PROVIDER_TEST_WORKSPACE_ROOT;
  const workspaceAuthorizer: WorkspaceAuthorizer | undefined = integrationToolsEnabled && integrationWorkspaceRoot !== undefined
    ? {
        authorize: async (workspaceId) => {
          const canonicalPath = assertDataOperand(await realpath(join(integrationWorkspaceRoot, workspaceId)), "workspace path");
          return {
            workspaceId, projectId: "provider-integration", canonicalPath,
            revalidate: async () => {
              if (await realpath(join(integrationWorkspaceRoot, workspaceId)) !== canonicalPath) {
                throw new Error("Integration workspace identity changed before launch");
              }
            },
          };
        },
      }
    : discovery === undefined
    ? undefined
    : new RegisteredWorkspaceAuthorizer(() => discovery.inventory());
  const launches = provider === undefined || workspaceAuthorizer === undefined
    ? undefined
    : new LaunchService(store, provider, workspaceAuthorizer);
  const capture = provider === undefined ? undefined : new ResultCaptureService(store, provider);
  if (launches !== undefined) await launches.dispatchPending();

  const integrationAssignment = z.object({
    label: z.string().min(1), prompt: z.string().min(1), workspace_id: z.string().min(1),
    agent_preset_id: z.string().min(1), idempotency_key: z.string().min(1),
  }).strict();
  server.registerTool(
    tool("provider_batches_launch"),
    {
      description: "Durably launch one real batch through the configured Superset provider",
      inputSchema: {
        request_id: z.string().min(1), client_id: z.string().min(1), name: z.string().min(1),
        idempotency_key: z.string().min(1),
        assignments: z.array(integrationAssignment).min(1).max(100),
      },
    },
    async ({ request_id, client_id, name, idempotency_key, assignments }) => {
      if (!integrationToolsEnabled) return providerError(request_id, "PROVIDER_UNAVAILABLE", "Provider test tools are disabled");
      if (launches === undefined) return providerError(request_id, "PROVIDER_UNAVAILABLE", "No Superset provider is configured");
      try {
        const accepted = await launches.acceptBatch({
          idempotencyKey: idempotency_key, clientId: client_id, batchName: name,
          assignments: assignments.map((assignment) => ({
            idempotencyKey: assignment.idempotency_key,
            attribution: { agent: assignment.agent_preset_id, task: assignment.label },
            prompt: assignment.prompt, workspaceId: assignment.workspace_id,
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
    tool("provider_sessions_results"),
    {
      description: "Refresh and return exact attributed results for up to 100 sessions",
      inputSchema: { request_id: z.string().min(1), session_ids: z.array(z.string().min(1)).min(1).max(100) },
    },
    async ({ request_id, session_ids }) => {
      if (!integrationToolsEnabled) return providerError(request_id, "PROVIDER_UNAVAILABLE", "Provider test tools are disabled");
      if (capture === undefined) return providerError(request_id, "PROVIDER_UNAVAILABLE", "No Superset provider is configured");
      const assignments = await store.assignmentsForSessions(session_ids);
      const items = [];
      for (const [index, assignment] of assignments.entries()) {
        const sessionId = session_ids[index]!;
        if (assignment === undefined) {
          items.push({ session_id: sessionId, error: contractError("SESSION_NOT_FOUND", "Unknown session") });
          continue;
        }
        if (assignment.status === "launched") {
          try {
            await capture.collect(assignment.id, `provider:${assignment.attemptId}`);
          } catch (error) {
            if (error instanceof SupersetProcessError) {
              items.push({ session_id: sessionId, error: contractError(error.code, error.message) });
              continue;
            }
            throw error;
          }
        }
        const captured = (await store.resultsForSessions([sessionId]))[0];
        const worker = await store.worker(sessionId);
        items.push({
          session_id: sessionId, assignment_id: assignment.id, batch_id: assignment.batchId,
          status: worker?.status ?? assignment.status, attribution: assignment.attribution,
          workspace_id: assignment.workspaceId, run_id: assignment.runId,
          ...(captured === undefined ? {} : { result: captured }),
          ...(assignment.error === undefined ? {} : {
            error: contractError(asErrorCode(assignment.errorCode), assignment.error),
          }),
        });
      }
      return result({ request_id, items });
    },
  );
  server.registerTool(
    tool("provider_sessions_cancel"),
    {
      description: "Cancel configured Superset provider sessions without retries",
      inputSchema: {
        request_id: z.string().min(1), session_ids: z.array(z.string().min(1)).min(1).max(100),
        reason: z.string().min(1).optional(),
      },
    },
    async ({ request_id, session_ids, reason }) => {
      if (!integrationToolsEnabled) return providerError(request_id, "PROVIDER_UNAVAILABLE", "Provider test tools are disabled");
      if (provider === undefined) return providerError(request_id, "PROVIDER_UNAVAILABLE", "No Superset provider is configured");
      const assignments = await store.assignmentsForSessions(session_ids);
      const captured = await store.resultsForSessions(session_ids);
      const items = [];
      for (const [index, assignment] of assignments.entries()) {
        const sessionId = session_ids[index]!;
        if (assignment === undefined || assignment.runId === undefined) {
          items.push({
            session_id: sessionId,
            error: contractError("SESSION_NOT_FOUND", "Session has no provider execution"),
          });
          continue;
        }
        if (captured[index] !== undefined) {
          items.push({
            session_id: sessionId,
            error: contractError("INVALID_TRANSITION", "A terminal session cannot be canceled"),
          });
          continue;
        }
        try {
          const state = await provider.status({ runId: assignment.runId });
          if (state.status !== "queued" && state.status !== "running") {
            items.push({
              session_id: sessionId,
              error: contractError("INVALID_TRANSITION", "A terminal session cannot be canceled"),
            });
            continue;
          }
          const cancellation = await provider.cancel({ runId: assignment.runId }, reason);
          if (cancellation?.status === "unsupported") {
            items.push({
              session_id: sessionId,
              error: contractError("CANCEL_UNSUPPORTED", "The backend rejected cancellation as unsupported"),
            });
            continue;
          }
          items.push({ session_id: sessionId, canceled: true });
        } catch (error) {
          const failure = error instanceof SupersetProcessError
            ? contractError(error.code, error.message)
            : contractError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : String(error));
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
    tool("sessions_cancel"),
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
    tool("batches_cancel"),
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
    tool("batches_wait"),
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
    tool("sessions_set_deadline"),
    {
      description: "Set an absolute deadline after which nonterminal sessions are expired as failed/deadline_exceeded",
      inputSchema: setDeadlineRequestSchema.shape,
    },
    async ({ session_ids: sessionIds, deadline_ms: deadlineMs }) => {
      const deadline = new Date(Date.now() + deadlineMs);
      const items = [];
      for (const id of [...new Set(sessionIds)]) {
        try {
          const worker = await store.setWorkerDeadline(id, deadline);
          items.push({ session_id: id, deadline_at: worker.deadlineAt, state: contractState(worker.status) });
        } catch (error) {
          items.push({
            session_id: id,
            error: contractError(
              error instanceof BatchQueryError && error.code === "not_found"
                ? "SESSION_NOT_FOUND"
                : error instanceof BatchQueryError && error.code === "invalid_request"
                  ? "INVALID_TRANSITION"
                  : "STATE_UNAVAILABLE",
              error instanceof BatchQueryError ? error.message : "Unable to persist the session deadline",
            ),
          });
        }
      }
      return result(setDeadlineResultSchema.parse(contractEnvelope({ items })));
    },
  );
  server.registerTool(
    tool("deadlines_enforce"),
    {
      description: "Expire up to 250 overdue nonterminal sessions and report whether another bounded sweep is needed",
      inputSchema: enforceDeadlinesRequestSchema.shape,
    },
    async () => {
      const expired = await lifecycle.enforceDeadlines();
      const hasMore = await lifecycle.hasOverdueDeadlines();
      return result(enforceDeadlinesResultSchema.parse(contractEnvelope({
        expired: expired.map((worker) => ({
        session_id: worker.sessionId,
        deadline_at: worker.deadlineAt,
        state: "failed" as const,
        ...(worker.providerStopError === undefined ? {} : { provider_stop_error: worker.providerStopError }),
      })),
        has_more: hasMore,
      })));
    },
  );
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

function providerError(requestId: string, code: ErrorCode, message: string) {
  return { ...result({ request_id: requestId, error: contractError(code, store.redactText(message)) }), isError: true };
}

function processFailure(requestId: string, error: unknown) {
  return error instanceof SupersetProcessError
    ? providerError(requestId, error.code, error.message)
    : providerError(requestId, "PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : String(error));
}

function asErrorCode(code: string | undefined): ErrorCode {
  return code !== undefined && code in errorDefinitions ? code as ErrorCode : "INTEGRITY_FAILURE";
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
  console.error(store.safeError(error));
  process.exitCode = 1;
});

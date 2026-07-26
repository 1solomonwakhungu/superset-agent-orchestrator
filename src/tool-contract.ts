import { z } from "zod";

export const CONTRACT_VERSION = "1.0" as const;
export const MAX_BATCH_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const MAX_WAIT_MS = 30_000;

const identifier = z.string().min(1).max(200);
const opaqueCursor = z.string().min(1).max(4096);
const timestamp = z.string().datetime({ offset: true });
const uniqueIdentifiers = z.array(identifier).min(1).max(MAX_BATCH_SIZE).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "IDs must be unique" });
  }
});

export const sessionStateSchema = z.enum([
  "requested",
  "launching",
  "running",
  "canceling",
  "lost",
  "completed",
  "failed",
  "canceled",
]);
const stopReasonSchema = z.enum([
  "succeeded",
  "succeeded_before_cancellation",
  "invalid_request",
  "policy_denied",
  "dependency_unavailable",
  "launch_error",
  "launch_timeout",
  "execution_error",
  "worker_crash",
  "resource_exhausted",
  "deadline_exceeded",
  "artifact_error",
  "user_requested",
  "orchestrator_shutdown",
  "superseded",
  "policy_revoked",
]);
const stopReasonsByState = {
  completed: new Set(["succeeded", "succeeded_before_cancellation"]),
  failed: new Set(["invalid_request", "policy_denied", "dependency_unavailable", "launch_error", "launch_timeout", "execution_error", "worker_crash", "resource_exhausted", "deadline_exceeded", "artifact_error"]),
  canceled: new Set(["user_requested", "orchestrator_shutdown", "superseded", "policy_revoked"]),
} as const;

export const errorDefinitions = {
  INVALID_ARGUMENT: { layer: "validation", retryable: false },
  LIMIT_EXCEEDED: { layer: "validation", retryable: false },
  DUPLICATE_ID: { layer: "validation", retryable: false },
  UNSUPPORTED_CONTRACT_VERSION: { layer: "validation", retryable: false },
  CONFIGURATION_INVALID: { layer: "configuration", retryable: false },
  EXECUTABLE_NOT_FOUND: { layer: "discovery", retryable: false },
  EXECUTABLE_CONFLICT: { layer: "discovery", retryable: false },
  HOST_STATE_NOT_FOUND: { layer: "discovery", retryable: true },
  AMBIGUOUS_WORKSPACE: { layer: "routing", retryable: false },
  REMOTE_WORKSPACE: { layer: "routing", retryable: false },
  DUPLICATE_WORKSPACE: { layer: "routing", retryable: false },
  WORKSPACE_UNAVAILABLE: { layer: "routing", retryable: true },
  WORKSPACE_WRITE_CONFLICT: { layer: "policy", retryable: true },
  POLICY_DENIED: { layer: "policy", retryable: false },
  CONCURRENCY_LIMIT: { layer: "policy", retryable: true },
  SESSION_NOT_FOUND: { layer: "orchestration", retryable: false },
  BATCH_NOT_FOUND: { layer: "orchestration", retryable: false },
  PROVIDER_UNAVAILABLE: { layer: "provider", retryable: true },
  PROVIDER_PROTOCOL_ERROR: { layer: "provider", retryable: true },
  LAUNCH_REJECTED: { layer: "provider", retryable: false },
  CANCEL_UNSUPPORTED: { layer: "provider", retryable: false },
  INVALID_TRANSITION: { layer: "orchestration", retryable: false },
  VERSION_CONFLICT: { layer: "orchestration", retryable: true },
  EXECUTION_IDENTITY_CONFLICT: { layer: "integrity", retryable: false },
  SESSION_LOST: { layer: "orchestration", retryable: true },
  STATE_UNAVAILABLE: { layer: "storage", retryable: true },
  STATE_CORRUPT: { layer: "integrity", retryable: false },
  ARTIFACT_MISSING: { layer: "storage", retryable: true },
  INTEGRITY_FAILURE: { layer: "integrity", retryable: false },
} as const;

export type ErrorCode = keyof typeof errorDefinitions;
const errorCodeSchema = z.enum(Object.keys(errorDefinitions) as [ErrorCode, ...ErrorCode[]]);
const errorLayerSchema = z.enum([
  "validation",
  "configuration",
  "discovery",
  "routing",
  "policy",
  "transport",
  "provider",
  "orchestration",
  "storage",
  "integrity",
]);

export const orchestratorErrorSchema = z.object({
  code: errorCodeSchema,
  layer: errorLayerSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
  cause_id: identifier.optional(),
}).strict().superRefine((error, context) => {
  const definition = errorDefinitions[error.code];
  if (error.layer !== definition.layer || error.retryable !== definition.retryable) {
    context.addIssue({
      code: "custom",
      message: `${error.code} must use layer=${definition.layer} and retryable=${definition.retryable}`,
    });
  }
});

const versionedRequest = z.object({ contract_version: z.literal(CONTRACT_VERSION) });
const warningSchema = z.object({ code: identifier, message: z.string().min(1) }).strict();
const envelopeFields = {
  contract_version: z.literal(CONTRACT_VERSION),
  request_id: identifier,
  warnings: z.array(warningSchema),
};

export const sessionSchema = z.object({
  session_id: identifier,
  batch_id: identifier.optional(),
  assignment_id: identifier.optional(),
  workspace_id: identifier,
  agent_preset_id: identifier,
  state: sessionStateSchema,
  version: z.number().int().nonnegative(),
  execution: z.object({
    adapter: identifier,
    execution_id: identifier,
    resume_token: z.string().min(1).optional(),
  }).strict().optional(),
  stop_reason: stopReasonSchema.optional(),
  artifact_manifest_id: identifier.optional(),
  created_at: timestamp,
  updated_at: timestamp,
}).strict().superRefine((session, context) => {
  const allowedReasons = session.state === "completed" || session.state === "failed" || session.state === "canceled"
    ? stopReasonsByState[session.state]
    : undefined;
  if (allowedReasons && (!session.stop_reason || !allowedReasons.has(session.stop_reason))) {
    context.addIssue({ code: "custom", message: `${session.state} requires an allowed stop_reason` });
  }
  if (!allowedReasons && session.stop_reason) {
    context.addIssue({ code: "custom", message: `${session.state} cannot have a stop_reason` });
  }
  if (session.state === "completed" && !session.artifact_manifest_id) {
    context.addIssue({ code: "custom", message: "completed requires artifact_manifest_id" });
  }
});

export const discoveryRequestSchema = versionedRequest.extend({
  include_unavailable: z.boolean().optional().default(false),
}).strict();

export const discoveryResultSchema = z.object({
  ...envelopeFields,
  data: z.object({
    hosts: z.array(z.object({ host_id: identifier, name: identifier, available: z.boolean() }).strict()),
    workspaces: z.array(z.object({
      workspace_id: identifier,
      host_id: identifier,
      name: identifier,
      local: z.literal(true),
      available: z.boolean(),
    }).strict()),
    agent_presets: z.array(z.object({ agent_preset_id: identifier, name: identifier }).strict()),
  }).strict(),
}).strict();

export const assignmentSchema = z.object({
  assignment_id: identifier.optional(),
  label: z.string().min(1).max(200),
  prompt: z.string().min(1).max(200_000),
  workspace_id: identifier,
  agent_preset_id: identifier,
  access_mode: z.enum(["read_only", "writer"]),
  idempotency_key: identifier,
}).strict();

export const launchRequestSchema = versionedRequest.extend({
  assignments: z.array(assignmentSchema).min(1).max(MAX_BATCH_SIZE),
}).strict().superRefine(({ assignments }, context) => {
  const keys = assignments.map(({ idempotency_key }) => idempotency_key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: "idempotency_key values must be unique" });
  }
});

const acceptedSessionSchema = z.object({
  assignment_id: identifier.optional(),
  session_id: identifier,
  state: z.enum(["requested", "launching"]),
}).strict();

export const launchResultSchema = z.object({
  ...envelopeFields,
  data: z.object({ sessions: z.array(acceptedSessionSchema).min(1).max(MAX_BATCH_SIZE) }).strict(),
}).strict();

export const batchLaunchRequestSchema = versionedRequest.extend({
  name: z.string().min(1).max(200),
  idempotency_key: identifier,
  assignments: z.array(assignmentSchema).min(1).max(MAX_BATCH_SIZE),
}).strict().superRefine(({ assignments }, context) => {
  const keys = assignments.map(({ idempotency_key }) => idempotency_key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: "idempotency_key values must be unique" });
  }
});

export const batchLaunchResultSchema = z.object({
  ...envelopeFields,
  data: z.object({
    batch_id: identifier,
    sessions: z.array(acceptedSessionSchema).min(1).max(MAX_BATCH_SIZE),
  }).strict(),
}).strict();

export const idsRequestSchema = versionedRequest.extend({ session_ids: uniqueIdentifiers }).strict();

const itemErrorSchema = z.object({ session_id: identifier, error: orchestratorErrorSchema }).strict();
const statusItemSchema = z.union([
  z.object({ session_id: identifier, session: sessionSchema }).strict(),
  itemErrorSchema,
]);

export const statusResultSchema = z.object({
  ...envelopeFields,
  data: z.object({ items: z.array(statusItemSchema).min(1).max(MAX_BATCH_SIZE) }).strict(),
}).strict().superRefine(({ data }, context) => {
  const ids = data.items.map(({ session_id }) => session_id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "item session_ids must be unique" });
  data.items.forEach((item, index) => {
    if ("session" in item && item.session.session_id !== item.session_id) {
      context.addIssue({ code: "custom", path: ["data", "items", index], message: "item and session IDs must match" });
    }
  });
});

const artifactSchema = z.object({
  artifact_id: identifier,
  media_type: identifier,
  uri: z.string().url(),
  bytes: z.number().int().nonnegative().optional(),
}).strict();
const resultItemSchema = z.union([
  z.object({
    session_id: identifier,
    state: sessionStateSchema,
    complete: z.boolean(),
    artifacts: z.array(artifactSchema),
  }).strict(),
  itemErrorSchema,
]);

export const resultsResultSchema = z.object({
  ...envelopeFields,
  data: z.object({ items: z.array(resultItemSchema).min(1).max(MAX_BATCH_SIZE) }).strict(),
}).strict().superRefine(({ data }, context) => {
  const ids = data.items.map(({ session_id }) => session_id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "item session_ids must be unique" });
  data.items.forEach((item, index) => {
    if ("complete" in item) {
      if (item.state === "completed" && !item.complete) {
        context.addIssue({ code: "custom", path: ["data", "items", index], message: "completed results must be complete" });
      }
      if ((item.state === "failed" || item.state === "canceled") && item.complete) {
        context.addIssue({ code: "custom", path: ["data", "items", index], message: `${item.state} results cannot be complete` });
      }
    }
  });
});

export const cancelRequestSchema = idsRequestSchema.extend({ reason: z.string().min(1).max(1000).optional() }).strict();
const cancellationItemSchema = z.union([
  z.object({
    session_id: identifier,
    state: sessionStateSchema,
    stop_reason: stopReasonSchema.optional(),
    changed: z.boolean(),
  }).strict(),
  itemErrorSchema,
]);
export const cancelResultSchema = z.object({
  ...envelopeFields,
  data: z.object({ items: z.array(cancellationItemSchema).min(1).max(MAX_BATCH_SIZE) }).strict(),
}).strict().superRefine(({ data }, context) => {
  const ids = data.items.map(({ session_id }) => session_id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "item session_ids must be unique" });
});
export const batchCancelRequestSchema = versionedRequest.extend({
  batch_ids: uniqueIdentifiers,
  reason: z.string().min(1).max(1000).optional(),
}).strict();

export const pageRequestSchema = versionedRequest.extend({
  batch_id: identifier,
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
  cursor: opaqueCursor.optional(),
}).strict();

const pageSchema = z.object({
  items: z.array(sessionSchema).max(MAX_PAGE_SIZE),
  has_more: z.boolean(),
  next_cursor: opaqueCursor.optional(),
}).strict().superRefine((page, context) => {
  if (page.has_more !== Boolean(page.next_cursor)) {
    context.addIssue({ code: "custom", message: "next_cursor is required exactly when has_more is true" });
  }
});

export const batchGetResultSchema = z.object({
  ...envelopeFields,
  data: z.object({ batch_id: identifier, name: z.string().min(1), page: pageSchema }).strict(),
}).strict();

export const waitRequestSchema = versionedRequest.extend({
  batch_ids: uniqueIdentifiers,
  timeout_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().default(MAX_WAIT_MS),
  until: z.enum(["any_terminal", "all_terminal"]).optional().default("all_terminal"),
}).strict();

export const waitResultSchema = z.object({
  ...envelopeFields,
  data: z.object({
    items: z.array(z.union([
      z.object({
        batch_id: identifier,
        timed_out: z.boolean(),
        counts: z.record(sessionStateSchema, z.number().int().nonnegative()),
      }).strict(),
      z.object({ batch_id: identifier, error: orchestratorErrorSchema }).strict(),
    ])).min(1).max(MAX_BATCH_SIZE),
  }).strict(),
}).strict().superRefine(({ data }, context) => {
  const ids = data.items.map(({ batch_id }) => batch_id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "item batch_ids must be unique" });
});
export const setDeadlineRequestSchema = versionedRequest.extend({
  session_ids: uniqueIdentifiers,
  deadline_ms: z.number().int().positive().max(2_147_483_647),
}).strict();
export const setDeadlineResultSchema = z.object({
  ...envelopeFields,
  data: z.object({
    items: z.array(z.union([
      z.object({
        session_id: identifier,
        deadline_at: timestamp,
        state: sessionStateSchema,
      }).strict(),
      itemErrorSchema,
    ])).min(1).max(MAX_BATCH_SIZE),
  }).strict(),
}).strict();
export const enforceDeadlinesRequestSchema = versionedRequest.strict();
export const enforceDeadlinesResultSchema = z.object({
  ...envelopeFields,
  data: z.object({
    expired: z.array(z.object({
      session_id: identifier,
      deadline_at: timestamp,
      state: z.literal("failed"),
      provider_stop_error: z.string().min(1).optional(),
    }).strict()).max(250),
    has_more: z.boolean(),
  }).strict(),
}).strict();
export const batchCancelResultSchema = z.object({
  ...envelopeFields,
  data: z.object({
    items: z.array(z.union([
      z.object({
        batch_id: identifier,
        sessions: z.array(cancellationItemSchema).max(250),
      }).strict().superRefine(({ sessions }, context) => {
        const ids = sessions.map(({ session_id }) => session_id);
        if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "session_ids must be unique" });
      }),
      z.object({ batch_id: identifier, error: orchestratorErrorSchema }).strict(),
    ])).min(1).max(MAX_BATCH_SIZE),
  }).strict(),
}).strict().superRefine(({ data }, context) => {
  const ids = data.items.map(({ batch_id }) => batch_id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "item batch_ids must be unique" });
});

export const recoveryRequestSchema = pageRequestSchema;
export const recoveryResultSchema = batchGetResultSchema;

export const failureResultSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION),
  request_id: identifier,
  error: orchestratorErrorSchema,
}).strict();

export const toolContract = {
  orchestrator_discover: { input: discoveryRequestSchema, output: z.union([discoveryResultSchema, failureResultSchema]) },
  sessions_launch: { input: launchRequestSchema, output: z.union([launchResultSchema, failureResultSchema]) },
  batches_launch: { input: batchLaunchRequestSchema, output: z.union([batchLaunchResultSchema, failureResultSchema]) },
  sessions_status: { input: idsRequestSchema, output: z.union([statusResultSchema, failureResultSchema]) },
  sessions_results: { input: idsRequestSchema, output: z.union([resultsResultSchema, failureResultSchema]) },
  sessions_cancel: { input: cancelRequestSchema, output: z.union([cancelResultSchema, failureResultSchema]) },
  batches_cancel: { input: batchCancelRequestSchema, output: z.union([batchCancelResultSchema, failureResultSchema]) },
  batches_get: { input: pageRequestSchema, output: z.union([batchGetResultSchema, failureResultSchema]) },
  batches_wait: { input: waitRequestSchema, output: z.union([waitResultSchema, failureResultSchema]) },
  sessions_set_deadline: { input: setDeadlineRequestSchema, output: z.union([setDeadlineResultSchema, failureResultSchema]) },
  deadlines_enforce: { input: enforceDeadlinesRequestSchema, output: z.union([enforceDeadlinesResultSchema, failureResultSchema]) },
  batches_recover: { input: recoveryRequestSchema, output: z.union([recoveryResultSchema, failureResultSchema]) },
} as const;

const semanticRules = {
  orchestrator_discover: [],
  sessions_launch: ["assignments[].idempotency_key MUST be unique"],
  batches_launch: ["assignments[].idempotency_key MUST be unique"],
  sessions_status: ["session_ids MUST be unique", "data.items[].session_id MUST be unique", "an item's session.session_id MUST equal its session_id"],
  sessions_results: ["session_ids MUST be unique", "data.items[].session_id MUST be unique", "completed results MUST have complete=true", "failed and canceled results MUST have complete=false"],
  sessions_cancel: ["session_ids MUST be unique", "data.items[].session_id MUST be unique", "an item's session.session_id MUST equal its session_id"],
  batches_cancel: ["batch_ids MUST be unique", "data.items[].batch_id MUST be unique"],
  batches_get: ["next_cursor MUST be present exactly when has_more=true", "terminal sessions MUST have a state-appropriate stop_reason", "completed sessions MUST have artifact_manifest_id"],
  batches_wait: ["batch_ids MUST be unique", "data.items[].batch_id MUST be unique"],
  sessions_set_deadline: ["session_ids MUST be unique", "data.items[].session_id MUST be unique"],
  deadlines_enforce: [],
  batches_recover: ["next_cursor MUST be present exactly when has_more=true", "terminal sessions MUST have a state-appropriate stop_reason", "completed sessions MUST have artifact_manifest_id"],
} satisfies Record<ToolName, string[]>;

export function jsonSchemaCatalog(): object {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/1solomonwakhungu/superset-agent-orchestrator/config/mcp-tools.schema.json",
    title: `Superset Agent Orchestrator MCP tool contract ${CONTRACT_VERSION}`,
    "x-error-definitions": errorDefinitions,
    tools: Object.fromEntries(Object.entries(toolContract).map(([name, contract]) => [name, {
      input: z.toJSONSchema(contract.input),
      output: z.toJSONSchema(contract.output),
      "x-semantic-rules": semanticRules[name as ToolName],
    }])),
  };
}

export type ContractSession = z.infer<typeof sessionSchema>;
export type OrchestratorError = z.infer<typeof orchestratorErrorSchema>;
export type ToolName = keyof typeof toolContract;

import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  MAX_PAGE_SIZE,
  batchGetResultSchema,
  batchLaunchRequestSchema,
  cancelRequestSchema,
  discoveryRequestSchema,
  discoveryResultSchema,
  errorDefinitions,
  jsonSchemaCatalog,
  launchRequestSchema,
  orchestratorErrorSchema,
  resultsResultSchema,
  sessionSchema,
  sessionStateSchema,
  statusResultSchema,
  toolContract,
  waitResultSchema,
  type ErrorCode,
  type ToolName,
} from "../src/tool-contract.js";

/**
 * Contract-level checks on the published MCP surface. These complement the
 * behavioural contract tests by asserting the schema itself is closed, total,
 * and self-consistent with the generated JSON Schema catalog.
 */

const TERMINAL_STOP_REASONS = {
  completed: ["succeeded", "succeeded_before_cancellation"],
  failed: [
    "invalid_request", "policy_denied", "dependency_unavailable", "launch_error", "launch_timeout",
    "execution_error", "worker_crash", "resource_exhausted", "deadline_exceeded", "artifact_error",
  ],
  canceled: ["user_requested", "orchestrator_shutdown", "superseded", "policy_revoked"],
} as const;

const ALL_STOP_REASONS = Object.values(TERMINAL_STOP_REASONS).flat();
const NON_TERMINAL_STATES = ["requested", "launching", "running", "canceling", "lost"] as const;

const envelope = (data: unknown) => ({
  contract_version: CONTRACT_VERSION,
  request_id: "request-1",
  data,
  warnings: [],
});

const baseSession = (state: (typeof sessionStateSchema.options)[number]) => ({
  session_id: "session-1",
  workspace_id: "workspace-1",
  agent_preset_id: "codex-default",
  state,
  version: 0,
  created_at: "2026-07-24T18:00:00Z",
  updated_at: "2026-07-24T18:01:00Z",
});

test("every terminal state accepts exactly its own stop reasons", () => {
  for (const [state, allowed] of Object.entries(TERMINAL_STOP_REASONS)) {
    for (const stopReason of ALL_STOP_REASONS) {
      const candidate = {
        ...baseSession(state as keyof typeof TERMINAL_STOP_REASONS),
        stop_reason: stopReason,
        ...(state === "completed" ? { artifact_manifest_id: "manifest-1" } : {}),
      };
      assert.equal(
        sessionSchema.safeParse(candidate).success,
        (allowed as readonly string[]).includes(stopReason),
        `${state} with ${stopReason}`,
      );
    }
    assert.equal(
      sessionSchema.safeParse({ ...baseSession(state as keyof typeof TERMINAL_STOP_REASONS) }).success,
      false,
      `${state} without a stop_reason`,
    );
  }
});

test("non-terminal states never carry a stop reason or manifest requirement", () => {
  for (const state of NON_TERMINAL_STATES) {
    assert.equal(sessionSchema.safeParse(baseSession(state)).success, true, state);
    for (const stopReason of ALL_STOP_REASONS) {
      assert.equal(
        sessionSchema.safeParse({ ...baseSession(state), stop_reason: stopReason }).success,
        false,
        `${state} with ${stopReason}`,
      );
    }
  }
});

test("a completed session without an artifact manifest is not representable", () => {
  assert.equal(sessionSchema.safeParse({
    ...baseSession("completed"), stop_reason: "succeeded",
  }).success, false);
  assert.equal(sessionSchema.safeParse({
    ...baseSession("completed"), stop_reason: "succeeded", artifact_manifest_id: "manifest-1",
  }).success, true);
  assert.equal(sessionSchema.safeParse({
    ...baseSession("running"), unexpected_field: true,
  }).success, false, "session objects are closed");
  assert.equal(sessionSchema.safeParse({ ...baseSession("running"), version: -1 }).success, false);
  assert.equal(sessionSchema.safeParse({ ...baseSession("running"), created_at: "2026-07-24T18:00:00" }).success, false,
    "timestamps require an explicit offset");
});

test("every tool input rejects an unknown field and a foreign contract version", () => {
  const samples: Record<ToolName, Record<string, unknown>> = {
    orchestrator_discover: {},
    sessions_launch: { assignments: [assignment()] },
    batches_launch: { name: "batch", idempotency_key: "key", assignments: [assignment()] },
    sessions_status: { session_ids: ["session-1"] },
    sessions_results: { session_ids: ["session-1"] },
    sessions_cancel: { session_ids: ["session-1"] },
    batches_get: { batch_id: "batch-1" },
    batches_wait: { batch_ids: ["batch-1"] },
    batches_recover: { batch_id: "batch-1" },
  };

  for (const [name, payload] of Object.entries(samples) as Array<[ToolName, Record<string, unknown>]>) {
    const input = toolContract[name].input;
    assert.equal(input.safeParse({ contract_version: CONTRACT_VERSION, ...payload }).success, true, name);
    assert.equal(input.safeParse({ ...payload }).success, false, `${name} without a contract version`);
    assert.equal(input.safeParse({ contract_version: "2.0", ...payload }).success, false, `${name} with a future version`);
    assert.equal(
      input.safeParse({ contract_version: CONTRACT_VERSION, ...payload, undeclared_option: true }).success,
      false,
      `${name} with an undeclared field`,
    );
  }
});

test("assignment payloads are closed and bounded", () => {
  const request = (overrides: Record<string, unknown>) => launchRequestSchema.safeParse({
    contract_version: CONTRACT_VERSION,
    assignments: [{ ...assignment(), ...overrides }],
  }).success;

  assert.equal(request({}), true);
  assert.equal(request({ access_mode: "read_only" }), true);
  assert.equal(request({ access_mode: "read-write" }), false);
  assert.equal(request({ prompt: "" }), false);
  assert.equal(request({ prompt: "x".repeat(200_001) }), false);
  assert.equal(request({ label: "x".repeat(201) }), false);
  assert.equal(request({ workspace_id: "x".repeat(201) }), false);
  assert.equal(request({ env: { TOKEN: "secret" } }), false, "assignments cannot smuggle process environment");
  assert.equal(request({ workspace_path: "/tmp/anywhere" }), false, "callers cannot bypass workspace routing by path");
  assert.equal(batchLaunchRequestSchema.safeParse({
    contract_version: CONTRACT_VERSION, name: "", idempotency_key: "key", assignments: [assignment()],
  }).success, false);
});

test("cancellation reasons are optional, bounded, and closed", () => {
  const parse = (payload: Record<string, unknown>) => cancelRequestSchema.safeParse({
    contract_version: CONTRACT_VERSION, session_ids: ["session-1"], ...payload,
  }).success;
  assert.equal(parse({}), true);
  assert.equal(parse({ reason: "user requested" }), true);
  assert.equal(parse({ reason: "" }), false);
  assert.equal(parse({ reason: "x".repeat(1001) }), false);
  assert.equal(parse({ force: true }), false, "there is no force-cancel escape hatch");
});

test("result items keep completeness consistent with terminal state", () => {
  const item = (overrides: Record<string, unknown>) => resultsResultSchema.safeParse(envelope({
    items: [{ session_id: "session-1", state: "completed", complete: true, artifacts: [], ...overrides }],
  })).success;

  assert.equal(item({}), true);
  assert.equal(item({ complete: false }), false, "completed must be complete");
  assert.equal(item({ state: "failed", complete: true }), false);
  assert.equal(item({ state: "canceled", complete: true }), false);
  assert.equal(item({ state: "failed", complete: false }), true);
  assert.equal(item({ state: "canceled", complete: false }), true);
  assert.equal(item({ state: "running", complete: false }), true);
  assert.equal(item({ artifacts: [{ artifact_id: "a-1", media_type: "text/plain", uri: "file:///tmp/out.txt", bytes: 12 }] }), true);
  assert.equal(item({ artifacts: [{ artifact_id: "a-1", media_type: "text/plain", uri: "not a uri" }] }), false);
  assert.equal(item({ artifacts: [{ artifact_id: "a-1", media_type: "text/plain", uri: "file:///tmp/out.txt", bytes: -1 }] }), false);
  assert.equal(resultsResultSchema.safeParse(envelope({
    items: [
      { session_id: "same", state: "running", complete: false, artifacts: [] },
      { session_id: "same", error: failure("SESSION_NOT_FOUND") },
    ],
  })).success, false, "one session may not appear twice in a response");
});

test("status and wait responses reject duplicate identities and malformed errors", () => {
  assert.equal(statusResultSchema.safeParse(envelope({
    items: [{ session_id: "session-1", error: failure("SESSION_LOST") }],
  })).success, true);
  assert.equal(statusResultSchema.safeParse(envelope({
    items: [{ session_id: "session-1", error: { ...failure("SESSION_LOST"), layer: "provider" } }],
  })).success, false, "an error code cannot be reattributed to another layer");
  assert.equal(statusResultSchema.safeParse(envelope({
    items: [{ session_id: "session-1", error: failure("SESSION_LOST"), session: baseSession("running") }],
  })).success, false, "an item is either a session or an error, never both");

  const counts = Object.fromEntries(sessionStateSchema.options.map((state) => [state, 0]));
  assert.equal(waitResultSchema.safeParse(envelope({
    items: [
      { batch_id: "batch-1", timed_out: false, counts },
      { batch_id: "batch-1", error: failure("BATCH_NOT_FOUND") },
    ],
  })).success, false);
  assert.equal(waitResultSchema.safeParse(envelope({
    items: [{ batch_id: "batch-1", timed_out: false, counts: { ...counts, running: -1 } }],
  })).success, false);
});

test("discovery only admits local workspaces", () => {
  const data = {
    hosts: [{ host_id: "host-1", name: "laptop", available: true }],
    workspaces: [{ workspace_id: "workspace-1", host_id: "host-1", name: "main", local: true, available: true }],
    agent_presets: [{ agent_preset_id: "codex-default", name: "Codex" }],
  };
  assert.equal(discoveryResultSchema.safeParse(envelope(data)).success, true);
  assert.equal(discoveryResultSchema.safeParse(envelope({
    ...data,
    workspaces: [{ ...data.workspaces[0], local: false }],
  })).success, false, "remote workspaces are not representable");
  assert.equal(discoveryResultSchema.safeParse(envelope({
    ...data,
    workspaces: [{ ...data.workspaces[0], endpoint: "https://remote.example" }],
  })).success, false);
  assert.equal(discoveryRequestSchema.parse({ contract_version: CONTRACT_VERSION }).include_unavailable, false);
});

test("pages never exceed the published maximum", () => {
  const page = (count: number, hasMore: boolean, cursor?: string) => batchGetResultSchema.safeParse(envelope({
    batch_id: "batch-1",
    name: "batch",
    page: {
      items: Array.from({ length: count }, (_, index) => ({ ...baseSession("running"), session_id: `session-${index}` })),
      has_more: hasMore,
      ...(cursor === undefined ? {} : { next_cursor: cursor }),
    },
  })).success;

  assert.equal(page(0, false), true, "an empty final page is valid");
  assert.equal(page(MAX_PAGE_SIZE, true, "cursor"), true);
  assert.equal(page(MAX_PAGE_SIZE + 1, false), false);
});

test("the error table is total and mirrored exactly by the JSON Schema catalog", () => {
  const catalog = jsonSchemaCatalog() as {
    "x-error-definitions": Record<string, { layer: string; retryable: boolean }>;
    tools: Record<string, { input: unknown; output: unknown; "x-semantic-rules": string[] }>;
  };

  assert.deepEqual(Object.keys(catalog.tools), Object.keys(toolContract));
  assert.deepEqual(catalog["x-error-definitions"], errorDefinitions);
  for (const [name, entry] of Object.entries(catalog.tools)) {
    assert.ok(entry.input, `${name} publishes an input schema`);
    assert.ok(entry.output, `${name} publishes an output schema`);
    assert.ok(Array.isArray(entry["x-semantic-rules"]), `${name} publishes semantic rules`);
  }

  for (const code of Object.keys(errorDefinitions) as ErrorCode[]) {
    const definition = errorDefinitions[code];
    assert.equal(orchestratorErrorSchema.safeParse({
      code, layer: definition.layer, retryable: definition.retryable, message: "diagnostic",
      details: { workspace_id: "workspace-1" }, cause_id: "cause-1",
    }).success, true, code);
    assert.equal(orchestratorErrorSchema.safeParse({
      code, layer: definition.layer, retryable: definition.retryable, message: "diagnostic", stack: "leak",
    }).success, false, `${code} must not carry undeclared fields`);
    assert.equal(orchestratorErrorSchema.safeParse({
      code, layer: definition.layer, retryable: definition.retryable, message: "",
    }).success, false, `${code} requires a diagnostic message`);
  }
  assert.equal(orchestratorErrorSchema.safeParse({
    code: "NOT_A_DEFINED_CODE", layer: "validation", retryable: false, message: "diagnostic",
  }).success, false);
});

test("catalog generation is deterministic and JSON-serializable", () => {
  const first = JSON.stringify(jsonSchemaCatalog());
  const second = JSON.stringify(jsonSchemaCatalog());
  assert.equal(first, second);
  const parsed: unknown = JSON.parse(first);
  assert.equal(
    (parsed as { $id?: unknown }).$id,
    "https://github.com/1solomonwakhungu/superset-agent-orchestrator/config/mcp-tools.schema.json",
  );
});

function assignment(): Record<string, unknown> {
  return {
    label: "Assignment",
    prompt: "Perform the task",
    workspace_id: "workspace-1",
    agent_preset_id: "codex-default",
    access_mode: "writer",
    idempotency_key: "key-1",
  };
}

function failure(code: ErrorCode): Record<string, unknown> {
  return { code, ...errorDefinitions[code], message: "Safe diagnostic" };
}

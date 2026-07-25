import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONTRACT_VERSION,
  MAX_BATCH_SIZE,
  MAX_WAIT_MS,
  batchGetResultSchema,
  batchLaunchRequestSchema,
  errorDefinitions,
  jsonSchemaCatalog,
  idsRequestSchema,
  launchRequestSchema,
  launchResultSchema,
  orchestratorErrorSchema,
  pageRequestSchema,
  sessionStateSchema,
  statusResultSchema,
  toolContract,
  waitRequestSchema,
  waitResultSchema,
} from "../src/tool-contract.js";

const assignment = (index: number) => ({
  assignment_id: `assignment-${index}`,
  label: `Assignment ${index}`,
  prompt: `Perform task ${index}`,
  workspace_id: `workspace-${index}`,
  agent_preset_id: "codex-default",
  access_mode: "writer" as const,
  idempotency_key: `key-${index}`,
});

const session = (sessionId: string, state: (typeof sessionStateSchema.options)[number] = "running") => ({
  session_id: sessionId,
  workspace_id: "workspace-1",
  agent_preset_id: "codex-default",
  state,
  version: 2,
  created_at: "2026-07-24T18:00:00Z",
  updated_at: "2026-07-24T18:01:00Z",
  ...(state === "completed" ? { stop_reason: "succeeded" as const, artifact_manifest_id: `manifest-${sessionId}` } : {}),
});

const envelope = (data: unknown) => ({
  contract_version: CONTRACT_VERSION,
  request_id: "request-1",
  data,
  warnings: [],
});

test("publishes the complete versioned tool surface", async () => {
  assert.deepEqual(Object.keys(toolContract), [
    "orchestrator_discover",
    "sessions_launch",
    "batches_launch",
    "sessions_status",
    "sessions_results",
    "sessions_cancel",
    "batches_cancel",
    "batches_get",
    "batches_wait",
    "batches_recover",
  ]);

  const catalog = JSON.parse(await readFile(new URL("../config/mcp-tools.schema.json", import.meta.url), "utf8")) as {
    $schema: string;
    "x-error-definitions": Record<string, unknown>;
    tools: Record<string, { "x-semantic-rules": string[] }>;
  };
  assert.equal(catalog.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(Object.keys(catalog.tools), Object.keys(toolContract));
  assert.deepEqual(catalog, jsonSchemaCatalog());
  assert.deepEqual(catalog["x-error-definitions"], errorDefinitions);
  assert.ok(catalog.tools.sessions_launch?.["x-semantic-rules"].some((rule) => rule.includes("idempotency_key")));
  assert.ok(catalog.tools.sessions_status?.["x-semantic-rules"].some((rule) => rule.includes("MUST equal")));
});

test("launch accepts exactly 100 assignments and promises immediate stable IDs", () => {
  const assignments = Array.from({ length: MAX_BATCH_SIZE }, (_, index) => assignment(index));
  assert.equal(launchRequestSchema.parse({ contract_version: CONTRACT_VERSION, assignments }).assignments.length, 100);
  assert.equal(batchLaunchRequestSchema.parse({
    contract_version: CONTRACT_VERSION,
    name: "hundred-session-batch",
    idempotency_key: "batch-key",
    assignments,
  }).assignments.length, 100);

  const accepted = assignments.map(({ assignment_id }, index) => ({
    assignment_id,
    session_id: `session-${index}`,
    state: index % 2 === 0 ? "requested" as const : "launching" as const,
  }));
  assert.equal(launchResultSchema.parse(envelope({ sessions: accepted })).data.sessions.length, 100);
});

test("rejects empty, oversized, duplicate, unversioned, and unknown launch inputs", () => {
  assert.equal(launchRequestSchema.safeParse({ contract_version: CONTRACT_VERSION, assignments: [] }).success, false);
  assert.equal(launchRequestSchema.safeParse({
    contract_version: CONTRACT_VERSION,
    assignments: Array.from({ length: 101 }, (_, index) => assignment(index)),
  }).success, false);
  assert.equal(launchRequestSchema.safeParse({
    contract_version: CONTRACT_VERSION,
    assignments: [assignment(1), { ...assignment(2), idempotency_key: "key-1" }],
  }).success, false);
  assert.equal(launchRequestSchema.safeParse({ assignments: [assignment(1)] }).success, false);
  assert.equal(launchRequestSchema.safeParse({
    contract_version: CONTRACT_VERSION,
    assignments: [assignment(1)],
    hermes_session: "not-client-independent",
  }).success, false);
});

test("ID array tools preserve capacity while rejecting duplicates and overflow", () => {
  const sessionIds = Array.from({ length: MAX_BATCH_SIZE }, (_, index) => `session-${index}`);
  assert.deepEqual(idsRequestSchema.parse({ contract_version: CONTRACT_VERSION, session_ids: sessionIds }).session_ids, sessionIds);
  assert.equal(idsRequestSchema.safeParse({ contract_version: CONTRACT_VERSION, session_ids: [] }).success, false);
  assert.equal(idsRequestSchema.safeParse({ contract_version: CONTRACT_VERSION, session_ids: [...sessionIds, "session-100"] }).success, false);
  assert.equal(idsRequestSchema.safeParse({ contract_version: CONTRACT_VERSION, session_ids: ["same", "same"] }).success, false);
});

test("mixed status outcomes are ordered data, not a whole-call failure", () => {
  const output = statusResultSchema.parse(envelope({ items: [
    { session_id: "completed", session: session("completed", "completed") },
    { session_id: "running", session: session("running") },
    {
      session_id: "missing",
      error: {
        code: "SESSION_NOT_FOUND",
        layer: "orchestration",
        message: "Session was not found",
        retryable: false,
      },
    },
  ] }));
  assert.deepEqual(output.data.items.map(({ session_id }) => session_id), ["completed", "running", "missing"]);
  assert.equal("error" in output, false);
});

test("pagination is bounded and cursor presence exactly matches has_more", () => {
  assert.deepEqual(pageRequestSchema.parse({ contract_version: CONTRACT_VERSION, batch_id: "batch-1" }), {
    contract_version: CONTRACT_VERSION,
    batch_id: "batch-1",
    limit: 50,
  });
  assert.equal(pageRequestSchema.safeParse({ contract_version: CONTRACT_VERSION, batch_id: "batch-1", limit: 101 }).success, false);
  assert.equal(batchGetResultSchema.safeParse(envelope({
    batch_id: "batch-1",
    name: "batch",
    page: { items: [session("session-1")], has_more: true },
  })).success, false);
  assert.equal(batchGetResultSchema.safeParse(envelope({
    batch_id: "batch-1",
    name: "batch",
    page: { items: [session("session-1")], has_more: false, next_cursor: "unexpected" },
  })).success, false);
  assert.equal(batchGetResultSchema.parse(envelope({
    batch_id: "batch-1",
    name: "batch",
    page: { items: [session("session-1")], has_more: true, next_cursor: "opaque-page-2" },
  })).data.page.next_cursor, "opaque-page-2");
});

test("bounded wait accepts zero and 30 seconds and represents timeout as data", () => {
  assert.equal(waitRequestSchema.parse({ contract_version: CONTRACT_VERSION, batch_ids: ["batch-1"], timeout_ms: 0 }).timeout_ms, 0);
  assert.equal(waitRequestSchema.parse({ contract_version: CONTRACT_VERSION, batch_ids: ["batch-1"], timeout_ms: MAX_WAIT_MS }).timeout_ms, 30_000);
  assert.equal(waitRequestSchema.safeParse({ contract_version: CONTRACT_VERSION, batch_ids: ["batch-1"], timeout_ms: MAX_WAIT_MS + 1 }).success, false);

  const counts = Object.fromEntries(sessionStateSchema.options.map((state) => [state, state === "running" ? 1 : 0]));
  const output = waitResultSchema.parse(envelope({ items: [{ batch_id: "batch-1", timed_out: true, counts }] }));
  assert.equal(output.data.items[0] && "timed_out" in output.data.items[0] ? output.data.items[0].timed_out : false, true);
});

test("typed errors have immutable layer and retry policy", () => {
  for (const [code, definition] of Object.entries(errorDefinitions)) {
    assert.equal(orchestratorErrorSchema.safeParse({ code, ...definition, message: "Safe diagnostic" }).success, true, code);
    assert.equal(orchestratorErrorSchema.safeParse({ code, ...definition, retryable: !definition.retryable, message: "Safe diagnostic" }).success, false, code);
  }
});

test("lifecycle vocabulary matches the authoritative state machine", () => {
  assert.deepEqual(sessionStateSchema.options, [
    "requested", "launching", "running", "canceling", "lost", "completed", "failed", "canceled",
  ]);
  for (const providerTerm of ["queued", "succeeded", "cancelled", "unknown_outcome"]) {
    assert.equal(sessionStateSchema.safeParse(providerTerm).success, false);
  }
});

test("enforces terminal stop reasons, complete artifacts, and item identity", () => {
  assert.equal(statusResultSchema.safeParse(envelope({ items: [
    { session_id: "outer", session: session("inner") },
  ] })).success, false);
  assert.equal(statusResultSchema.safeParse(envelope({ items: [
    { session_id: "same", session: session("same") },
    { session_id: "same", session: session("same") },
  ] })).success, false);

  const invalidCompleted = { ...session("completed", "completed"), stop_reason: undefined, artifact_manifest_id: undefined };
  assert.equal(statusResultSchema.safeParse(envelope({ items: [
    { session_id: "completed", session: invalidCompleted },
  ] })).success, false);
  assert.equal(statusResultSchema.safeParse(envelope({ items: [
    { session_id: "running", session: { ...session("running"), stop_reason: "succeeded" } },
  ] })).success, false);
});

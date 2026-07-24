import assert from "node:assert/strict";
import test from "node:test";
import { MalformedCodexResponseError, mapCodexTerminalResponse } from "../src/codex-response-adapter.js";

test("normalizes Codex terminal responses into the core contract", () => {
  assert.deepEqual(
    mapCodexTerminalResponse({ status: "completed", output_text: "answer", thread_id: "thread-1" }),
    { status: "succeeded", output: "answer", resume: { adapter: "codex", token: "thread-1" } },
  );
  assert.deepEqual(
    mapCodexTerminalResponse({ status: "failed", error: { message: "rate limited", retryable: true } }),
    { status: "failed", error: "rate limited", retryable: true },
  );
  assert.deepEqual(
    mapCodexTerminalResponse({ status: "cancelled", cancellation_reason: "requested" }),
    { status: "cancelled", reason: "requested" },
  );
});

test("does not expose known non-terminal Codex states and rejects unknown states", () => {
  assert.equal(mapCodexTerminalResponse({ status: "in_progress" }), undefined);
  assert.equal(mapCodexTerminalResponse({ status: "queued" }), undefined);
  assert.throws(() => mapCodexTerminalResponse({ status: "future_status" }), MalformedCodexResponseError);
  assert.throws(() => mapCodexTerminalResponse({}), MalformedCodexResponseError);
});

test("preserves explicit empty and partial responses", () => {
  assert.deepEqual(mapCodexTerminalResponse({ status: "completed", output_text: "" }), {
    status: "succeeded", output: "",
  });
  assert.deepEqual(mapCodexTerminalResponse({
    status: "failed", output_text: "partial", error: { message: "stopped", retryable: true },
  }), { status: "failed", output: "partial", error: "stopped", retryable: true });
  assert.deepEqual(mapCodexTerminalResponse({
    status: "cancelled", output_text: "partial", cancellation_reason: "operator",
  }), { status: "cancelled", output: "partial", reason: "operator" });
});

test("rejects malformed terminal responses instead of inventing results", () => {
  assert.throws(() => mapCodexTerminalResponse({ status: "completed" }), MalformedCodexResponseError);
  assert.throws(() => mapCodexTerminalResponse({ status: "failed" }), MalformedCodexResponseError);
  assert.throws(
    () => mapCodexTerminalResponse({ status: "completed", output_text: "ok", extra: true }),
    MalformedCodexResponseError,
  );
});

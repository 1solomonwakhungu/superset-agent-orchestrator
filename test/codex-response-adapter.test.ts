import assert from "node:assert/strict";
import test from "node:test";
import { mapCodexTerminalResponse } from "../src/codex-response-adapter.js";

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

test("does not expose non-terminal or unknown Codex states", () => {
  assert.equal(mapCodexTerminalResponse({ status: "in_progress" }), undefined);
  assert.equal(mapCodexTerminalResponse({ status: "future_status" }), undefined);
  assert.equal(mapCodexTerminalResponse({}), undefined);
});

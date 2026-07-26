import assert from "node:assert/strict";
import test from "node:test";
import { MalformedOpenCodeResponseError, mapOpenCodeTerminalResponse } from "../src/opencode-response-adapter.js";

const response = (info: Record<string, unknown>, parts: unknown[] = []) => ({
  info: { id: "msg-1", sessionID: "session-1", role: "assistant", time: { created: 1, completed: 2 }, ...info },
  parts,
});
const text = (value: string, overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), sessionID: "session-1", messageID: "msg-1", type: "text", text: value, ...overrides,
});

test("preserves ordered OpenCode text parts and excludes ignored text", () => {
  assert.deepEqual(mapOpenCodeTerminalResponse(response({}, [text("first"), text(""), text("hidden", { ignored: true }), text(" second")])), {
    status: "succeeded",
    output: "first second",
    resume: { adapter: "opencode", token: "session-1" },
  });
});

test("maps documented OpenCode error variants", () => {
  assert.deepEqual(mapOpenCodeTerminalResponse(response({
    error: { name: "ProviderAuthError", data: { providerID: "example", message: "authentication failed" } },
  }, [text("partial")])), {
    status: "failed", error: "authentication failed", retryable: false, output: "partial",
    resume: { adapter: "opencode", token: "session-1" },
  });
  assert.deepEqual(mapOpenCodeTerminalResponse(response({
    error: { name: "MessageOutputLengthError", data: {} },
  })), {
    status: "failed", error: "OpenCode response exceeded the model output limit", retryable: false,
    resume: { adapter: "opencode", token: "session-1" },
  });
});

test("rejects cross-session and cross-message attribution", () => {
  assert.throws(
    () => mapOpenCodeTerminalResponse(response({}, [text("wrong", { sessionID: "other" })])),
    MalformedOpenCodeResponseError,
  );
  assert.throws(
    () => mapOpenCodeTerminalResponse(response({}, [text("wrong", { messageID: "other" })])),
    MalformedOpenCodeResponseError,
  );
});

test("rejects unknown errors and non-assistant responses", () => {
  assert.throws(
    () => mapOpenCodeTerminalResponse(response({ error: { name: "FutureError", data: {} } })),
    MalformedOpenCodeResponseError,
  );
  assert.throws(
    () => mapOpenCodeTerminalResponse(response({ role: "user" })),
    MalformedOpenCodeResponseError,
  );
});

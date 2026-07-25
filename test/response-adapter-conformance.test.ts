import { mapCodexTerminalResponse } from "../src/codex-response-adapter.js";
import { mapOpenCodeTerminalResponse } from "../src/opencode-response-adapter.js";
import { responseAdapterConformance } from "./response-adapter-conformance.js";

responseAdapterConformance({
  name: "Codex response adapter",
  map: mapCodexTerminalResponse,
  running: { status: "in_progress" },
  succeeded: { status: "completed", output_text: "exact answer", thread_id: "codex-thread" },
  failed: { status: "failed", error: { message: "provider failure", retryable: true } },
  cancelled: { status: "cancelled", cancellation_reason: "operator" },
  malformed: { status: "completed" },
  expectedResume: { adapter: "codex", token: "codex-thread" },
});

const message = (overrides: Record<string, unknown> = {}) => ({
  info: {
    id: "message-1",
    sessionID: "opencode-session",
    role: "assistant",
    time: { created: 1, completed: 2 },
    ...overrides,
  },
  parts: [{
    id: "part-1",
    sessionID: "opencode-session",
    messageID: "message-1",
    type: "text",
    text: "exact answer",
  }],
});

responseAdapterConformance({
  name: "OpenCode response adapter",
  map: mapOpenCodeTerminalResponse,
  running: message({ time: { created: 1 } }),
  succeeded: message(),
  failed: message({ error: { name: "APIError", data: { message: "provider failure", isRetryable: true } } }),
  cancelled: message({ error: { name: "MessageAbortedError", data: { message: "operator" } } }),
  malformed: { info: { id: "message-1" }, parts: [] },
  expectedResume: { adapter: "opencode", token: "opencode-session" },
});

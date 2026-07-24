import type { ResumeMetadata, RunResult, TerminalRunStatus } from "./agent-adapter.js";

export interface CodexResponse {
  thread_id?: string;
  status?: string;
  output_text?: string;
  error?: { message?: string; retryable?: boolean };
  cancellation_reason?: string;
}

const terminalStatuses: Record<string, TerminalRunStatus> = {
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

export function mapCodexTerminalResponse(response: CodexResponse): RunResult | undefined {
  const status = response.status === undefined ? undefined : terminalStatuses[response.status];
  if (status === undefined) return undefined;

  const resume = response.thread_id === undefined
    ? undefined
    : { adapter: "codex", token: response.thread_id } satisfies ResumeMetadata;

  switch (status) {
    case "succeeded":
      return { status, output: response.output_text ?? "", ...(resume && { resume }) };
    case "failed":
      return {
        status,
        error: response.error?.message ?? "Codex run failed",
        retryable: response.error?.retryable ?? false,
        ...(resume && { resume }),
      };
    case "cancelled":
      return {
        status,
        ...(response.cancellation_reason !== undefined && { reason: response.cancellation_reason }),
        ...(resume && { resume }),
      };
  }
}

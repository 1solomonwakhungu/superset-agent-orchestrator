import { z } from "zod";
import type { ResumeMetadata, RunResult, TerminalRunStatus } from "./agent-adapter.js";

export type CodexResponse = unknown;

const terminalStatuses: Record<string, TerminalRunStatus> = {
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};
const nonTerminalStatuses = new Set(["queued", "in_progress"]);

const responseSchema = z.object({
  thread_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  output_text: z.string().optional(),
  error: z.object({ message: z.string().min(1), retryable: z.boolean().optional() }).optional(),
  cancellation_reason: z.string().min(1).optional(),
}).strict();

export class MalformedCodexResponseError extends Error {}

export function mapCodexTerminalResponse(input: CodexResponse): RunResult | undefined {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) throw new MalformedCodexResponseError(`Malformed Codex response: ${parsed.error.message}`);
  const response = parsed.data;
  if (response.status === undefined) {
    throw new MalformedCodexResponseError("Malformed Codex response: status is required");
  }
  const status = response.status === undefined ? undefined : terminalStatuses[response.status];
  if (status === undefined) {
    if (nonTerminalStatuses.has(response.status)) return undefined;
    throw new MalformedCodexResponseError(`Malformed Codex response: unknown status ${JSON.stringify(response.status)}`);
  }

  const resume = response.thread_id === undefined
    ? undefined
    : { adapter: "codex", token: response.thread_id } satisfies ResumeMetadata;

  switch (status) {
    case "succeeded":
      if (response.output_text === undefined) {
        throw new MalformedCodexResponseError("Malformed Codex completed response: output_text is required");
      }
      return { status, output: response.output_text, ...(resume && { resume }) };
    case "failed":
      if (response.error === undefined) {
        throw new MalformedCodexResponseError("Malformed Codex failed response: error is required");
      }
      return {
        status,
        error: response.error.message,
        retryable: response.error.retryable ?? false,
        ...(response.output_text !== undefined && { output: response.output_text }),
        ...(resume && { resume }),
      };
    case "cancelled":
      return {
        status,
        ...(response.cancellation_reason !== undefined && { reason: response.cancellation_reason }),
        ...(response.output_text !== undefined && { output: response.output_text }),
        ...(resume && { resume }),
      };
  }
}

import { z } from "zod";
import type { ResumeMetadata, RunResult } from "./agent-adapter.js";

export type OpenCodeResponse = unknown;

const errorSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("MessageAbortedError"), data: z.object({ message: z.string() }).passthrough() }).passthrough(),
  z.object({
    name: z.literal("APIError"),
    data: z.object({ message: z.string().min(1), isRetryable: z.boolean() }).passthrough(),
  }).passthrough(),
  z.object({ name: z.literal("ProviderAuthError"), data: z.object({ message: z.string().min(1) }).passthrough() }).passthrough(),
  z.object({ name: z.literal("UnknownError"), data: z.object({ message: z.string().min(1) }).passthrough() }).passthrough(),
  z.object({ name: z.literal("MessageOutputLengthError"), data: z.record(z.string(), z.unknown()) }).passthrough(),
]);

const responseSchema = z.object({
  info: z.object({
    id: z.string().min(1),
    sessionID: z.string().min(1),
    role: z.literal("assistant"),
    time: z.object({ created: z.number(), completed: z.number().optional() }).passthrough(),
    error: errorSchema.optional(),
    finish: z.string().optional(),
  }).passthrough(),
  parts: z.array(z.object({
    id: z.string().min(1),
    sessionID: z.string().min(1),
    messageID: z.string().min(1),
    type: z.string().min(1),
    text: z.string().optional(),
    ignored: z.boolean().optional(),
  }).passthrough()),
}).strict();

export class MalformedOpenCodeResponseError extends Error {}

/** Normalizes the documented OpenCode SDK assistant-message response without changing the core adapter contract. */
export function mapOpenCodeTerminalResponse(input: OpenCodeResponse): RunResult | undefined {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) {
    throw new MalformedOpenCodeResponseError(`Malformed OpenCode response: ${parsed.error.message}`);
  }

  const { info, parts } = parsed.data;
  if (parts.some((part) => part.sessionID !== info.sessionID || part.messageID !== info.id)) {
    throw new MalformedOpenCodeResponseError("Malformed OpenCode response: part attribution does not match the assistant message");
  }
  if (info.time.completed === undefined) return undefined;

  const output = parts
    .filter((part) => part.type === "text" && part.ignored !== true)
    .map((part) => part.text ?? "")
    .join("");
  const resume = { adapter: "opencode", token: info.sessionID } satisfies ResumeMetadata;

  if (info.error === undefined) return { status: "succeeded", output, resume };
  if (info.error.name === "MessageAbortedError") {
    return { status: "cancelled", reason: info.error.data.message, ...(output !== "" && { output }), resume };
  }

  const error = info.error.name === "MessageOutputLengthError"
    ? "OpenCode response exceeded the model output limit"
    : info.error.data.message;
  return {
    status: "failed",
    error,
    retryable: info.error.name === "APIError" && info.error.data.isRetryable,
    ...(output !== "" && { output }),
    resume,
  };
}

import { Buffer } from "node:buffer";
import { z } from "zod";
import type { CancellationOutcome, RunResult, RunState } from "./agent-adapter.js";

export const MAX_PROVIDER_STATUS_BYTES = 16 * 1024;
export const MAX_PROVIDER_RESULT_BYTES = 1024 * 1024;
export const MAX_PROVIDER_CANCEL_BYTES = 1024;
export const MAX_PROVIDER_OUTPUT_LENGTH = 1_000_000;
const MAX_PROVIDER_TEXT_LENGTH = 16_384;
const MAX_PROVIDER_ID_LENGTH = 512;

const resumeMetadataSchema = z.strictObject({
  adapter: z.string().min(1).max(MAX_PROVIDER_ID_LENGTH),
  token: z.string().min(1).max(MAX_PROVIDER_TEXT_LENGTH),
});

export const providerStatusSchema = z.strictObject({
  runId: z.string().min(1).max(MAX_PROVIDER_ID_LENGTH),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const providerResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    output: z.string().max(MAX_PROVIDER_OUTPUT_LENGTH),
    resume: resumeMetadataSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: z.string().min(1).max(MAX_PROVIDER_TEXT_LENGTH),
    retryable: z.boolean(),
    output: z.string().max(MAX_PROVIDER_OUTPUT_LENGTH).optional(),
    resume: resumeMetadataSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("cancelled"),
    reason: z.string().max(MAX_PROVIDER_TEXT_LENGTH).optional(),
    output: z.string().max(MAX_PROVIDER_OUTPUT_LENGTH).optional(),
    resume: resumeMetadataSchema.optional(),
  }),
]);

export const providerCancellationSchema = z.union([
  z.strictObject({ status: z.enum(["accepted", "unsupported"]) }),
  z.undefined(),
]);

export class ProviderProtocolError extends Error {
  constructor(operation: "status" | "result" | "cancel", reason: "malformed" | "oversized") {
    super(`Provider ${operation} response was ${reason}`);
    this.name = "ProviderProtocolError";
  }
}

export function parseProviderStatus(value: unknown): RunState {
  return parseProviderResponse("status", value, MAX_PROVIDER_STATUS_BYTES, providerStatusSchema);
}

export function parseProviderResult(value: unknown): RunResult | undefined {
  if (value === undefined) return undefined;
  return parseProviderResponse("result", value, MAX_PROVIDER_RESULT_BYTES, providerResultSchema) as RunResult;
}

export function parseProviderCancellation(value: unknown): CancellationOutcome | undefined {
  return parseProviderResponse("cancel", value, MAX_PROVIDER_CANCEL_BYTES, providerCancellationSchema);
}

function parseProviderResponse<T>(
  operation: "status" | "result" | "cancel",
  value: unknown,
  maxBytes: number,
  schema: z.ZodType<T>,
): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ProviderProtocolError(operation, "malformed");
  }
  if (serialized === undefined && value !== undefined) {
    throw new ProviderProtocolError(operation, "malformed");
  }
  if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new ProviderProtocolError(operation, "oversized");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderProtocolError(operation, "malformed");
  return parsed.data;
}

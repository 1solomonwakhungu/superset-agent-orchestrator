import { execFile } from "node:child_process";
import { z } from "zod";
import { childEnvironment } from "./child-environment.js";
import type {
  AgentAdapter,
  LaunchRequest,
  ResumeMetadata,
  RunHandle,
  RunResult,
  RunState,
} from "./agent-adapter.js";

export type SupersetProcessErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_PROTOCOL_ERROR"
  | "LAUNCH_REJECTED"
  | "CANCEL_UNSUPPORTED";

export class SupersetProcessError extends Error {
  constructor(readonly code: SupersetProcessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const handleSchema = z.object({ runId: z.string().min(1) }).strict();
const optionalHandleSchema = handleSchema.nullable();
const resumeSchema = z.object({ adapter: z.string().min(1), token: z.string().min(1) }).strict();
const stateSchema = handleSchema.extend({
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  updatedAt: z.iso.datetime(),
}).strict();
const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), output: z.string(), resume: resumeSchema.optional() }).strict(),
  z.object({
    status: z.literal("failed"), error: z.string(), retryable: z.boolean(),
    output: z.string().optional(), resume: resumeSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("cancelled"), reason: z.string().optional(),
    output: z.string().optional(), resume: resumeSchema.optional(),
  }).strict(),
]);
const processErrorSchema = z.object({
  code: z.enum(["PROVIDER_UNAVAILABLE", "LAUNCH_REJECTED", "CANCEL_UNSUPPORTED"]),
  message: z.string().min(1),
}).strict();

export interface SupersetProcessAdapterOptions {
  executable: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Agent adapter for Superset-compatible command processes with one JSON response per invocation. */
export class SupersetProcessAdapter implements AgentAdapter {
  constructor(private readonly options: SupersetProcessAdapterOptions) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<RunHandle | undefined> {
    const value = await this.invoke("find", { idempotencyKey }, optionalHandleSchema);
    return value ?? undefined;
  }

  async launch(request: LaunchRequest): Promise<RunHandle> {
    return this.invoke("launch", request, handleSchema);
  }

  async status(handle: RunHandle): Promise<RunState> {
    return this.invoke("status", handle, stateSchema);
  }

  async result(handle: RunHandle): Promise<RunResult | undefined> {
    const value = await this.invoke("result", handle, resultSchema.nullable());
    if (value === null) return undefined;
    if (value.resume !== undefined) return value as RunResult;
    const { resume: _resume, ...withoutUndefinedResume } = value;
    return withoutUndefinedResume as RunResult;
  }

  async cancel(handle: RunHandle, reason?: string): Promise<void> {
    await this.invoke("cancel", { ...handle, ...(reason === undefined ? {} : { reason }) }, z.object({ cancelled: z.literal(true) }).strict());
  }

  async resumeMetadata(handle: RunHandle): Promise<ResumeMetadata | undefined> {
    const value = await this.invoke("resume", handle, resumeSchema.nullable());
    return value ?? undefined;
  }

  private async invoke<T>(command: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const input = JSON.stringify(payload);
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(
        this.options.executable,
        [...(this.options.args ?? []), command],
        {
          env: this.options.env ?? childEnvironment(),
          encoding: "utf8",
          timeout: this.options.timeoutMs ?? 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            const processError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals };
            const declared = parseProcessError(stderr);
            const code: SupersetProcessErrorCode = declared?.code
              ?? (processError.code === "ENOENT" || processError.killed || processError.signal
                ? "PROVIDER_UNAVAILABLE"
                : command === "launch" ? "LAUNCH_REJECTED" : "PROVIDER_UNAVAILABLE");
            reject(new SupersetProcessError(code, `${command} provider command failed`, { cause: error }));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });

    try {
      return schema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new SupersetProcessError(
        "PROVIDER_PROTOCOL_ERROR",
        `Invalid ${command} provider response`,
        { cause: error },
      );
    }
  }
}

function parseProcessError(stderr: string): z.infer<typeof processErrorSchema> | undefined {
  try {
    return processErrorSchema.parse(JSON.parse(stderr));
  } catch {
    return undefined;
  }
}

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type {
  AgentAdapter,
  CancellationOutcome,
  LaunchRequest,
  ResumeMetadata,
  RunHandle,
  RunResult,
  RunState,
} from "./agent-adapter.js";
import { childEnvironment } from "./child-environment.js";
import { SupersetProcessError, type SupersetProcessErrorCode } from "./superset-process-adapter.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;
const CHILD_EXIT_GRACE_MS = 1_000;
const STATE_LOCK_STALE_MS = 10_000;

const boundRecordSchema = z.strictObject({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentPresetId: z.string().min(1),
  createdAt: z.iso.datetime(),
});
/**
 * Write-ahead intent persisted before `agents_create` is sent. If the process dies after Superset accepted
 * the launch but before the session ID was bound, this record is what keeps a retry from starting a
 * second agent.
 */
const pendingRecordSchema = z.strictObject({
  status: z.literal("pending"),
  attemptId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentPresetId: z.string().min(1),
  startedAt: z.iso.datetime(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  runs: z.record(z.string(), boundRecordSchema),
  pending: z.record(z.string(), pendingRecordSchema).optional(),
});
type ProviderState = z.infer<typeof stateSchema>;

const createResultSchema = z.object({
  sessionId: z.string().min(1),
});
const responseSchema = z.object({
  sessionId: z.string().min(1),
  status: z.enum(["starting", "running", "waiting_for_input", "completed", "stopped", "failed"]),
  response: z.string().nullable(),
  pendingQuestion: z.unknown().nullable().optional(),
});
const jsonRpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: z.string(), result: z.unknown() }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: z.string().nullable(),
    error: z.object({ code: z.number(), message: z.string() }),
  }),
]);
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  isError: z.boolean().optional(),
});

/**
 * How far a failed tool call got. Launch idempotency depends on this: only `not_dispatched` and
 * `rejected` prove that Superset did not start a session.
 */
export type SupersetLocalToolOutcome = "not_dispatched" | "rejected" | "unknown";

export class SupersetLocalToolError extends SupersetProcessError {
  constructor(
    code: SupersetProcessErrorCode,
    message: string,
    readonly outcome: SupersetLocalToolOutcome,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "SupersetLocalToolError";
  }
}

export type SupersetLocalToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface SupersetLocalMcpAdapterOptions {
  serverPath: string;
  statePath: string;
  nodeExecutable?: string;
  timeoutMs?: number;
  callTool?: SupersetLocalToolCaller;
  now?: () => Date;
}

/**
 * Live adapter for Superset Desktop's local stdio MCP bridge.
 *
 * Superset terminal session IDs are durably bound to orchestrator idempotency
 * keys, so a server restart rediscovers an already accepted launch instead of
 * starting a duplicate agent. The run-state file is guarded by a cross-process
 * lock and replaced atomically.
 */
export class SupersetLocalMcpAdapter implements AgentAdapter {
  readonly cancellation = "unsupported" as const;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly callTool: SupersetLocalToolCaller;

  constructor(private readonly options: SupersetLocalMcpAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    this.callTool = options.callTool ?? ((name, args) => this.invokeLocalTool(name, args));
  }

  /**
   * Returns the bound session for this key. A pending intent with no bound session is not reported here:
   * `launch` owns reconciling it and refuses to start a second agent.
   */
  async findByIdempotencyKey(idempotencyKey: string): Promise<RunHandle | undefined> {
    const record = (await this.readState()).runs[idempotencyKey];
    return record === undefined ? undefined : { runId: record.runId };
  }

  async launch(request: LaunchRequest): Promise<RunHandle> {
    await request.revalidateWorkspace();
    const workspaceId = request.workspaceId;
    const agentPresetId = request.agentPresetId;
    if (workspaceId === undefined || agentPresetId === undefined) {
      throw new SupersetProcessError(
        "LAUNCH_REJECTED",
        "Live Superset launch requires workspaceId and agentPresetId",
      );
    }

    return this.exclusive(async () => {
      const state = await this.readState();
      const existing = state.runs[request.idempotencyKey];
      if (existing !== undefined) return { runId: existing.runId };
      const pending = state.pending?.[request.idempotencyKey];
      if (pending !== undefined) {
        // The public bridge cannot enumerate sessions, so a previous attempt that may have reached
        // Superset cannot be proven absent. Fail closed instead of risking a duplicate agent.
        throw new SupersetProcessError(
          "LAUNCH_REJECTED",
          `A previous Superset launch attempt for this idempotency key (attempt ${pending.attemptId}, `
            + `started ${pending.startedAt}) has an unknown outcome; verify the workspace in Superset `
            + "before relaunching under a new idempotency key",
        );
      }

      state.pending = {
        ...state.pending,
        [request.idempotencyKey]: {
          status: "pending",
          attemptId: randomUUID(),
          workspaceId,
          agentPresetId,
          startedAt: this.now().toISOString(),
        },
      };
      await this.writeState(state);

      let created: z.infer<typeof createResultSchema>;
      try {
        const response = await this.callTool("agents_create", {
          workspace_id: workspaceId,
          agent: agentPresetId,
          prompt: request.prompt,
        });
        const parsed = createResultSchema.safeParse(response);
        if (!parsed.success) {
          // Superset answered, but without a usable identity: a session may exist, so keep the intent.
          throw new SupersetProcessError("PROVIDER_PROTOCOL_ERROR", "Superset agents_create returned no session ID", {
            cause: parsed.error,
          });
        }
        created = parsed.data;
      } catch (error) {
        if (error instanceof SupersetLocalToolError && error.outcome !== "unknown") {
          await this.clearPending(state, request.idempotencyKey);
          if (error.outcome === "rejected") {
            throw new SupersetProcessError("LAUNCH_REJECTED", error.message, { cause: error });
          }
        }
        throw error;
      }

      delete state.pending?.[request.idempotencyKey];
      if (state.pending !== undefined && Object.keys(state.pending).length === 0) delete state.pending;
      state.runs[request.idempotencyKey] = {
        runId: created.sessionId,
        workspaceId,
        agentPresetId,
        createdAt: this.now().toISOString(),
      };
      await this.writeState(state);
      return { runId: created.sessionId };
    });
  }

  async status(handle: RunHandle): Promise<RunState> {
    const response = await this.response(handle);
    const updatedAt = this.now().toISOString();
    if (response.status === "completed") return { runId: handle.runId, status: "succeeded", updatedAt };
    if (response.status === "failed" || response.status === "stopped") {
      return { runId: handle.runId, status: "failed", updatedAt };
    }
    return {
      runId: handle.runId,
      status: "running",
      updatedAt,
      ...(response.status === "waiting_for_input" ? { attention: "waiting_for_input" as const } : {}),
    };
  }

  async result(handle: RunHandle): Promise<RunResult | undefined> {
    const response = await this.response(handle);
    if (response.status === "starting" || response.status === "running"
      || response.status === "waiting_for_input") {
      return undefined;
    }
    if (response.status === "completed" && response.response !== null) {
      return { status: "succeeded", output: response.response };
    }
    return {
      status: "failed",
      error: response.status === "stopped"
        ? "Superset stopped the agent without a readable final response"
        : "Superset reported that the agent failed",
      retryable: response.status === "stopped",
      ...(response.response === null ? {} : { output: response.response }),
    };
  }

  async cancel(): Promise<CancellationOutcome> {
    return { status: "unsupported" };
  }

  async resumeMetadata(): Promise<ResumeMetadata | undefined> {
    return undefined;
  }

  private async response(handle: RunHandle): Promise<z.infer<typeof responseSchema>> {
    const parsed = z.array(responseSchema).length(1).safeParse(
      await this.callTool("agents_responses", { session_ids: [handle.runId] }),
    );
    if (!parsed.success || parsed.data[0]!.sessionId !== handle.runId) {
      throw new SupersetProcessError("PROVIDER_PROTOCOL_ERROR", "Superset agents_responses returned an unexpected shape", {
        ...(parsed.success ? {} : { cause: parsed.error }),
      });
    }
    return parsed.data[0]!;
  }

  private async clearPending(state: ProviderState, idempotencyKey: string): Promise<void> {
    delete state.pending?.[idempotencyKey];
    if (state.pending !== undefined && Object.keys(state.pending).length === 0) delete state.pending;
    await this.writeState(state);
  }

  private async readState(): Promise<ProviderState> {
    try {
      const contents = await readFile(this.options.statePath, "utf8");
      return stateSchema.parse(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, runs: {} };
      throw new SupersetProcessError("PROVIDER_UNAVAILABLE", "Unable to read live Superset run state", {
        cause: error,
      });
    }
  }

  private async writeState(state: ProviderState): Promise<void> {
    const temporary = `${this.options.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.options.statePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new SupersetProcessError("PROVIDER_UNAVAILABLE", "Unable to persist live Superset run state", {
        cause: error,
      });
    }
  }

  /**
   * Serializes run-state mutations within this process, then across processes with a lock directory
   * next to the state file. A crashed holder's lock goes stale and is reclaimed; its pending intent stays.
   */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let releaseQueue!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      try {
        await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
        // Another process may hold the lock for a whole agents_create round trip.
        const waitMs = (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + STATE_LOCK_STALE_MS;
        releaseLock = await lockfile.lock(this.options.statePath, {
          realpath: false,
          stale: STATE_LOCK_STALE_MS,
          update: STATE_LOCK_STALE_MS / 5,
          retries: { retries: Math.ceil(waitMs / 100), minTimeout: 25, maxTimeout: 100 },
        });
      } catch (error) {
        throw new SupersetProcessError("PROVIDER_UNAVAILABLE", "Unable to lock live Superset run state", {
          cause: error,
        });
      }
      return await operation();
    } finally {
      try {
        if (releaseLock !== undefined) await releaseLock();
      } finally {
        releaseQueue();
      }
    }
  }

  /**
   * Runs one tool call against a fresh bridge process: `initialize`, `notifications/initialized`, then
   * `tools/call`. The process group is killed on timeout, on oversized output, and after the answer.
   */
  private async invokeLocalTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const initializeId = randomUUID();
    const callId = randomUUID();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      let dispatched = false;
      let settled = false;
      let outputBytes = 0;
      let pendingLine = "";
      const stderr: Buffer[] = [];
      const child = spawn(
        this.options.nodeExecutable ?? process.execPath,
        [this.options.serverPath],
        {
          env: childEnvironment(),
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const terminate = () => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
        }
      };
      const fail = (
        code: SupersetProcessErrorCode,
        message: string,
        outcome: SupersetLocalToolOutcome = dispatched ? "unknown" : "not_dispatched",
        cause?: unknown,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminate();
        reject(new SupersetLocalToolError(code, `Superset local MCP ${name}: ${message}`, outcome,
          cause === undefined ? undefined : { cause }));
      };
      const succeed = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        // Give the bridge a moment to exit on EOF, then reap the whole group.
        setTimeout(terminate, CHILD_EXIT_GRACE_MS).unref();
        resolve(value);
      };
      const send = (message: Record<string, unknown>) => {
        if (!child.stdin.writable) return;
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      };
      const countOutput = (chunk: Buffer): boolean => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= MAX_OUTPUT_BYTES) return true;
        fail("PROVIDER_UNAVAILABLE", "output exceeded the supported limit");
        return false;
      };
      const handleMessage = (line: string) => {
        let message: z.infer<typeof jsonRpcResponseSchema>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const record = parsed as Record<string, unknown>;
            if (!("id" in record)) return; // notification
            if ("method" in record) {
              // Server-initiated request; this client offers no capabilities.
              send({ id: record.id, error: { code: -32601, message: "Method not found" } });
              return;
            }
          }
          message = jsonRpcResponseSchema.parse(parsed);
        } catch (error) {
          fail("PROVIDER_PROTOCOL_ERROR", "returned a malformed JSON-RPC message", undefined, error);
          return;
        }
        if (message.id === initializeId) {
          if ("error" in message) {
            fail("PROVIDER_UNAVAILABLE", `initialize failed: ${message.error.message}`);
            return;
          }
          send({ method: "notifications/initialized" });
          dispatched = true;
          send({ id: callId, method: "tools/call", params: { name, arguments: args } });
          return;
        }
        if (message.id === callId) {
          if ("error" in message) {
            fail("PROVIDER_UNAVAILABLE", message.error.message, "rejected");
            return;
          }
          const result = toolResultSchema.safeParse(message.result);
          if (!result.success) {
            fail("PROVIDER_PROTOCOL_ERROR", "returned a malformed tool result", undefined, result.error);
            return;
          }
          const text = result.data.content[0]!.text;
          if (result.data.isError === true) {
            fail("PROVIDER_UNAVAILABLE", text, "rejected");
            return;
          }
          try {
            succeed(JSON.parse(text) as unknown);
          } catch (error) {
            fail("PROVIDER_PROTOCOL_ERROR", "returned non-JSON tool content", undefined, error);
          }
          return;
        }
        if (message.id === null && "error" in message) {
          fail("PROVIDER_PROTOCOL_ERROR", message.error.message);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || !countOutput(chunk)) return;
        pendingLine += chunk.toString("utf8");
        let newline = pendingLine.indexOf("\n");
        while (newline !== -1 && !settled) {
          const line = pendingLine.slice(0, newline).trim();
          pendingLine = pendingLine.slice(newline + 1);
          if (line.length > 0) handleMessage(line);
          newline = pendingLine.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled || !countOutput(chunk)) return;
        stderr.push(chunk);
      });
      child.stdin.on("error", () => undefined); // EPIPE surfaces through "close".
      child.once("error", (error) => fail("PROVIDER_UNAVAILABLE", `could not start: ${error.message}`, undefined, error));
      child.once("close", (code, signal) => {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2_000);
        fail(
          "PROVIDER_UNAVAILABLE",
          `exited ${signal ?? code} before responding${detail.length > 0 ? `: ${detail}` : ""}`,
        );
      });
      const timer = setTimeout(() => fail("PROVIDER_UNAVAILABLE", `timed out after ${timeoutMs}ms`), timeoutMs);
      timer.unref();

      send({
        id: initializeId,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "superset-agent-orchestrator", version: "0.1.0" },
        },
      });
    });
  }
}

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import { SupersetProcessError } from "./superset-process-adapter.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const runRecordSchema = z.strictObject({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentPresetId: z.string().min(1),
  createdAt: z.iso.datetime(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  runs: z.record(z.string(), runRecordSchema),
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
 * starting a duplicate agent.
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

      const created = createResultSchema.parse(await this.callTool("agents_create", {
        workspace_id: workspaceId,
        agent: agentPresetId,
        prompt: request.prompt,
      }));
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
    return {
      runId: handle.runId,
      status: response.status === "completed"
        ? "succeeded"
        : response.status === "failed" || response.status === "stopped"
          ? "failed"
          : "running",
      updatedAt: this.now().toISOString(),
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
    const responses = z.array(responseSchema).length(1).parse(
      await this.callTool("agents_responses", { session_ids: [handle.runId] }),
    );
    return responses[0]!;
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
    const parent = dirname(this.options.statePath);
    const temporary = `${this.options.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.options.statePath);
    } catch (error) {
      throw new SupersetProcessError("PROVIDER_UNAVAILABLE", "Unable to persist live Superset run state", {
        cause: error,
      });
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async invokeLocalTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const requestId = randomUUID();
    const response = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.options.nodeExecutable ?? process.execPath,
        [this.options.serverPath],
        {
          env: childEnvironment(),
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const terminate = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const append = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          terminate();
          finish(() => reject(new Error("Superset local MCP output exceeded the supported limit")));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => finish(() => {
        if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
        else reject(new Error(Buffer.concat(stderr).toString("utf8") || `Superset local MCP exited ${code}`));
      }));
      const timer = setTimeout(() => {
        terminate();
        finish(() => reject(new Error(`Superset local MCP ${name} timed out`)));
      }, this.options.timeoutMs ?? 30_000);
      timer.unref();
      child.stdin.end(`${JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name, arguments: args },
      })}\n`);
    });

    try {
      const messages = response.trim().split("\n").map((line) => JSON.parse(line) as unknown);
      const envelope = z.object({
        id: z.string(),
        result: z.object({
          content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
          isError: z.boolean().optional(),
        }),
      }).parse(messages.find((message) =>
        typeof message === "object" && message !== null && "id" in message
        && (message as { id?: unknown }).id === requestId));
      if (envelope.result.isError === true) throw new Error(envelope.result.content[0]!.text);
      return JSON.parse(envelope.result.content[0]!.text) as unknown;
    } catch (error) {
      throw new SupersetProcessError("PROVIDER_UNAVAILABLE", `Invalid Superset local MCP ${name} response`, {
        cause: error,
      });
    }
  }
}

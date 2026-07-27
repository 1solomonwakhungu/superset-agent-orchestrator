import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  type CallGraph,
  type CallNode,
  type ToolSchema,
  validateCallGraph,
} from "./call-validator.js";

export type ExecutableTool = ToolSchema & {
  capability: string;
  source: string;
  output: NonNullable<ToolSchema["output"]>;
};

export type ExecutionPolicy = {
  allowedCapabilities?: readonly string[];
  timeoutMs: number;
  maxInputBytes?: number;
  maxOutputBytes: number;
  maxMemoryMb?: number;
  maxNodes?: number;
  replayMode?: "disabled" | "record" | "replay";
  replayKey?: string;
  audit?: (entry: AuditEntry) => void | Promise<void>;
};

export type AuditDecision =
  | "validation_denied"
  | "capability_denied"
  | "attempted"
  | "executed"
  | "failed"
  | "replayed";

export type AuditEntry = {
  sequence: number;
  nodeId: string | null;
  tool: string | null;
  capability: string | null;
  decision: AuditDecision;
  input: unknown;
  output: unknown;
  error: string | null;
};

export type ReplayRecord = {
  sequence: number;
  nodeId: string;
  tool: string;
  inputHash: string;
  output: unknown;
  toolHash: string;
  recordHash: string;
};

export type ExecutionResult = {
  outputs: Readonly<Record<string, unknown>>;
  audit: readonly AuditEntry[];
  replay: readonly ReplayRecord[];
};

export class ExecutionRefusedError extends Error {}

export async function executeCallGraph(
  graph: CallGraph,
  tools: Readonly<Record<string, ExecutableTool>>,
  policy: ExecutionPolicy,
  replayRecords: readonly ReplayRecord[] = [],
): Promise<ExecutionResult> {
  assertPolicy(policy);
  const graphSnapshot = cloneJson(graph);
  const toolSnapshot = cloneJson(tools);
  const replaySnapshot = cloneJson(replayRecords);
  const policySnapshot: ExecutionPolicy = {
    allowedCapabilities: [...(policy.allowedCapabilities ?? [])],
    timeoutMs: policy.timeoutMs,
    maxInputBytes: policy.maxInputBytes ?? 1_048_576,
    maxOutputBytes: policy.maxOutputBytes,
    maxMemoryMb: policy.maxMemoryMb ?? 128,
    maxNodes: policy.maxNodes ?? 100,
    replayMode: policy.replayMode ?? "disabled",
    ...(policy.replayKey === undefined ? {} : { replayKey: policy.replayKey }),
  };
  const audit: AuditEntry[] = [];
  const appendAudit = async (entry: Omit<AuditEntry, "sequence">) => {
    const complete = cloneJson({ sequence: audit.length, ...entry });
    audit.push(complete);
    await policy.audit?.(deepFreeze(cloneJson(complete)));
  };
  const schemas: Record<string, ToolSchema> = Object.fromEntries(
    Object.entries(toolSnapshot).map(([name, { input, output }]) => [
      name,
      output ? { input, output } : { input },
    ]),
  );
  const validation = validateCallGraph(graphSnapshot, schemas);
  if (
    !validation.valid ||
    graphSnapshot.nodes.length > policySnapshot.maxNodes!
  ) {
    await appendAudit({
      nodeId: null,
      tool: null,
      capability: null,
      decision: "validation_denied",
      input: graphSnapshot,
      output: null,
      error: validation.valid
        ? "graph exceeds maximum node count"
        : JSON.stringify(validation.diagnostics),
    });
    throw withAudit(
      new ExecutionRefusedError("call graph failed validation"),
      audit,
    );
  }

  const mode = policySnapshot.replayMode!;
  if (mode !== "replay" && replaySnapshot.length > 0)
    throw new ExecutionRefusedError("replay records require replay mode");
  const ordered = topologicalOrder(graphSnapshot.nodes);
  if (mode === "replay" && replaySnapshot.length !== ordered.length)
    throw new ExecutionRefusedError(
      "replay must contain exactly one record per node",
    );

  const allowed = new Set(policySnapshot.allowedCapabilities);
  for (const node of ordered) {
    const tool = toolSnapshot[node.tool]!;
    if (!allowed.has(tool.capability)) {
      await appendAudit({
        nodeId: node.id,
        tool: node.tool,
        capability: tool.capability,
        decision: "capability_denied",
        input: node.arguments,
        output: null,
        error: `capability ${tool.capability} is not allowed`,
      });
      throw withAudit(
        new ExecutionRefusedError(`denied capability ${tool.capability}`),
        audit,
      );
    }
  }
  const outputs = new Map<string, unknown>();
  const generated: ReplayRecord[] = [];
  for (const [sequence, node] of ordered.entries()) {
    const tool = toolSnapshot[node.tool]!;
    const arguments_ = cloneJson(resolveReferences(node.arguments, outputs));
    const base = {
      nodeId: node.id,
      tool: node.tool,
      capability: tool.capability,
      input: arguments_,
    };
    let observedOutput: unknown = null;
    try {
      let output: unknown;
      if (mode === "replay") {
        output = verifyReplay(
          replaySnapshot[sequence]!,
          sequence,
          node,
          arguments_,
          tool,
          policySnapshot.replayKey!,
        );
        observedOutput = output;
        validateOutput(node, tool, output);
        assertOutputSize(output, policySnapshot.maxOutputBytes);
        await appendAudit({
          ...base,
          decision: "replayed",
          output,
          error: null,
        });
      } else {
        await appendAudit({
          ...base,
          decision: "attempted",
          output: null,
          error: null,
        });
        output = await runSandboxed(tool.source, arguments_, policySnapshot);
        observedOutput = output;
        validateOutput(node, tool, output);
        assertOutputSize(output, policySnapshot.maxOutputBytes);
        output = cloneJson(output);
        await appendAudit({
          ...base,
          decision: "executed",
          output,
          error: null,
        });
      }
      const safeOutput = cloneJson(output);
      outputs.set(node.id, safeOutput);
      if (mode === "record")
        generated.push(
          makeReplay(
            sequence,
            node,
            arguments_,
            safeOutput,
            tool,
            policySnapshot.replayKey!,
          ),
        );
    } catch (error) {
      await appendAudit({
        ...base,
        decision: "failed",
        output: boundedAuditValue(
          observedOutput,
          policySnapshot.maxOutputBytes,
        ),
        error: errorMessage(error),
      });
      throw withAudit(
        error instanceof Error ? error : new Error(String(error)),
        audit,
      );
    }
  }
  return { outputs: Object.fromEntries(outputs), audit, replay: generated };
}

async function runSandboxed(
  source: string,
  input: unknown,
  policy: ExecutionPolicy,
): Promise<unknown> {
  const sandboxExec =
    process.platform === "darwin" ? "/usr/bin/sandbox-exec" : null;
  if (!sandboxExec)
    throw new ExecutionRefusedError(
      "live execution requires the supported macOS sandbox; use strict replay elsewhere",
    );
  if (Buffer.byteLength(source) > 64 * 1_024)
    throw new ExecutionRefusedError("tool source exceeds 64 KiB");
  const runner =
    `let data="";for await(const chunk of process.stdin)data+=chunk;` +
    `const execute=(${source});` +
    `process.stdout.write(JSON.stringify(await execute(JSON.parse(data))));`;
  // Node's permission model restricts filesystem/process/native capabilities;
  // Seatbelt supplies the network isolation that Node permissions do not cover.
  const profile =
    `(version 1) (allow default)` +
    ` (deny network*) (deny signal) (deny file-write*)`;
  const serializedInput = canonicalJson(input);
  const maxInputBytes = policy.maxInputBytes ?? 1_048_576;
  if (Buffer.byteLength(serializedInput) > maxInputBytes)
    throw new ExecutionRefusedError(
      `tool input exceeds ${maxInputBytes} bytes`,
    );
  const output = await spawnBounded(
    sandboxExec,
    [
      "-p",
      profile,
      process.execPath,
      "--permission",
      `--max-old-space-size=${policy.maxMemoryMb ?? 128}`,
      "--eval",
      runner,
    ],
    serializedInput,
    policy.timeoutMs,
    policy.maxOutputBytes,
  );
  return JSON.parse(output) as unknown;
}

function spawnBounded(
  command: string,
  arguments_: readonly string[],
  input: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    const errors: Buffer[] = [];
    const output: Buffer[] = [];
    let errorBytes = 0;
    let outputBytes = 0;
    let outputExceeded = false;
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      errors.push(chunk);
      while (errorBytes > maxBytes && errors.length > 0)
        errorBytes -= errors.shift()!.length;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
      } else output.push(chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.kill("SIGKILL"))
        reject(new Error("failed to terminate timed-out sandbox"));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut)
        reject(new Error(`tool execution timed out after ${timeoutMs}ms`));
      else if (outputExceeded)
        reject(new Error(`tool output exceeds ${maxBytes} bytes`));
      else if (code === 0)
        resolvePromise(Buffer.concat(output).toString("utf8"));
      else
        reject(
          new Error(
            `sandbox exited ${code ?? signal}: ${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
    });
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

function validateOutput(
  node: CallNode,
  tool: ToolSchema,
  output: unknown,
): void {
  if (!tool.output) return;
  const result = validateCallGraph(
    { nodes: [{ id: node.id, tool: "output", arguments: { value: output } }] },
    {
      output: {
        input: {
          type: "object",
          properties: { value: tool.output },
          required: ["value"],
          additionalProperties: false,
        },
      },
    },
  );
  if (!result.valid)
    throw new Error(`tool ${node.tool} returned an invalid output`);
}

function makeReplay(
  sequence: number,
  node: CallNode,
  input: unknown,
  output: unknown,
  tool: ExecutableTool,
  replayKey: string,
): ReplayRecord {
  const core = {
    sequence,
    nodeId: node.id,
    tool: node.tool,
    inputHash: hashJson(input),
    output,
    toolHash: hashJson(tool),
  };
  return { ...core, recordHash: authenticate(core, replayKey) };
}

function verifyReplay(
  record: ReplayRecord,
  sequence: number,
  node: CallNode,
  input: unknown,
  tool: ExecutableTool,
  replayKey: string,
): unknown {
  const core = {
    sequence: record.sequence,
    nodeId: record.nodeId,
    tool: record.tool,
    inputHash: record.inputHash,
    output: record.output,
    toolHash: record.toolHash,
  };
  if (
    !authenticated(core, record.recordHash, replayKey) ||
    record.sequence !== sequence ||
    record.nodeId !== node.id ||
    record.tool !== node.tool ||
    record.inputHash !== hashJson(input) ||
    record.toolHash !== hashJson(tool)
  )
    throw new ExecutionRefusedError(
      "replay record does not match the trajectory",
    );
  return cloneJson(record.output);
}

function topologicalOrder(nodes: readonly CallNode[]): readonly CallNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered: CallNode[] = [];
  const visited = new Set<string>();
  const visit = (node: CallNode): void => {
    if (visited.has(node.id)) return;
    const dependencies = new Set(node.dependsOn ?? []);
    collectReferences(node.arguments, dependencies);
    for (const dependency of dependencies) visit(byId.get(dependency)!);
    visited.add(node.id);
    ordered.push(node);
  };
  for (const node of nodes) visit(node);
  return ordered;
}

function collectReferences(value: unknown, references: Set<string>): void {
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.$ref === "string"
  ) {
    references.add(value.$ref);
    return;
  }
  if (Array.isArray(value))
    value.forEach((item) => collectReferences(item, references));
  else if (isRecord(value))
    Object.values(value).forEach((item) => collectReferences(item, references));
}

function resolveReferences(
  value: unknown,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.$ref === "string"
  )
    return cloneJson(outputs.get(value.$ref));
  if (Array.isArray(value))
    return value.map((item) => resolveReferences(item, outputs));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReferences(item, outputs),
      ]),
    );
  return value;
}

function assertPolicy(policy: ExecutionPolicy): void {
  for (const [name, value] of [
    ["timeoutMs", policy.timeoutMs],
    ["maxInputBytes", policy.maxInputBytes ?? 1_048_576],
    ["maxOutputBytes", policy.maxOutputBytes],
    ["maxMemoryMb", policy.maxMemoryMb ?? 128],
    ["maxNodes", policy.maxNodes ?? 100],
  ] as const)
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      (name === "timeoutMs" && value > 300_000) ||
      ((name === "maxInputBytes" || name === "maxOutputBytes") &&
        value > 16 * 1_048_576) ||
      (name === "maxMemoryMb" && (value < 16 || value > 1_024)) ||
      (name === "maxNodes" && value > 10_000)
    )
      throw new TypeError(`${name} must be a bounded positive safe integer`);
  const mode = policy.replayMode ?? "disabled";
  if (
    mode !== "disabled" &&
    (!policy.replayKey || policy.replayKey.length < 32)
  )
    throw new TypeError(
      "record and replay modes require a 32-character replayKey",
    );
}

function boundedAuditValue(value: unknown, maximum: number): unknown {
  try {
    return Buffer.byteLength(canonicalJson(value)) <= maximum
      ? cloneJson(value)
      : { truncated: true, reason: `output exceeds ${maximum} bytes` };
  } catch {
    return { truncated: true, reason: "output is not JSON serializable" };
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function authenticate(value: unknown, key: string): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

function authenticated(
  value: unknown,
  signature: string,
  key: string,
): boolean {
  const expected = Buffer.from(authenticate(value, key), "hex");
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertOutputSize(output: unknown, maximum: number): void {
  if (Buffer.byteLength(canonicalJson(output)) > maximum)
    throw new Error(`tool output exceeds ${maximum} bytes`);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  throw new TypeError("tool values must be JSON serializable");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function withAudit<T extends Error>(error: T, audit: readonly AuditEntry[]): T {
  Object.defineProperty(error, "audit", {
    value: [...audit],
    enumerable: true,
  });
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { LaunchRequest } from "../src/agent-adapter.js";
import {
  SupersetLocalMcpAdapter,
  SupersetLocalToolError,
} from "../src/superset-local-mcp-adapter.js";

type Mode =
  | "ok"
  | "hang"
  | "flood"
  | "tool-error"
  | "rpc-error"
  | "rpc-internal-error"
  | "split-utf8"
  | "malformed"
  | "exit-early"
  | "crash-after-call"
  | "waiting";

/**
 * A minimal line-delimited JSON-RPC MCP stdio server. It enforces the initialize handshake, so a client
 * that skips it gets an error rather than a result, and it logs every method it receives.
 */
function fakeBridge(mode: Mode, logPath: string, childPidPath: string): string {
  return `
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const mode = ${JSON.stringify(mode)};
const log = (entry) => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let initialized = false;

if (mode === "exit-early") {
  process.stderr.write("bridge could not reach Superset Desktop");
  process.exit(3);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ method: message.method, params: message.params });
  if (message.method === "initialize") {
    send({ id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-superset", version: "0.0.0" },
    } });
    send({ method: "notifications/message", params: { level: "info", data: "ready" } });
    return;
  }
  if (message.method === "notifications/initialized") {
    initialized = true;
    return;
  }
  if (message.method !== "tools/call") return;
  if (!initialized) {
    send({ id: message.id, error: { code: -32002, message: "Server not initialized" } });
    return;
  }
  const { name, arguments: args } = message.params;
  if (mode === "hang") {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(childPidPath)}, String(sleeper.pid));
    return;
  }
  if (mode === "flood") {
    const chunk = "x".repeat(64 * 1024);
    for (let index = 0; index < 80; index += 1) process.stdout.write(chunk);
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("this is not json\\n");
    return;
  }
  if (mode === "crash-after-call") process.exit(9);
  if (mode === "rpc-error") {
    send({ id: message.id, error: { code: -32602, message: "Unknown agent preset" } });
    return;
  }
  if (mode === "rpc-internal-error") {
    send({ id: message.id, error: { code: -32603, message: "Host relay failed" } });
    return;
  }
  if (mode === "split-utf8") {
    const text = JSON.stringify(args.session_ids.map((sessionId) => ({
      sessionId, status: "completed", response: "caf\u00e9 \u2713 \u{1F680}", pendingQuestion: null,
    })));
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } }) + "\\n");
    // Split inside the four-byte emoji so the two halves arrive as separate chunks.
    const cut = bytes.indexOf(Buffer.from("\u{1F680}")) + 2;
    process.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 100);
    return;
  }
  if (mode === "tool-error") {
    send({ id: message.id, result: { content: [{ type: "text", text: "Workspace is not registered" }], isError: true } });
    return;
  }
  const payload = name === "agents_create"
    ? { sessionId: "terminal-fake-1" }
    : args.session_ids.map((sessionId) => ({
        sessionId,
        status: mode === "waiting" ? "waiting_for_input" : "completed",
        response: mode === "waiting" ? null : "done",
        pendingQuestion: mode === "waiting" ? { question: "Proceed?" } : null,
      }));
  send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
});
`;
}

interface Fixture {
  directory: string;
  logPath: string;
  childPidPath: string;
  statePath: string;
  adapter(mode: Mode, timeoutMs?: number): Promise<SupersetLocalMcpAdapter>;
  methods(): Promise<string[]>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "superset-local-transport-"));
  const logPath = join(directory, "bridge.log");
  const childPidPath = join(directory, "grandchild.pid");
  const statePath = join(directory, "state", "runs.json");
  try {
    await run({
      directory,
      logPath,
      childPidPath,
      statePath,
      async adapter(mode, timeoutMs = 10_000) {
        const serverPath = join(directory, `bridge-${mode}.mjs`);
        await writeFile(serverPath, fakeBridge(mode, logPath, childPidPath));
        return new SupersetLocalMcpAdapter({ serverPath, statePath, timeoutMs });
      },
      async methods() {
        const contents = await readFile(logPath, "utf8").catch(() => "");
        return contents.trim().split("\n").filter(Boolean)
          .map((line) => (JSON.parse(line) as { method: string }).method);
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    idempotencyKey: "client:transport",
    prompt: "Run the transport test",
    workspacePath: "/workspace/transport",
    workspaceId: "workspace-transport",
    agentPresetId: "opencode-medium",
    environment: {},
    revalidateWorkspace: async () => undefined,
    ...overrides,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("performs the MCP initialize handshake before calling a tool", async () => {
  await withFixture(async (fixture) => {
    const adapter = await fixture.adapter("ok");
    assert.deepEqual(await adapter.launch(request()), { runId: "terminal-fake-1" });
    assert.deepEqual(await fixture.methods(), ["initialize", "notifications/initialized", "tools/call"]);
    const log = (await readFile(fixture.logPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { params?: Record<string, unknown> });
    assert.deepEqual(log[2]!.params, {
      name: "agents_create",
      arguments: { workspace_id: "workspace-transport", agent: "opencode-medium", prompt: "Run the transport test" },
    });
    assert.deepEqual(await adapter.result({ runId: "terminal-fake-1" }), { status: "succeeded", output: "done" });
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as Record<string, unknown>;
    assert.equal(state.pending, undefined);
  });
});

test("reports a session waiting for input distinctly from healthy progress", async () => {
  await withFixture(async (fixture) => {
    const adapter = await fixture.adapter("waiting");
    const state = await adapter.status({ runId: "terminal-wait" });
    assert.equal(state.status, "running");
    assert.equal(state.attention, "waiting_for_input");
    assert.equal(await adapter.result({ runId: "terminal-wait" }), undefined);
  });
});

test("kills the bridge process group on timeout", async () => {
  await withFixture(async (fixture) => {
    const adapter = await fixture.adapter("hang", 1_500);
    const started = Date.now();
    await assert.rejects(adapter.status({ runId: "terminal-hang" }), (error: unknown) => {
      assert.ok(error instanceof SupersetLocalToolError);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.outcome, "unknown");
      assert.match(error.message, /timed out after 1500ms/);
      return true;
    });
    assert.ok(Date.now() - started < 8_000);
    const grandchild = Number(await readFile(fixture.childPidPath, "utf8"));
    for (let attempt = 0; attempt < 50 && isAlive(grandchild); attempt += 1) await delay(50);
    assert.equal(isAlive(grandchild), false, "the bridge's own child must be killed with its group");
  });
});

test("stops reading and kills the bridge when output exceeds the limit", async () => {
  await withFixture(async (fixture) => {
    const adapter = await fixture.adapter("flood");
    await assert.rejects(adapter.status({ runId: "terminal-flood" }), (error: unknown) => {
      assert.ok(error instanceof SupersetLocalToolError);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.match(error.message, /output exceeded the supported limit/);
      return true;
    });
  });
});

test("treats only JSON-RPC request-validation errors as definitive rejections", async () => {
  await withFixture(async (fixture) => {
    const adapter = await fixture.adapter("rpc-error");
    await assert.rejects(adapter.status({ runId: "terminal-error" }), (error: unknown) => {
      assert.ok(error instanceof SupersetLocalToolError);
      assert.equal(error.outcome, "rejected");
      assert.match(error.message, /Unknown agent preset/);
      return true;
    });
    // The server refused the request before any handler ran, so the intent is cleared and a retry may launch.
    await assert.rejects(adapter.launch(request()), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "LAUNCH_REJECTED");
      assert.match(error.message, /Unknown agent preset/);
      return true;
    });
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as Record<string, unknown>;
    assert.equal(state.pending, undefined);
  });
});

test("keeps the pending intent for tool errors and internal JSON-RPC errors", async () => {
  // Superset reports relay and host failures that follow a dispatched mutation as isError results, so
  // neither proves that no agent started.
  for (const [mode, pattern] of [
    ["tool-error", /Workspace is not registered/],
    ["rpc-internal-error", /Host relay failed/],
  ] as const) {
    await withFixture(async (fixture) => {
      const adapter = await fixture.adapter(mode);
      await assert.rejects(adapter.launch(request()), (error: unknown) => {
        assert.ok(error instanceof SupersetLocalToolError);
        assert.equal(error.outcome, "unknown");
        assert.equal(error.code, "PROVIDER_UNAVAILABLE");
        assert.match(error.message, pattern);
        return true;
      });
      const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as { pending?: Record<string, unknown> };
      assert.deepEqual(Object.keys(state.pending ?? {}), ["client:transport"]);
      await assert.rejects(adapter.launch(request()), /has an unknown outcome/);
      const calls = (await fixture.methods()).filter((method) => method === "tools/call");
      assert.equal(calls.length, 1, "the retry must not send a second agents_create");
    });
  }
});

test("decodes a multi-byte character split across stdout chunks", async () => {
  await withFixture(async (fixture) => {
    const adapter = await fixture.adapter("split-utf8");
    assert.deepEqual(await adapter.result({ runId: "terminal-utf8" }), {
      status: "succeeded",
      output: "caf\u00e9 \u2713 \u{1F680}",
    });
  });
});

test("rejects malformed JSON-RPC output as a protocol error", async () => {
  await withFixture(async (fixture) => {
    const adapter = await fixture.adapter("malformed");
    await assert.rejects(adapter.status({ runId: "terminal-malformed" }), (error: unknown) => {
      assert.ok(error instanceof SupersetLocalToolError);
      assert.equal(error.code, "PROVIDER_PROTOCOL_ERROR");
      assert.equal(error.outcome, "unknown");
      return true;
    });
  });
});

test("reports a bridge that exits before the handshake as not dispatched", async () => {
  await withFixture(async (fixture) => {
    const adapter = await fixture.adapter("exit-early");
    await assert.rejects(adapter.launch(request()), (error: unknown) => {
      assert.ok(error instanceof SupersetLocalToolError);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.outcome, "not_dispatched");
      assert.match(error.message, /exited 3 before responding: bridge could not reach Superset Desktop/);
      return true;
    });
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as Record<string, unknown>;
    assert.equal(state.pending, undefined, "an undispatched launch must not block a retry");
  });
});

test("keeps the pending intent when the bridge dies after the call and refuses to relaunch", async () => {
  await withFixture(async (fixture) => {
    const crashing = await fixture.adapter("crash-after-call");
    await assert.rejects(crashing.launch(request()), (error: unknown) => {
      assert.ok(error instanceof SupersetLocalToolError);
      assert.equal(error.outcome, "unknown");
      assert.match(error.message, /exited 9 before responding/);
      return true;
    });

    const healthy = await fixture.adapter("ok");
    assert.equal(await healthy.findByIdempotencyKey("client:transport"), undefined);
    await assert.rejects(healthy.launch(request()), /has an unknown outcome/);
    const creates = (await fixture.methods()).filter((method) => method === "tools/call");
    assert.equal(creates.length, 1, "the retry must not send a second agents_create");
  });
});

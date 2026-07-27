import assert from "node:assert/strict";
import test from "node:test";

import {
  executeCallGraph,
  ExecutionRefusedError,
  type ExecutableTool,
} from "../src/call-executor.js";

const source = `(input) => {
  if (input.action === "read") return import("node:fs/promises").then(({ readFile }) => readFile("/etc/passwd", "utf8"));
  if (input.action === "network") return fetch("https://example.com");
  if (input.action === "hang") return new Promise(() => {});
  if (input.action === "signal") return process.kill(process.ppid, 0);
  if (input.action === "bad-output") return 42;
  return "user-" + input.id;
}`;
const tools: Record<string, ExecutableTool> = {
  lookup: {
    capability: "contacts:read",
    source,
    input: {
      type: "object",
      properties: { id: { type: "integer" }, action: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: { type: "string" },
  },
};
const policy = {
  allowedCapabilities: ["contacts:read"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
  replayMode: "record" as const,
  replayKey: "test-key-that-is-at-least-32-characters",
};

test("executes in a sandbox and records deterministic replay", async (context) => {
  if (process.platform !== "darwin")
    return context.skip("live sandbox is macOS-only");
  const graph = { nodes: [{ id: "a", tool: "lookup", arguments: { id: 7 } }] };
  const first = await executeCallGraph(graph, tools, policy);
  assert.equal(first.outputs.a, "user-7");
  assert.deepEqual(
    first.audit.map(({ decision }) => decision),
    ["attempted", "executed"],
  );
  const replayed = await executeCallGraph(
    graph,
    tools,
    { ...policy, replayMode: "replay" },
    first.replay,
  );
  assert.equal(replayed.outputs.a, "user-7");
  assert.equal(replayed.audit[0]?.decision, "replayed");
});

test("validation and capabilities deny before an attempt", async () => {
  await assert.rejects(
    executeCallGraph(
      { nodes: [{ id: "a", tool: "lookup", arguments: { id: "bad" } }] },
      tools,
      policy,
    ),
    /validation/,
  );
  await assert.rejects(
    executeCallGraph(
      { nodes: [{ id: "a", tool: "lookup", arguments: { id: 1 } }] },
      tools,
      { ...policy, allowedCapabilities: [] },
    ),
    (
      error: ExecutionRefusedError & { audit?: Array<{ decision: string }> },
    ) => {
      assert.equal(error.audit?.[0]?.decision, "capability_denied");
      return true;
    },
  );
  await assert.rejects(
    executeCallGraph(
      { nodes: [{ id: "a", tool: "lookup", arguments: { id: 1 } }] },
      tools,
      {
        timeoutMs: policy.timeoutMs,
        maxOutputBytes: policy.maxOutputBytes,
        replayMode: policy.replayMode,
        replayKey: policy.replayKey,
      },
    ),
    /denied capability/,
  );
});

test("capabilities are preflighted for the entire graph", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    executeCallGraph(
      {
        nodes: [
          { id: "allowed", tool: "lookup", arguments: { id: 1 } },
          { id: "denied", tool: "destroy", arguments: {} },
        ],
      },
      {
        ...tools,
        destroy: {
          capability: "system:destroy",
          source: `() => "destroyed"`,
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          output: { type: "string" },
        },
      },
      {
        ...policy,
        audit: ({ decision, nodeId }) => {
          if (decision === "attempted") attempted.push(nodeId!);
        },
      },
    ),
    /denied capability system:destroy/,
  );
  assert.deepEqual(attempted, []);
});

test("strict replay rejects incomplete, reordered, forged, and invalid outputs", async () => {
  const graph = { nodes: [{ id: "a", tool: "lookup", arguments: { id: 7 } }] };
  await assert.rejects(
    executeCallGraph(graph, tools, { ...policy, replayMode: "replay" }),
    /exactly one/,
  );
  const record = {
    sequence: 0,
    nodeId: "a",
    tool: "lookup",
    inputHash: "wrong",
    output: "user-7",
    toolHash: "wrong",
    recordHash: "forged",
  };
  await assert.rejects(
    executeCallGraph(graph, tools, { ...policy, replayMode: "replay" }, [
      record,
    ]),
    /trajectory/,
  );
});

test("replay reproduces canonical trajectories bit-for-bit", async (context) => {
  if (process.platform !== "darwin")
    return context.skip("recording requires live sandbox");
  const graph = {
    nodes: [
      { id: "a", tool: "lookup", arguments: { id: 7 } },
      { id: "b", tool: "lookup", arguments: { id: 8 } },
    ],
  };
  const recorded = await executeCallGraph(graph, tools, policy);
  const first = await executeCallGraph(
    graph,
    tools,
    { ...policy, replayMode: "replay" },
    recorded.replay,
  );
  const second = await executeCallGraph(
    graph,
    tools,
    { ...policy, replayMode: "replay" },
    recorded.replay,
  );
  assert.equal(JSON.stringify(first.outputs), JSON.stringify(recorded.outputs));
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  await assert.rejects(
    executeCallGraph(
      graph,
      tools,
      { ...policy, replayMode: "replay" },
      [...recorded.replay].reverse(),
    ),
    /trajectory/,
  );
});

test("actual outputs are validated before dependent execution", async (context) => {
  if (process.platform !== "darwin")
    return context.skip("live sandbox is macOS-only");
  await assert.rejects(
    executeCallGraph(
      {
        nodes: [
          {
            id: "a",
            tool: "lookup",
            arguments: { id: 1, action: "bad-output" },
          },
        ],
      },
      tools,
      policy,
    ),
    /invalid output/,
  );
});

test("filesystem, network, and non-cooperative hangs are contained", async (context) => {
  if (process.platform !== "darwin")
    return context.skip("live sandbox is macOS-only");
  for (const action of ["read", "network", "signal"])
    await assert.rejects(
      executeCallGraph(
        { nodes: [{ id: "a", tool: "lookup", arguments: { id: 1, action } }] },
        tools,
        policy,
      ),
      /sandbox exited/,
    );
  await assert.rejects(
    executeCallGraph(
      {
        nodes: [
          { id: "a", tool: "lookup", arguments: { id: 1, action: "hang" } },
        ],
      },
      tools,
      { ...policy, timeoutMs: 25 },
    ),
    /timed out/,
  );
});

test("sandbox blocks write and subprocess escape attempts", async (context) => {
  if (process.platform !== "darwin")
    return context.skip("live sandbox is macOS-only");
  const escapeTools = {
    escape: {
      ...tools.lookup!,
      source: `(input) => {
        if (input.action === "write") return import("node:fs/promises").then(({ writeFile }) => writeFile("/tmp/per394-escape", "escaped"));
        return import("node:child_process").then(({ execFile }) => new Promise((resolve, reject) => execFile("/usr/bin/touch", ["/tmp/per394-child-escape"], (error) => error ? reject(error) : resolve("escaped"))));
      }`,
    },
  };
  for (const action of ["write", "child"])
    await assert.rejects(
      executeCallGraph(
        { nodes: [{ id: "a", tool: "escape", arguments: { id: 1, action } }] },
        escapeTools,
        policy,
      ),
      /sandbox exited/,
    );
});

test("audit callbacks cannot mutate validated inputs", async (context) => {
  if (process.platform !== "darwin")
    return context.skip("live sandbox is macOS-only");
  const result = await executeCallGraph(
    { nodes: [{ id: "a", tool: "lookup", arguments: { id: 7 } }] },
    tools,
    {
      ...policy,
      audit: (entry) => {
        assert.throws(() => {
          (entry.input as { id: number }).id = 999;
        }, TypeError);
      },
    },
  );
  assert.equal(result.outputs.a, "user-7");
});

test("resource policy limits are bounded", async () => {
  const graph = { nodes: [{ id: "a", tool: "lookup", arguments: { id: 7 } }] };
  await assert.rejects(
    executeCallGraph(graph, tools, { ...policy, timeoutMs: 300_001 }),
    /timeoutMs must be a bounded/,
  );
  await assert.rejects(
    executeCallGraph(graph, tools, { ...policy, maxMemoryMb: 1_025 }),
    /maxMemoryMb must be a bounded/,
  );
  await assert.rejects(
    executeCallGraph(graph, tools, { ...policy, maxInputBytes: 16_777_217 }),
    /maxInputBytes must be a bounded/,
  );
});

test("implicit references use the validator's inferred dependency order", async (context) => {
  if (process.platform !== "darwin")
    return context.skip("recording requires live sandbox");
  const graph = {
    nodes: [
      { id: "b", tool: "lookup", arguments: { id: { $ref: "a" } } },
      { id: "a", tool: "lookup", arguments: { id: 7 } },
    ],
  };
  const numericTools = {
    lookup: {
      ...tools.lookup!,
      output: { type: "integer" as const },
      source: `(input) => typeof input.id === "number" ? input.id : 8`,
    },
  };
  const result = await executeCallGraph(graph, numericTools, policy);
  assert.deepEqual(result.outputs, { a: 7, b: 7 });
});

test("prototype-like node ids resolve safely in strict replay", async (context) => {
  if (process.platform !== "darwin")
    return context.skip("recording requires live sandbox");
  const graph = {
    nodes: [{ id: "__proto__", tool: "lookup", arguments: { id: 7 } }],
  };
  const recorded = await executeCallGraph(graph, tools, policy);
  const result = await executeCallGraph(
    graph,
    tools,
    { ...policy, replayMode: "replay" },
    recorded.replay,
  );
  assert.equal(Object.hasOwn(result.outputs, "__proto__"), true);
});

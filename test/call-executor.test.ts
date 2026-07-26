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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  type CallGraph,
  type ToolSchema,
  validateCallGraph,
} from "../src/call-validator.js";

const tools: Record<string, ToolSchema> = {
  lookup: {
    input: {
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
      additionalProperties: false,
    },
    output: { type: "string" },
  },
  notify: {
    input: {
      type: "object",
      properties: {
        user: { type: "string" },
        channel: { type: "string", enum: ["email", "sms"] },
      },
      required: ["user", "channel"],
      additionalProperties: false,
    },
    output: { type: "boolean" },
  },
};

test("labeled corpus has perfect category recall and no valid false positives", async () => {
  const corpus = JSON.parse(
    await readFile(new URL("fixtures/call-validator-corpus.json", import.meta.url), "utf8"),
  ) as Array<{ valid: boolean; expected?: string; graph: CallGraph }>;
  for (const example of corpus) {
    const result = validateCallGraph(example.graph, tools);
    assert.equal(result.valid, example.valid, JSON.stringify(example));
    if (example.expected)
      assert.ok(result.diagnostics.some(({ id }) => id === example.expected));
  }
});

test("diagnostics are deterministic and input remains unchanged", () => {
  const graph = {
    nodes: [
      { id: "b", tool: "notify", arguments: { user: { $ref: "a" }, channel: "push" } },
      { id: "a", tool: "lookup", arguments: { email: "bad" } },
    ],
  } satisfies CallGraph;
  const before = JSON.stringify(graph);
  assert.deepEqual(validateCallGraph(graph, tools), validateCallGraph(graph, tools));
  assert.equal(JSON.stringify(graph), before);
});

test("compatible references create a warning but remain valid", () => {
  const result = validateCallGraph(
    {
      nodes: [
        { id: "a", tool: "lookup", arguments: { email: "a@example.com" } },
        { id: "b", tool: "notify", arguments: { user: { $ref: "a" }, channel: "email" } },
      ],
    },
    tools,
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics.map(({ id }) => id), ["CFV201"]);
});

test("fuzzed unknown JSON values never crash", () => {
  let seed = 0x393;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const value = (depth: number): unknown => {
    if (depth <= 0) return [null, random(), String(random()), random() > 0.5][Math.floor(random() * 4)];
    if (random() < 0.5) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth - 1));
    return Object.fromEntries(
      Array.from({ length: Math.floor(random() * 4) }, (_, index) => [`k${index}`, value(depth - 1)]),
    );
  };
  for (let index = 0; index < 2_000; index += 1)
    assert.doesNotThrow(() => validateCallGraph(value(4), tools));
});

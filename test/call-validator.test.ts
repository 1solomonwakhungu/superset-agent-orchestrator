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
    await readFile(
      new URL("fixtures/call-validator-corpus.json", import.meta.url),
      "utf8",
    ),
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
      {
        id: "b",
        tool: "notify",
        arguments: { user: { $ref: "a" }, channel: "push" },
      },
      { id: "a", tool: "lookup", arguments: { email: "bad" } },
    ],
  } satisfies CallGraph;
  const before = JSON.stringify(graph);
  assert.deepEqual(
    validateCallGraph(graph, tools),
    validateCallGraph(graph, tools),
  );
  assert.equal(JSON.stringify(graph), before);
});

test("compatible references create a warning but remain valid", () => {
  const result = validateCallGraph(
    {
      nodes: [
        { id: "a", tool: "lookup", arguments: { email: "a@example.com" } },
        {
          id: "b",
          tool: "notify",
          arguments: { user: { $ref: "a" }, channel: "email" },
        },
      ],
    },
    tools,
  );
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.diagnostics.map(({ id }) => id),
    ["CFV201"],
  );
});

test("fuzzed unknown JSON values never crash", () => {
  let seed = 0x393;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const value = (depth: number): unknown => {
    if (depth <= 0)
      return [null, random(), String(random()), random() > 0.5][
        Math.floor(random() * 4)
      ];
    if (random() < 0.5)
      return Array.from({ length: Math.floor(random() * 4) }, () =>
        value(depth - 1),
      );
    return Object.fromEntries(
      Array.from({ length: Math.floor(random() * 4) }, (_, index) => [
        `k${index}`,
        value(depth - 1),
      ]),
    );
  };
  for (let index = 0; index < 2_000; index += 1)
    assert.doesNotThrow(() => validateCallGraph(value(4), tools));
});

test("prototype names cannot bypass tool and closed-property checks", () => {
  const unknownTool = validateCallGraph(
    { nodes: [{ id: "a", tool: "constructor", arguments: {} }] },
    tools,
  );
  assert.deepEqual(
    unknownTool.diagnostics.map(({ id }) => id),
    ["CFV003"],
  );
  const unknownField = validateCallGraph(
    {
      nodes: [
        {
          id: "a",
          tool: "lookup",
          arguments: { email: "a@example.com", toString: "not allowed" },
        },
      ],
    },
    tools,
  );
  assert.ok(unknownField.diagnostics.some(({ id }) => id === "CFV105"));
});

test("reference compatibility checks nested object requirements", () => {
  const objectTools: Record<string, ToolSchema> = {
    produce: {
      input: { type: "object" },
      output: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    consume: {
      input: {
        type: "object",
        properties: {
          value: {
            type: "object",
            properties: { email: { type: "string" } },
            required: ["email"],
            additionalProperties: false,
          },
        },
        required: ["value"],
      },
    },
  };
  const result = validateCallGraph(
    {
      nodes: [
        { id: "a", tool: "produce", arguments: {} },
        {
          id: "b",
          tool: "consume",
          dependsOn: ["a"],
          arguments: { value: { $ref: "a" } },
        },
      ],
    },
    objectTools,
  );
  assert.ok(result.diagnostics.some(({ id }) => id === "CFV106"));
});

test("object enums ignore insertion order", () => {
  const result = validateCallGraph(
    {
      nodes: [{ id: "a", tool: "enum", arguments: { value: { b: 2, a: 1 } } }],
    },
    {
      enum: {
        input: {
          type: "object",
          properties: { value: { type: "object", enum: [{ a: 1, b: 2 }] } },
          required: ["value"],
        },
      },
    },
  );
  assert.equal(result.valid, true);
});

test("date-time requires a real RFC 3339 timestamp", () => {
  const dateTools: Record<string, ToolSchema> = {
    date: {
      input: {
        type: "object",
        properties: { value: { type: "string", format: "date-time" } },
        required: ["value"],
      },
    },
  };
  for (const value of ["2026-07-26T11:00:00", "2024-02-30T00:00:00Z"])
    assert.ok(
      validateCallGraph(
        { nodes: [{ id: "a", tool: "date", arguments: { value } }] },
        dateTools,
      ).diagnostics.some(({ id }) => id === "CFV104"),
    );
  assert.equal(
    validateCallGraph(
      {
        nodes: [
          {
            id: "a",
            tool: "date",
            arguments: { value: "2024-02-29T00:00:00Z" },
          },
        ],
      },
      dateTools,
    ).valid,
    true,
  );
});

#!/usr/bin/env node

import process from "node:process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const requestText = process.env.ORCHESTRATOR_TOOL_REQUEST;
if (requestText === undefined) {
  throw new Error("ORCHESTRATOR_TOOL_REQUEST must contain a JSON tool request");
}

const request = JSON.parse(requestText);
if (
  typeof request !== "object"
  || request === null
  || typeof request.name !== "string"
  || typeof request.arguments !== "object"
  || request.arguments === null
) {
  throw new Error("Tool request must contain name and arguments");
}

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
);
delete env.ORCHESTRATOR_TOOL_REQUEST;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(process.env.ORCHESTRATOR_SERVER ?? "dist/src/server.js")],
  env,
  stderr: "inherit",
});
const client = new Client({ name: "superset-orchestrator-operator", version: "1.0.0" });

try {
  await client.connect(transport);
  const response = await client.callTool(
    { name: request.name, arguments: request.arguments },
    undefined,
    { timeout: Number(process.env.ORCHESTRATOR_TOOL_TIMEOUT_MS ?? 120_000) },
  );
  process.stdout.write(`${JSON.stringify(response.structuredContent ?? response.content, null, 2)}\n`);
} finally {
  await transport.close();
}

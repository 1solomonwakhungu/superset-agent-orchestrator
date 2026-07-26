#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";

const [output, runner, requestedNode, conclusion, commit] = process.argv.slice(2);
if (!output || !runner || !requestedNode || !conclusion || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
  throw new Error("usage: write-compatibility-result <output> <runner> <node-major> <conclusion> <commit-sha>");
}
const npm = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
const result = {
  schemaVersion: 1,
  commit,
  runner,
  requestedNode: Number(requestedNode),
  conclusion,
  detected: { platform: platform(), release: release(), architecture: arch(), node: process.version.slice(1), npm },
  command: "npm run verify",
  runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  recordedAt: new Date().toISOString(),
};
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

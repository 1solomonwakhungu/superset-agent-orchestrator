#!/usr/bin/env node
// Records real Superset CLI discovery responses into a redacted fixture so the
// discovery contract keeps schema coverage on machines without the executable.
//
// Usage: node scripts/record-discovery-fixture.mjs [--executable superset]
//
// The recording keeps every field name, type, null/absent distinction, and
// cross-record relationship produced by the real CLI. Only identifying values
// (identities, host and project names, filesystem paths, clone URLs) are
// replaced with stable pseudonyms of the same shape.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../dist/src/superset-discovery.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = join(ROOT, "test", "fixtures", "superset-discovery-recorded.json");
const TIMEOUT_MS = 30_000;
const MAX_WORKSPACES = 8;

const IDENTITY_KEYS = new Set([
  "id", "organizationId", "projectId", "hostId", "createdByUserId", "taskId", "githubRepositoryId",
]);
const LABEL_KEYS = new Set(["hostName", "projectName", "name", "slug", "branch"]);
const PATH_KEYS = new Set(["path", "worktreePath"]);

function parseArgs(argv) {
  const index = argv.indexOf("--executable");
  return { executable: index === -1 ? (process.env.SUPERSET_ORCHESTRATOR_EXECUTABLE ?? "superset") : argv[index + 1] };
}

// Reuses the adapter's spawn path so the recording is exactly the bytes the
// adapter would receive, including its temp-file stdout spooling. The Superset
// CLI truncates large payloads when its stdout is a pipe.
async function run(executable, args) {
  const { stdout, stderr, exitCode } = await runProcess(executable, args, TIMEOUT_MS);
  if (exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} exited with ${exitCode}: ${stderr.trim()}`);
  }
  return stdout;
}

async function runJson(executable, args) {
  const stdout = await run(executable, args);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${executable} ${args.join(" ")} did not return JSON`, { cause: error });
  }
}

function createRedactor() {
  const assigned = new Map();
  const counters = new Map();
  const next = (kind) => {
    const value = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, value);
    return value;
  };
  const pseudonym = (kind, value, build) => {
    const key = `${kind}:${value}`;
    if (!assigned.has(key)) assigned.set(key, build(next(kind)));
    return assigned.get(key);
  };

  const uuid = (value) => pseudonym("uuid", value, (n) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  const hex = (value) => pseudonym("hex", value, (n) =>
    `${String(n).padStart(32, "0")}`);

  return function redact(node, key) {
    if (Array.isArray(node)) return node.map((item) => redact(item, key));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([name, value]) => [name, redact(value, name)]));
    }
    if (typeof node !== "string") return node;
    if (IDENTITY_KEYS.has(key)) return /^[0-9a-f]{32}$/i.test(node) ? hex(node) : uuid(node);
    if (LABEL_KEYS.has(key)) return pseudonym(key, node, (n) => `recorded-${key.toLowerCase()}-${n}`);
    if (PATH_KEYS.has(key)) return pseudonym("path", node, (n) => `/recorded/workspace-${n}`);
    if (key === "repoCloneUrl") return pseudonym("repo", node, (n) => `https://github.com/recorded-org/recorded-repo-${n}`);
    return node;
  };
}

// Keeps the workspaces that exercise the widest set of optional and nullable
// fields so the recorded sample is small without losing schema coverage.
function selectWorkspaces(workspaces) {
  const signature = (workspace) => [
    workspace.type,
    workspace.taskId === null,
    workspace.createdByUserId === null,
    workspace.worktreeExists,
    workspace.projectId,
  ].join("|");
  const selected = new Map();
  for (const workspace of workspaces) {
    const key = signature(workspace);
    if (!selected.has(key)) selected.set(key, workspace);
  }
  return [...selected.values()].slice(0, MAX_WORKSPACES);
}

async function main() {
  const { executable } = parseArgs(process.argv.slice(2));
  const version = (await run(executable, ["--version"])).trim();
  const host = await runJson(executable, ["status", "--json"]);
  const projects = await runJson(executable, ["projects", "list", "--local", "--json"]);
  const workspaces = await runJson(executable, ["workspaces", "list", "--local", "--json"]);
  const presets = await runJson(executable, ["agents", "list", "--local", "--json"]);

  const sampled = selectWorkspaces(workspaces);
  const referenced = new Set(sampled.map((workspace) => workspace.projectId));
  const sampledProjects = projects.filter((project) => referenced.has(project.id));
  if (sampledProjects.length === 0) sampledProjects.push(...projects.slice(0, 1));

  const redact = createRedactor();
  const fixture = {
    recordedAt: new Date().toISOString(),
    recordedFromVersion: version,
    note: "Recorded from a real local Superset CLI by scripts/record-discovery-fixture.mjs. Field names, types, and null/absent distinctions are verbatim; identifying values are pseudonymised.",
    responses: {
      "--version": `${version}\n`,
      "status --json": redact(host),
      "projects list --local --json": redact(sampledProjects),
      "workspaces list --local --json": redact(sampled),
      "agents list --local --json": redact(presets),
    },
  };

  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stdout.write(`recorded ${sampledProjects.length} projects, ${sampled.length} workspaces, ${presets.length} presets from Superset ${version}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

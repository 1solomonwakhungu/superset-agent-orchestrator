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
const LABEL_KEYS = new Set(["hostName", "projectName", "name", "slug", "branch", "label", "presetId", "iconId"]);
const PATH_KEYS = new Set(["path", "worktreePath"]);
const SAFE_STRING_VALUES = {
  setUp: new Set(["yes", "no"]),
  type: new Set(["main", "worktree"]),
  promptTransport: new Set(["argv", "stdin"]),
};
const SAFE_NON_STRING_KEYS = new Set(["running", "healthy", "worktreeExists", "order"]);
const PROCESS_NUMBER_KEYS = new Set(["pid", "port", "uptimeSec"]);
const ARRAY_KEYS = new Set(["$", "args", "promptArgs"]);
const OBJECT_KEYS = new Set(["$", "env"]);
const KNOWN_KEYS = new Set([
  ...IDENTITY_KEYS, ...LABEL_KEYS, ...PATH_KEYS, ...Object.keys(SAFE_STRING_VALUES),
  ...SAFE_NON_STRING_KEYS, ...PROCESS_NUMBER_KEYS, ...ARRAY_KEYS, ...OBJECT_KEYS,
  "repoCloneUrl", "command", "endpoint", "createdAt", "updatedAt",
]);
export const FIXTURE_NOTE = "Recorded from a real local Superset CLI by scripts/record-discovery-fixture.mjs. Field names, types, and null/absent distinctions are verbatim; live values follow the strict privacy classification documented in docs/configuration-and-discovery.md.";
export const FIXTURE_RECORDED_AT = "2000-01-01T00:00:00.000Z";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function sanitizeVersion(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 32) throw new Error("Superset version must be a bounded semantic version");
  const transported = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!VERSION_PATTERN.test(transported)) throw new Error("Superset version must be an exact major.minor.patch semantic version");
  return transported;
}

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

export function createRedactor() {
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
  const timestamp = (value) => pseudonym("timestamp", value, (n) =>
    `2000-01-01T00:00:${String(n).padStart(2, "0")}.000Z`);

  return function redact(node, key = "$", path = "$") {
    if (!KNOWN_KEYS.has(key)) throw new Error(`Unclassified discovery field at ${path}`);
    if (Array.isArray(node)) {
      if (!ARRAY_KEYS.has(key)) throw new Error(`Unclassified array discovery field at ${path}`);
      if (key === "args" || key === "promptArgs") return node.map((item, index) => {
        if (typeof item !== "string") throw new Error(`Unclassified non-string discovery field at ${path}[${index}]`);
        return pseudonym("argument", item, (n) => `recorded-arg-${n}`);
      });
      return node.map((item, index) => redact(item, key, `${path}[${index}]`));
    }
    if (node !== null && typeof node === "object") {
      if (!OBJECT_KEYS.has(key)) throw new Error(`Unclassified object discovery field at ${path}`);
      if (key === "env") {
        return Object.fromEntries(Object.entries(node).map(([name, value]) => {
          if (typeof value !== "string") throw new Error(`Unclassified non-string discovery field at ${path}.${name}`);
          return [pseudonym("env-name", name, (n) => `recorded-env-${n}`), pseudonym("env-value", value, (n) => `recorded-value-${n}`)];
        }));
      }
      return Object.fromEntries(Object.entries(node).map(([name, value]) => [name, redact(value, name, `${path}.${name}`)]));
    }
    if (node === null) return null;
    if (typeof node !== "string") {
      if (PROCESS_NUMBER_KEYS.has(key) && typeof node === "number") return pseudonym(key, String(node), (n) => key === "port" ? 40_000 + n : n);
      if (SAFE_NON_STRING_KEYS.has(key) && (typeof node === "boolean" || typeof node === "number")) return node;
      throw new Error(`Unclassified non-string discovery field at ${path}`);
    }
    if (IDENTITY_KEYS.has(key)) return /^[0-9a-f]{32}$/i.test(node) ? hex(node) : uuid(node);
    if (LABEL_KEYS.has(key)) return pseudonym(key, node, (n) => `recorded-${key.toLowerCase()}-${n}`);
    if (PATH_KEYS.has(key)) return pseudonym("path", node, (n) => `/recorded/workspace-${n}`);
    if (key === "repoCloneUrl") return pseudonym("repo", node, (n) => `https://github.com/recorded-org/recorded-repo-${n}`);
    if (key === "command") return pseudonym("command", node, (n) => `recorded-command-${n}`);
    if (key === "endpoint") return pseudonym("endpoint", node, (n) => `http://127.0.0.1:${40_000 + n}`);
    if (key === "createdAt" || key === "updatedAt") return timestamp(node);
    if (SAFE_STRING_VALUES[key]?.has(node)) return node;
    throw new Error(`Unclassified string discovery field at ${path}`);
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
  const version = sanitizeVersion(await run(executable, ["--version"]));
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
    recordedAt: FIXTURE_RECORDED_AT,
    recordedFromVersion: version,
    note: FIXTURE_NOTE,
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

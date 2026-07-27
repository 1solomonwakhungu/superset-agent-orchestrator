import assert from "node:assert/strict";
import { test } from "node:test";
import { type ProcessRunner, SupersetDiscoveryAdapter, SupersetDiscoveryError } from "../src/superset-discovery.js";

const host = { running: true, healthy: true, pid: 10, port: 48_707, endpoint: "http://127.0.0.1:48707", organizationId: "org-local", hostId: "host-local", hostName: "local-host", uptimeSec: 30 };
const projects = [{ id: "project-1", name: "orchestrator", slug: "orchestrator", repoCloneUrl: null, githubRepositoryId: null, setUp: "yes", path: "/tmp/orchestrator" }];
const workspaces = [{ id: "workspace-1", organizationId: "org-local", projectId: "project-1", hostId: "host-local", name: "main", branch: "main", type: "main", createdByUserId: null, taskId: null, createdAt: "2026-07-24T12:00:00.000Z", updatedAt: "2026-07-24T12:00:00.000Z", worktreePath: "/tmp/orchestrator", worktreeExists: true, projectName: "orchestrator", hostName: "local-host" }];
const presets = [{ id: "preset-config-1", presetId: "codex", iconId: null, label: "Codex", command: "codex", args: [], promptTransport: "argv", promptArgs: ["--"], env: {}, order: 0 }];

function fakeRunner(overrides: Record<string, unknown> = {}): { calls: string[][]; runner: ProcessRunner } {
  const calls: string[][] = [];
  const responses: Record<string, unknown> = {
    "--version": "1.16.1\n",
    "status --json": host,
    "projects list --local --json": projects,
    "workspaces list --local --json": workspaces,
    "agents list --local --json": presets,
    ...overrides,
  };
  return { calls, runner: async (_executable, args) => {
    calls.push([...args]);
    const response = responses[args.join(" ")];
    if (response instanceof Error) throw response;
    return { stdout: typeof response === "string" ? response : JSON.stringify(response), stderr: "", exitCode: 0 };
  } };
}

async function expectCode(adapter: SupersetDiscoveryAdapter, code: string): Promise<void> {
  await assert.rejects(adapter.discover(), (error: unknown) => error instanceof SupersetDiscoveryError && error.code === code);
}

test("discovers valid local projects, workspaces, host, and presets", async () => {
  const fake = fakeRunner();
  const result = await new SupersetDiscoveryAdapter({ executable: process.execPath, runner: fake.runner }).discover();
  assert.equal(result.version, "1.16.1");
  assert.equal(result.host.hostId, "host-local");
  assert.equal(result.projects[0]?.id, "project-1");
  assert.equal(result.workspaces[0]?.id, "workspace-1");
  assert.equal(result.presets[0]?.presetId, "codex");
  assert.deepEqual(fake.calls, [["--version"], ["status", "--json"], ["projects", "list", "--local", "--json"], ["workspaces", "list", "--local", "--json"], ["agents", "list", "--local", "--json"]]);
});

test("normalizes the current local CLI project and workspace shapes", async () => {
  const fake = fakeRunner({
    "projects list --local --json": [{
      id: "project-1",
      name: "orchestrator",
      repo: "https://github.com/example/orchestrator.git",
      path: "/tmp/orchestrator",
    }],
    "workspaces list --local --json": [{
      ...workspaces[0],
      hostName: undefined,
    }],
  });
  const result = await new SupersetDiscoveryAdapter({
    executable: process.execPath,
    runner: fake.runner,
  }).discover();

  assert.deepEqual(result.projects[0], {
    id: "project-1",
    name: "orchestrator",
    slug: "orchestrator",
    repoCloneUrl: "https://github.com/example/orchestrator.git",
    githubRepositoryId: null,
    setUp: "yes",
    path: "/tmp/orchestrator",
  });
  assert.equal(result.workspaces[0]?.hostName, "local");
});

test("normalizes malformed JSON and schema mismatches", async () => {
  await expectCode(new SupersetDiscoveryAdapter({ executable: process.execPath, runner: fakeRunner({ "projects list --local --json": "not-json" }).runner }), "MALFORMED_RESPONSE");
  await expectCode(new SupersetDiscoveryAdapter({ executable: process.execPath, runner: fakeRunner({ "status --json": { ...host, hostId: null } }).runner }), "MALFORMED_RESPONSE");
});

test("normalizes unavailable and timed-out commands", async () => {
  await expectCode(new SupersetDiscoveryAdapter({ executable: process.execPath, runner: fakeRunner({ "status --json": new SupersetDiscoveryError("UNAVAILABLE", "offline") }).runner }), "UNAVAILABLE");
  await expectCode(new SupersetDiscoveryAdapter({ executable: process.execPath, runner: fakeRunner({ "--version": new SupersetDiscoveryError("TIMED_OUT", "late") }).runner }), "TIMED_OUT");
});

test("rejects ambiguous duplicate identities", async () => {
  const fake = fakeRunner({ "agents list --local --json": [presets[0], { ...presets[0], label: "Duplicate" }] });
  await expectCode(new SupersetDiscoveryAdapter({ executable: process.execPath, runner: fake.runner }), "AMBIGUOUS");
});

test("rejects remote-only workspaces returned by local routing", async () => {
  const fake = fakeRunner({ "workspaces list --local --json": [{ ...workspaces[0], hostId: "host-remote" }] });
  await expectCode(new SupersetDiscoveryAdapter({ executable: process.execPath, runner: fake.runner }), "REMOTE_ONLY");
});

test("rejects unsupported CLI versions before discovery", async () => {
  const fake = fakeRunner({ "--version": "superset 0.9.0\n" });
  await expectCode(new SupersetDiscoveryAdapter({ executable: process.execPath, runner: fake.runner }), "UNSUPPORTED_VERSION");
  assert.deepEqual(fake.calls, [["--version"]]);
});

test("passes a pinned executable and fixed argument vectors to the runner", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const fake = fakeRunner();
  const runner: ProcessRunner = async (executable, args, timeoutMs) => {
    calls.push({ executable, args });
    return fake.runner(executable, args.slice(2), timeoutMs);
  };
  await new SupersetDiscoveryAdapter({ executable: process.execPath, args: ["wrapper.mjs", "config.json"], runner }).discover();
  assert.equal(calls[0]?.executable, process.execPath);
  assert.deepEqual(calls[0]?.args, ["wrapper.mjs", "config.json", "--version"]);
});

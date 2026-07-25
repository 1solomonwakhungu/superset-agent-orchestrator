import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ProcessRunner,
  SupersetDiscoveryAdapter,
  type SupersetDiscoveryResult,
} from "../src/superset-discovery.js";

const FIXTURE_URL = new URL("./fixtures/superset-discovery-1.16.1.json", import.meta.url);

// Key sets pinned from real `superset v1.16.1` local discovery responses. They exist so a
// silently reshaped CLI contract fails here instead of being masked by the sanitized fixture.
const RECORDED_KEYS = {
  host: ["running", "healthy", "pid", "port", "endpoint", "organizationId", "hostId", "hostName", "uptimeSec"],
  project: ["id", "name", "slug", "repoCloneUrl", "githubRepositoryId", "setUp", "path"],
  workspace: ["id", "organizationId", "projectId", "hostId", "name", "branch", "type", "createdByUserId", "taskId", "createdAt", "updatedAt", "worktreePath", "worktreeExists", "projectName", "hostName"],
  preset: ["id", "presetId", "iconId", "label", "command", "args", "promptTransport", "promptArgs", "env", "order"],
} as const;

/**
 * The discovery contract asserted against both recorded and live CLI responses, so the
 * offline run exercises exactly the guarantees the live smoke test exists to prove.
 */
function assertDiscoveryContract(result: SupersetDiscoveryResult): void {
  assert.match(result.version, /^\d+\.\d+\.\d+/);
  assert.ok(result.host.running && result.host.healthy);
  assert.ok(result.projects.length > 0);
  assert.ok(result.workspaces.every(({ hostId }) => hostId === result.host.hostId));
  assert.ok(result.presets.length > 0);
}

async function readRecordedResponses(): Promise<Record<string, unknown>> {
  const fixture = JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), "utf8")) as {
    responses: Record<string, unknown>;
  };
  return fixture.responses;
}

function recordedRunner(responses: Record<string, unknown>): ProcessRunner {
  return async (_executable, args) => {
    const key = args.join(" ");
    const response = responses[key];
    assert.ok(response !== undefined, `no recorded Superset response for "${key}"`);
    return {
      stdout: typeof response === "string" ? response : JSON.stringify(response),
      stderr: "",
      exitCode: 0,
    };
  };
}

/**
 * Resolves true only when the executable cannot be found at all (ENOENT). Every other
 * outcome, including a present-but-broken or unhealthy CLI, is reported as available so
 * that a genuine discovery failure surfaces as a test failure rather than a skip.
 */
async function executableIsMissing(executable: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (missing: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(missing);
    };
    const child = spawn(executable, ["--version"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT"));
    child.once("close", () => finish(false));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 10_000);
    timer.unref();
  });
}

const explicitExecutable = process.env.SUPERSET_ORCHESTRATOR_EXECUTABLE;
const executable = explicitExecutable ?? "superset";
// A live run is mandatory when the operator points at a specific executable or opts in
// explicitly. Only the default, unconfigured case may skip on a genuinely absent CLI.
const liveRunRequired =
  explicitExecutable !== undefined || process.env.SUPERSET_ORCHESTRATOR_REQUIRE_LIVE_SMOKE === "1";

test("recorded Superset 1.16.1 responses satisfy the discovery contract", async () => {
  const responses = await readRecordedResponses();
  const result = await new SupersetDiscoveryAdapter({ runner: recordedRunner(responses) }).discover();
  assertDiscoveryContract(result);
  assert.equal(result.version, "1.16.1");
  assert.deepEqual(result.projects.map(({ setUp }) => setUp), ["yes", "no"]);
  assert.deepEqual(result.workspaces.map(({ type }) => type), ["main", "worktree"]);
  // A preset that omits the optional transport fields must still be accepted.
  assert.equal(result.presets.at(-1)?.promptTransport, undefined);
});

test("recorded responses preserve the real Superset 1.16.1 key sets", async () => {
  const responses = await readRecordedResponses();
  const keysOf = (value: unknown) => Object.keys(value as object);
  const list = (key: string) => responses[key] as Record<string, unknown>[];

  assert.deepEqual(keysOf(responses["status --json"]), RECORDED_KEYS.host);
  for (const project of list("projects list --local --json")) {
    assert.deepEqual(keysOf(project), RECORDED_KEYS.project);
  }
  for (const workspace of list("workspaces list --local --json")) {
    assert.deepEqual(keysOf(workspace), RECORDED_KEYS.workspace);
  }
  const presets = list("agents list --local --json");
  assert.deepEqual(keysOf(presets[0]), RECORDED_KEYS.preset);
  // Optional-field variation observed on the real CLI must stay represented.
  assert.ok(presets.some((preset) => !("promptTransport" in preset)));
});

test("real Superset CLI responses match supported discovery schemas", async (t) => {
  if (!liveRunRequired && (await executableIsMissing(executable))) {
    t.skip(
      `Superset executable "${executable}" is not installed; ` +
        "set SUPERSET_ORCHESTRATOR_REQUIRE_LIVE_SMOKE=1 to require this check",
    );
    return;
  }
  const result = await new SupersetDiscoveryAdapter({ executable, timeoutMs: 10_000 }).discover();
  assertDiscoveryContract(result);
});

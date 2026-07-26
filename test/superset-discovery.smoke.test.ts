import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import {
  type ProcessRunner,
  type SupersetDiscoveryResult,
  SupersetDiscoveryAdapter,
} from "../src/superset-discovery.js";
import {
  REQUIRE_LIVE_VARIABLE,
  liveDiscoveryRequired,
  resolveSupersetExecutable,
} from "./superset-executable.js";

const FIXTURE_NOTE = "Recorded from a real local Superset CLI by scripts/record-discovery-fixture.mjs. Field names, types, and null/absent distinctions are verbatim; live values follow the strict privacy classification documented in docs/configuration-and-discovery.md.";
const FIXTURE_RECORDED_AT = "2000-01-01T00:00:00.000Z";

interface RecordedFixture {
  recordedAt: string;
  recordedFromVersion: string;
  note: string;
  responses: Record<string, unknown>;
}

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "superset-discovery-recorded.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RecordedFixture;

function recordedRunner(responses: Record<string, unknown>): ProcessRunner {
  return async (_executable, args) => {
    const response = responses[args.join(" ")];
    assert.ok(response !== undefined, `recorded fixture is missing a response for: ${args.join(" ")}`);
    return {
      stdout: typeof response === "string" ? response : JSON.stringify(response),
      stderr: "",
      exitCode: 0,
    };
  };
}

/** Union of field names across a record or list of records. */
function fieldNames(value: unknown): string[] {
  const records = Array.isArray(value) ? value : [value];
  const names = new Set<string>();
  for (const record of records) {
    if (record !== null && typeof record === "object") {
      for (const name of Object.keys(record as Record<string, unknown>)) names.add(name);
    }
  }
  return [...names].sort();
}

function assertSupportedDiscovery(result: SupersetDiscoveryResult, source: string): void {
  assert.match(result.version, /^\d+\.\d+\.\d+/, `${source}: version is not semantic`);
  assert.ok(result.host.running && result.host.healthy, `${source}: host is not running and healthy`);
  assert.ok(result.projects.length > 0, `${source}: no local projects were discovered`);
  assert.ok(result.workspaces.length > 0, `${source}: no local workspaces were discovered`);
  assert.ok(result.presets.length > 0, `${source}: no agent presets were discovered`);
  assert.ok(
    result.workspaces.every(({ hostId }) => hostId === result.host.hostId),
    `${source}: a workspace belongs to another host`,
  );
  assert.ok(
    result.workspaces.every(({ organizationId }) => organizationId === result.host.organizationId),
    `${source}: a workspace belongs to another organization`,
  );
}

// Runs everywhere. The fixture holds real CLI payloads captured by
// scripts/record-discovery-fixture.mjs, so schema coverage of the supported
// Superset contract does not depend on the optional executable being installed.
test("recorded Superset CLI responses match supported discovery schemas", async () => {
  const runner = recordedRunner(fixture.responses);
  const result = await new SupersetDiscoveryAdapter({ executable: process.execPath, runner }).discover();
  assertSupportedDiscovery(result, "recorded");
  assert.equal(result.version, fixture.recordedFromVersion);
});

test("recorded discovery fixture contains only pseudonymized execution values", () => {
  const presets = fixture.responses["agents list --local --json"] as Array<{
    command: string;
    args?: string[];
    promptArgs?: string[];
    env?: Record<string, string>;
  }>;
  for (const preset of presets) {
    assert.match(preset.command, /^recorded-command-\d+$/);
    for (const argument of [...(preset.args ?? []), ...(preset.promptArgs ?? [])]) {
      assert.match(argument, /^recorded-arg-\d+$/);
    }
    for (const value of Object.values(preset.env ?? {})) assert.match(value, /^recorded-value-\d+$/);
  }
  const executionValues = presets.flatMap(({ command, args = [], promptArgs = [], env = {} }) => [
    command, ...args, ...promptArgs, ...Object.values(env),
  ]);
  assert.doesNotMatch(JSON.stringify(executionValues), /(?:\/Users\/|\/home\/|claude|opencode|dangerously|approval-mode)/i);
});

test("recorded discovery fixture satisfies the strict whole-tree privacy contract", () => {
  assert.equal(fixture.recordedAt, FIXTURE_RECORDED_AT);
  assert.equal(fixture.note, FIXTURE_NOTE);
  assert.match(fixture.recordedFromVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(fixture.responses["--version"], `${fixture.recordedFromVersion}\n`);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /(?:\/Users\/|\/home\/|@|\?.*=|claude|opencode|codex|github\.com\/(?!recorded-org)|48707|2026-07-(?:0[1-9]|[12]\d|3[01])T)/i);
  const presets = fixture.responses["agents list --local --json"] as Array<Record<string, unknown>>;
  for (const preset of presets) {
    assert.match(String(preset.presetId), /^recorded-presetid-\d+$/);
    assert.match(String(preset.label), /^recorded-label-\d+$/);
  }
  const host = fixture.responses["status --json"] as Record<string, unknown>;
  assert.equal(host.endpoint, "http://127.0.0.1:40001");
  assert.equal(host.pid, 1);
  assert.equal(host.port, 40001);
  assert.equal(host.uptimeSec, 1);
});

const executablePath = resolveSupersetExecutable();
const required = liveDiscoveryRequired();
const smokeEnabled = process.env.SUPERSET_DISCOVERY_SMOKE === "1";
const skip = !required && !smokeEnabled
  ? `requires explicit SUPERSET_DISCOVERY_SMOKE=1 opt-in; recorded discovery coverage still ran. Set ${REQUIRE_LIVE_VARIABLE}=1 to require live discovery.`
  : executablePath === null && !required
    ? `Superset executable not found on PATH; recorded discovery coverage still ran. Set ${REQUIRE_LIVE_VARIABLE}=1 to make this a failure.`
    : false;

// Runs only against a real installation. An executable that exists but
// misbehaves still fails here; only a genuinely absent executable is skipped.
test("live Superset CLI responses match supported discovery schemas", { skip }, async () => {
  assert.ok(
    executablePath !== null,
    `${REQUIRE_LIVE_VARIABLE} is set but no Superset executable was found on PATH`,
  );
  const result = await new SupersetDiscoveryAdapter({
    executable: executablePath,
    timeoutMs: 30_000,
  }).discover();
  assertSupportedDiscovery(result, "live");

  // Guards against the recorded fixture drifting away from the real CLI.
  const runner = recordedRunner(fixture.responses);
  const recorded = await new SupersetDiscoveryAdapter({ executable: process.execPath, runner }).discover();
  for (const [label, live, sample] of [
    ["host", result.host, recorded.host],
    ["projects", result.projects, recorded.projects],
    ["workspaces", result.workspaces, recorded.workspaces],
    ["presets", result.presets, recorded.presets],
  ] as const) {
    assert.deepEqual(
      fieldNames(live),
      fieldNames(sample),
      `${label} fields drifted from test/fixtures/superset-discovery-recorded.json; re-run npm run discovery:record`,
    );
  }
});

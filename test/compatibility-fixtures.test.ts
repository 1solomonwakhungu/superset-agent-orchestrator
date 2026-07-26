import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import type { RunResult } from "../src/agent-adapter.js";
import { MalformedCodexResponseError, mapCodexTerminalResponse } from "../src/codex-response-adapter.js";
import { MalformedOpenCodeResponseError, mapOpenCodeTerminalResponse } from "../src/opencode-response-adapter.js";
import { DurableStore, type CapturedResult } from "../src/store.js";
import { withTemporaryDirectory } from "./support/deterministic.js";

/**
 * Synthetic provider payloads and historical-shape durable state cases. These
 * fixtures are contract examples, not captures from an upstream release.
 */

interface FixtureCase {
  name: string;
  input: unknown;
  expect:
    | { kind: "result"; value: RunResult }
    | { kind: "non_terminal" }
    | { kind: "malformed"; message: string };
}

interface FixtureFile {
  adapter: string;
  cases: FixtureCase[];
}

interface FixtureManifest {
  version: 1;
  provenance: "synthetic";
  sourceRevision: string;
  sourceRevisionMeaning: string;
  sanitized: true;
  hash: { algorithm: "sha256"; canonicalization: "canonical-json-v1" };
  files: Record<string, string>;
}

const fixtureDirectory = fileURLToPath(new URL("./fixtures/compat/", import.meta.url));

async function loadFixture(name: string): Promise<FixtureFile> {
  return JSON.parse(await readFile(join(fixtureDirectory, name), "utf8")) as FixtureFile;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
}

const fixtureDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

test("compatibility fixture manifest binds synthetic provenance and sanitization", async () => {
  const manifest = JSON.parse(await readFile(join(fixtureDirectory, "manifest.json"), "utf8")) as FixtureManifest;
  assert.deepEqual(Object.keys(manifest).sort(), ["files", "hash", "provenance", "sanitized", "sourceRevision", "sourceRevisionMeaning", "version"]);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.provenance, "synthetic");
  assert.match(manifest.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.sourceRevisionMeaning, "PER-346 commit that introduced these synthetic cases");
  assert.equal(manifest.sanitized, true);
  assert.deepEqual(manifest.hash, { algorithm: "sha256", canonicalization: "canonical-json-v1" });
  const fixtureFiles = (await readdir(fixtureDirectory))
    .filter((name) => name.endsWith(".json") && name !== "manifest.json").sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), fixtureFiles, "every compatibility fixture must have provenance");
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert.match(digest, /^[0-9a-f]{64}$/);
    const fixture: unknown = JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
    assert.equal(fixtureDigest(fixture), digest, name);
    assert.equal(fixtureDigest(JSON.parse(JSON.stringify(fixture, null, 4))), digest, `${name} formatting independence`);
  }
});

test("canonical fixture hashes change only for semantic mutations", () => {
  const first = { z: [1, { b: true, a: null }], a: "value" };
  const reordered = { a: "value", z: [1, { a: null, b: true }] };
  assert.equal(fixtureDigest(first), fixtureDigest(reordered));
  assert.notEqual(fixtureDigest(first), fixtureDigest({ ...reordered, a: "changed" }));
});

function runFixture(
  fixture: FixtureFile,
  map: (input: unknown) => RunResult | undefined,
  malformed: new (...args: never[]) => Error,
): void {
  assert.ok(fixture.cases.length > 0, `${fixture.adapter} fixtures must not be empty`);
  const names = fixture.cases.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length, `${fixture.adapter} fixture names must be unique`);

  for (const testCase of fixture.cases) {
    const label = `${fixture.adapter}: ${testCase.name}`;
    if (testCase.expect.kind === "malformed") {
      assert.throws(
        () => map(testCase.input),
        (error: unknown) => error instanceof malformed && error.message.includes((testCase.expect as { message: string }).message),
        label,
      );
      continue;
    }
    const actual = map(testCase.input);
    if (testCase.expect.kind === "non_terminal") {
      assert.equal(actual, undefined, label);
      continue;
    }
    assert.deepEqual(actual, testCase.expect.value, label);
  }
}

test("synthetic Codex contract cases map to their declared results", async () => {
  const fixture = await loadFixture("codex-responses.json");
  runFixture(fixture, mapCodexTerminalResponse, MalformedCodexResponseError);

  const statuses = new Set(fixture.cases
    .flatMap(({ expect }) => (expect.kind === "result" ? [expect.value.status] : [])));
  assert.deepEqual([...statuses].sort(), ["cancelled", "failed", "succeeded"],
    "the fixture set must cover every terminal result the core contract defines");
  assert.ok(fixture.cases.some(({ expect }) => expect.kind === "non_terminal"));
  assert.ok(fixture.cases.filter(({ expect }) => expect.kind === "malformed").length >= 4);
});

test("synthetic OpenCode contract cases map to their declared results", async () => {
  const fixture = await loadFixture("opencode-responses.json");
  runFixture(fixture, mapOpenCodeTerminalResponse, MalformedOpenCodeResponseError);

  const errorVariants = new Set(fixture.cases.flatMap(({ input }) => {
    const name = (input as { info?: { error?: { name?: string } } }).info?.error?.name;
    return name === undefined ? [] : [name];
  }));
  assert.deepEqual([...errorVariants].sort(), [
    "APIError", "MessageAbortedError", "MessageOutputLengthError", "ProviderAuthError", "TeapotError", "UnknownError",
  ], "every documented OpenCode error variant, plus an undocumented one, must stay covered");
});

test("adapters never emit a result outside the core union", async () => {
  for (const [name, map] of [
    ["codex-responses.json", mapCodexTerminalResponse],
    ["opencode-responses.json", mapOpenCodeTerminalResponse],
  ] as const) {
    const fixture = await loadFixture(name);
    for (const testCase of fixture.cases) {
      let actual: RunResult | undefined;
      try {
        actual = map(testCase.input);
      } catch {
        continue;
      }
      if (actual === undefined) continue;
      assert.ok(["succeeded", "failed", "cancelled"].includes(actual.status), `${name}: ${testCase.name}`);
      if (actual.status === "succeeded") assert.equal(typeof actual.output, "string");
      if (actual.status === "failed") {
        assert.equal(typeof actual.error, "string");
        assert.equal(typeof actual.retryable, "boolean");
      }
      if (actual.resume !== undefined) {
        assert.equal(actual.resume.adapter, fixture.adapter);
        assert.ok(actual.resume.token.length > 0);
      }
    }
  }
});

test("state written before assignments existed still loads and reconciles", async () => {
  await withTemporaryDirectory("orchestrator-compat", async (directory) => {
    const path = join(directory, "state.json");
    await copyFile(join(fixtureDirectory, "durable-state-legacy.json"), path);
    await chmod(path, 0o600);

    const store = new DurableStore(path, () => false);
    const summary = await store.reconcile(new Date("2026-07-01T00:00:00.000Z"));
    assert.equal(summary.sessionsRecovered, 1);
    assert.equal(summary.batchesRecovered, 1);
    assert.equal(summary.workersRecovered, 3);
    assert.equal(summary.runningWorkers, 0, "a process that did not survive the upgrade is not still running");
    assert.equal(summary.diagnosticsAdded, 2, "one unknown outcome and one missing result for the failed worker");

    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.assignments, [], "absent collections default rather than fail");
    assert.deepEqual(snapshot.auditEvents, []);
    assert.deepEqual(snapshot.launchIntents, []);
    assert.deepEqual(snapshot.capturedResults, []);

    const reopened = store.reopenBatch("overnight-sweep");
    assert.equal(reopened?.batch.id, "batch-legacy-1");
    assert.deepEqual(reopened?.workers.map(({ attribution }) => attribution.agent), ["codex", "opencode", "codex"]);
    assert.equal(reopened?.session?.clientId, "hermes-cli");

    const page = await store.getBatch("batch-legacy-1", { limit: 10 });
    assert.deepEqual(page.sessions.map(({ id }) => id), ["worker-legacy-1", "worker-legacy-2", "worker-legacy-3"]);

    // The upgraded file must round-trip through the current schema unchanged.
    const rewritten = new DurableStore(path, () => false);
    const second = await rewritten.reconcile(new Date("2026-07-01T01:00:00.000Z"));
    assert.equal(second.diagnosticsAdded, 0);
  });
});

test("assignments without exact identities can never accept a result", async () => {
  await withTemporaryDirectory("orchestrator-compat", async (directory) => {
    const path = join(directory, "state.json");
    await copyFile(join(fixtureDirectory, "durable-state-preidentity.json"), path);
    await chmod(path, 0o600);

    const store = new DurableStore(path, () => false);
    await store.reconcile(new Date("2026-07-01T00:00:00.000Z"));

    const assignment = await store.assignmentForResult("assignment-pre-1");
    assert.equal(assignment.status, "launched");
    assert.equal(assignment.workspaceId, undefined);
    assert.equal(assignment.attemptId, undefined);
    assert.equal(assignment.attempt, undefined);

    const result: CapturedResult = {
      deliveryId: "delivery-pre-1",
      deliveryFingerprint: "3".repeat(64),
      assignmentId: "assignment-pre-1",
      batchId: "batch-pre-1",
      sessionId: "session-pre-1",
      workspaceId: "workspace-invented",
      workspacePath: "/tmp/legacy-workspace",
      attemptId: "attempt-invented",
      attempt: 1,
      runId: "run-pre-1",
      attribution: { agent: "codex", task: "upgrade identities" },
      claim: { status: "succeeded", completeness: "complete", output: "done" },
      verifiedArtifacts: [],
      capturedAt: "2026-07-01T00:00:00.000Z",
    };
    await assert.rejects(
      () => store.captureResult(result),
      /Legacy assignments without exact workspace and attempt identities cannot accept results/,
    );
    assert.deepEqual(store.snapshot().capturedResults, []);

    const intents = store.launchIntents();
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.status, "bound");
    await assert.rejects(
      () => store.updateLaunch("pre-key-1", "reserved"),
      /Invalid launch transition: bound -> reserved/,
      "an upgraded file keeps its bindings immutable",
    );
  });
});

test("the published tool schema catalog matches the generated contract byte for byte", async () => {
  const [tracked, { jsonSchemaCatalog }] = await Promise.all([
    readFile(new URL("../config/mcp-tools.schema.json", import.meta.url), "utf8"),
    import("../src/tool-contract.js"),
  ]);
  assert.equal(tracked.trimEnd(), JSON.stringify(jsonSchemaCatalog(), null, 2),
    "regenerate config/mcp-tools.schema.json with `npm run schema` after changing the contract");
});

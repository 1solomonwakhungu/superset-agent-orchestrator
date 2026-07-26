import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const matrix = JSON.parse(readFileSync(resolve(root, "config/compatibility-matrix.v1.json"), "utf8"));

test("matrix rows are evidence-backed or explicitly non-supported", () => {
  const ids = new Set();
  for (const row of matrix.combinations) {
    assert.ok(!ids.has(row.id), `duplicate combination id: ${row.id}`);
    ids.add(row.id);
    assert.ok(matrix.classifications[row.classification], `unknown classification: ${row.classification}`);
    assert.deepEqual(
      Object.keys(row.environment).sort(),
      ["agentPreset", "architecture", "mcpSdk", "node", "npm", "os", "osVersion", "supersetCli", "supersetDesktop", "transport"].sort(),
    );
    if (["verified", "contract-supported", "experimental", "unsupported"].includes(row.classification)) {
      assert.ok(row.evidence.length > 0, `${row.id} requires evidence`);
    }
    if (row.classification === "verified") {
      assert.ok(row.evidence.every((item) => /^[0-9a-f]{40}$/.test(item.revision)), `${row.id} evidence must use immutable revisions`);
      assert.ok(row.claims.length > 0, `${row.id} requires a bounded claim`);
    }
    if (["unknown", "unsupported"].includes(row.classification)) {
      assert.equal(row.claims.length, 0, `${row.id} cannot make support claims`);
    }
  }
});

test("policy rejects unknown combinations actionably and before mutation", () => {
  assert.equal(matrix.supportPolicy.defaultClassification, "unknown");
  assert.equal(matrix.supportPolicy.failBeforeMutation, true);
  assert.equal(matrix.supportPolicy.allowImplicitVersionCoverage, false);
  assert.equal(matrix.supportPolicy.allowFallback, false);
  assert.equal(matrix.supportPolicy.compatibilityError.code, "UNSUPPORTED_COMBINATION");
  assert.deepEqual(matrix.supportPolicy.compatibilityError.requiredFields, [
    "classification",
    "detected",
    "unsupportedDimensions",
    "supportedAlternatives",
    "probeCommand",
  ]);
});

test("probe is sanitized, repeatable, and fail-closed for incomplete environments", () => {
  const output = execFileSync(process.execPath, [resolve(root, "scripts/probe-compatibility.mjs")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  const report = JSON.parse(output);
  assert.equal(report.schemaVersion, 1);
  assert.ok(["unknown", "unsupported", "contract-supported"].includes(report.classification));
  assert.equal(report.mutationAllowed, false);
  assert.equal(report.probeCommand, "npm run compatibility:probe");
  assert.ok(report.detected.node);
  assert.ok(report.detected.mcpSdk);
  assert.doesNotMatch(output, /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/);
  assert.doesNotMatch(output, /(?:workspaceId|hostId|organizationId|token|credential)/i);
});

test("probe classifies out-of-envelope Node versions as unsupported", () => {
  const source = readFileSync(resolve(root, "scripts/probe-compatibility.mjs"), "utf8");
  assert.match(source, /unsupportedDimensions\.push\("Node\.js major"\)/);
  assert.match(source, /classification = unsupportedDimensions\.length > 0 \? "unsupported"/);
});

test("Windows is explicitly unsupported and excluded from CI", () => {
  const windows = matrix.combinations.find(({ id }) => id === "windows-native-stdio");
  assert.equal(windows?.classification, "unsupported");
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.deepEqual(packageJson.os, ["darwin", "linux"]);
  const workflow = readFileSync(resolve(root, ".github/workflows/compatibility.yml"), "utf8");
  assert.doesNotMatch(workflow, /windows-/i);
  assert.match(workflow, /ubuntu-24\.04/);
  assert.match(workflow, /macos-14/);
});

test("generated compatibility reports require all four passing exact-head lanes", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "compatibility-report-"));
  const output = resolve(directory, "report.md");
  const commit = "a".repeat(40);
  try {
    for (const [runner, node, platform] of [
      ["ubuntu-24.04", 22, "linux"],
      ["ubuntu-24.04", 24, "linux"],
      ["macos-14", 22, "darwin"],
      ["macos-14", 24, "darwin"],
    ]) {
      const lane = resolve(directory, `${runner}-${node}`);
      mkdirSync(lane);
      writeFileSync(resolve(lane, "result.json"), JSON.stringify({
        commit, runner, requestedNode: node, conclusion: "success",
        detected: { platform, release: "tested", architecture: "x64", node: `${node}.0.0`, npm: "10.9.8" },
      }));
    }
    execFileSync(process.execPath, [resolve(root, "scripts/generate-compatibility-report.mjs"), directory, output]);
    const report = readFileSync(output, "utf8");
    assert.match(report, new RegExp(commit));
    assert.match(report, /Windows is unsupported/);

    const mismatched = resolve(directory, "ubuntu-24.04-22", "result.json");
    const result = JSON.parse(readFileSync(mismatched, "utf8"));
    writeFileSync(mismatched, JSON.stringify({ ...result, detected: { ...result.detected, node: "24.0.0" } }));
    assert.throws(() => execFileSync(
      process.execPath,
      [resolve(root, "scripts/generate-compatibility-report.mjs"), directory, output],
      { stdio: "pipe" },
    ));
    writeFileSync(mismatched, JSON.stringify(result));

    rmSync(resolve(directory, "macos-14-24"), { recursive: true });
    assert.throws(() => execFileSync(
      process.execPath,
      [resolve(root, "scripts/generate-compatibility-report.mjs"), directory, output],
      { stdio: "pipe" },
    ));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

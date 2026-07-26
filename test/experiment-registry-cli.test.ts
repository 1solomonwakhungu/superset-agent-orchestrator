import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const HASH = "a".repeat(64);

test("built CLI adds, queries, diffs, and rejects malformed filters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "experiment-registry-cli-"));
  const registry = join(directory, "experiments.jsonl");
  const catalog = join(directory, "baselines.json");
  const input = join(directory, "input.json");
  const baseline = {
    fingerprint: HASH,
    config: { pages: 4 },
    checkpointSha: "b".repeat(40),
    env: { os: "linux" },
    hardware: { cpu: "test" },
    codeRevision: "c".repeat(40),
    tokenizerHash: "d".repeat(64),
    chatTemplateHash: "e".repeat(64),
    corpusHash: "f".repeat(64),
    metrics: { accuracy: 0.5 },
  };
  await writeFile(catalog, JSON.stringify([baseline]), "utf8");
  await writeFile(
    input,
    JSON.stringify({
      parentBaselineFingerprint: HASH,
      lineage: "callforge",
      hypothesis: "Typed calls improve accuracy",
      config: { pages: 8 },
      checkpointSha: "b".repeat(40),
      env: { os: "linux" },
      hardware: { cpu: "test" },
      codeRevision: "c".repeat(40),
      tokenizerHash: "d".repeat(64),
      chatTemplateHash: "e".repeat(64),
      corpusHash: "f".repeat(64),
      metrics: { accuracy: 0.75 },
      artifactLinks: [],
      status: "succeeded",
      ownerAgent: "cli-test",
    }),
    "utf8",
  );
  const cli = join(process.cwd(), "dist/src/experiment-registry-cli.js");
  const added = JSON.parse(
    (
      await execute(process.execPath, [
        cli,
        "add",
        "--registry",
        registry,
        "--catalog",
        catalog,
        "--input",
        input,
      ])
    ).stdout,
  ) as { experimentId: string };
  const queried = JSON.parse(
    (
      await execute(process.execPath, [
        cli,
        "query",
        "--registry",
        registry,
        "--catalog",
        catalog,
        "--hypothesis",
        "Typed calls improve accuracy",
      ])
    ).stdout,
  ) as unknown[];
  assert.equal(queried.length, 1);
  const diff = JSON.parse(
    (
      await execute(process.execPath, [
        cli,
        "diff",
        "--registry",
        registry,
        "--catalog",
        catalog,
        "--baseline",
        HASH,
        "--experiment",
        added.experimentId,
      ])
    ).stdout,
  ) as { changes: unknown[] };
  assert.equal(diff.changes.length, 2);
  await assert.rejects(
    execute(process.execPath, [
      cli,
      "query",
      "--registry",
      registry,
      "--catalog",
      catalog,
      "--checkpoint",
      "bad",
    ]),
  );
});

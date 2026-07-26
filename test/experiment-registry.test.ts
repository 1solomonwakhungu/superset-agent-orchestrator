import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ExperimentRegistry,
  type ExperimentInput,
} from "../src/experiment-registry.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function input(overrides: Partial<ExperimentInput> = {}): ExperimentInput {
  return {
    parentBaselineFingerprint: HASH_A,
    lineage: "disklm",
    hypothesis: "Page alignment reduces reads",
    config: { pages: 4 },
    checkpointSha: "c".repeat(40),
    env: { os: "linux" },
    hardware: { cpu: "test" },
    codeRevision: "d".repeat(40),
    tokenizerHash: "e".repeat(64),
    chatTemplateHash: "f".repeat(64),
    corpusHash: HASH_B,
    metrics: { accuracy: 0.75 },
    artifactLinks: ["https://example.test/result.json"],
    status: "succeeded",
    ownerAgent: "test-agent",
    ...overrides,
  };
}

async function paths(): Promise<{ path: string; catalog: string }> {
  const directory = await mkdtemp(join(tmpdir(), "experiment-registry-"));
  const path = join(directory, "experiments.jsonl");
  const catalog = join(directory, "baselines.json");
  await writeFile(
    catalog,
    JSON.stringify([
      {
        fingerprint: HASH_A,
        config: { pages: 4 },
        checkpointSha: "c".repeat(40),
        env: { os: "linux" },
        hardware: { cpu: "test" },
        codeRevision: "d".repeat(40),
        tokenizerHash: "e".repeat(64),
        chatTemplateHash: "f".repeat(64),
        corpusHash: HASH_B,
        metrics: { accuracy: 0.75 },
      },
    ]),
    "utf8",
  );
  return { path, catalog };
}

test("appends immutable records and queries by hypothesis or checkpoint", async () => {
  const { path, catalog } = await paths();
  const registry = new ExperimentRegistry(
    path,
    catalog,
    () => new Date("2026-07-26T00:00:00Z"),
    () => "00000000-0000-4000-8000-000000000001",
  );
  const first = await registry.add(input());
  const prefix = await readFile(path, "utf8");
  await assert.rejects(
    registry.add(input({ experimentId: first.experimentId })),
    /already exists/,
  );
  await registry.add(
    input({
      experimentId: "exp_00000000-0000-4000-8000-000000000002",
      hypothesis: "Other",
      checkpointSha: "d".repeat(40),
      timestamp: "2026-07-26T00:00:01Z",
    }),
  );
  assert.ok((await readFile(path, "utf8")).startsWith(prefix));
  assert.deepEqual(
    (await registry.query({ hypothesis: first.hypothesis })).map(
      (record) => record.experimentId,
    ),
    [first.experimentId],
  );
  assert.equal(
    (await registry.query({ checkpointSha: "d".repeat(40) })).length,
    1,
  );
});

test("diffs nested experiment data deterministically", async () => {
  const { path, catalog } = await paths();
  const registry = new ExperimentRegistry(path, catalog);
  await registry.add(
    input({
      experimentId: "exp_00000000-0000-4000-8000-000000000001",
      timestamp: "2026-07-26T00:00:00Z",
    }),
  );
  await registry.add(
    input({
      experimentId: "exp_00000000-0000-4000-8000-000000000002",
      timestamp: "2026-07-26T00:00:01Z",
      config: { pages: 8 },
      metrics: { accuracy: 0.8 },
    }),
  );
  assert.deepEqual(
    (await registry.diff(HASH_A, "exp_00000000-0000-4000-8000-000000000002"))
      .changes,
    [
      { path: "/config/pages", baseline: 4, experiment: 8 },
      { path: "/metrics/accuracy", baseline: 0.75, experiment: 0.8 },
    ],
  );
});

test("rejects unknown baselines and path aliases share one lock", async () => {
  const { path, catalog } = await paths();
  await assert.rejects(
    new ExperimentRegistry(path, catalog).add(
      input({ parentBaselineFingerprint: "9".repeat(64) }),
    ),
    /Unknown baseline fingerprint/,
  );
  const alias = join(dirname(path), "alias.jsonl");
  await symlink(path, alias);
  const duplicate = input({
    experimentId: "exp_00000000-0000-4000-8000-000000000009",
  });
  const results = await Promise.allSettled([
    new ExperimentRegistry(path, catalog).add(duplicate),
    new ExperimentRegistry(alias, catalog).add(duplicate),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await new ExperimentRegistry(path, catalog).query()).length, 1);
});

test("parallel processes do not lose records", async () => {
  const { path, catalog } = await paths();
  const writer = fileURLToPath(
    new URL("fixtures/experiment-registry-writer.ts", import.meta.url),
  );
  const writes = Array.from({ length: 12 }, (_, index) =>
    input({
      experimentId: `exp_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      timestamp: `2026-07-26T00:00:${String(index).padStart(2, "0")}Z`,
    }),
  );
  await Promise.all(
    writes.map(
      (record) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              writer,
              path,
              catalog,
              Buffer.from(JSON.stringify(record)).toString("base64url"),
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          let stderr = "";
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`Writer exited ${String(code)}: ${stderr}`)),
          );
        }),
    ),
  );
  assert.equal(
    (await new ExperimentRegistry(path, catalog).query()).length,
    12,
  );
});

test("fails closed on malformed and truncated existing records", async () => {
  const { path, catalog } = await paths();
  await writeFile(path, '{"partial":true}', "utf8");
  await assert.rejects(
    new ExperimentRegistry(path, catalog).query(),
    /truncated final line/,
  );
  await writeFile(path, "{}\n", "utf8");
  await assert.rejects(
    new ExperimentRegistry(path, catalog).add(input()),
    /Invalid registry record on line 1/,
  );
  assert.equal(await readFile(path, "utf8"), "{}\n");
});

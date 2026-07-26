import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import contract from "../scripts/disklm-contract.mjs";

const verifier = path.resolve("scripts/verify-disklm-research.mjs");

test("exports a recursively frozen evaluation contract", () => {
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.storage), true);
  assert.equal(Object.isFrozen(contract.seeds), true);
  assert.equal(Object.isFrozen(contract.qualitySuites[0]), true);
  assert.throws(() => contract.seeds.push(99), TypeError);
});

test("rejects a benchmark that redefines frozen constants", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "disklm-verifier-"));
  const benchmark = path.join(directory, "bad-benchmark.mjs");
  await writeFile(
    benchmark,
    'import contract from "disklm-contract.mjs";\nconsole.log(contract, 4096);\n',
  );
  const result = spawnSync(process.execPath, [verifier, benchmark], {
    encoding: "utf8",
  });
  await rm(directory, { recursive: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /redefines 4096/);
});

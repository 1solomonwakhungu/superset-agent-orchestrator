import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/run-race-tests.sh", import.meta.url).pathname;

test("race runner rejects zero, negative, nonnumeric, and excessive repeats", async () => {
  for (const repeats of ["0", "-1", "abc", "101"]) {
    const result = await runRace(repeats);
    assert.equal(result.code, 2, `RACE_REPEATS=${repeats}`);
    assert.match(result.stderr, /integer from 1 to 100/);
    assert.equal(result.stdout, "");
  }
});

test("parallel race runners use isolated temporary output", async () => {
  const results = await Promise.all([runRace("1"), runRace("1")]);
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /all 1 race runs passed/);
  }
});

async function runRace(repeats: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn("bash", [script], {
    env: { ...process.env, RACE_REPEATS: repeats },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

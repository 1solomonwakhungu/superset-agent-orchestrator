import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/run-race-tests.sh", import.meta.url).pathname;

test("race runner rejects zero, negative, nonnumeric, and excessive repeats", async () => {
  for (const repeats of ["0", "-1", "+1", "01", "abc", "101", "9".repeat(100)]) {
    const result = await runRace(repeats);
    assert.equal(result.code, 2, `RACE_REPEATS=${repeats}`);
    assert.match(result.stderr, /integer from 1 to 100/);
    assert.equal(result.stdout, "");
  }
});

test("race runner rejects unbounded per-run timeouts", async () => {
  for (const timeout of ["0", "999", "600001", "9".repeat(100)]) {
    const result = await runRace("1", { RACE_RUN_TIMEOUT_MS: timeout });
    assert.equal(result.code, 2, `RACE_RUN_TIMEOUT_MS=${timeout}`);
    assert.match(result.stderr, /integer from 1000 to 600000/);
  }
});

test("timeout wrapper terminates the complete descendant process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-timeout-"));
  const marker = join(directory, "survivor.txt");
  const fixture = join(directory, "descendant.mjs");
  await writeFile(fixture, `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 300)`) }], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `);
  try {
    const child = spawn(process.execPath, [new URL("../scripts/run-with-timeout.mjs", import.meta.url).pathname, "100", process.execPath, fixture]);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 124);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(() => access(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("parallel race runners use isolated temporary output", async () => {
  const results = await Promise.all([runRace("1"), runRace("1")]);
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /all 1 race runs passed/);
  }
});

async function runRace(repeats: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn("bash", [script], {
    env: { ...process.env, RACE_REPEATS: repeats, ...env },
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

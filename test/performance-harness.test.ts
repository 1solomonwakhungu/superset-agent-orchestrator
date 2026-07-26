import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFakeBenchmark } from "../src/fake-backend-benchmark.js";
import { runRealLoad } from "../src/real-agent-load-runner.js";
import { verifyReport } from "../src/report-verifier.js";

test("fake benchmark enforces the exact production session count", async () => {
  await assert.rejects(runFakeBenchmark({ sessions: 99, output: "/unused" }), /exactly 100/);
});

test("fake benchmark completes and attributes all 100 responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  const output = join(directory, "fake");
  try {
    const report = await runFakeBenchmark({ sessions: 100, output });
    const lifecycle = report.lifecycle as { completed: number; attributedResults: number };
    assert.equal(lifecycle.completed, 100);
    assert.equal(lifecycle.attributedResults, 100);
    assert.equal((report.correctness as { everyResponseAttributed: boolean }).everyResponseAttributed, true);
    assert.equal((report.restartRecovery as { recoveredResults: number }).recoveredResults, 100);
    assert.equal((report.responsiveness as { passed: boolean }).passed, true);
    assert.equal(await verifyReport(output), "per-351.fake-backend.v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real runner launches each ramp concurrently and attributes acceptances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  let active = 0;
  let maximumActive = 0;
  try {
    const report = await runRealLoad({
      execute: true, workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "codex", prompt: "safe test", output: join(directory, "execute"), launchTimeoutMs: 1_000,
      maxRssBytes: 1_000_000_000, maxCpuMs: 10_000, maxDescriptors: 10_000,
      launch: async (workspaceId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { sessionId: `session-${workspaceId}`, kind: "terminal" };
      },
    });
    assert.equal(maximumActive, 15);
    assert.equal((report.launch as { accepted: number }).accepted, 30);
    assert.deepEqual(report.validation, { passed: true, blocked: false, reason: null });
    const sessions = (report.launch as { acceptedSessions: Array<{ workspaceId: string; task: string }> }).acceptedSessions;
    assert.equal(new Set(sessions.map(({ workspaceId }) => workspaceId)).size, 30);
    assert.equal(new Set(sessions.map(({ task }) => task)).size, 30);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real runner plans 30 unique workspaces without launching in dry-run mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  const output = join(directory, "dry-run");
  let launches = 0;
  try {
    const report = await runRealLoad({
      execute: false,
      workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "codex", prompt: "safe test", output, launchTimeoutMs: 1_000,
      maxRssBytes: 1_000_000_000, maxCpuMs: 10_000, maxDescriptors: 1_000,
      launch: async () => { launches += 1; return { sessionId: "forbidden", kind: "terminal" }; },
    });
    assert.equal(launches, 0);
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(report.validation, {
      passed: true,
      blocked: true,
      reason: "Paid execution requires 30 explicitly authorized isolated workspaces and operator opt-in.",
    });
    assert.equal(await verifyReport(output), "per-351.real-agent-load.v1");
    assert.match(await readFile(`${output}.md`, "utf8"), /starts no paid agents/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report verifier rejects inconsistent and incomplete load evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  const output = join(directory, "invalid");
  try {
    const report = await runRealLoad({
      execute: false,
      workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "codex", prompt: "safe test", output, launchTimeoutMs: 1_000,
      maxRssBytes: 1_000_000_000, maxCpuMs: 10_000, maxDescriptors: 1_000,
    });
    (report.launch as { attempted: number }).attempted = 1;
    await writeFile(`${output}.json`, `${JSON.stringify(report)}\n`, "utf8");
    await assert.rejects(verifyReport(output), /Dry-run must launch nothing|Launch counts are inconsistent/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report verifier enforces latency ceilings and unique session IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  try {
    const fakeOutput = join(directory, "fake");
    const fake = await runFakeBenchmark({ sessions: 100, output: fakeOutput });
    (fake.responsiveness as { launchP95Ms: number }).launchP95Ms = 1_001;
    await writeFile(`${fakeOutput}.json`, `${JSON.stringify(fake)}\n`, "utf8");
    await assert.rejects(verifyReport(fakeOutput), /fixed 1000ms ceiling/);

    const realOutput = join(directory, "real");
    const real = await runRealLoad({
      execute: true, workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "codex", prompt: "safe test", output: realOutput, launchTimeoutMs: 1_000,
      maxRssBytes: 1_000_000_000, maxCpuMs: 10_000, maxDescriptors: 10_000,
      launch: async () => ({ sessionId: "duplicate", kind: "terminal" }),
    });
    await assert.rejects(verifyReport(realOutput), /unique workspace, task, and session attribution/);
    assert.equal((real.launch as { accepted: number }).accepted, 30);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paid runner validates every workspace against a local snapshot before launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  const workspaceIds = Array.from({ length: 30 }, (_, index) => `workspace-${index}`);
  let listed = 0;
  try {
    await assert.rejects(runRealLoad({
      execute: true, workspaceIds, agent: "codex", prompt: "safe test", output: join(directory, "local"), launchTimeoutMs: 1_000,
      maxRssBytes: 1_000_000_000, maxCpuMs: 10_000, maxDescriptors: 10_000,
      listLocalWorkspaces: async () => {
        listed += 1;
        return workspaceIds.slice(0, 29).map((id) => ({ id }));
      },
    }), /workspace-29/);
    assert.equal(listed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real runner rejects shared writers and aborts before crossing a ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  try {
    await assert.rejects(runRealLoad({
      execute: false, workspaceIds: Array.from({ length: 30 }, () => "shared"),
      agent: "codex", prompt: "safe test", output: join(directory, "shared"), launchTimeoutMs: 1_000,
      maxRssBytes: 1, maxCpuMs: 1, maxDescriptors: 1,
    }), /30 unique/);
    let launches = 0;
    const report = await runRealLoad({
      execute: true,
      workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "codex", prompt: "safe test", output: join(directory, "abort"), launchTimeoutMs: 1_000,
      maxRssBytes: 1, maxCpuMs: 10_000, maxDescriptors: 1_000,
      launch: async () => { launches += 1; return { sessionId: "unexpected", kind: "terminal" }; },
    });
    assert.equal(launches, 0);
    assert.equal((report.abort as { aborted: boolean }).aborted, true);
    assert.match(String((report.abort as { reason: string }).reason), /RSS ceiling/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

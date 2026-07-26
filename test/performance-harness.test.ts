import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFakeBenchmark } from "../src/fake-backend-benchmark.js";
import type { PerformanceMeasurements, ResourceSample } from "../src/performance-report.js";
import { runRealLoad } from "../src/real-agent-load-runner.js";
import { verifyReport } from "../src/report-verifier.js";

const SAFE_RESOURCE: ResourceSample = { elapsedMs: 1, cpuUserMs: 1, cpuSystemMs: 1, rssBytes: 1_024, descriptors: 8 };

function measurements(resources: readonly ResourceSample[] = [SAFE_RESOURCE]): PerformanceMeasurements {
  let index = 0;
  return {
    async durationMs<T>(label: string, operation: () => Promise<T>) {
      return { value: await operation(), durationMs: label === "lifecycle" ? 250 : 5 };
    },
    async resources() {
      const resource = resources[Math.min(index, resources.length - 1)]!;
      index += 1;
      return { ...resource };
    },
  };
}

function queryClock(): () => number {
  let now = 0;
  return () => now++;
}

test("fake benchmark enforces the exact production session count", async () => {
  await assert.rejects(runFakeBenchmark({ sessions: 99, output: "/unused" }), /exactly 100/);
});

test("fake benchmark completes and attributes all 100 responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  const output = join(directory, "fake");
  try {
    const report = await runFakeBenchmark({ sessions: 100, output, measurements: measurements(), queryNow: queryClock() });
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
      maxInFlight: 15, measurements: measurements(),
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
    assert.deepEqual(report.admission, {
      planned: 30, offered: 30, admitted: 30, failed: 0, withheld: 0, maxObservedInFlight: 15,
      stages: [
        { stage: 1, planned: 5, offered: 5, admitted: 5, failed: 0, withheld: 0 },
        { stage: 2, planned: 10, offered: 10, admitted: 10, failed: 0, withheld: 0 },
        { stage: 3, planned: 15, offered: 15, admitted: 15, failed: 0, withheld: 0 },
      ],
    });
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
      measurements: measurements(),
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
      measurements: measurements(),
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
    const fake = await runFakeBenchmark({ sessions: 100, output: fakeOutput, measurements: measurements(), queryNow: queryClock() });
    (fake.responsiveness as { launchP95Ms: number }).launchP95Ms = 1_001;
    await writeFile(`${fakeOutput}.json`, `${JSON.stringify(fake)}\n`, "utf8");
    await assert.rejects(verifyReport(fakeOutput), /fixed 1000ms ceiling/);

    const realOutput = join(directory, "real");
    const real = await runRealLoad({
      execute: true, workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "codex", prompt: "safe test", output: realOutput, launchTimeoutMs: 1_000,
      maxRssBytes: 1_000_000_000, maxCpuMs: 10_000, maxDescriptors: 10_000,
      measurements: measurements(),
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
      measurements: measurements(),
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
      measurements: measurements(),
    }), /30 unique/);
    let launches = 0;
    const report = await runRealLoad({
      execute: true,
      workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "codex", prompt: "safe test", output: join(directory, "abort"), launchTimeoutMs: 1_000,
      maxRssBytes: 1, maxCpuMs: 10_000, maxDescriptors: 1_000,
      measurements: measurements([{ ...SAFE_RESOURCE, rssBytes: 2 }]),
      launch: async () => { launches += 1; return { sessionId: "unexpected", kind: "terminal" }; },
    });
    assert.equal(launches, 0);
    assert.equal((report.abort as { aborted: boolean }).aborted, true);
    assert.match(String((report.abort as { reason: string }).reason), /RSS ceiling/);
    assert.equal((report.admission as { withheld: number }).withheld, 30);
    assert.equal(await verifyReport(join(directory, "abort")), "per-351.real-agent-load.v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real runner times out an injected launch and withholds later work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  try {
    const report = await runRealLoad({
      execute: true,
      workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "fake", prompt: "safe test", output: join(directory, "timeout"), launchTimeoutMs: 10,
      maxRssBytes: 10_000, maxCpuMs: 10_000, maxDescriptors: 100, maxInFlight: 1,
      measurements: measurements(),
      launch: async () => new Promise(() => undefined),
    });
    assert.equal((report.launch as { attempted: number }).attempted, 1);
    assert.equal((report.admission as { failed: number; withheld: number; maxObservedInFlight: number }).failed, 1);
    assert.equal((report.admission as { withheld: number }).withheld, 29);
    assert.equal((report.admission as { maxObservedInFlight: number }).maxObservedInFlight, 1);
    assert.match((report.abort as { reason: string }).reason, /launch failure/);
    assert.match(((report.launch as { failures: Array<{ error: string }> }).failures[0]?.error ?? ""), /timed out after 10ms/);
    assert.equal(await verifyReport(join(directory, "timeout")), "per-351.real-agent-load.v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report verifier rejects forged throughput and admission arithmetic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  try {
    const fakeOutput = join(directory, "fake-arithmetic");
    const fake = await runFakeBenchmark({ sessions: 100, output: fakeOutput, measurements: measurements(), queryNow: queryClock() });
    (fake.throughput as { sessionsPerSecond: number }).sessionsPerSecond = 999;
    await writeFile(`${fakeOutput}.json`, `${JSON.stringify(fake)}\n`, "utf8");
    await assert.rejects(verifyReport(fakeOutput), /Throughput arithmetic is inconsistent/);

    const loadOutput = join(directory, "load-arithmetic");
    const load = await runRealLoad({
      execute: false, workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "fake", prompt: "safe test", output: loadOutput, launchTimeoutMs: 10,
      maxRssBytes: 10_000, maxCpuMs: 10_000, maxDescriptors: 100, measurements: measurements(),
    });
    (load.admission as { withheld: number }).withheld = 29;
    await writeFile(`${loadOutput}.json`, `${JSON.stringify(load)}\n`, "utf8");
    await assert.rejects(verifyReport(loadOutput), /Admission and backpressure arithmetic is inconsistent/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report verifier rejects forged latency and unsupported resource aborts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "per-351-test-"));
  try {
    const latencyOutput = join(directory, "latency-arithmetic");
    const latency = await runRealLoad({
      execute: true, workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "fake", prompt: "safe test", output: latencyOutput, launchTimeoutMs: 10,
      maxRssBytes: 10_000, maxCpuMs: 10_000, maxDescriptors: 100, measurements: measurements(),
      launch: async (workspaceId) => ({ sessionId: `session-${workspaceId}`, kind: "terminal" }),
    });
    (latency.launch as { latencyMs: { p95: number } }).latencyMs.p95 = 6;
    await writeFile(`${latencyOutput}.json`, `${JSON.stringify(latency)}\n`, "utf8");
    await assert.rejects(verifyReport(latencyOutput), /Launch latency arithmetic is inconsistent/);

    const resourceOutput = join(directory, "resource-evidence");
    const resource = await runRealLoad({
      execute: false, workspaceIds: Array.from({ length: 30 }, (_, index) => `workspace-${index}`),
      agent: "fake", prompt: "safe test", output: resourceOutput, launchTimeoutMs: 10,
      maxRssBytes: 1_000, maxCpuMs: 10_000, maxDescriptors: 100,
      measurements: measurements([{ ...SAFE_RESOURCE, rssBytes: 1_001 }]),
    });
    await writeFile(`${resourceOutput}.json`, `${JSON.stringify(resource)}\n`, "utf8");
    await assert.rejects(verifyReport(resourceOutput), /Resource ceiling violation was not aborted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

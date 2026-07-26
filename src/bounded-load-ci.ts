import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runFakeBenchmark } from "./fake-backend-benchmark.js";
import type { PerformanceMeasurements, ResourceSample } from "./performance-report.js";
import { runRealLoad } from "./real-agent-load-runner.js";
import { verifyReport } from "./report-verifier.js";

const WORKSPACES = Array.from({ length: 30 }, (_, index) => `offline-workspace-${index + 1}`);
const SAFE_RESOURCE: ResourceSample = {
  elapsedMs: 10,
  cpuUserMs: 4,
  cpuSystemMs: 1,
  rssBytes: 64 * 1024 * 1024,
  descriptors: 32,
};

function deterministicMeasurements(resources: readonly ResourceSample[] = [SAFE_RESOURCE]): PerformanceMeasurements {
  let resourceIndex = 0;
  const durations: Record<string, number> = { launch: 5, lifecycle: 250, queries: 6, recovery: 8 };
  return {
    async durationMs<T>(label: string, operation: () => Promise<T>) {
      return { value: await operation(), durationMs: durations[label] ?? 1 };
    },
    async resources() {
      const sample = resources[Math.min(resourceIndex, resources.length - 1)]!;
      resourceIndex += 1;
      return { ...sample };
    },
  };
}

function deterministicQueryClock(): () => number {
  let now = 0;
  return () => {
    const current = now;
    now += 1;
    return current;
  };
}

export async function runBoundedLoadCi(outputDirectory: string): Promise<void> {
  const base = resolve(outputDirectory);
  const fake = `${base}/fake-backend`;
  const admitted = `${base}/admitted-load`;
  const overloaded = `${base}/overloaded-load`;

  await runFakeBenchmark({
    sessions: 100,
    output: fake,
    measurements: deterministicMeasurements(),
    queryNow: deterministicQueryClock(),
  });
  await runRealLoad({
    execute: true,
    workspaceIds: WORKSPACES,
    agent: "offline-fake",
    prompt: "offline deterministic CI",
    output: admitted,
    launchTimeoutMs: 100,
    maxRssBytes: 128 * 1024 * 1024,
    maxCpuMs: 100,
    maxDescriptors: 64,
    maxInFlight: 4,
    measurements: deterministicMeasurements(),
    launch: async (workspaceId) => ({ sessionId: `session-${workspaceId}`, kind: "terminal" }),
  });
  await runRealLoad({
    execute: true,
    workspaceIds: WORKSPACES,
    agent: "offline-fake",
    prompt: "offline deterministic CI overload",
    output: overloaded,
    launchTimeoutMs: 100,
    maxRssBytes: 128 * 1024 * 1024,
    maxCpuMs: 100,
    maxDescriptors: 64,
    maxInFlight: 5,
    measurements: deterministicMeasurements([
      SAFE_RESOURCE,
      SAFE_RESOURCE,
      { ...SAFE_RESOURCE, elapsedMs: 20, rssBytes: 129 * 1024 * 1024 },
    ]),
    launch: async (workspaceId) => ({ sessionId: `session-${workspaceId}`, kind: "terminal" }),
  });

  for (const report of [fake, admitted, overloaded]) await verifyReport(report);
  process.stdout.write(`${JSON.stringify({ reports: [fake, admitted, overloaded], paidAgents: 0 })}\n`);
}

async function main(): Promise<void> {
  if (process.argv.length > 3) throw new Error("Usage: bounded-load-ci [output-directory]");
  await runBoundedLoadCi(process.argv[2] ?? "artifacts/per-351-ci");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

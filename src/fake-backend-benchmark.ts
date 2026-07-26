import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FakeAgentAdapter, type FakeRunScript } from "./fake-agent-adapter.js";
import { LaunchCoordinator, type AttributedLaunchRequest } from "./launch-coordinator.js";
import { descriptorCount, numericArgument, parseArguments, percentile, realMeasurements, rejectUnknownArguments, writeReports, type PerformanceMeasurements } from "./performance-report.js";
import type { WorkspaceAuthorizer } from "./security.js";
import { DurableStore, type QueryMeasurement } from "./store.js";

export const FAKE_BENCHMARK_SCHEMA = "per-351.fake-backend.v1";
const RESPONSIVENESS_CEILING_MS = 1_000;

export async function runFakeBenchmark(options: {
  sessions: number;
  output: string;
  measurements?: PerformanceMeasurements;
  queryNow?: () => number;
}): Promise<Record<string, unknown>> {
  if (!Number.isInteger(options.sessions) || options.sessions !== 100) {
    throw new Error("The production benchmark requires exactly 100 sessions");
  }
  const directory = await mkdtemp(join(tmpdir(), "per-351-fake-"));
  const statePath = join(directory, "state.json");
  const queries: QueryMeasurement[] = [];
  const store = new DurableStore(statePath, undefined, (measurement) => queries.push(measurement), options.queryNow);
  const scripts: FakeRunScript[] = Array.from({ length: options.sessions }, (_, index) => ({
    statuses: ["queued", "running", "succeeded"], result: { status: "succeeded", output: `result-${index}` },
  }));
  const adapter = new FakeAgentAdapter(scripts);
  const workspaceAuthorizer: WorkspaceAuthorizer = {
    authorize: async (workspaceId) => ({
      workspaceId,
      projectId: "per-351-benchmark",
      canonicalPath: join(directory, workspaceId),
      revalidate: async () => undefined,
    }),
  };
  const coordinator = new LaunchCoordinator(store, adapter, workspaceAuthorizer);
  const launchLatencies: number[] = [];
  const failures: string[] = [];
  const measurements = options.measurements ?? realMeasurements();
  const initialDescriptors = await descriptorCount();
  let mismatches = 0;
  let completed = 0;
  let attributedResults = 0;

  try {
    const created = await store.createBatch(
      "per-351-indexed-query",
      "per-351-benchmark",
      Array.from({ length: options.sessions }, (_, index) => ({ agent: `fake-${index}`, task: `task-${index}` })),
      "per-351-indexed-query",
    );
    const requests: AttributedLaunchRequest[] = created.sessions.map((worker, index) => ({
      idempotencyKey: `per-351-${index}`,
      sessionId: worker.sessionId,
      batchId: worker.batchId,
      workerId: worker.id,
      attribution: worker.attribution,
      prompt: `Deterministic benchmark task ${index}`,
      workspaceId: `workspace-${index}`,
    }));
    for (const request of requests) {
      try {
        const measured = await measurements.durationMs("launch", () => coordinator.launch(request));
        const intent = measured.value;
        launchLatencies.push(measured.durationMs);
        if (intent.sessionId !== request.sessionId || intent.batchId !== request.batchId
          || intent.workerId !== request.workerId || intent.attribution.agent !== request.attribution.agent
          || intent.attribution.task !== request.attribution.task) mismatches += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    const lifecycle = await measurements.durationMs("lifecycle", async () => {
      for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index]!;
      const handle = await adapter.findByIdempotencyKey(request.idempotencyKey);
      if (handle === undefined) { failures.push(`Missing run for ${request.idempotencyKey}`); continue; }
      let state = await adapter.status(handle);
      while (state.status === "queued" || state.status === "running") state = await adapter.status(handle);
      const result = await adapter.result(handle);
      if (state.status !== "succeeded" || result?.status !== "succeeded") {
        failures.push(`Run ${handle.runId} did not return a successful result`); continue;
      }
      await store.recordWorkerResult(request.workerId, "succeeded", result);
      completed += 1;
      if (result.output === `result-${index}` && request.attribution.agent === `fake-${index}`
        && request.attribution.task === `task-${index}`) attributedResults += 1;
      else mismatches += 1;
      }
    });
    const lifecycleMs = lifecycle.durationMs;

    const measuredQueries = await measurements.durationMs("queries", async () => {
      const page = await store.getBatch(created.batch.id, { ids: created.sessions.map(({ id }) => id) });
      await store.batchStatus(created.batch.id, { limit: options.sessions });
      const batchResults = await store.batchResults(created.batch.id, { limit: options.sessions });
      return { page, batchResults };
    });
    const { page, batchResults } = measuredQueries.value;
    const queryWallMs = measuredQueries.durationMs;
    page.sessions.forEach((worker, index) => {
      const expected = created.sessions[index];
      if (expected === undefined || worker.id !== expected.id || worker.attribution.agent !== expected.attribution.agent
        || worker.attribution.task !== expected.attribution.task) mismatches += 1;
    });
    for (const [index, item] of batchResults.results.entries()) {
      const result = item.result as { output?: string };
      if (item.sessionId !== created.sessions[index]?.id || item.batchId !== created.batch.id
        || item.attribution.agent !== `fake-${index}` || item.attribution.task !== `task-${index}`
        || result.output !== `result-${index}`) mismatches += 1;
    }
    if (batchResults.results.length !== options.sessions) {
      mismatches += Math.abs(options.sessions - batchResults.results.length);
    }

    const restartedStore = new DurableStore(statePath);
    const recovery = await measurements.durationMs("recovery", async () => ({
      reconciliation: await restartedStore.reconcile(),
      recovered: await restartedStore.getBatch(created.batch.id, { limit: options.sessions }),
      recoveredResults: await restartedStore.batchResults(created.batch.id, { limit: options.sessions }),
    }));
    const { reconciliation, recovered, recoveredResults } = recovery.value;
    const recoveryMs = recovery.durationMs;
    if (recovered.sessions.length !== options.sessions) mismatches += Math.abs(options.sessions - recovered.sessions.length);
    const resources = await measurements.resources();
    const launchP95Ms = percentile(launchLatencies, 0.95);
    const queryP95Ms = percentile(queries.map(({ durationMs }) => durationMs), 0.95);
    const maxExamined = Math.max(0, ...queries.map(({ examined }) => examined));
    const responsivenessPassed = launchLatencies.length === options.sessions
      && queries.length === 3
      && launchP95Ms <= RESPONSIVENESS_CEILING_MS
      && queryP95Ms <= RESPONSIVENESS_CEILING_MS
      && maxExamined <= options.sessions;
    const validationPassed = failures.length === 0
      && mismatches === 0
      && adapter.launches.length === options.sessions
      && completed === options.sessions
      && attributedResults === options.sessions
      && recovered.sessions.length === options.sessions
      && recoveredResults.results.length === options.sessions
      && responsivenessPassed;
    const report: Record<string, unknown> = {
      schema: FAKE_BENCHMARK_SCHEMA,
      generatedAt: new Date().toISOString(),
      configuration: { sessions: options.sessions, backend: "FakeAgentAdapter", persistence: "DurableStore" },
      launch: {
        attempted: options.sessions, accepted: adapter.launches.length, failures: failures.length,
        latencyMs: { min: Math.min(...launchLatencies), p50: percentile(launchLatencies, 0.5), p95: launchP95Ms, max: Math.max(...launchLatencies) },
      },
      lifecycle: { completed, attributedResults, durationMs: lifecycleMs },
      throughput: { sessionsPerSecond: completed / (lifecycleMs / 1_000), durationMs: lifecycleMs },
      indexedQueries: {
        count: queries.length, examined: queries.reduce((sum, query) => sum + query.examined, 0), maxExamined,
        returned: queries.reduce((sum, query) => sum + query.returned, 0), wallMs: queryWallMs,
        latencyMs: { p50: percentile(queries.map(({ durationMs }) => durationMs), 0.5), p95: queryP95Ms },
      },
      responsiveness: {
        ceilingMs: RESPONSIVENESS_CEILING_MS,
        launchP95Ms,
        queryP95Ms,
        passed: responsivenessPassed,
      },
      resources: { ...resources, initialDescriptors, descriptorDelta: resources.descriptors === null || initialDescriptors === null ? null : resources.descriptors - initialDescriptors },
      correctness: { failures, exactAttributionMismatches: mismatches, everyResponseAttributed: attributedResults === options.sessions },
      validation: { passed: validationPassed },
      restartRecovery: { durationMs: recoveryMs, ...reconciliation, recoveredSessions: recovered.sessions.length,
        recoveredResults: recoveredResults.results.length,
        passed: recovered.sessions.length === options.sessions && recoveredResults.results.length === options.sessions },
      limitations: ["Fake timings characterize local orchestration and persistence, not paid-agent execution or Superset network latency."],
    };
    await writeReports(options.output, report, fakeMarkdown(report));
    if (!validationPassed) throw new Error(`Fake benchmark validation failed; inspect ${options.output}.json`);
    return report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeMarkdown(report: Record<string, unknown>): string {
  const schema = String(report.schema);
  const launch = report.launch as { accepted: number; failures: number };
  const correctness = report.correctness as { exactAttributionMismatches: number };
  const restart = report.restartRecovery as { recoveredSessions: number; passed: boolean };
  const resources = report.resources as { cpuUserMs: number; cpuSystemMs: number; rssBytes: number; descriptorDelta: number | null };
  const lifecycle = report.lifecycle as { completed: number; attributedResults: number };
  return `# PER-351 Fake Backend Benchmark\n\n- Schema: \`${schema}\`\n- Sessions: 100\n- Accepted: ${launch.accepted}\n- Completed: ${lifecycle.completed}\n- Attributed results: ${lifecycle.attributedResults}\n- Failures: ${launch.failures}\n- Exact attribution mismatches: ${correctness.exactAttributionMismatches}\n- Restart recovered sessions: ${restart.recoveredSessions}\n- Restart passed: ${restart.passed}\n- CPU user/system ms: ${resources.cpuUserMs}/${resources.cpuSystemMs}\n- Observed RSS bytes: ${resources.rssBytes}\n- Descriptor delta: ${resources.descriptorDelta ?? "unsupported"}\n\nThe JSON companion contains launch percentiles, full-lifecycle duration, and indexed-query examined, returned, and latency measurements.\n`;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  rejectUnknownArguments(args, ["--sessions", "--output"]);
  const sessions = numericArgument(args, "--sessions", 100);
  const output = String(args.get("--output") ?? "evidence/per-351/fake-backend-100");
  const report = await runFakeBenchmark({ sessions, output: resolve(output) });
  process.stdout.write(`${JSON.stringify({ report: resolve(output), schema: report.schema })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { FAKE_BENCHMARK_SCHEMA } from "./fake-backend-benchmark.js";
import { REAL_LOAD_SCHEMA } from "./real-agent-load-runner.js";

const fakeSchema = z.object({
  schema: z.literal(FAKE_BENCHMARK_SCHEMA), configuration: z.object({ sessions: z.literal(100) }),
  launch: z.object({ attempted: z.literal(100), accepted: z.literal(100), failures: z.literal(0) }),
  lifecycle: z.object({ completed: z.literal(100), attributedResults: z.literal(100), durationMs: z.number().positive() }),
  throughput: z.object({ sessionsPerSecond: z.number().positive(), durationMs: z.number().positive() }),
  indexedQueries: z.object({ count: z.number().int().positive(), examined: z.number().int().positive(), maxExamined: z.number().int().max(100), latencyMs: z.object({ p95: z.number().nonnegative() }) }),
  responsiveness: z.object({ ceilingMs: z.number().positive(), launchP95Ms: z.number().nonnegative(), queryP95Ms: z.number().nonnegative(), passed: z.literal(true) }),
  resources: z.object({ cpuUserMs: z.number().nonnegative(), cpuSystemMs: z.number().nonnegative(), rssBytes: z.number().positive(), descriptors: z.number().int().nonnegative().nullable() }),
  correctness: z.object({ exactAttributionMismatches: z.literal(0), everyResponseAttributed: z.literal(true) }), restartRecovery: z.object({ recoveredSessions: z.literal(100), recoveredResults: z.literal(100), passed: z.literal(true) }),
  validation: z.object({ passed: z.literal(true) }),
}).superRefine((report, context) => {
  if (report.responsiveness.ceilingMs !== 1_000
    || report.responsiveness.launchP95Ms > 1_000
    || report.responsiveness.queryP95Ms > 1_000) {
    context.addIssue({ code: "custom", message: "Responsiveness measurements must satisfy the fixed 1000ms ceiling" });
  }
  const expectedThroughput = report.lifecycle.completed / (report.lifecycle.durationMs / 1_000);
  if (report.throughput.durationMs !== report.lifecycle.durationMs
    || Math.abs(report.throughput.sessionsPerSecond - expectedThroughput) > Number.EPSILON * expectedThroughput) {
    context.addIssue({ code: "custom", message: "Throughput arithmetic is inconsistent" });
  }
});
const resourceSampleSchema = z.object({
  elapsedMs: z.number().nonnegative(), cpuUserMs: z.number().nonnegative(), cpuSystemMs: z.number().nonnegative(),
  rssBytes: z.number().positive(), descriptors: z.number().int().nonnegative().nullable(),
});
const acceptedSessionSchema = z.object({
  workspaceId: z.string().min(1), task: z.string().min(1), stage: z.number().int().min(1).max(3),
  sessionId: z.string().min(1), kind: z.enum(["terminal", "chat"]), latencyMs: z.number().nonnegative(),
});
const realSchema = z.object({
  schema: z.literal(REAL_LOAD_SCHEMA), mode: z.enum(["dry-run", "execute"]),
  configuration: z.object({ sessions: z.literal(30), stages: z.tuple([z.literal(5), z.literal(10), z.literal(15)]), uniqueWorkspaces: z.literal(true),
    maxInFlight: z.number().int().min(1).max(30),
    ceilings: z.object({ maxRssBytes: z.number().positive(), maxCpuMs: z.number().positive(), maxDescriptors: z.number().positive() }) }),
  admission: z.object({
    planned: z.literal(30), offered: z.number().int().min(0).max(30), admitted: z.number().int().min(0).max(30),
    failed: z.number().int().min(0).max(30), withheld: z.number().int().min(0).max(30),
    maxObservedInFlight: z.number().int().min(0).max(30),
    stages: z.array(z.object({ stage: z.number().int().min(1).max(3), planned: z.number().int().positive(), offered: z.number().int().nonnegative(),
      admitted: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), withheld: z.number().int().nonnegative() })).length(3),
  }),
  launch: z.object({ attempted: z.number().int().min(0).max(30), accepted: z.number().int().min(0).max(30), failures: z.array(z.unknown()),
    acceptedSessions: z.array(acceptedSessionSchema).max(30),
    latencyMs: z.object({ p50: z.number().nonnegative(), p95: z.number().nonnegative(), max: z.number().nonnegative() }) }),
  resources: z.object({ samples: z.array(resourceSampleSchema).min(1).max(60) }),
  abort: z.object({ aborted: z.boolean(), reason: z.string().min(1).nullable() }),
  validation: z.object({ passed: z.boolean(), blocked: z.boolean(), reason: z.string().min(1).nullable() }),
  capabilities: z.object({ completion: z.literal("unavailable"), results: z.literal("unavailable"), cancellation: z.literal("unavailable"),
    recovery: z.literal("unavailable through supported Superset APIs") }),
}).superRefine((report, context) => {
  const accepted = report.launch.acceptedSessions;
  const uniqueWorkspaces = new Set(accepted.map(({ workspaceId }) => workspaceId)).size === accepted.length;
  const uniqueTasks = new Set(accepted.map(({ task }) => task)).size === accepted.length;
  const uniqueSessions = new Set(accepted.map(({ sessionId }) => sessionId)).size === accepted.length;
  const countsConsistent = report.launch.attempted === report.launch.accepted + report.launch.failures.length
    && report.launch.accepted === accepted.length;
  const stagePlanned = report.admission.stages.reduce((sum, stage) => sum + stage.planned, 0);
  const stageOffered = report.admission.stages.reduce((sum, stage) => sum + stage.offered, 0);
  const stageAdmitted = report.admission.stages.reduce((sum, stage) => sum + stage.admitted, 0);
  const stageFailed = report.admission.stages.reduce((sum, stage) => sum + stage.failed, 0);
  const stageWithheld = report.admission.stages.reduce((sum, stage) => sum + stage.withheld, 0);
  const admissionConsistent = report.admission.planned === report.admission.offered + report.admission.withheld
    && report.admission.offered === report.admission.admitted + report.admission.failed
    && report.admission.offered === report.launch.attempted
    && report.admission.admitted === report.launch.accepted
    && report.admission.failed === report.launch.failures.length
    && stagePlanned === report.admission.planned && stageOffered === report.admission.offered
    && stageAdmitted === report.admission.admitted && stageFailed === report.admission.failed
    && stageWithheld === report.admission.withheld
    && report.admission.maxObservedInFlight <= report.configuration.maxInFlight;
  if (!uniqueWorkspaces || !uniqueTasks || !uniqueSessions) context.addIssue({ code: "custom", message: "Accepted sessions require unique workspace, task, and session attribution" });
  if (!countsConsistent) context.addIssue({ code: "custom", message: "Launch counts are inconsistent" });
  if (!admissionConsistent) context.addIssue({ code: "custom", message: "Admission and backpressure arithmetic is inconsistent" });
  if (report.abort.aborted !== (report.abort.reason !== null)) context.addIssue({ code: "custom", message: "Abort reason is inconsistent" });
  if (report.mode === "dry-run") {
    if (report.launch.attempted !== 0 || report.launch.accepted !== 0 || report.launch.failures.length !== 0
      || report.validation.passed !== true || report.validation.blocked !== true || report.validation.reason === null) {
      context.addIssue({ code: "custom", message: "Dry-run must launch nothing and declare its external execution blocker" });
    }
  } else if (!report.abort.aborted) {
    if (report.launch.attempted !== 30 || report.launch.accepted !== 30 || report.launch.failures.length !== 0
      || !report.validation.passed || report.validation.blocked || report.validation.reason !== null || report.admission.withheld !== 0
      || accepted.filter(({ stage }) => stage === 1).length !== 5
      || accepted.filter(({ stage }) => stage === 2).length !== 10
      || accepted.filter(({ stage }) => stage === 3).length !== 15) {
      context.addIssue({ code: "custom", message: "Completed load evidence must prove all 30 staged acceptances" });
    }
  } else if (report.validation.passed || report.validation.blocked || report.validation.reason !== null
    || report.admission.withheld === 0 || report.launch.attempted >= 30) {
    context.addIssue({ code: "custom", message: "Overload evidence must fail validation and withhold unoffered work" });
  }
});

export async function verifyReport(basePath: string): Promise<string> {
  const jsonPath = `${basePath}.json`;
  const markdownPath = `${basePath}.md`;
  const report: unknown = JSON.parse(await readFile(jsonPath, "utf8"));
  const schema = typeof report === "object" && report !== null && "schema" in report ? report.schema : undefined;
  if (schema === FAKE_BENCHMARK_SCHEMA) fakeSchema.parse(report);
  else if (schema === REAL_LOAD_SCHEMA) realSchema.parse(report);
  else throw new Error(`Unsupported report schema: ${String(schema)}`);
  await access(markdownPath);
  const markdown = await readFile(markdownPath, "utf8");
  if (!markdown.includes(String(schema))) throw new Error("Markdown companion does not identify the JSON schema");
  return String(schema);
}

async function main(): Promise<void> {
  const bases = process.argv.slice(2);
  if (bases.length === 0) throw new Error("Pass one or more report base paths without extensions");
  for (const base of bases) process.stdout.write(`${resolve(base)}: ${await verifyReport(resolve(base))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { numericArgument, parseArguments, percentile, rejectUnknownArguments, sampleResources, writeReports } from "./performance-report.js";

const executeFile = promisify(execFile);
export const REAL_LOAD_SCHEMA = "per-351.real-agent-load.v1";
const SESSION_COUNT = 30;

type LocalWorkspace = { id: string };

export async function runRealLoad(options: {
  execute: boolean; workspaceIds: string[]; agent: string; prompt: string; output: string;
  launchTimeoutMs: number; maxRssBytes: number; maxCpuMs: number; maxDescriptors: number;
  launch?: (workspaceId: string) => Promise<{ sessionId: string; kind: string }>;
  listLocalWorkspaces?: () => Promise<LocalWorkspace[]>;
}): Promise<Record<string, unknown>> {
  if (options.workspaceIds.length !== SESSION_COUNT || new Set(options.workspaceIds).size !== SESSION_COUNT) {
    throw new Error("Exactly 30 unique workspace IDs are required; shared writers are forbidden");
  }
  const stages = [5, 10, 15];
  const started = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const accepted: Array<{ workspaceId: string; task: string; stage: number; sessionId: string; kind: string; latencyMs: number }> = [];
  const failures: Array<{ workspaceId: string; error: string }> = [];
  const samples = [];
  let aborted: string | null = null;
  const launch = options.launch ?? ((workspaceId: string) => launchSuperset(workspaceId, options));

  if (options.execute) {
    if (options.launch === undefined) {
      const listLocalWorkspaces = options.listLocalWorkspaces ?? listSupersetLocalWorkspaces;
      const localIds = new Set((await listLocalWorkspaces()).map(({ id }) => id));
      const unresolved = options.workspaceIds.filter((workspaceId) => !localIds.has(workspaceId));
      if (unresolved.length > 0) {
        throw new Error(`Workspace IDs are not present in the local workspace snapshot: ${unresolved.join(", ")}`);
      }
    }
    let offset = 0;
    for (let stage = 0; stage < stages.length; stage += 1) {
      const stageSize = stages[stage]!;
      const stageIds = options.workspaceIds.slice(offset, offset + stageSize);
      const before = await sampleResources(started, cpuStart);
      aborted = ceilingViolation(before, options);
      if (aborted !== null) { samples.push(before); break; }
      const outcomes = await Promise.allSettled(stageIds.map(async (workspaceId, stageIndex) => {
        const launchStarted = process.hrtime.bigint();
        const result = await launch(workspaceId);
        return { ...result, workspaceId, task: `load-task-${offset + stageIndex + 1}`, stage: stage + 1,
          latencyMs: Number(process.hrtime.bigint() - launchStarted) / 1e6 };
      }));
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") accepted.push(outcome.value);
        else failures.push({ workspaceId: stageIds[index]!, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
      });
      if (failures.length > 0) aborted = "launch failure";
      const after = await sampleResources(started, cpuStart);
      samples.push(after);
      aborted ??= ceilingViolation(after, options);
      if (aborted !== null) break;
      offset += stageSize;
    }
  } else samples.push(await sampleResources(started, cpuStart));

  const report: Record<string, unknown> = {
    schema: REAL_LOAD_SCHEMA,
    generatedAt: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry-run",
    configuration: { sessions: SESSION_COUNT, stages, uniqueWorkspaces: true, agent: options.agent, launchTimeoutMs: options.launchTimeoutMs,
      ceilings: { maxRssBytes: options.maxRssBytes, maxCpuMs: options.maxCpuMs, maxDescriptors: options.maxDescriptors } },
    launch: { attempted: options.execute ? accepted.length + failures.length : 0, accepted: accepted.length, failures, acceptedSessions: accepted,
      latencyMs: { p50: percentile(accepted.map(({ latencyMs }) => latencyMs), 0.5), p95: percentile(accepted.map(({ latencyMs }) => latencyMs), 0.95), max: Math.max(0, ...accepted.map(({ latencyMs }) => latencyMs)) } },
    resources: { samples },
    abort: { aborted: aborted !== null, reason: aborted },
    validation: {
      passed: options.execute ? accepted.length === SESSION_COUNT && failures.length === 0 && aborted === null : true,
      blocked: !options.execute,
      reason: options.execute ? null : "Paid execution requires 30 explicitly authorized isolated workspaces and operator opt-in.",
    },
    capabilities: { launchAcceptance: "measured when explicitly executed", completion: "unavailable", results: "unavailable", cancellation: "unavailable", recovery: "unavailable through supported Superset APIs" },
    limitations: [
      "Supported Superset APIs cannot retrieve ordinary agent completion, exact results, stop reasons, or cancellation.",
      "An abort stops new launches only; already accepted paid sessions cannot be cancelled through a supported API.",
      "CPU, RSS, and descriptor samples cover this harness process; Superset does not expose supported per-session or aggregate host resource telemetry.",
    ],
  };
  await writeReports(options.output, report, realMarkdown(report));
  return report;
}

async function listSupersetLocalWorkspaces(): Promise<LocalWorkspace[]> {
  const { stdout } = await executeFile("superset", ["workspaces", "list", "--local", "--json"], {
    timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: "1" },
  });
  const value: unknown = JSON.parse(stdout);
  const workspaces: unknown[] | null = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "workspaces" in value && Array.isArray(value.workspaces)
      ? value.workspaces
      : null;
  if (workspaces === null || workspaces.some((workspace) => typeof workspace !== "object" || workspace === null
    || !("id" in workspace) || typeof workspace.id !== "string" || workspace.id.length === 0)) {
    throw new Error("Superset local workspace discovery returned an invalid response");
  }
  return workspaces.map((workspace) => ({ id: (workspace as { id: string }).id }));
}

function ceilingViolation(sample: Awaited<ReturnType<typeof sampleResources>>, options: { maxRssBytes: number; maxCpuMs: number; maxDescriptors: number }): string | null {
  if (sample.rssBytes > options.maxRssBytes) return `RSS ceiling exceeded: ${sample.rssBytes}`;
  if (sample.cpuUserMs + sample.cpuSystemMs > options.maxCpuMs) return `CPU ceiling exceeded: ${sample.cpuUserMs + sample.cpuSystemMs}`;
  if (sample.descriptors !== null && sample.descriptors > options.maxDescriptors) return `descriptor ceiling exceeded: ${sample.descriptors}`;
  return null;
}

async function launchSuperset(workspaceId: string, options: { agent: string; prompt: string; launchTimeoutMs: number }): Promise<{ sessionId: string; kind: string }> {
  const { stdout } = await executeFile("superset", ["agents", "create", "--workspace", workspaceId, "--agent", options.agent, "--prompt", options.prompt, "--json"], {
    timeout: options.launchTimeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, CI: "1" },
  });
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "object" || value === null || !("sessionId" in value) || !("kind" in value)
    || typeof value.sessionId !== "string" || (value.kind !== "terminal" && value.kind !== "chat")) {
    throw new Error("Superset launch returned invalid acceptance metadata");
  }
  return { sessionId: value.sessionId, kind: value.kind };
}

function realMarkdown(report: Record<string, unknown>): string {
  const schema = String(report.schema);
  const mode = String(report.mode);
  const launch = report.launch as { accepted: number };
  const abort = report.abort as { aborted: boolean; reason: string | null };
  return `# PER-351 Real Agent Load\n\n- Schema: \`${schema}\`\n- Mode: ${mode}\n- Planned sessions: 30\n- Ramp: 5, 10, 15\n- Accepted launches: ${launch.accepted}\n- Aborted: ${abort.aborted}\n- Abort reason: ${abort.reason ?? "none"}\n\nEach assignment uses a unique workspace. Supported Superset APIs expose launch acceptance but cannot retrieve completion or exact results. Dry-run is the default and starts no paid agents.\n`;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  rejectUnknownArguments(args, [
    "--execute-paid-agents", "--workspace-file", "--agent", "--prompt", "--output",
    "--launch-timeout-ms", "--max-rss-bytes", "--max-cpu-ms", "--max-descriptors",
  ]);
  const execute = args.has("--execute-paid-agents");
  if (args.get("--execute-paid-agents") !== undefined && args.get("--execute-paid-agents") !== true) {
    throw new Error("--execute-paid-agents does not accept a value");
  }
  const workspaceFile = args.get("--workspace-file");
  if (execute && typeof workspaceFile !== "string") throw new Error("--execute-paid-agents requires --workspace-file");
  const workspaceIds = typeof workspaceFile === "string"
    ? (await readFile(resolve(workspaceFile), "utf8")).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    : Array.from({ length: SESSION_COUNT }, (_, index) => `dry-run-workspace-${index + 1}`);
  const output = resolve(String(args.get("--output") ?? "evidence/per-351/real-agent-load-30"));
  const report = await runRealLoad({
    execute, workspaceIds, output,
    agent: String(args.get("--agent") ?? "codex"),
    prompt: String(args.get("--prompt") ?? "PER-351 controlled load probe. Make no changes and exit."),
    launchTimeoutMs: numericArgument(args, "--launch-timeout-ms", 30_000),
    maxRssBytes: numericArgument(args, "--max-rss-bytes", 2 * 1024 * 1024 * 1024),
    maxCpuMs: numericArgument(args, "--max-cpu-ms", 300_000),
    maxDescriptors: numericArgument(args, "--max-descriptors", 4_096),
  });
  process.stdout.write(`${JSON.stringify({ report: output, schema: report.schema, mode: report.mode })}\n`);
  if (!(report.validation as { passed: boolean }).passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

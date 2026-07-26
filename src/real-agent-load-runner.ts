import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { numericArgument, parseArguments, percentile, realMeasurements, rejectUnknownArguments, writeReports, type PerformanceMeasurements, type ResourceSample } from "./performance-report.js";

const executeFile = promisify(execFile);
export const REAL_LOAD_SCHEMA = "per-351.real-agent-load.v1";
const SESSION_COUNT = 30;

type LocalWorkspace = { id: string };

export async function runRealLoad(options: {
  execute: boolean; workspaceIds: string[]; agent: string; prompt: string; output: string;
  launchTimeoutMs: number; maxRssBytes: number; maxCpuMs: number; maxDescriptors: number; maxInFlight?: number;
  launch?: (workspaceId: string) => Promise<{ sessionId: string; kind: string }>;
  listLocalWorkspaces?: () => Promise<LocalWorkspace[]>;
  measurements?: PerformanceMeasurements;
}): Promise<Record<string, unknown>> {
  if (options.workspaceIds.length !== SESSION_COUNT || new Set(options.workspaceIds).size !== SESSION_COUNT) {
    throw new Error("Exactly 30 unique workspace IDs are required; shared writers are forbidden");
  }
  const stages = [5, 10, 15];
  const maxInFlight = options.maxInFlight ?? 15;
  if (!Number.isInteger(maxInFlight) || maxInFlight <= 0 || maxInFlight > SESSION_COUNT) {
    throw new Error("maxInFlight must be an integer from 1 to 30");
  }
  const measurements = options.measurements ?? realMeasurements();
  const accepted: Array<{ workspaceId: string; task: string; stage: number; sessionId: string; kind: string; latencyMs: number }> = [];
  const failures: Array<{ workspaceId: string; error: string }> = [];
  const samples: ResourceSample[] = [];
  const stageEvidence: Array<{ stage: number; planned: number; offered: number; admitted: number; failed: number; withheld: number }> = [];
  let aborted: string | null = null;
  let active = 0;
  let maxObservedInFlight = 0;
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
      let offered = 0;
      let admitted = 0;
      let failed = 0;
      while (offered < stageSize && aborted === null) {
        const before = await measurements.resources();
        samples.push(before);
        aborted = ceilingViolation(before, options);
        if (aborted !== null) break;
        const chunk = stageIds.slice(offered, offered + maxInFlight);
        const chunkOffset = offered;
        offered += chunk.length;
        const outcomes = await Promise.allSettled(chunk.map(async (workspaceId, chunkIndex) => {
          active += 1;
          maxObservedInFlight = Math.max(maxObservedInFlight, active);
          try {
            const measured = await measurements.durationMs("launch", () => withTimeout(launch(workspaceId), options.launchTimeoutMs));
            return { ...measured.value, workspaceId, task: `load-task-${offset + chunkOffset + chunkIndex + 1}`,
              stage: stage + 1, latencyMs: measured.durationMs };
          } finally {
            active -= 1;
          }
        }));
        outcomes.forEach((outcome, index) => {
          if (outcome.status === "fulfilled") { accepted.push(outcome.value); admitted += 1; }
          else {
            failed += 1;
            failures.push({ workspaceId: chunk[index]!, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
          }
        });
        if (failed > 0) aborted = "launch failure";
        const after = await measurements.resources();
        samples.push(after);
        aborted ??= ceilingViolation(after, options);
      }
      stageEvidence.push({ stage: stage + 1, planned: stageSize, offered, admitted, failed, withheld: stageSize - offered });
      if (aborted !== null) {
        for (let remaining = stage + 1; remaining < stages.length; remaining += 1) {
          stageEvidence.push({ stage: remaining + 1, planned: stages[remaining]!, offered: 0, admitted: 0, failed: 0, withheld: stages[remaining]! });
        }
        break;
      }
      offset += stageSize;
    }
  } else {
    samples.push(await measurements.resources());
    stages.forEach((planned, index) => stageEvidence.push({ stage: index + 1, planned, offered: 0, admitted: 0, failed: 0, withheld: planned }));
  }

  const offered = stageEvidence.reduce((sum, stage) => sum + stage.offered, 0);
  const withheld = stageEvidence.reduce((sum, stage) => sum + stage.withheld, 0);

  const report: Record<string, unknown> = {
    schema: REAL_LOAD_SCHEMA,
    generatedAt: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry-run",
    configuration: { sessions: SESSION_COUNT, stages, uniqueWorkspaces: true, agent: options.agent, launchTimeoutMs: options.launchTimeoutMs, maxInFlight,
      ceilings: { maxRssBytes: options.maxRssBytes, maxCpuMs: options.maxCpuMs, maxDescriptors: options.maxDescriptors } },
    admission: { planned: SESSION_COUNT, offered, admitted: accepted.length, failed: failures.length, withheld, maxObservedInFlight, stages: stageEvidence },
    launch: { attempted: offered, accepted: accepted.length, failures, acceptedSessions: accepted,
      latencyMs: { p50: percentile(accepted.map(({ latencyMs }) => latencyMs), 0.5), p95: percentile(accepted.map(({ latencyMs }) => latencyMs), 0.95), max: Math.max(0, ...accepted.map(({ latencyMs }) => latencyMs)) } },
    resources: { samples },
    abort: { aborted: aborted !== null, reason: aborted },
    validation: {
      passed: options.execute ? accepted.length === SESSION_COUNT && failures.length === 0 && aborted === null && withheld === 0 : true,
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

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Launch timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function ceilingViolation(sample: ResourceSample, options: { maxRssBytes: number; maxCpuMs: number; maxDescriptors: number }): string | null {
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
  const admission = report.admission as { offered: number; admitted: number; failed: number; withheld: number; maxObservedInFlight: number };
  return `# PER-351 Real Agent Load\n\n- Schema: \`${schema}\`\n- Mode: ${mode}\n- Planned sessions: 30\n- Ramp: 5, 10, 15\n- Offered/admitted/failed/withheld: ${admission.offered}/${admission.admitted}/${admission.failed}/${admission.withheld}\n- Maximum observed in flight: ${admission.maxObservedInFlight}\n- Accepted launches: ${launch.accepted}\n- Aborted: ${abort.aborted}\n- Abort reason: ${abort.reason ?? "none"}\n\nThe JSON companion contains per-stage admission and resource evidence. Each assignment uses a unique workspace. Supported Superset APIs expose launch acceptance but cannot retrieve completion or exact results. Dry-run is the default and starts no paid agents.\n`;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  rejectUnknownArguments(args, [
    "--execute-paid-agents", "--workspace-file", "--agent", "--prompt", "--output",
    "--launch-timeout-ms", "--max-rss-bytes", "--max-cpu-ms", "--max-descriptors",
    "--max-in-flight",
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
    maxInFlight: numericArgument(args, "--max-in-flight", 15),
  });
  process.stdout.write(`${JSON.stringify({ report: output, schema: report.schema, mode: report.mode })}\n`);
  if (!(report.validation as { passed: boolean }).passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

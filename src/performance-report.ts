import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ResourceSample {
  elapsedMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssBytes: number;
  descriptors: number | null;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted[0] ?? 0;
}

export async function descriptorCount(): Promise<number | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    return (await readdir(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd")).length;
  } catch {
    return null;
  }
}

export async function sampleResources(started: bigint, cpuStart: NodeJS.CpuUsage): Promise<ResourceSample> {
  const cpu = process.cpuUsage(cpuStart);
  return {
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    cpuUserMs: cpu.user / 1_000,
    cpuSystemMs: cpu.system / 1_000,
    rssBytes: process.memoryUsage.rss(),
    descriptors: await descriptorCount(),
  };
}

export async function writeReports(basePath: string, report: Record<string, unknown>, markdown: string): Promise<void> {
  await mkdir(dirname(basePath), { recursive: true });
  await Promise.all([
    writeFile(`${basePath}.json`, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(`${basePath}.md`, `${markdown.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 }),
  ]);
}

export function parseArguments(args: readonly string[]): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    if (parsed.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed.set(argument, next);
      index += 1;
    } else parsed.set(argument, true);
  }
  return parsed;
}

export function rejectUnknownArguments(args: Map<string, string | true>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = [...args.keys()].filter((argument) => !allowedSet.has(argument));
  if (unknown.length > 0) throw new Error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

export function numericArgument(args: Map<string, string | true>, name: string, fallback: number): number {
  const raw = args.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

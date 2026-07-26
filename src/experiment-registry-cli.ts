#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ExperimentRegistry,
  type ExperimentInput,
  type ExperimentQuery,
  experimentRecordSchema,
} from "./experiment-registry.js";

function options(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error(`Invalid option ${flag ?? ""}`.trim());
    if (result.has(flag.slice(2))) throw new Error(`Duplicate option ${flag}`);
    result.set(flag.slice(2), value);
  }
  return result;
}

export async function runExperimentRegistryCommand(
  args: string[],
): Promise<number> {
  try {
    const [command, ...rest] = args;
    const parsed = options(rest);
    const registryPath = parsed.get("registry");
    if (!registryPath) throw new Error("--registry is required");
    const registry = new ExperimentRegistry(registryPath);
    if (command === "add") {
      const input = parsed.get("input");
      if (!input || parsed.size !== 2)
        throw new Error("add accepts only --registry and --input");
      const record = await registry.add(
        JSON.parse(await readFile(input, "utf8")) as ExperimentInput,
      );
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
      return 0;
    }
    if (command === "query") {
      const allowed = new Set([
        "registry",
        "hypothesis",
        "checkpoint",
        "baseline",
        "status",
        "owner",
      ]);
      if ([...parsed.keys()].some((key) => !allowed.has(key)))
        throw new Error("query received an unknown option");
      const query: ExperimentQuery = {};
      const hypothesis = parsed.get("hypothesis");
      const checkpoint = parsed.get("checkpoint");
      const baseline = parsed.get("baseline");
      const status = parsed.get("status");
      const owner = parsed.get("owner");
      if (hypothesis) query.hypothesis = hypothesis;
      if (checkpoint) query.checkpointSha = checkpoint;
      if (baseline) query.parentBaselineFingerprint = baseline;
      if (status)
        query.status = experimentRecordSchema.shape.status.parse(status);
      if (owner) query.ownerAgent = owner;
      process.stdout.write(
        `${JSON.stringify(await registry.query(query), null, 2)}\n`,
      );
      return 0;
    }
    if (command === "diff") {
      const baseline = parsed.get("baseline-experiment");
      const experiment = parsed.get("experiment");
      if (!baseline || !experiment || parsed.size !== 3)
        throw new Error(
          "diff accepts --registry, --baseline-experiment, and --experiment",
        );
      process.stdout.write(
        `${JSON.stringify(await registry.diff(baseline, experiment), null, 2)}\n`,
      );
      return 0;
    }
    throw new Error("Expected command add, query, or diff");
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
) {
  process.exitCode = await runExperimentRegistryCommand(process.argv.slice(2));
}

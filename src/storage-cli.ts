#!/usr/bin/env node
import { resolve } from "node:path";
import { OrchestratorStorage } from "./storage.js";

function options(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid option ${flag ?? ""}`.trim());
    parsed.set(flag.slice(2), value);
  }
  return parsed;
}

export function runStorageCommand(args: string[]): number {
  const [command, ...rest] = args;
  try {
    const parsed = options(rest);
    const databasePath = parsed.get("database");
    if (!databasePath) throw new Error("--database is required");
    if (command === "integrity-check") {
      if (parsed.size !== 1) throw new Error("integrity-check only accepts --database");
      const report = OrchestratorStorage.checkIntegrity(databasePath);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? 0 : 1;
    }
    if (command === "export") {
      const outputPath = parsed.get("output");
      if (!outputPath) throw new Error("--output is required");
      if (parsed.size !== 2) throw new Error("export only accepts --database and --output");
      if (resolve(databasePath) === resolve(outputPath)) throw new Error("Export path must differ from the live registry");
      OrchestratorStorage.exportJson(databasePath, outputPath);
      process.stdout.write(`${outputPath}\n`);
      return 0;
    }
    throw new Error("Expected command export or integrity-check");
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  process.exitCode = runStorageCommand(process.argv.slice(2));
}

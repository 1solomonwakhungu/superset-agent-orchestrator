import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const REQUIRE_LIVE_VARIABLE = "SUPERSET_ORCHESTRATOR_REQUIRE_LIVE_DISCOVERY";

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the Superset executable the same way `spawn` would, without running
 * it. Returns null only when no such file exists, so a Superset that is present
 * but broken still reaches the live test and fails there rather than being
 * quietly skipped.
 */
export function resolveSupersetExecutable(
  executable = process.env.SUPERSET_ORCHESTRATOR_EXECUTABLE ?? "superset",
): string | null {
  if (executable.includes("/") || isAbsolute(executable)) {
    return isExecutableFile(executable) ? executable : null;
  }
  const directories = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
  for (const directory of directories) {
    const candidate = join(directory, executable);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * True when the caller has declared that a real Superset must be present, which
 * turns an absent executable from a skip into a failure.
 */
export function liveDiscoveryRequired(): boolean {
  const value = process.env[REQUIRE_LIVE_VARIABLE];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const matrix = JSON.parse(readFileSync(resolve(root, "config/compatibility-matrix.v1.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));

function commandVersion(command, args) {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      env: { PATH: process.env.PATH ?? "" },
    }).trim();
    const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    return match?.[0] ?? "unparseable";
  } catch (error) {
    if (error?.code === "ENOENT") return "not-found";
    return "probe-failed";
  }
}

function major(version) {
  const match = version.match(/^(?:v)?(\d+)/);
  return match ? Number(match[1]) : null;
}

const sdkVersion = lockfile.packages?.["node_modules/@modelcontextprotocol/sdk"]?.version ?? "not-locked";
const supersetCommand = process.env.SUPERSET_CLI || "superset";
const detected = {
  os: platform(),
  osRelease: release(),
  architecture: arch(),
  node: process.version.replace(/^v/, ""),
  npm: commandVersion("npm", ["--version"]),
  mcpSdk: sdkVersion,
  transport: "stdio",
  supersetCli: commandVersion(supersetCommand, ["--version"]),
  supersetCliSource: process.env.SUPERSET_CLI ? "SUPERSET_CLI" : "PATH",
  supersetDesktop: process.env.SUPERSET_DESKTOP_VERSION || "not-provided",
  agentPreset: process.env.SUPERSET_AGENT_PRESET || "not-provided",
};

const unsupportedDimensions = [];
const unknownDimensions = [];
if (!matrix.supportedEnvelope.operatingSystems.includes(detected.os)) unsupportedDimensions.push("operating system");
if (!matrix.supportedEnvelope.nodeMajors.includes(major(detected.node))) unsupportedDimensions.push("Node.js major");
if (major(detected.npm) !== matrix.supportedEnvelope.npmMajor) unknownDimensions.push("npm major");
if (major(detected.mcpSdk) !== matrix.supportedEnvelope.mcpSdk.major) unsupportedDimensions.push("MCP SDK major");
if (detected.mcpSdk !== matrix.supportedEnvelope.mcpSdk.lockedVersion) unknownDimensions.push("MCP SDK lockfile version");
if (detected.supersetCli === "not-found" || detected.supersetCli === "probe-failed" || detected.supersetCli === "unparseable") {
  unknownDimensions.push("Superset CLI version");
}
if (detected.supersetDesktop === "not-provided") unknownDimensions.push("Superset Desktop version");
if (detected.agentPreset === "not-provided") unknownDimensions.push("agent preset");
if (
  detected.supersetDesktop !== "not-provided" &&
  detected.supersetCli !== "not-found" &&
  detected.supersetCli !== "probe-failed" &&
  detected.supersetCli !== "unparseable" &&
  detected.supersetDesktop !== detected.supersetCli
) {
  unknownDimensions.push("Desktop and CLI version pair");
}

const classification = unsupportedDimensions.length > 0 ? "unsupported" : unknownDimensions.length > 0 ? "unknown" : "contract-supported";
const report = {
  schemaVersion: 1,
  matrixVersion: matrix.matrixVersion,
  probe: basename(import.meta.filename),
  classification,
  detected,
  unsupportedDimensions: [...unsupportedDimensions, ...unknownDimensions],
  supportedAlternatives: {
    operatingSystems: matrix.supportedEnvelope.operatingSystems,
    nodeMajors: matrix.supportedEnvelope.nodeMajors,
    npmMajor: matrix.supportedEnvelope.npmMajor,
    mcpSdk: matrix.supportedEnvelope.mcpSdk.lockedVersion,
    transport: matrix.supportedEnvelope.transport,
    supersetDesktopCliPairs: matrix.supportedEnvelope.superset.desktopCliPairs,
  },
  probeCommand: "npm run compatibility:probe",
  mutationAllowed: false,
  note: classification === "contract-supported"
    ? "Run operation-specific probes before promoting this exact combination to verified."
    : "This combination must fail before mutation until the listed dimensions are supported and verified.",
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

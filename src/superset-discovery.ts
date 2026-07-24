import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPresetListSchema,
  type AgentPreset,
  type LocalHost,
  localHostSchema,
  parseJson,
  parseVersion,
  projectListSchema,
  type Project,
  type Workspace,
  workspaceListSchema,
} from "./discovery-parser.js";

export type DiscoveryErrorCode =
  | "AMBIGUOUS"
  | "MALFORMED_RESPONSE"
  | "REMOTE_ONLY"
  | "TIMED_OUT"
  | "UNAVAILABLE"
  | "UNSUPPORTED_VERSION";

export class SupersetDiscoveryError extends Error {
  constructor(
    public readonly code: DiscoveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SupersetDiscoveryError";
  }
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ProcessResult>;

export interface SupersetDiscoveryOptions {
  executable?: string;
  timeoutMs?: number;
  runner?: ProcessRunner;
}

export interface SupersetDiscoveryResult {
  version: string;
  host: LocalHost;
  projects: Project[];
  workspaces: Workspace[];
  presets: AgentPreset[];
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MINIMUM_SUPPORTED_MAJOR = 1;
const CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot",
  "ComSpec", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR",
  "FORCE_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy",
  "https_proxy", "no_proxy",
] as const;

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(CHILD_ENVIRONMENT_ALLOWLIST.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]));
}

export const runProcess: ProcessRunner = async (executable, args, timeoutMs) => {
  const directory = await mkdtemp(join(tmpdir(), "superset-discovery-"));
  const stdoutPath = join(directory, "stdout");
  const stdoutFile = await open(stdoutPath, "wx", 0o600);
  try {
    const result = await new Promise<Omit<ProcessResult, "stdout">>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        stdio: ["ignore", stdoutFile.fd, "pipe"],
        windowsHide: true,
        env: childEnvironment(),
      });
      let stderr = "";
      let settled = false;

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const append = (current: string, chunk: Buffer) => {
        if (Buffer.byteLength(current) + chunk.byteLength > MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(() => reject(new SupersetDiscoveryError(
            "MALFORMED_RESPONSE",
            "Superset discovery output exceeded the supported limit",
          )));
          return current;
        }
        return current + chunk.toString("utf8");
      };

      child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => finish(() => reject(new SupersetDiscoveryError(
        "UNAVAILABLE",
        "Superset executable is unavailable",
        { cause: error },
      ))));
      child.once("close", (exitCode) => finish(() => resolve({
        stderr,
        exitCode: exitCode ?? -1,
      })));

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new SupersetDiscoveryError(
          "TIMED_OUT",
          `Superset discovery exceeded ${timeoutMs} ms`,
        )));
      }, timeoutMs);
      timer.unref();
    });
    await stdoutFile.close();
    const stdout = await readFile(stdoutPath);
    if (stdout.byteLength > MAX_OUTPUT_BYTES) {
      throw new SupersetDiscoveryError(
        "MALFORMED_RESPONSE",
        "Superset discovery output exceeded the supported limit",
      );
    }
    return { ...result, stdout: stdout.toString("utf8") };
  } finally {
    await stdoutFile.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
};

export class SupersetDiscoveryAdapter {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly runner: ProcessRunner;

  constructor(options: SupersetDiscoveryOptions = {}) {
    this.executable = options.executable ?? "superset";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.runner = options.runner ?? runProcess;
  }

  async discover(): Promise<SupersetDiscoveryResult> {
    const version = await this.probeVersion();
    const host = await this.command(["status", "--json"], localHostSchema);
    if (!host.running || !host.healthy) {
      throw new SupersetDiscoveryError("UNAVAILABLE", "Local Superset host is unavailable");
    }

    const [projects, workspaces, presets] = await Promise.all([
      this.command(["projects", "list", "--local", "--json"], projectListSchema),
      this.command(["workspaces", "list", "--local", "--json"], workspaceListSchema),
      this.command(["agents", "list", "--local", "--json"], agentPresetListSchema),
    ]);
    this.validateLocalResults(host, projects, workspaces, presets);
    return { version, host, projects, workspaces, presets };
  }

  private async probeVersion(): Promise<string> {
    const result = await this.invoke(["--version"]);
    let version: string;
    try {
      version = parseVersion(result.stdout);
    } catch (error) {
      throw this.malformed("version probe", error);
    }
    const major = Number(version.split(".", 1)[0]);
    if (major < MINIMUM_SUPPORTED_MAJOR) {
      throw new SupersetDiscoveryError(
        "UNSUPPORTED_VERSION",
        `Superset ${version} is unsupported; version ${MINIMUM_SUPPORTED_MAJOR}.0.0 or newer is required`,
      );
    }
    return version;
  }

  private async command<T>(args: readonly string[], schema: Parameters<typeof parseJson<T>>[1]): Promise<T> {
    const result = await this.invoke(args);
    try {
      return parseJson(result.stdout, schema);
    } catch (error) {
      throw this.malformed(args.slice(0, 2).join(" "), error);
    }
  }

  private async invoke(args: readonly string[]): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await this.runner(this.executable, args, this.timeoutMs);
    } catch (error) {
      if (error instanceof SupersetDiscoveryError) throw error;
      throw new SupersetDiscoveryError("UNAVAILABLE", "Superset discovery failed", { cause: error });
    }
    if (result.exitCode !== 0) {
      throw new SupersetDiscoveryError(
        "UNAVAILABLE",
        `Superset ${args[0]} failed with exit code ${result.exitCode}`,
      );
    }
    return result;
  }

  private malformed(command: string, cause: unknown): SupersetDiscoveryError {
    return new SupersetDiscoveryError(
      "MALFORMED_RESPONSE",
      `Superset ${command} returned an unsupported response`,
      { cause },
    );
  }

  private validateLocalResults(
    host: LocalHost,
    projects: Project[],
    workspaces: Workspace[],
    presets: AgentPreset[],
  ): void {
    const unique = <T>(values: T[]) => new Set(values).size === values.length;
    if (!unique(projects.map(({ id }) => id)) ||
        !unique(workspaces.map(({ id }) => id)) ||
        !unique(presets.map(({ id }) => id))) {
      throw new SupersetDiscoveryError("AMBIGUOUS", "Superset discovery returned duplicate identities");
    }
    if (workspaces.some(({ hostId, organizationId }) =>
      hostId !== host.hostId || organizationId !== host.organizationId)) {
      throw new SupersetDiscoveryError(
        "REMOTE_ONLY",
        "Superset local discovery returned a workspace belonging to a remote host or organization",
      );
    }
  }
}

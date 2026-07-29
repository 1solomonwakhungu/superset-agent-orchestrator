import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
import {
  assertFixedArguments,
  assertPinnedExecutable,
  childEnvironment,
  pinExecutable,
  revalidateExecutable,
  safeErrorMessage,
  SecurityError,
  type WorkspaceInventory,
} from "./security.js";

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
  signal?: AbortSignal,
) => Promise<ProcessResult>;

export interface SupersetDiscoveryOptions {
  executable?: string;
  args?: readonly string[];
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
function discoverExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    try {
      const candidate = realpathSync(join(directory, process.platform === "win32" ? "superset.exe" : "superset"));
      accessSync(candidate, constants.X_OK);
      return assertPinnedExecutable(candidate);
    } catch {
      // Continue until an executable canonical path is found.
    }
  }
  throw new SecurityError("POLICY_DENIED", "Superset executable could not be pinned to an absolute path");
}
export const runProcess: ProcessRunner = async (executable, args, timeoutMs, signal) => {
  const pin = await pinExecutable(executable);
  await revalidateExecutable(pin);
  if (signal?.aborted) {
    throw new SupersetDiscoveryError("UNAVAILABLE", "Superset discovery was cancelled");
  }
  const program = pin.path;
  const argv = assertFixedArguments(args);
  const captureDirectory = mkdtempSync(join(tmpdir(), "superset-discovery-"));
  const stdoutPath = join(captureDirectory, "stdout");
  const stdoutFd = openSync(stdoutPath, "wx", 0o600);
  return new Promise<ProcessResult>((resolve, reject) => {
      const useProcessGroup = process.platform !== "win32";
      const child = spawn(program, argv, {
        shell: false,
        // Superset 1.17 can truncate large JSON responses at exactly 64 KiB
        // when its stdout is a pipe. A private file preserves the complete
        // response while the size monitor retains the same hard bound.
        stdio: ["ignore", stdoutFd, "pipe"],
        windowsHide: true,
        detached: useProcessGroup,
        env: childEnvironment(),
      });
      closeSync(stdoutFd);
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let settled = false;
      let terminationError: SupersetDiscoveryError | undefined;

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(outputMonitor);
        signal?.removeEventListener("abort", abort);
        try {
          action();
        } finally {
          rmSync(captureDirectory, { recursive: true, force: true });
        }
      };
      const terminate = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(useProcessGroup ? -child.pid : child.pid, "SIGKILL");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ESRCH") return;
          if (code !== "EPERM" || !useProcessGroup) throw error;
          // A very short-lived child can exit between the group lookup and
          // signal delivery on macOS. Fall back to the child handle so an
          // output-limit race cannot surface as an uncaught timer exception.
          try {
            child.kill("SIGKILL");
          } catch (fallbackError) {
            if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
          }
        }
      };
      const appendStderr = (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes + stdoutSize() > MAX_OUTPUT_BYTES) {
          terminationError ??= new SupersetDiscoveryError(
            "MALFORMED_RESPONSE",
            "Superset discovery output exceeded the supported limit",
          );
          terminate();
          return;
        }
        stderr.push(chunk);
      };
      const abort = () => {
        terminationError ??= new SupersetDiscoveryError(
          "UNAVAILABLE",
          "Superset discovery was cancelled",
        );
        terminate();
      };

      const stdoutSize = () => {
        try {
          return statSync(stdoutPath).size;
        } catch {
          return 0;
        }
      };
      const outputMonitor = setInterval(() => {
        if (stdoutSize() + stderrBytes <= MAX_OUTPUT_BYTES) return;
        terminationError ??= new SupersetDiscoveryError(
          "MALFORMED_RESPONSE",
          "Superset discovery output exceeded the supported limit",
        );
        terminate();
      }, 10);
      outputMonitor.unref();
      child.stderr?.on("data", appendStderr);
      child.once("error", (error) => finish(() => reject(new SupersetDiscoveryError(
        "UNAVAILABLE",
        "Superset executable is unavailable",
        { cause: error },
      ))));
      child.once("close", (exitCode) => finish(() => {
        if (terminationError === undefined && stdoutSize() + stderrBytes > MAX_OUTPUT_BYTES) {
          reject(new SupersetDiscoveryError(
            "MALFORMED_RESPONSE",
            "Superset discovery output exceeded the supported limit",
          ));
          return;
        }
        if (terminationError !== undefined) {
          reject(terminationError);
          return;
        }
        resolve({
          stdout: readFileSync(stdoutPath, "utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: exitCode ?? -1,
        });
      }));

      const timer = setTimeout(() => {
        terminationError ??= new SupersetDiscoveryError(
          "TIMED_OUT",
          `Superset discovery exceeded ${timeoutMs} ms`,
        );
        terminate();
      }, timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
};

export class SupersetDiscoveryAdapter {
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;
  private readonly runner: ProcessRunner;

  constructor(options: SupersetDiscoveryOptions = {}) {
    this.executable = options.executable ?? discoverExecutable();
    this.args = assertFixedArguments(options.args ?? []);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.runner = options.runner ?? runProcess;
  }

  async discover(): Promise<SupersetDiscoveryResult> {
    const version = await this.probeVersion();
    const host = await this.command(["status", "--json"], localHostSchema);
    if (!host.running || !host.healthy) {
      throw new SupersetDiscoveryError("UNAVAILABLE", "Local Superset host is unavailable");
    }

    const controller = new AbortController();
    const commands = [
      this.command(["projects", "list", "--local", "--json"], projectListSchema, controller.signal),
      this.command(["workspaces", "list", "--local", "--json"], workspaceListSchema, controller.signal),
      this.command(["agents", "list", "--local", "--json"], agentPresetListSchema, controller.signal),
    ] as const;
    let projects: Project[];
    let workspaces: Workspace[];
    let presets: AgentPreset[];
    try {
      [projects, workspaces, presets] = await Promise.all(commands);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(commands);
      throw error;
    }
    this.validateLocalResults(host, projects, workspaces, presets);
    return { version, host, projects, workspaces, presets };
  }

  /** Fresh authoritative inventory for workspace authorization decisions. */
  async inventory(): Promise<WorkspaceInventory> {
    const { host, projects, workspaces } = await this.discover();
    return { hostId: host.hostId, organizationId: host.organizationId, projects, workspaces };
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

  private async command<T>(
    args: readonly string[],
    schema: Parameters<typeof parseJson<T>>[1],
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await this.invoke(args, signal);
    try {
      return parseJson(result.stdout, schema);
    } catch (error) {
      throw this.malformed(args.slice(0, 2).join(" "), error);
    }
  }

  private async invoke(args: readonly string[], signal?: AbortSignal): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await this.runner(this.executable, [...this.args, ...args], this.timeoutMs, signal);
    } catch (error) {
      if (error instanceof SupersetDiscoveryError) throw error;
      throw new SupersetDiscoveryError("UNAVAILABLE", safeErrorMessage(error));
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

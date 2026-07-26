import { access, constants } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Project, Workspace } from "./discovery-parser.js";

export const SECURITY_POLICY_VERSION = "2026-07-24";

export type SecurityErrorCode =
  | "INVALID_ARGUMENT"
  | "WORKSPACE_UNAVAILABLE"
  | "AMBIGUOUS_WORKSPACE"
  | "REMOTE_WORKSPACE"
  | "POLICY_DENIED"
  | "INTEGRITY_FAILURE";

export class SecurityError extends Error {
  constructor(
    public readonly code: SecurityErrorCode,
    message: string,
    public readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SecurityError";
  }
}

const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|api[_-]?key|credential|private[_-]?key)/i;
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED:authorization]"],
  [/\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED:token]"],
  [/-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g,
    "[REDACTED:private-key]"],
];

export function redactText(value: string, canaries: readonly string[] = []): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) redacted = redacted.replace(pattern, replacement);
  for (const canary of canaries) {
    if (canary.length > 0) {
      const variants = new Set([
        canary,
        encodeURIComponent(canary),
        Buffer.from(canary).toString("base64"),
        Buffer.from(canary).toString("base64url"),
      ]);
      for (const variant of variants) redacted = redacted.split(variant).join("[REDACTED:canary]");
    }
  }
  return redacted;
}

export class RedactionPolicy {
  readonly canaries: readonly string[];

  constructor(canaries: readonly string[] = []) {
    this.canaries = Object.freeze([...new Set(canaries.filter((value) => value.length > 0))]);
  }

  text(value: string): string {
    return redactText(value, this.canaries);
  }

  value(value: unknown): unknown {
    return redactValue(value, this.canaries);
  }

  error(error: unknown): string {
    return safeErrorMessage(error, this.canaries);
  }
}

export function redactValue(value: unknown, canaries: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return redactText(current, canaries);
    if (current === null || typeof current !== "object") return current;
    if (depth > 20) return "[REDACTED:depth]";
    if (seen.has(current)) return "[REDACTED:cycle]";
    seen.add(current);
    if (current instanceof Error) {
      return { name: current.name, message: redactText(current.message, canaries), cause: visit(current.cause, depth + 1) };
    }
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
    return Object.fromEntries(Object.entries(current).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? `[REDACTED:${key.toLowerCase()}]` : visit(item, depth + 1),
    ]));
  };
  return visit(value, 0);
}

/** Maps a failure to a stable audit reason code without echoing rejected payloads. */
export function reasonCode(error: unknown): string {
  return error instanceof SecurityError ? error.code : "POLICY_DENIED";
}

export function safeErrorMessage(error: unknown, canaries: readonly string[] = []): string {
  return redactText(error instanceof Error ? error.message : String(error), canaries);
}

// eslint-disable-next-line no-control-regex -- these controls are the rejected input set
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex -- ANSI escape starts with ESC by definition
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const AUDIT_FIELD_MAX_CHARACTERS = 256;
const TRUNCATION_MARKER = "[TRUNCATED]";

/** Normalizes an untrusted value into a bounded, single-line, redacted audit field. */
export function auditField(value: string, canaries: readonly string[] = []): string {
  const normalized = redactText(wellFormed(value), canaries)
    .replace(ANSI_ESCAPE, "")
    // eslint-disable-next-line no-control-regex -- audit records normalize all controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return "[NORMALIZED:empty]";
  return normalized.length <= AUDIT_FIELD_MAX_CHARACTERS
    ? normalized
    : `${truncateWellFormed(normalized, AUDIT_FIELD_MAX_CHARACTERS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function truncateWellFormed(value: string, length: number): string {
  const truncated = value.slice(0, length);
  const final = truncated.charCodeAt(truncated.length - 1);
  return final >= 0xd800 && final <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

function wellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, "�");
}

export const MAX_PROMPT_BYTES = 128 * 1024;
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;
export const MAX_IDEMPOTENCY_KEY_BYTES = 256;
export const MAX_IDENTITY_BYTES = 256;
export const MAX_ATTRIBUTION_BYTES = 1024;
export const MAX_RESUME_TOKEN_BYTES = 4096;

/**
 * Validates untrusted text before it is persisted or handed to a child process.
 * Rejects NUL bytes, C0/C1 control characters other than tab and newline, lone
 * surrogates, and over-limit payloads.
 */
export function assertBoundedText(value: string, name: string, maxBytes = MAX_PROMPT_BYTES): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must be a non-empty string`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must not contain control characters`);
  }
  if (LONE_SURROGATE.test(value)) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must be well-formed Unicode`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} exceeds the ${maxBytes} byte limit`);
  }
  return value;
}

/** Applies the same encoding and size checks to text fields that may be empty. */
export function assertBoundedOptionalText(value: string, name: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must be a string`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must not contain control characters`);
  }
  if (LONE_SURROGATE.test(value)) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must be well-formed Unicode`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} exceeds the ${maxBytes} byte limit`);
  }
  return value;
}

/**
 * Requires an absolute executable path. PATH lookup is intentionally forbidden so
 * a hostile parent environment cannot substitute a different program.
 */
export function assertPinnedExecutable(executable: string): string {
  if (executable.length === 0 || executable.includes("\0")
    || CONTROL_CHARACTERS.test(executable) || /[\n\r]/.test(executable)) {
    throw new SecurityError("INVALID_ARGUMENT", "Executable must be a printable single-line path");
  }
  if (!isAbsolute(executable)) {
    throw new SecurityError("POLICY_DENIED", "Executable must be a pinned absolute path");
  }
  return executable;
}

/**
 * Validates a fixed argument vector. Arguments are always passed as an array to a
 * shell-free spawn, so this rejects only values a shell-free child could still
 * misparse: NUL bytes, control characters, and embedded newlines.
 */
export function assertFixedArguments(args: readonly string[]): string[] {
  return args.map((argument, index) => {
    if (typeof argument !== "string") {
      throw new SecurityError("INVALID_ARGUMENT", `Argument ${index} must be a string`);
    }
    if (argument.includes("\0") || CONTROL_CHARACTERS.test(argument) || /[\n\r]/.test(argument)) {
      throw new SecurityError("INVALID_ARGUMENT", `Argument ${index} must not contain control characters`);
    }
    return argument;
  });
}

/**
 * Validates a data operand, such as a resolved workspace path, before it joins an
 * argument vector. A value starting with a dash would be parsed as an option by a
 * child that does not support `--`, so it fails closed.
 */
export function assertDataOperand(value: string, name: string): string {
  assertBoundedText(value, name, 4096);
  if (/[\n\r\t]/.test(value)) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must not contain line or tab separators`);
  }
  if (value.startsWith("-")) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must not begin with an option marker`);
  }
  return value;
}

export function assertIdentifier(value: string, name: string, maxBytes = MAX_IDENTITY_BYTES): string {
  const validated = assertBoundedText(value, name, maxBytes);
  if (/\s/.test(validated)) {
    throw new SecurityError("INVALID_ARGUMENT", `${name} must not contain whitespace`);
  }
  return validated;
}

const CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
] as const;

/**
 * Builds a child environment from an empty map plus an explicit allowlist. Cloud,
 * Git, SSH, proxy, dynamic-loader, and runtime-option variables are never
 * inherited. Lookup is exact-case, so a differently cased duplicate cannot smuggle
 * a value into an allowlisted name. Windows resolves case itself.
 */
export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string" && !value.includes("\0")) environment[name] = value;
  }
  return environment;
}

export function allowlistedEnvironmentNames(): readonly string[] {
  return CHILD_ENVIRONMENT_ALLOWLIST;
}

export interface WorkspaceInventory {
  hostId: string;
  organizationId: string;
  projects: Project[];
  workspaces: Workspace[];
}

export interface WorkspaceGrant {
  workspaceId: string;
  projectId: string;
  canonicalPath: string;
  ownerId?: string | null;
  revalidate(): Promise<void>;
}

/** Resolves an opaque registered workspace ID into a confined canonical target. */
export interface WorkspaceAuthorizer {
  authorize(workspaceId: string): Promise<WorkspaceGrant>;
}

export type WorkspaceInventoryProvider = () => Promise<WorkspaceInventory>;

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

export interface ExecutablePin {
  path: string;
  identity: FileIdentity;
  owner?: bigint;
}

export async function pinExecutable(executable: string): Promise<ExecutablePin> {
  const configured = assertPinnedExecutable(executable);
  try {
    if ((await lstat(configured)).isSymbolicLink()) throw new Error("symlink executable is not trusted");
    const canonical = assertPinnedExecutable(await realpath(configured));
    const metadata = await stat(canonical, { bigint: true });
    if (!metadata.isFile()) throw new Error("not a regular file");
    if (process.platform !== "win32") {
      await new Promise<void>((resolve, reject) => access(canonical, constants.X_OK, (error) => error ? reject(error) : resolve()));
      if ((metadata.mode & 0o022n) !== 0n) throw new Error("group or other writable");
      if (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()) && metadata.uid !== 0n) {
        throw new Error("not owned by the current user or root");
      }
    }
    return {
      path: canonical,
      identity: { device: metadata.dev, inode: metadata.ino },
      ...(process.platform === "win32" ? {} : { owner: metadata.uid }),
    };
  } catch (error) {
    throw new SecurityError("POLICY_DENIED", "Executable provenance is not trusted", false, { cause: error });
  }
}

export async function revalidateExecutable(pin: ExecutablePin): Promise<void> {
  const current = await pinExecutable(pin.path);
  if (current.path !== pin.path || current.identity.device !== pin.identity.device
    || current.identity.inode !== pin.identity.inode || current.owner !== pin.owner) {
    throw new SecurityError("INTEGRITY_FAILURE", "Executable identity changed before spawn");
  }
}

function opaqueWorkspaceId(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || CONTROL_CHARACTERS.test(value) || /\s/.test(value) || value.length > 200
    || isAbsolute(value) || value.includes("/") || value.includes("\\")
    || value.includes(":") || value.startsWith("..") || value.startsWith("~")) {
    throw new SecurityError("INVALID_ARGUMENT", "Workspace target must be an opaque registered ID");
  }
}

function contained(projectPath: string, workspacePath: string): boolean {
  const child = relative(projectPath, workspacePath);
  return child === "" || (!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && child !== ".." && !isAbsolute(child));
}

async function canonicalDirectory(path: string, unavailableMessage: string): Promise<{ path: string; identity: FileIdentity }> {
  try {
    if (!isAbsolute(path)) throw new Error("not absolute");
    const canonical = await realpath(path);
    const metadata = await stat(canonical, { bigint: true });
    if (!metadata.isDirectory()) throw new Error("not a directory");
    return { path: canonical, identity: { device: metadata.dev, inode: metadata.ino } };
  } catch (error) {
    throw new SecurityError("WORKSPACE_UNAVAILABLE", unavailableMessage, true, { cause: error });
  }
}

/**
 * Authorizes launches against Superset's registered local inventory. Client input
 * is only ever an opaque workspace ID; the canonical path is derived here, must
 * belong to the active local host, and must stay inside its registered project.
 */
export class RegisteredWorkspaceAuthorizer implements WorkspaceAuthorizer {
  constructor(private readonly inventory: WorkspaceInventoryProvider) {}

  async authorize(workspaceId: string): Promise<WorkspaceGrant> {
    opaqueWorkspaceId(workspaceId);
    const inventory = await this.inventory();
    const matches = inventory.workspaces.filter(({ id }) => id === workspaceId);
    if (matches.length !== 1) {
      throw new SecurityError(matches.length === 0 ? "WORKSPACE_UNAVAILABLE" : "AMBIGUOUS_WORKSPACE",
        matches.length === 0 ? "Registered workspace is unavailable" : "Registered workspace identity is ambiguous",
        matches.length === 0);
    }
    const workspace = matches[0]!;
    if (workspace.hostId !== inventory.hostId || workspace.organizationId !== inventory.organizationId) {
      throw new SecurityError("REMOTE_WORKSPACE", "Workspace is not registered to the active local host");
    }
    const projects = inventory.projects.filter(({ id }) => id === workspace.projectId);
    if (projects.length !== 1) throw new SecurityError("AMBIGUOUS_WORKSPACE", "Workspace project identity is unavailable or ambiguous");
    const project = projects[0]!;
    if (!workspace.worktreeExists || project.path === null) {
      throw new SecurityError("WORKSPACE_UNAVAILABLE", "Registered workspace is unavailable", true);
    }
    const projectDirectory = await canonicalDirectory(project.path, "Registered project path is unavailable");
    const workspaceDirectory = await canonicalDirectory(workspace.worktreePath, "Registered workspace path is unavailable");
    if (!contained(projectDirectory.path, workspaceDirectory.path)) {
      throw new SecurityError("POLICY_DENIED", "Registered workspace escapes its project boundary");
    }
    assertDataOperand(workspaceDirectory.path, "workspace path");

    return {
      workspaceId,
      projectId: project.id,
      canonicalPath: workspaceDirectory.path,
      ownerId: workspace.createdByUserId,
      revalidate: async () => {
        const fresh = await this.inventory();
        const currentWorkspaces = fresh.workspaces.filter(({ id }) => id === workspaceId);
        const currentProjects = fresh.projects.filter(({ id }) => id === project.id);
        if (fresh.hostId !== inventory.hostId || fresh.organizationId !== inventory.organizationId
          || currentWorkspaces.length !== 1 || currentProjects.length !== 1) {
          throw new SecurityError("INTEGRITY_FAILURE", "Workspace registration changed before launch");
        }
        const currentWorkspace = currentWorkspaces[0]!;
        const currentProject = currentProjects[0]!;
        if (currentWorkspace.hostId !== inventory.hostId
          || currentWorkspace.organizationId !== inventory.organizationId
          || currentWorkspace.projectId !== project.id
          || currentWorkspace.createdByUserId !== workspace.createdByUserId
          || currentWorkspace.worktreePath !== workspace.worktreePath
          || currentProject.path !== project.path
          || !currentWorkspace.worktreeExists) {
          throw new SecurityError("INTEGRITY_FAILURE", "Workspace registration changed before launch");
        }
        const currentProjectDirectory = await canonicalDirectory(currentProject.path!, "Registered project path is unavailable");
        const current = await canonicalDirectory(currentWorkspace.worktreePath, "Registered workspace path is unavailable");
        if (!contained(currentProjectDirectory.path, current.path)
          || currentProjectDirectory.path !== projectDirectory.path
          || currentProjectDirectory.identity.device !== projectDirectory.identity.device
          || currentProjectDirectory.identity.inode !== projectDirectory.identity.inode
          || current.path !== workspaceDirectory.path
          || current.identity.device !== workspaceDirectory.identity.device
          || current.identity.inode !== workspaceDirectory.identity.inode) {
          throw new SecurityError("INTEGRITY_FAILURE", "Workspace identity changed before launch");
        }
      },
    };
  }
}

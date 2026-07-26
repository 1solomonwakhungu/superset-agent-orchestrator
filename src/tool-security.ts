import { SecurityError } from "./security.js";

/**
 * The reviewed MVP tool surface. Adding a name here is a security review event:
 * `assertRegisteredToolNames` fails the build and the test suite when a
 * registration drifts from this snapshot.
 */
export const REGISTERED_TOOL_NAMES = [
  "batches_create",
  "batches_get",
  "batches_status",
  "batches_results",
  "sessions_cancel",
  "batches_cancel",
  "batches_wait",
  "sessions_set_deadline",
  "deadlines_enforce",
  "recent_sessions",
  "reopen_batch",
  "recovery_diagnostics",
] as const;

export type RegisteredToolName = (typeof REGISTERED_TOOL_NAMES)[number];

/**
 * Capabilities the threat model excludes from MVP: arbitrary command execution,
 * destructive workspace or repository mutation, raw filesystem or database access,
 * environment and secret inspection, relay or remote escape hatches, and dynamic
 * plugin registration. The pattern matches whole name parts so that an alias such
 * as `workspace_reset` or `run_shell` cannot be registered by accident.
 */
const EXCLUDED_TOOL_PART = new RegExp(
  "(?:^|_)(?:" + [
    "shell", "sh", "bash", "zsh", "powershell", "cmd", "terminal", "tty", "pty",
    "command", "commands", "exec", "execute", "eval", "run", "spawn", "script", "repl",
    "delete", "destroy", "remove", "rm", "reset", "clean", "prune", "checkout",
    "restore", "revert", "trash",
    "read", "write", "file", "files", "filesystem", "fs", "glob", "grep",
    "git", "commit", "push", "merge", "rebase", "hook", "hooks",
    "env", "environment", "secret", "secrets", "credential", "credentials", "token",
    "database", "db", "sql", "query", "state",
    "install", "publish", "deploy", "relay", "remote", "ssh", "fetch", "curl",
    "kill", "signal", "pid", "plugin", "plugins", "register",
  ].join("|") + ")(?:_|$)",
  "i",
);

/** Rejects a destructive or generic tool name before it can reach registration. */
export function assertSafeToolNames(names: readonly string[]): void {
  for (const name of names) {
    if (EXCLUDED_TOOL_PART.test(name)) {
      throw new SecurityError("POLICY_DENIED", `Destructive or generic tool is excluded: ${name}`);
    }
  }
}

/** Requires the registered surface to match the reviewed snapshot exactly. */
export function assertRegisteredToolNames(names: readonly string[]): void {
  assertSafeToolNames(names);
  const reviewed = [...REGISTERED_TOOL_NAMES].sort();
  const actual = [...names].sort();
  if (actual.length !== reviewed.length || actual.some((name, index) => name !== reviewed[index])) {
    throw new SecurityError(
      "POLICY_DENIED",
      `Registered tool surface requires security review: ${JSON.stringify(actual)}`,
    );
  }
}

assertSafeToolNames(REGISTERED_TOOL_NAMES);

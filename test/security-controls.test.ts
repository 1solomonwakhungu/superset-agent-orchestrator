import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Project, Workspace } from "../src/discovery-parser.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchService, type AsynchronousLaunchRequest } from "../src/launch-service.js";
import {
  assertBoundedText,
  assertDataOperand,
  assertFixedArguments,
  allowlistedEnvironmentNames,
  assertPinnedExecutable,
  auditField,
  childEnvironment,
  MAX_REDACTION_DEPTH,
  MAX_REDACTION_ENTRIES,
  MAX_RESULT_BYTES,
  RedactionPolicy,
  redactText,
  redactValue,
  RegisteredWorkspaceAuthorizer,
  safeErrorMessage,
  SecurityError,
  SECURITY_POLICY_VERSION,
  type WorkspaceGrant,
  type WorkspaceInventory,
} from "../src/security.js";
import { runProcess } from "../src/superset-discovery.js";
import { DurableStore, type DurableState } from "../src/store.js";
import {
  assertRegisteredToolNames,
  assertSafeToolNames,
  REGISTERED_TOOL_NAMES,
} from "../src/tool-security.js";

const HOST = "host-local";
const ORGANIZATION = "organization-local";
const TOKEN_CANARY = "ghp_CANARY0000000000000000000000000000";
const NODE_FIXTURE_DIRECTORY = await mkdtemp(join(tmpdir(), "orchestrator-secure-node-"));
const NODE_EXECUTABLE = join(NODE_FIXTURE_DIRECTORY, "node");
await copyFile(process.execPath, NODE_EXECUTABLE);
await chmod(NODE_EXECUTABLE, 0o700);
test.after(async () => rm(NODE_FIXTURE_DIRECTORY, { recursive: true, force: true }));

function project(path: string | null, id = "project-1"): Project {
  return { id, name: "Orchestrator", slug: "orchestrator", repoCloneUrl: null, githubRepositoryId: null, setUp: "yes", path };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1", organizationId: ORGANIZATION, projectId: "project-1", hostId: HOST,
    name: "per-345", branch: "per-345", type: "worktree", createdByUserId: null, taskId: null,
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    worktreePath: "/unset", worktreeExists: true, projectName: "Orchestrator", hostName: "local",
    ...overrides,
  };
}

function inventory(projects: Project[], workspaces: Workspace[]): WorkspaceInventory {
  return { hostId: HOST, organizationId: ORGANIZATION, projects, workspaces };
}

async function withDirectory(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "orchestrator-security-"));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** Registered project with one contained workspace and one sibling outside it. */
async function layout(base: string): Promise<{ projectPath: string; insidePath: string; outsidePath: string }> {
  const projectPath = join(base, "project");
  const insidePath = join(projectPath, "worktrees", "per-345");
  const outsidePath = join(base, "outside", "credentials");
  await mkdir(insidePath, { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await writeFile(join(outsidePath, "token"), TOKEN_CANARY, "utf8");
  return { projectPath, insidePath, outsidePath };
}

test("T-PATH-01 rejects every non-opaque or unregistered workspace target", async () => {
  await withDirectory(async (base) => {
    const { projectPath, insidePath } = await layout(base);
    const authorizer = new RegisteredWorkspaceAuthorizer(async () =>
      inventory([project(projectPath)], [workspace({ worktreePath: insidePath })]));

    for (const target of [
      "", "..", "../../etc", "/etc/passwd", "workspace-1/../../etc", "workspace\\1",
      "C:\\Windows", "~/secrets", "\\\\server\\share", "work\u0000space", "work\nspace",
      "workspace-1".padEnd(400, "x"),
    ]) {
      const error = await authorizer.authorize(target).then(() => undefined, (caught: unknown) => caught);
      assert.ok(error instanceof SecurityError, `expected refusal for ${JSON.stringify(target)}`);
      assert.equal(error.code, "INVALID_ARGUMENT");
    }

    const unknown = await authorizer.authorize("workspace-absent").then(() => undefined, (caught: unknown) => caught);
    assert.ok(unknown instanceof SecurityError);
    assert.equal(unknown.code, "WORKSPACE_UNAVAILABLE");
    assert.equal(unknown.retryable, true);

    const granted = await authorizer.authorize("workspace-1");
    assert.equal(granted.canonicalPath, await realpath(insidePath));
    assert.equal(granted.projectId, "project-1");
  });
});

test("T-PATH-01 fails closed on ambiguous, remote, and unavailable registrations", async () => {
  await withDirectory(async (base) => {
    const { projectPath, insidePath } = await layout(base);
    const inside = workspace({ worktreePath: insidePath });

    const cases: Array<[string, WorkspaceInventory, string]> = [
      ["duplicate workspace identity", inventory([project(projectPath)], [inside, inside]), "AMBIGUOUS_WORKSPACE"],
      ["remote host", inventory([project(projectPath)], [{ ...inside, hostId: "host-cloud" }]), "REMOTE_WORKSPACE"],
      ["remote organization", inventory([project(projectPath)], [{ ...inside, organizationId: "organization-cloud" }]), "REMOTE_WORKSPACE"],
      ["duplicate project identity", inventory([project(projectPath), project(projectPath)], [inside]), "AMBIGUOUS_WORKSPACE"],
      ["unregistered project path", inventory([project(null)], [inside]), "WORKSPACE_UNAVAILABLE"],
      ["missing worktree", inventory([project(projectPath)], [{ ...inside, worktreeExists: false }]), "WORKSPACE_UNAVAILABLE"],
      ["absent directory", inventory([project(projectPath)], [{ ...inside, worktreePath: join(base, "gone") }]), "WORKSPACE_UNAVAILABLE"],
      ["relative project path", inventory([project("project")], [inside]), "WORKSPACE_UNAVAILABLE"],
      ["relative worktree path", inventory([project(projectPath)], [{ ...inside, worktreePath: "worktrees/per-345" }]), "WORKSPACE_UNAVAILABLE"],
    ];

    for (const [label, records, code] of cases) {
      const error = await new RegisteredWorkspaceAuthorizer(async () => records)
        .authorize("workspace-1").then(() => undefined, (caught: unknown) => caught);
      assert.ok(error instanceof SecurityError, `expected refusal for ${label}`);
      assert.equal(error.code, code, label);
    }
  });
});

test("T-PATH-02 refuses a symlinked workspace that escapes its registered project", async () => {
  await withDirectory(async (base) => {
    const { projectPath, outsidePath } = await layout(base);
    const escape = join(projectPath, "escape");
    await symlink(outsidePath, escape, "dir");
    const authorizer = new RegisteredWorkspaceAuthorizer(async () =>
      inventory([project(projectPath)], [workspace({ worktreePath: escape })]));

    const error = await authorizer.authorize("workspace-1").then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof SecurityError);
    assert.equal(error.code, "POLICY_DENIED");
    assert.match(error.message, /escapes its project boundary/);
    assert.doesNotMatch(error.message, new RegExp(TOKEN_CANARY));
  });
});

test("T-PATH-02 refuses a sibling directory that only shares a path prefix", async () => {
  await withDirectory(async (base) => {
    const projectPath = join(base, "project");
    const sibling = join(base, "project-evil");
    await mkdir(projectPath, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const authorizer = new RegisteredWorkspaceAuthorizer(async () =>
      inventory([project(projectPath)], [workspace({ worktreePath: sibling })]));

    const error = await authorizer.authorize("workspace-1").then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof SecurityError);
    assert.equal(error.code, "POLICY_DENIED");
  });
});

test("T-PATH-02 authorizes only an exact external registered worktree grant", async () => {
  await withDirectory(async (base) => {
    const { projectPath, outsidePath } = await layout(base);
    const canonicalPath = await realpath(outsidePath);
    const records = inventory([project(projectPath)], [workspace({ worktreePath: outsidePath })]);
    const exact = new RegisteredWorkspaceAuthorizer(async () => records, [
      { workspaceId: "workspace-1", projectId: "project-1", canonicalPath },
    ]);
    const grant = await exact.authorize("workspace-1");
    assert.equal(grant.canonicalPath, canonicalPath);
    await grant.revalidate();

    for (const authorization of [
      { workspaceId: "workspace-2", projectId: "project-1", canonicalPath },
      { workspaceId: "workspace-1", projectId: "project-2", canonicalPath },
      { workspaceId: "workspace-1", projectId: "project-1", canonicalPath: projectPath },
    ]) {
      const authorizer = new RegisteredWorkspaceAuthorizer(async () => records, [authorization]);
      await assert.rejects(authorizer.authorize("workspace-1"), (error: unknown) =>
        error instanceof SecurityError && error.code === "POLICY_DENIED");
    }
  });
});

test("T-PATH-03 external worktree grants retain registration and inode confinement", async () => {
  await withDirectory(async (base) => {
    const { projectPath, outsidePath } = await layout(base);
    const canonicalPath = await realpath(outsidePath);
    const original = workspace({ worktreePath: outsidePath, createdByUserId: "owner-1" });
    let records = inventory([project(projectPath)], [original]);
    const authorizer = new RegisteredWorkspaceAuthorizer(async () => records, [
      { workspaceId: "workspace-1", projectId: "project-1", canonicalPath },
    ]);
    const grant = await authorizer.authorize("workspace-1");
    records = inventory([project(projectPath)], [{ ...original, createdByUserId: "owner-2" }]);
    await assert.rejects(grant.revalidate(), (error: unknown) =>
      error instanceof SecurityError && error.code === "INTEGRITY_FAILURE");

    records = inventory([project(projectPath)], [original]);
    const inodeGrant = await authorizer.authorize("workspace-1");
    await rename(outsidePath, `${outsidePath}-old`);
    await mkdir(outsidePath);
    await assert.rejects(inodeGrant.revalidate(), (error: unknown) =>
      error instanceof SecurityError && error.code === "INTEGRITY_FAILURE");
  });
});

test("T-PATH-03 revalidation aborts when the validated directory is retargeted", async () => {
  await withDirectory(async (base) => {
    const { projectPath, insidePath, outsidePath } = await layout(base);
    const grant = await new RegisteredWorkspaceAuthorizer(async () =>
      inventory([project(projectPath)], [workspace({ worktreePath: insidePath })])).authorize("workspace-1");
    await grant.revalidate();

    await rename(insidePath, `${insidePath}-moved`);
    await symlink(outsidePath, insidePath, "dir");

    const error = await grant.revalidate().then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof SecurityError);
    assert.equal(error.code, "INTEGRITY_FAILURE");
  });
});

test("T-PATH-03 revalidation re-reads registration and rejects removal, reassignment, remote retarget, and owner change", async () => {
  await withDirectory(async (base) => {
    const { projectPath, insidePath } = await layout(base);
    const original = workspace({ worktreePath: insidePath, createdByUserId: "owner-1" });
    let records = inventory([project(projectPath)], [original]);
    const authorizer = new RegisteredWorkspaceAuthorizer(async () => records);

    for (const mutate of [
      () => { records = inventory([project(projectPath)], []); },
      () => { records = inventory([project(projectPath, "project-2")], [{ ...original, projectId: "project-2" }]); },
      () => { records = inventory([project(projectPath)], [{ ...original, hostId: "remote-host" }]); },
      () => { records = inventory([project(projectPath)], [{ ...original, createdByUserId: "owner-2" }]); },
      () => { records = inventory([project(join(base, "other"))], [original]); },
    ]) {
      records = inventory([project(projectPath)], [original]);
      const grant = await authorizer.authorize("workspace-1");
      mutate();
      const error = await grant.revalidate().then(() => undefined, (caught: unknown) => caught);
      assert.ok(error instanceof SecurityError);
      assert.equal(error.code, "INTEGRITY_FAILURE");
    }
  });
});

test("T-PATH-03 a retargeted workspace audits the race and launches no child", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{ statuses: ["succeeded"], result: { status: "succeeded", output: "unused" } }]);
    let retargeted = false;
    const authorizer = {
      authorize: async (workspaceId: string): Promise<WorkspaceGrant> => ({
        workspaceId, projectId: "project-1", canonicalPath: "/base/project/worktrees/per-345",
        revalidate: async () => {
          if (retargeted) throw new SecurityError("INTEGRITY_FAILURE", "Workspace identity changed before launch");
        },
      }),
    };
    const service = new LaunchService(store, adapter, authorizer);
    await service.accept(launchRequest());
    retargeted = true;
    await service.dispatchPending();

    assert.equal(adapter.launches.length, 0);
    const state = JSON.parse(await readFile(path, "utf8")) as DurableState;
    assert.equal(state.assignments[0]?.status, "failed");
    const denied = state.securityAuditEvents?.filter(({ decision }) => decision === "denied") ?? [];
    assert.deepEqual(denied.map(({ reasonCode }) => reasonCode), ["INTEGRITY_FAILURE"]);
    assert.equal(denied[0]?.assignmentId, state.assignments[0]?.id);
  });
});

test("T-CMD-01 spawning is shell free, so metacharacters stay inert data", async () => {
  await withDirectory(async (base) => {
    const sentinel = join(base, "sentinel");
    const payload = `; touch ${sentinel} && echo pwned | cat $(id) \`id\``;
    const result = await runProcess(
      NODE_EXECUTABLE,
      ["-e", "process.stdout.write(process.argv[1])", payload],
      20_000,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, payload);
    await assert.rejects(access(sentinel), /ENOENT/);
  });
});

test("T-CMD-02 only a pinned executable and a control-free argument vector can spawn", async () => {
  for (const executable of ["superset; touch /tmp/orchestrator-sentinel", "./relative/superset", "super set", "superset\nrm"]) {
    assert.throws(() => assertPinnedExecutable(executable), SecurityError);
    await assert.rejects(runProcess(executable, ["--version"], 1_000), SecurityError);
  }
  assert.throws(() => assertPinnedExecutable("superset"), SecurityError);
  assert.equal(assertPinnedExecutable(NODE_EXECUTABLE), NODE_EXECUTABLE);

  for (const argument of ["a\nb", "a\u0000b", "a\u001b[2Jb", "a\rb"]) {
    assert.throws(() => assertFixedArguments(["status", argument]), SecurityError);
    await assert.rejects(runProcess(NODE_EXECUTABLE, ["-e", "0", argument], 1_000), SecurityError);
  }
  assert.deepEqual(assertFixedArguments(["workspaces", "list", "--local", "--json"]),
    ["workspaces", "list", "--local", "--json"]);
});

test("T-CMD-02 rejects group or other writable executables on POSIX", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode bits are not available on Windows");
    return;
  }
  await withDirectory(async (base) => {
    const executable = join(base, "node-copy");
    await copyFile(NODE_EXECUTABLE, executable);
    for (const mode of [0o775, 0o757]) {
      await chmod(executable, mode);
      await assert.rejects(runProcess(executable, ["--version"], 5_000), /provenance is not trusted/);
    }
  });
});

test("T-CMD-02 discovery output is bounded while the child is running", async () => {
  await assert.rejects(
    runProcess(
      NODE_EXECUTABLE,
      ["-e", `process.stdout.write("x".repeat(${4 * 1024 * 1024 + 1}))`],
      20_000,
    ),
    /output exceeded the supported limit/,
  );
});

test("T-CMD-02 discovery preserves UTF-8 split across child writes", async () => {
  const result = await runProcess(
    NODE_EXECUTABLE,
    ["-e", "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 10)"],
    20_000,
  );
  assert.equal(result.stdout, "€");
});

test("T-CMD-03 bounded text and data operands reject injected payloads", () => {
  assert.throws(() => assertBoundedText("", "prompt"), SecurityError);
  assert.throws(() => assertBoundedText("prompt\u0000", "prompt"), SecurityError);
  assert.throws(() => assertBoundedText("prompt\u001b[31m", "prompt"), SecurityError);
  assert.throws(() => assertBoundedText("prompt\uD800", "prompt"), SecurityError);
  assert.throws(() => assertBoundedText("x".repeat(200), "prompt", 64), SecurityError);
  assert.equal(assertBoundedText("Implement PER-345\n\tstep one", "prompt"), "Implement PER-345\n\tstep one");

  assert.throws(() => assertDataOperand("--upload-pack=touch /tmp/x", "workspace path"), SecurityError);
  assert.throws(() => assertDataOperand("/base/pro\tject", "workspace path"), SecurityError);
  assert.equal(assertDataOperand("/base/project/worktrees/per-345", "workspace path"),
    "/base/project/worktrees/per-345");
});

test("T-ENV-01 the child environment is an allowlist and carries no seeded secret", async () => {
  const hostile = {
    PATH: process.env.PATH ?? "/usr/bin", HOME: "/home/test", TERM: "xterm-256color",
    AWS_SECRET_ACCESS_KEY: TOKEN_CANARY, AWS_SESSION_TOKEN: TOKEN_CANARY,
    GITHUB_TOKEN: TOKEN_CANARY, GH_TOKEN: TOKEN_CANARY, NPM_TOKEN: TOKEN_CANARY,
    SSH_AUTH_SOCK: "/tmp/agent.sock", GPG_AGENT_INFO: "/tmp/gpg", GIT_SSH_COMMAND: `ssh -i ${TOKEN_CANARY}`,
    NODE_OPTIONS: "--require /tmp/evil.js", LD_PRELOAD: "/tmp/evil.so", DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    BASH_ENV: "/tmp/evil.sh", ENV: "/tmp/evil.sh", HTTPS_PROXY: `http://user:${TOKEN_CANARY}@proxy`,
    SUPERSET_ORCHESTRATOR_STATE: "/tmp/hijack.json",
  };
  const filtered = childEnvironment(hostile);

  assert.deepEqual(Object.keys(filtered).sort(), ["HOME", "PATH", "TERM"]);
  assert.doesNotMatch(JSON.stringify(filtered), new RegExp(TOKEN_CANARY));
  assert.deepEqual(childEnvironment({ PATH: "/a", path: "/b" }), { PATH: "/a" });
  assert.deepEqual(childEnvironment({ path: "/b", nOdE_oPtIoNs: "--require /tmp/evil.js" }), {});

  const seeded = ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "HTTPS_PROXY"] as const;
  const saved = seeded.map((name) => [name, process.env[name]] as const);
  for (const name of seeded) process.env[name] = TOKEN_CANARY;
  try {
    const inherited = await runProcess(
      NODE_EXECUTABLE,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      20_000,
    );
    assert.doesNotMatch(inherited.stdout, new RegExp(TOKEN_CANARY));
    const childKeys = Object.keys(JSON.parse(inherited.stdout) as Record<string, string>);
    for (const forbidden of [...seeded, "NODE_OPTIONS", "LD_PRELOAD", "GIT_SSH_COMMAND"]) {
      assert.ok(!childKeys.includes(forbidden), `child inherited ${forbidden}`);
    }
    // macOS adds __CF_USER_TEXT_ENCODING to every spawned process; nothing else may appear.
    const harnessVariables = process.env.NODE_V8_COVERAGE === undefined ? [] : ["NODE_V8_COVERAGE"];
    const unexpected = childKeys.filter((key) => !allowlistedEnvironmentNames().includes(key)
      && !key.startsWith("__CF") && !harnessVariables.includes(key));
    assert.deepEqual(unexpected, []);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("T-SECRET-02 redaction covers keys, credential formats, cycles, and canaries", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
  const cyclic: Record<string, unknown> = { Authorization: `Bearer ${TOKEN_CANARY}`, nested: { API_Key: TOKEN_CANARY } };
  cyclic.self = cyclic;

  const redacted = JSON.stringify(redactValue(cyclic, [TOKEN_CANARY]));
  assert.doesNotMatch(redacted, new RegExp(TOKEN_CANARY));
  assert.match(redacted, /\[REDACTED:authorization\]/);
  assert.match(redacted, /\[REDACTED:api_key\]/);
  assert.match(redacted, /\[REDACTED:cycle\]/);

  assert.equal(redactText(`Authorization: Bearer ${TOKEN_CANARY}`), "Authorization: Bearer [REDACTED:authorization]");
  assert.equal(redactText("basic YWRtaW46cGFzcw=="), "basic [REDACTED:authorization]");
  assert.equal(redactText(`token ${TOKEN_CANARY}`), "token [REDACTED:token]");
  assert.equal(redactText("key AKIAIOSFODNN7EXAMPLE"), "key [REDACTED:token]");
  assert.equal(redactText(`config ${pem} end`), "config [REDACTED:private-key] end");
  assert.equal(redactText(`leak ${TOKEN_CANARY}`, [TOKEN_CANARY]), "leak [REDACTED:token]");
  assert.equal(redactText("leak s3cret-literal", ["s3cret-literal"]), "leak [REDACTED:canary]");
  assert.equal(redactText(`leak ${Buffer.from("s3cret-literal").toString("base64")}`, ["s3cret-literal"]), "leak [REDACTED:canary]");
  assert.equal(redactText(`leak ${encodeURIComponent("s3cret/literal")}`, ["s3cret/literal"]), "leak [REDACTED:canary]");
  assert.equal(safeErrorMessage(new Error(`spawn failed for ${TOKEN_CANARY}`)), "spawn failed for [REDACTED:token]");
  assert.deepEqual(redactValue([{ password: "hunter2" }, 7, null]), [{ password: "[REDACTED:password]" }, 7, null]);
});

test("T-SECRET-02 redaction covers common text credentials and bounds hostile structures", () => {
  const credentials = [
    "password=hunter2", "api_key: sk_live_example", "AWS_SECRET_ACCESS_KEY=awsSecretValue",
    `Slack ${["xoxb", "1234567890", "abcdefghijklmnop"].join("-")}`,
    `npm ${["npm", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_")}`,
    "AWS ASIAIOSFODNN7EXAMPLE", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
  ];
  for (const credential of credentials) {
    const redacted = redactText(credential);
    assert.match(redacted, /\[REDACTED:(?:secret|token)\]/, credential);
    assert.notEqual(redacted, credential);
  }

  const wide = Array.from({ length: MAX_REDACTION_ENTRIES + 20 }, (_, index) => `value-${index}`);
  const bounded = redactValue(wide) as unknown[];
  assert.equal(bounded.length, MAX_REDACTION_ENTRIES + 1);
  assert.equal(bounded.at(-1), "[REDACTED:entries]");

  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let index = 0; index < MAX_REDACTION_DEPTH + 5; index++) deep = deep.next = {};
  assert.match(JSON.stringify(redactValue(root)), /\[REDACTED:depth\]/);

  let accessed = false;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, "value", { enumerable: true, get: () => { accessed = true; return TOKEN_CANARY; } });
  assert.deepEqual({ ...redactValue(hostile) as object }, { value: "[REDACTED:accessor]" });
  assert.equal(accessed, false);
  const pollution = Object.create(null) as Record<string, unknown>;
  pollution.__proto__ = { polluted: true };
  const safePollution = redactValue(pollution) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(safePollution), Object.prototype);
  assert.deepEqual(safePollution.__proto__, { polluted: true });
});

test("T-AUDIT-02 audit fields are normalized, bounded, and injection safe", () => {
  assert.equal(auditField("client\r\nnot ok 99 - forged"), "client not ok 99 - forged");
  assert.equal(auditField("client\u001b[31mred\u001b[0m"), "clientred");
  assert.equal(auditField(`requester ${TOKEN_CANARY}`), "requester [REDACTED:token]");
  assert.equal(auditField("\u0000\u0007 \t"), "[NORMALIZED:empty]");
  const bounded = auditField("x".repeat(600));
  assert.equal(bounded.length, 256);
  assert.ok(bounded.endsWith("[TRUNCATED]"));
  const unicodeBounded = auditField(`${"x".repeat(244)}😀${"y".repeat(20)}`);
  assert.equal(unicodeBounded.length <= 256, true);
  assert.doesNotMatch(unicodeBounded, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.equal(auditField("bad\uD800value"), "bad�value");
  assert.equal(auditField("allow\u202edeny\u202c\u200b\ufeff"), "allowdeny");
});

test("T-INPUT-01 persisted schemas reject unknown fields at every security boundary", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    await store.appendSecurityAudit({
      requesterId: "client-1", operation: "sessions_launch", decision: "allowed",
      reasonCode: "launch_intent", correlationId: "operation-1",
    });
    const valid = JSON.parse(await readFile(path, "utf8")) as DurableState & Record<string, unknown>;
    valid.unexpected = TOKEN_CANARY;
    await writeFile(path, JSON.stringify(valid), "utf8");
    await assert.rejects(new DurableStore(path).reconcile(), /Unrecognized key/);
  });

  await withStore(async (path) => {
    const store = new DurableStore(path);
    await store.appendSecurityAudit({
      requesterId: "client-1", operation: "sessions_launch", decision: "allowed",
      reasonCode: "launch_intent", correlationId: "operation-1",
    });
    const invalid = JSON.parse(await readFile(path, "utf8")) as DurableState;
    (invalid.securityAuditEvents![0] as unknown as Record<string, unknown>).credential = TOKEN_CANARY;
    await writeFile(path, JSON.stringify(invalid), "utf8");
    await assert.rejects(new DurableStore(path).reconcile(), /Unrecognized key/);
  });
});

test("T-SECRET-01 a launch prompt secret never reaches state, audit, or diagnostics", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{ statuses: ["succeeded"], result: { status: "succeeded", output: "done" } }]);
    const service = new LaunchService(store, adapter, allowingAuthorizer());
    await service.accept(launchRequest({
      prompt: `Use Authorization: Bearer ${TOKEN_CANARY} and key AKIAIOSFODNN7EXAMPLE`,
      clientId: `desktop ${TOKEN_CANARY}`,
    }));
    await service.dispatchPending();

    const persisted = await readFile(path, "utf8");
    assert.doesNotMatch(persisted, new RegExp(TOKEN_CANARY));
    assert.doesNotMatch(persisted, /AKIAIOSFODNN7EXAMPLE/);
    assert.match(persisted, /\[REDACTED:token\]/);
    assert.equal(adapter.launches[0]?.prompt.includes(TOKEN_CANARY), false);
    assert.equal(store.securityAuditEvents().some(({ requesterId }) => requesterId.includes(TOKEN_CANARY)), false);
  });
});

test("T-SECRET-01 adapter result secrets are redacted before persistence", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{
      statuses: ["succeeded"],
      result: { status: "succeeded", output: `result ${TOKEN_CANARY}`, resume: { adapter: "fake", token: TOKEN_CANARY } },
    }]);
    const service = new LaunchService(store, adapter, allowingAuthorizer());
    const accepted = await service.accept(launchRequest());
    await service.dispatchPending();
    const { ResultCaptureService } = await import("../src/result-capture.js");
    await new ResultCaptureService(store, adapter).collect(accepted.assignmentId, "delivery-secret");

    const persisted = await readFile(path, "utf8");
    assert.doesNotMatch(persisted, new RegExp(TOKEN_CANARY));
    assert.match(persisted, /\[REDACTED:token\]/);
  });
});

test("T-SECRET-01 configured literal canaries are enforced across metadata, diagnostics, audit, and results", async () => {
  await withStore(async (path) => {
    const literal = "low-entropy-canary-credential";
    const store = new DurableStore(path, undefined, undefined, undefined, new RedactionPolicy([literal]));
    const adapter = new FakeAgentAdapter([{
      statuses: ["succeeded"],
      result: { status: "succeeded", output: `output ${literal}` },
    }]);
    const service = new LaunchService(store, adapter, allowingAuthorizer());
    const accepted = await service.accept(launchRequest({
      batchName: `batch ${literal}`,
      attribution: { agent: "codex", task: `task ${literal}` },
      prompt: `prompt ${literal}`,
      clientId: `client ${literal}`,
    }));
    await service.dispatchPending();
    const { ResultCaptureService } = await import("../src/result-capture.js");
    await new ResultCaptureService(store, adapter).collect(accepted.assignmentId, "delivery-canary");
    await store.updateLaunch("missing", "reserved", { diagnostic: literal }).catch(() => undefined);

    const persisted = await readFile(path, "utf8");
    assert.doesNotMatch(persisted, new RegExp(literal));
    assert.match(persisted, /\[REDACTED:canary\]/);
  });
});

test("T-INPUT-01 rejects unsafe launch identities and metadata before mutation", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const service = new LaunchService(store, new FakeAgentAdapter([]), allowingAuthorizer());
    for (const request of [
      launchRequest({ idempotencyKey: "x".repeat(257) }),
      launchRequest({ idempotencyKey: "key\nforged" }),
      launchRequest({ workspaceId: `workspace-${TOKEN_CANARY}` }),
      launchRequest({ attribution: { agent: "codex\nforged", task: "task" } }),
      launchRequest({ attribution: { agent: "codex", task: "x".repeat(1025) } }),
    ]) {
      await assert.rejects(service.accept(request), SecurityError);
    }
    const state = JSON.parse(await readFile(path, "utf8")) as DurableState;
    assert.deepEqual(state.assignments, []);
    assert.doesNotMatch(JSON.stringify(state), new RegExp(TOKEN_CANARY));
  });
});

test("T-AUDIT-01 allowed and denied launches produce a chained attributable trail", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{ statuses: ["succeeded"], result: { status: "succeeded", output: "done" } }]);
    const service = new LaunchService(store, adapter, allowingAuthorizer());
    await service.accept(launchRequest());
    await service.dispatchPending();
    await assert.rejects(service.accept(launchRequest({ idempotencyKey: "denied-1", prompt: "bad\u0000prompt" })), SecurityError);

    const events = store.securityAuditEvents();
    assert.deepEqual(events.map(({ decision, reasonCode }) => `${decision}:${reasonCode}`), [
      "allowed:launch_accepted",
      "allowed:launch_intent",
      "allowed:launch_started",
      "denied:INVALID_ARGUMENT",
    ]);
    assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3, 4]);
    for (const event of events) {
      assert.equal(event.policyVersion, SECURITY_POLICY_VERSION);
      assert.equal(event.operation, "sessions_launch");
      assert.ok(event.correlationId.length > 0);
      assert.match(event.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.equal(events[0]?.projectId, "project-1");
    assert.deepEqual(store.verifySecurityAuditChain(), { valid: true, length: 4 });

    const reopened = new DurableStore(path);
    await reopened.reconcile();
    assert.deepEqual(reopened.verifySecurityAuditChain(), { valid: true, length: 4 });
  });
});

test("T-RESULT-01 replaces oversized adapter output with a bounded malformed claim", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{
      statuses: ["succeeded"],
      result: { status: "succeeded", output: "x".repeat(MAX_RESULT_BYTES + 1) },
    }]);
    const service = new LaunchService(store, adapter, allowingAuthorizer());
    const accepted = await service.accept(launchRequest());
    await service.dispatchPending();
    const { ResultCaptureService } = await import("../src/result-capture.js");

    const captured = await new ResultCaptureService(store, adapter).collect(accepted.assignmentId, "delivery-oversized");
    assert.equal(captured.result?.claim.status, "malformed");
    assert.equal(captured.result?.claim.error, "Provider result response was oversized");
    assert.doesNotMatch(await readFile(path, "utf8"), /x{1000}/);
  });
});

test("T-AUDIT-02 chain verification detects an edited, deleted, or reordered event", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    await store.appendSecurityAudit({
      requesterId: "client-1", operation: "sessions_launch", decision: "allowed",
      reasonCode: "launch_intent", correlationId: "operation-1",
    });
    await store.appendSecurityAudit({
      requesterId: "client-1", operation: "sessions_launch", decision: "denied",
      reasonCode: "POLICY_DENIED", correlationId: "operation-2",
    });
    assert.deepEqual(store.verifySecurityAuditChain(), { valid: true, length: 2 });

    const tampered = JSON.parse(await readFile(path, "utf8")) as DurableState;
    const original = structuredClone(tampered);
    tampered.securityAuditEvents![1]!.decision = "allowed";
    await writeFile(path, JSON.stringify(tampered), "utf8");
    const reopened = new DurableStore(path);
    await assert.rejects(reopened.reconcile(), /Security audit integrity failure at sequence 2/);

    const truncated = structuredClone(original);
    truncated.securityAuditEvents = [truncated.securityAuditEvents![1]!];
    await writeFile(path, JSON.stringify(truncated), "utf8");
    const shortened = new DurableStore(path);
    await assert.rejects(shortened.reconcile(), /Security audit integrity failure at sequence 1/);
  });
});

test("T-AUDIT-02 loading fails closed when the audit suffix is truncated", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    await store.appendSecurityAudit({
      requesterId: "client-1", operation: "sessions_launch", decision: "allowed",
      reasonCode: "launch_intent", correlationId: "operation-1",
    });
    await store.appendSecurityAudit({
      requesterId: "client-1", operation: "sessions_launch", decision: "failed",
      reasonCode: "POLICY_DENIED", correlationId: "operation-2",
    });
    const truncated = JSON.parse(await readFile(path, "utf8")) as DurableState;
    truncated.securityAuditEvents!.pop();
    await writeFile(path, JSON.stringify(truncated), "utf8");

    await assert.rejects(new DurableStore(path).reconcile(), /Security audit integrity failure at sequence 2/);
  });
});

test("T-AUDIT-02 loading fails closed when a controlled launch loses its entire audit trail", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const service = new LaunchService(
      store,
      new FakeAgentAdapter([{ statuses: ["succeeded"], result: { status: "succeeded", output: "done" } }]),
      allowingAuthorizer(),
    );
    await service.accept(launchRequest());
    const tampered = JSON.parse(await readFile(path, "utf8")) as DurableState;
    delete tampered.securityAuditEvents;
    tampered.securityAuditHead = { sequence: 0, eventHash: "0".repeat(64) };
    await writeFile(path, JSON.stringify(tampered), "utf8");

    await assert.rejects(new DurableStore(path).reconcile(), /requires an acceptance audit event/);
  });
});

test("T-ENV-01 launch adapters receive only allowlisted environment and final revalidation", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{ statuses: ["succeeded"], result: { status: "succeeded", output: "done" } }]);
    let validations = 0;
    const authorizer = {
      authorize: async (workspaceId: string): Promise<WorkspaceGrant> => ({
        workspaceId, projectId: "project-1", canonicalPath: "/base/project/worktrees/per-345",
        revalidate: async () => { validations += 1; },
      }),
    };
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = TOKEN_CANARY;
    try {
      const service = new LaunchService(store, adapter, authorizer);
      await service.accept(launchRequest());
      await service.dispatchPending();
      assert.equal(validations, 2);
      assert.equal(adapter.launches[0]?.environment.GITHUB_TOKEN, undefined);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });
});

test("T-PATH-02 retryable workspace discovery failures remain pending", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{ statuses: ["succeeded"], result: { status: "succeeded", output: "done" } }]);
    let authorizations = 0;
    const authorizer = {
      authorize: async (workspaceId: string): Promise<WorkspaceGrant> => {
        authorizations += 1;
        if (authorizations === 2) throw new SecurityError("WORKSPACE_UNAVAILABLE", "Inventory is temporarily unavailable", true);
        return { workspaceId, projectId: "project-1", canonicalPath: "/base/project/worktrees/per-345", revalidate: async () => undefined };
      },
    };
    const service = new LaunchService(store, adapter, authorizer);
    const accepted = await service.accept(launchRequest());

    await assert.rejects(service.dispatchPending(), /temporarily unavailable/);
    assert.equal((await store.assignmentForResult(accepted.assignmentId)).status, "accepted");
    assert.equal(adapter.launches.length, 0);

    await service.dispatchPending();
    assert.equal((await store.assignmentForResult(accepted.assignmentId)).status, "launched");
    assert.equal(adapter.launches.length, 1);
  });
});

test("T-PATH-02 one retryable workspace failure does not starve other assignments", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{ statuses: ["succeeded"], result: { status: "succeeded", output: "done" } }]);
    const authorizer = {
      authorize: async (workspaceId: string): Promise<WorkspaceGrant> => {
        if (workspaceId === "workspace-blocked") {
          throw new SecurityError("WORKSPACE_UNAVAILABLE", "Inventory is temporarily unavailable", true);
        }
        return { workspaceId, projectId: "project-1", canonicalPath: "/base/project/worktrees/per-345", revalidate: async () => undefined };
      },
    };
    const service = new LaunchService(store, adapter, authorizer);
    const blocked = await service.accept(launchRequest({ idempotencyKey: "blocked", workspaceId: "workspace-1" }));
    const ready = await service.accept(launchRequest({ idempotencyKey: "ready", workspaceId: "workspace-ready" }));
    const originalAuthorize = authorizer.authorize;
    authorizer.authorize = async (workspaceId: string) => workspaceId === "workspace-1"
      ? originalAuthorize("workspace-blocked")
      : originalAuthorize(workspaceId);

    await assert.rejects(service.dispatchPending(), /temporarily unavailable/);
    assert.equal((await store.assignmentForResult(blocked.assignmentId)).status, "accepted");
    assert.equal((await store.assignmentForResult(ready.assignmentId)).status, "launched");
    assert.equal(adapter.launches.length, 1);
  });
});

test("T-TOOLS-01 the registered surface excludes destructive and generic capabilities", () => {
  assert.deepEqual([...REGISTERED_TOOL_NAMES], [
    "batches_create", "batches_get", "batches_status", "batches_results",
    "sessions_cancel", "batches_cancel", "batches_wait", "sessions_set_deadline", "deadlines_enforce",
    "recent_sessions", "reopen_batch", "recovery_diagnostics",
  ]);
  assertRegisteredToolNames([...REGISTERED_TOOL_NAMES]);

  for (const excluded of [
    "shell", "run_shell", "exec_command", "terminal_open", "bash_run", "eval_script",
    "workspaces_delete", "workspace_reset", "git_clean", "repo_checkout", "worktree_prune",
    "files_read", "filesystem_write", "fs_glob", "git_commit", "git_push",
    "env_get", "secrets_list", "credentials_read", "database_query", "state_edit",
    "processes_kill", "relay_send", "ssh_run", "packages_install", "plugins_register",
  ]) {
    assert.throws(() => assertSafeToolNames([excluded]), SecurityError, `${excluded} must be excluded`);
  }
});

test("T-TOOLS-02 the reviewed snapshot fails on any registration drift", () => {
  assert.throws(() => assertRegisteredToolNames([...REGISTERED_TOOL_NAMES, "batches_cancel"]), SecurityError);
  assert.throws(() => assertRegisteredToolNames(REGISTERED_TOOL_NAMES.slice(1)), SecurityError);
  assert.throws(() => assertRegisteredToolNames([...REGISTERED_TOOL_NAMES, "shell_exec"]), SecurityError);
});

test("state and audit files stay owner readable and writable only", async () => {
  await withStore(async (path) => {
    const store = new DurableStore(path);
    await store.appendSecurityAudit({
      requesterId: "client-1", operation: "sessions_launch", decision: "allowed",
      reasonCode: "launch_intent", correlationId: "operation-1",
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("state persistence fails closed on permissive directories and files", async () => {
  await withDirectory(async (base) => {
    const directory = join(base, "state");
    const path = join(directory, "state.json");
    await mkdir(directory, { mode: 0o755 });
    await assert.rejects(new DurableStore(path).reconcile(), (error: unknown) =>
      error instanceof SecurityError && error.code === "POLICY_DENIED");

    await chmod(directory, 0o700);
    await writeFile(path, "{}", { mode: 0o644 });
    await assert.rejects(new DurableStore(path).reconcile(), (error: unknown) =>
      error instanceof SecurityError && error.code === "POLICY_DENIED");
  });
});

test("state persistence fails closed on symlink and non-regular paths", async () => {
  await withDirectory(async (base) => {
    const privateDirectory = join(base, "private");
    const targetDirectory = join(base, "target");
    await mkdir(privateDirectory, { mode: 0o700 });
    await mkdir(targetDirectory, { mode: 0o700 });
    await symlink(targetDirectory, join(privateDirectory, "linked"), "dir");
    await assert.rejects(new DurableStore(join(privateDirectory, "linked", "state.json")).reconcile(),
      (error: unknown) => error instanceof SecurityError && error.code === "POLICY_DENIED");

    const target = join(privateDirectory, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, join(privateDirectory, "state.json"));
    await assert.rejects(new DurableStore(join(privateDirectory, "state.json")).reconcile(),
      (error: unknown) => error instanceof SecurityError && error.code === "POLICY_DENIED");

    await mkdir(join(privateDirectory, "nonregular.json"));
    await assert.rejects(new DurableStore(join(privateDirectory, "nonregular.json")).reconcile(),
      (error: unknown) => error instanceof SecurityError && error.code === "POLICY_DENIED");
  });
});

test("state persistence requires an absolute path", async () => {
  await assert.rejects(new DurableStore("relative-state.json").reconcile(),
    (error: unknown) => error instanceof SecurityError && error.code === "POLICY_DENIED");
});

function launchRequest(overrides: Partial<AsynchronousLaunchRequest> = {}): AsynchronousLaunchRequest {
  return {
    idempotencyKey: "operation-1",
    clientId: "desktop-client",
    batchName: "PER-345",
    attribution: { agent: "codex", task: "implement security controls" },
    prompt: "Implement the assignment",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function allowingAuthorizer(canonicalPath = "/base/project/worktrees/per-345") {
  return {
    authorize: async (workspaceId: string): Promise<WorkspaceGrant> => ({
      workspaceId, projectId: "project-1", canonicalPath, revalidate: async () => undefined,
    }),
  };
}

async function withStore(run: (path: string) => Promise<void>): Promise<void> {
  await withDirectory(async (base) => { await run(join(base, "state.json")); });
}

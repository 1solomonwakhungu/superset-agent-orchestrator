import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { OrchestratorStorage } from "../src/storage.js";
import { DurableStore } from "../src/store.js";
import { SupersetDiscoveryError, runProcess } from "../src/superset-discovery.js";
import { withTemporaryDirectory } from "./support/deterministic.js";

/**
 * Adversarial checks against the security controls the code actually
 * implements: child-process isolation, output bounds, least-privilege file
 * modes, parameterized persistence, and payload redaction. Every case runs
 * offline against the local Node binary; nothing reaches the network.
 */

const NODE = process.execPath;
const SECRET_VARIABLE = "SUPERSET_ORCHESTRATOR_TEST_SECRET";
const AT = "2026-07-01T00:00:00.000Z";
const posixOnly = { skip: process.platform === "win32" ? "POSIX file modes" : false };

/** Mirrors CHILD_ENVIRONMENT_ALLOWLIST in src/superset-discovery.ts. */
const ALLOWLISTED_CHILD_VARIABLES = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "LANG", "LC_ALL",
  "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
];

/**
 * Variables the platform or the Node runtime adds to every child regardless of
 * the env the parent supplies: macOS CoreFoundation injects the text-encoding
 * hint, and Node propagates NODE_V8_COVERAGE so subprocess coverage is written.
 * Their presence is not evidence that the allowlist leaked.
 */
const PLATFORM_INJECTED_VARIABLES = ["__CF_USER_TEXT_ENCODING", "NODE_V8_COVERAGE"];

test("discovery child processes inherit only allowlisted environment variables", async () => {
  const previous = process.env[SECRET_VARIABLE];
  const previousAwsSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env[SECRET_VARIABLE] = "must-not-leak";
  process.env.AWS_SECRET_ACCESS_KEY ??= "must-not-leak-either";
  try {
    const result = await runProcess(NODE, ["-e", "process.stdout.write(JSON.stringify(process.env))"], 10_000);
    assert.equal(result.exitCode, 0);
    const childEnvironment = JSON.parse(result.stdout) as Record<string, string>;

    assert.equal(childEnvironment[SECRET_VARIABLE], undefined, "ambient secrets must not reach a provider process");
    assert.equal(childEnvironment.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(childEnvironment.SUPERSET_ORCHESTRATOR_STATE, undefined);
    assert.equal(childEnvironment.PATH, process.env.PATH, "the allowlist still carries what execution requires");
    for (const name of Object.keys(childEnvironment)) {
      assert.ok(
        ALLOWLISTED_CHILD_VARIABLES.includes(name) || PLATFORM_INJECTED_VARIABLES.includes(name),
        `${name} is not on the child environment allowlist`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env[SECRET_VARIABLE];
    else process.env[SECRET_VARIABLE] = previous;
    if (previousAwsSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousAwsSecret;
  }
});

test("discovery arguments are never interpreted by a shell", async () => {
  const injected = "$(printf pwned); `printf pwned`; && printf pwned";
  const result = await runProcess(NODE, ["-e", "process.stdout.write(process.argv[1] ?? '')", injected], 10_000);
  assert.equal(result.stdout, injected, "arguments arrive verbatim, so metacharacters cannot execute");
  assert.equal(result.exitCode, 0);
});

test("discovery children cannot read the orchestrator's standard input", async () => {
  const result = await runProcess(
    NODE,
    ["-e", "let seen = ''; process.stdin.on('data', (chunk) => { seen += chunk; }); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ seen, tty: process.stdin.isTTY === true })));"],
    10_000,
  );
  assert.deepEqual(JSON.parse(result.stdout), { seen: "", tty: false });
});

test("oversized provider output is refused instead of buffered without bound", async () => {
  await assert.rejects(
    () => runProcess(NODE, ["-e", "process.stdout.write('x'.repeat(4 * 1024 * 1024 + 64))"], 20_000),
    (error: unknown) => error instanceof SupersetDiscoveryError && error.code === "MALFORMED_RESPONSE",
    "stdout above the supported limit is rejected",
  );
  await assert.rejects(
    () => runProcess(NODE, ["-e", "process.stderr.write('x'.repeat(4 * 1024 * 1024 + 64)); setInterval(() => {}, 1000);"], 20_000),
    (error: unknown) => error instanceof SupersetDiscoveryError && error.code === "MALFORMED_RESPONSE",
    "stderr above the supported limit is rejected and the child is killed",
  );
});

test("a provider process that never exits is killed at the deadline", async () => {
  await assert.rejects(
    () => runProcess(NODE, ["-e", "setInterval(() => {}, 1000);"], 500),
    (error: unknown) => error instanceof SupersetDiscoveryError && error.code === "TIMED_OUT",
  );
});

test("a missing provider executable fails closed as unavailable", async () => {
  await assert.rejects(
    () => runProcess(join("/", "nonexistent", "superset-binary"), ["--version"], 5_000),
    (error: unknown) => error instanceof SupersetDiscoveryError && error.code === "UNAVAILABLE",
  );
});

test("durable state is written with owner-only permissions", posixOnly, async () => {
  await withTemporaryDirectory("orchestrator-security", async (directory) => {
    const path = join(directory, "nested", "state.json");
    const store = new DurableStore(path);
    await store.createBatch("secure", "client-1", [{ agent: "codex", task: "one" }], undefined, new Date(AT));

    assert.equal((await stat(path)).mode & 0o777, 0o600, "the state file must not be world or group readable");
    const files = await readdirNames(join(directory, "nested"));
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "no temporary state file is left behind");
  });
});

test("the registry directory and its exports are owner-only", posixOnly, async () => {
  await withTemporaryDirectory("orchestrator-security", async (directory) => {
    const registryDirectory = join(directory, "registry");
    const storage = new OrchestratorStorage(join(registryDirectory, "registry.sqlite"));
    try {
      const exportPath = join(directory, "exports", "snapshot.json");
      storage.exportJson(exportPath);
      assert.equal((await stat(registryDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(exportPath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, "exports"))).mode & 0o777, 0o700);
    } finally {
      storage.close();
    }
  });
});

test("hostile identifiers are stored as data, never executed as SQL", async () => {
  await withTemporaryDirectory("orchestrator-security", async (directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      const hostileName = "'); DROP TABLE batches; --";
      storage.database.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("batch-1", hostileName, "solomon", "running", "{}", AT, AT, null);
      storage.appendEvent({
        aggregateType: "batch", aggregateId: "batch-1", eventType: "batch.created",
        actor: hostileName, data: { note: hostileName }, occurredAt: new Date(AT),
      });

      assert.equal(storage.database.prepare("SELECT name FROM batches WHERE id = 'batch-1'").get()?.name, hostileName);
      assert.equal(storage.database.prepare("SELECT COUNT(*) count FROM batches").get()?.count, 1,
        "the batches table survived a classic injection payload");
      assert.equal(storage.database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally {
      storage.close();
    }
  });
});

test("retention redacts prompts and result bodies from live rows and exports", async () => {
  await withTemporaryDirectory("orchestrator-security", async (directory) => {
    const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
    try {
      const secretPrompt = "SECRET-PROMPT-6f2b";
      const secretBody = "SECRET-OUTPUT-9d1c";
      storage.database.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("batch-1", "overnight", "solomon", "completed", "{}", AT, AT, AT);
      storage.database.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("assignment-1", "batch-1", "label", secretPrompt, "workspace-1", "PR", AT, null);
      storage.database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("session-1", "assignment-1", "superset", "backend-1", 1, "completed", AT, AT, AT);
      storage.database.prepare("INSERT INTO results VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("result-1", "session-1", secretBody, "[]", "completed", AT, null);

      const summary = storage.cleanup(new Date("2026-09-01T00:00:00.000Z"));
      assert.equal(summary.assignmentsRedacted, 1);
      assert.equal(summary.resultsRedacted, 1);

      const exportPath = join(directory, "snapshot.json");
      storage.exportJson(exportPath);
      const exported = await readFile(exportPath, "utf8");
      assert.equal(exported.includes(secretPrompt), false, "a redacted prompt must not survive in an export");
      assert.equal(exported.includes(secretBody), false);
      assert.ok(exported.includes("solomon"), "attribution is retained for accountability");
      assert.ok(exported.includes("retention.cleanup_completed"), "redaction is itself auditable");
    } finally {
      storage.close();
    }
  });
});

test("a corrupt registry is never silently replaced", async () => {
  await withTemporaryDirectory("orchestrator-security", async (directory) => {
    const path = join(directory, "registry.sqlite");
    const corrupt = Buffer.from("SQLite format 3  but not really");
    await writeFile(path, corrupt);
    assert.throws(() => new OrchestratorStorage(path), /Cannot open orchestrator registry/);
    assert.deepEqual(await readFile(path), corrupt);
  });
});

test("a refused idempotency conflict leaves durable state byte-identical", async () => {
  await withTemporaryDirectory("orchestrator-security", async (directory) => {
    const path = join(directory, "state.json");
    const store = new DurableStore(path);
    await store.createBatch("locked", "client-1", [{ agent: "codex", task: "one" }], "key-1", new Date(AT));

    const before = await readFile(path, "utf8");
    await assert.rejects(
      () => store.createBatch("locked", "client-1", [{ agent: "codex", task: "two" }], "key-1", new Date(AT)),
      /Idempotency key was already used/,
    );
    assert.equal(await readFile(path, "utf8"), before, "a refused write leaves the durable file byte-identical");
  });
});

async function readdirNames(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(directory);
}

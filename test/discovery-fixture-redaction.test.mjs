import assert from "node:assert/strict";
import test from "node:test";
import { createRedactor, sanitizeVersion } from "../scripts/record-discovery-fixture.mjs";

test("version sanitization accepts only the adapter's exact semantic version shape", () => {
  assert.equal(sanitizeVersion("1.16.1"), "1.16.1");
  assert.equal(sanitizeVersion("1.16.1\n"), "1.16.1");
  for (const malicious of [
    "1.16.1 SECRET",
    "1.16.1 /Users/secret",
    "1.16.1 https://example.invalid/?token=SECRET",
    "1.16.1\nSECRET",
    "1.16.1\r\n",
    "1.16.1-alpha",
    "1.16.1+build",
    `1.16.1${"0".repeat(40)}`,
  ]) assert.throws(() => sanitizeVersion(malicious), /semantic version/);
});

test("discovery fixture redaction is deterministic and removes seeded execution secrets", () => {
  const source = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "SECRET_NAME",
    path: "/Users/secret/private-worktree",
    repoCloneUrl: "https://token@github.com/private/repository.git?secret=yes",
    command: "/Users/secret/bin/SECRET_COMMAND",
    args: ["--token", "SECRET_ARGUMENT"],
    promptArgs: ["SECRET_PROMPT_ARGUMENT"],
    env: { SECRET_ENV_NAME: "SECRET_ENVIRONMENT" },
    endpoint: "http://secret-host.invalid:48707/?token=SECRET_QUERY",
    pid: 99999,
    port: 48707,
    uptimeSec: 12345,
    createdAt: "2026-07-25T01:02:03.000Z",
    updatedAt: "2026-07-25T01:02:03.000Z",
    type: "main",
    setUp: "yes",
    worktreeExists: true,
  };
  const original = JSON.parse(JSON.stringify(source));
  const first = createRedactor()(source);
  const second = createRedactor()(source);
  assert.deepEqual(first, second);
  assert.deepEqual(source, original);
  assert.match(first.id, /^00000000-0000-4000-8000-/);
  assert.match(first.command, /^recorded-command-1$/);
  assert.deepEqual(first.args, ["recorded-arg-1", "recorded-arg-2"]);
  assert.deepEqual(first.promptArgs, ["recorded-arg-3"]);
  assert.deepEqual(first.env, { "recorded-env-1": "recorded-value-1" });
  assert.equal(first.path, "/recorded/workspace-1");
  assert.match(first.repoCloneUrl, /^https:\/\/github\.com\/recorded-org\//);
  assert.equal(first.endpoint, "http://127.0.0.1:40001");
  assert.equal(first.pid, 1);
  assert.equal(first.port, 40001);
  assert.equal(first.uptimeSec, 1);
  assert.equal(first.createdAt, first.updatedAt);
  const serialized = JSON.stringify(first);
  for (const secret of ["SECRET_NAME", "SECRET_COMMAND", "SECRET_ARGUMENT", "SECRET_PROMPT_ARGUMENT", "SECRET_ENV_NAME", "SECRET_ENVIRONMENT", "secret-host", "SECRET_QUERY", "/Users/secret", "token@", "48707", "99999", "2026-07-25"] ) {
    assert.ok(!serialized.includes(secret), `redacted output leaked ${secret}`);
  }
});

test("discovery fixture redaction rejects every unclassified string at any depth", () => {
  for (const value of [
    { unknown: "SECRET_UNKNOWN" },
    { nested: { email: "secret@example.com" } },
    { nested: [{ privateUrl: "https://secret.invalid/?token=SECRET" }] },
  ]) {
    assert.throws(() => createRedactor()(value), /Unclassified discovery field/);
  }
  for (const value of [{ unknown: null }, { unknown: {} }, { unknown: [] }]) {
    assert.throws(() => createRedactor()(value), /Unclassified discovery field/);
  }
  assert.throws(() => createRedactor()({ env: { SECRET_OBJECT_KEY: { nested: "SECRET" } } }), /Unclassified non-string/);
});

test("discovery fixture redaction preserves equality relationships within classified domains", () => {
  const redacted = createRedactor()({
    args: ["same", "different", "same"],
    env: { FIRST: "same-value", SECOND: "different-value", THIRD: "same-value" },
  });
  assert.equal(redacted.args[0], redacted.args[2]);
  assert.notEqual(redacted.args[0], redacted.args[1]);
  const values = Object.values(redacted.env);
  assert.equal(values[0], values[2]);
  assert.notEqual(values[0], values[1]);
});

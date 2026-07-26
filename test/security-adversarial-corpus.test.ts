import assert from "node:assert/strict";
import test from "node:test";
import { agentPresetListSchema, projectListSchema, parseJson } from "../src/discovery-parser.js";

const baseProject = {
  id: "project", name: "fixture", slug: "fixture", repoCloneUrl: null,
  githubRepositoryId: null, setUp: "yes", path: "/tmp/fixture",
};

test("backend inventory rejects unknown and prototype-bearing fields", () => {
  const hostile = JSON.stringify([{ ...baseProject, remote: true }]);
  assert.throws(() => parseJson(hostile, projectListSchema));
  const prototypeKey = `[{"id":"project","name":"fixture","slug":"fixture","repoCloneUrl":null,"githubRepositoryId":null,"setUp":"yes","path":"/tmp/fixture","__proto__":{"polluted":true}}]`;
  const parsed = parseJson(prototypeKey, projectListSchema);
  assert.equal(Object.hasOwn(parsed[0]!, "__proto__"), false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("backend inventory rejects oversized strings and collections", () => {
  assert.throws(() => projectListSchema.parse([{ ...baseProject, name: "x".repeat(4_097) }]));
  assert.throws(() => projectListSchema.parse(Array.from({ length: 10_001 }, () => baseProject)));
});

test("malformed backend corpus never echoes synthetic secret payloads", () => {
  const secret = "ghp_PER348_NOT_REAL_0123456789";
  for (const payload of [secret, `{"id":"${secret}"`, `[] trailing ${secret}`]) {
    assert.throws(() => parseJson(payload, projectListSchema), (error: unknown) => {
      assert.equal((error as Error).message.includes(secret), false);
      return true;
    });
  }
});

test("hostile command fields remain inert parsed data", () => {
  const hostile = ["--help", "../outside", "$(touch /tmp/per-348)", "line\nbreak", "prototype"];
  for (const command of hostile) {
    const parsed = agentPresetListSchema.parse([{
      id: "preset", presetId: "fixture", label: "fixture", command,
      args: ["--", command], promptTransport: "stdin", env: { VALUE: command },
    }]);
    assert.equal(parsed[0]?.command, command);
    assert.deepEqual(parsed[0]?.args, ["--", command]);
    assert.equal(parsed[0]?.env?.VALUE, command);
  }
  assert.throws(() => agentPresetListSchema.parse([{
    id: "preset", presetId: "fixture", label: "fixture", command: "bad\0command",
  }]));
});

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter, RunResult } from "../src/agent-adapter.js";
import { FakeAgentAdapter, type FakeRunScript } from "../src/fake-agent-adapter.js";

const terminalScripts: FakeRunScript[] = [
  { statuses: ["queued", "running", "succeeded"], result: { status: "succeeded", output: "done" } },
  { statuses: ["running", "failed"], result: { status: "failed", error: "boom", retryable: true } },
  { statuses: ["cancelled"], result: { status: "cancelled", reason: "upstream stopped" } },
];

async function runToCompletion(adapter: AgentAdapter, prompt: string): Promise<RunResult> {
  const handle = await adapter.launch({ prompt, workspacePath: "/workspace" });
  let state = await adapter.status(handle);
  while (state.status === "queued" || state.status === "running") state = await adapter.status(handle);
  const result = await adapter.result(handle);
  assert.ok(result);
  return result;
}

test("drives every terminal path deterministically", async () => {
  const adapter = new FakeAgentAdapter(terminalScripts, () => "2026-07-24T12:00:00.000Z");
  const results: RunResult[] = [];

  for (let index = 0; index < terminalScripts.length; index += 1) {
    results.push(await runToCompletion(adapter, `task ${index}`));
  }

  assert.deepEqual(results, terminalScripts.map(({ result }) => result));
  assert.deepEqual(adapter.launches.map(({ prompt }) => prompt), ["task 0", "task 1", "task 2"]);
});

test("supports cancellation and resume metadata", async () => {
  const resume = { adapter: "fake", token: "resume-1" };
  const adapter = new FakeAgentAdapter([
    { statuses: ["queued", "running", "succeeded"], result: { status: "succeeded", output: "unreachable" }, resume },
  ]);
  const handle = await adapter.launch({ prompt: "task", workspacePath: "/workspace" });

  assert.equal(await adapter.result(handle), undefined);
  await adapter.cancel(handle, "operator request");

  assert.equal((await adapter.status(handle)).status, "cancelled");
  assert.deepEqual(await adapter.result(handle), { status: "cancelled", reason: "operator request" });
  assert.deepEqual(await adapter.resumeMetadata(handle), resume);
  assert.deepEqual(adapter.cancellations, [{ runId: "fake-1", reason: "operator request" }]);
});

test("rejects missing scripts and unknown handles", async () => {
  const adapter = new FakeAgentAdapter([]);
  await assert.rejects(adapter.launch({ prompt: "task", workspacePath: "/workspace" }), /No fake run script/);
  await assert.rejects(adapter.status({ runId: "missing" }), /Unknown fake run/);
});

test("rejects invalid lifecycle scripts", async () => {
  const nonTerminal = new FakeAgentAdapter([
    { statuses: ["running"], result: { status: "succeeded", output: "done" } },
  ]);
  await assert.rejects(nonTerminal.launch({ prompt: "task", workspacePath: "/workspace" }), /must end/);

  const mismatch = new FakeAgentAdapter([
    { statuses: ["failed"], result: { status: "succeeded", output: "done" } },
  ]);
  await assert.rejects(mismatch.launch({ prompt: "task", workspacePath: "/workspace" }), /result is succeeded/);

  const regression = new FakeAgentAdapter([
    { statuses: ["succeeded", "failed"], result: { status: "failed", error: "boom", retryable: false } },
  ]);
  await assert.rejects(regression.launch({ prompt: "task", workspacePath: "/workspace" }), /cannot transition/);
});

test("does not overwrite a completed run with late cancellation", async () => {
  const adapter = new FakeAgentAdapter([
    { statuses: ["succeeded"], result: { status: "succeeded", output: "done" } },
  ]);
  const handle = await adapter.launch({ prompt: "task", workspacePath: "/workspace" });
  await adapter.status(handle);
  await adapter.cancel(handle, "too late");

  assert.deepEqual(await adapter.result(handle), { status: "succeeded", output: "done" });
  assert.deepEqual(adapter.cancellations, []);
});

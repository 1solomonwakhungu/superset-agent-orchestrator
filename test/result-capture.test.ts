import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchService, type AsynchronousLaunchRequest } from "../src/launch-service.js";
import { ResultCaptureService, type ResultDelivery } from "../src/result-capture.js";
import { DurableStore, type DurableState } from "../src/store.js";

const request: AsynchronousLaunchRequest = {
  idempotencyKey: "capture-1",
  clientId: "client-1",
  batchName: "PER-340",
  attribution: { agent: "codex", task: "capture exact response" },
  prompt: "Return an exact result",
  workspaceId: "workspace-340",
  workspacePath: "/workspace/per-340",
};

async function fixture(result = { status: "succeeded", output: "exact answer" } as const) {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-result-"));
  const path = join(directory, "state.json");
  const store = new DurableStore(path);
  const adapter = new FakeAgentAdapter([{ statuses: ["succeeded"], result }]);
  const launch = new LaunchService(store, adapter);
  const accepted = await launch.accept(request);
  await launch.dispatchPending();
  return { directory, path, store, adapter, accepted };
}

test("collects an exact adapter claim with immutable attribution and no verified artifacts", async () => {
  const context = await fixture();
  try {
    const captured = await new ResultCaptureService(context.store, context.adapter)
      .collect(context.accepted.assignmentId, "delivery-1");
    assert.equal(captured.duplicate, false);
    assert.deepEqual(captured.result?.claim, { status: "succeeded", completeness: "complete", output: "exact answer" });
    assert.deepEqual(captured.result?.verifiedArtifacts, []);
    assert.equal(captured.result?.assignmentId, context.accepted.assignmentId);
    assert.equal(captured.result?.sessionId, context.accepted.sessionId);
    assert.equal(captured.result?.batchId, context.accepted.batchId);
    assert.equal(captured.result?.workspaceId, request.workspaceId);
    assert.equal(captured.result?.attempt, 1);
    assert.match(captured.result?.attemptId ?? "", /^attempt_[a-f0-9]{24}$/);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("normalizes empty, partial, malformed, and stopped-without-result deliveries", async () => {
  const cases: Array<[ResultDelivery, object]> = [
    [{ kind: "adapter_result", result: { status: "succeeded", output: "" } },
      { status: "succeeded", completeness: "empty", output: "" }],
    [{ kind: "adapter_result", result: { status: "failed", error: "boom", retryable: false, output: "partial" } },
      { status: "failed", completeness: "partial", error: "boom", retryable: false, output: "partial" }],
    [{ kind: "adapter_result", result: { status: "cancelled", reason: "operator" } },
      { status: "cancelled", completeness: "missing", stopReason: "operator" }],
    [{ kind: "stopped_without_result", status: "failed", stopReason: "process exited" },
      { status: "stopped_without_result", completeness: "missing", stopReason: "process exited" }],
    [{ kind: "malformed", error: "bad provider payload" },
      { status: "malformed", completeness: "malformed", error: "bad provider payload" }],
  ];
  for (const [index, [delivery, expected]] of cases.entries()) {
    const context = await fixture();
    try {
      const captured = await new ResultCaptureService(context.store, context.adapter)
        .ingest(context.accepted.assignmentId, `delivery-${index}`, delivery);
      assert.deepEqual(captured.result.claim, expected);
    } finally {
      await rm(context.directory, { recursive: true, force: true });
    }
  }
});

test("makes duplicate and late delivery idempotent and rejects conflicts", async () => {
  const context = await fixture();
  try {
    const firstService = new ResultCaptureService(context.store, context.adapter);
    const delivery = { kind: "adapter_result", result: { status: "succeeded", output: "same" } } as const;
    const first = await firstService.ingest(context.accepted.assignmentId, "delivery-1", delivery);
    const duplicate = await new ResultCaptureService(new DurableStore(context.path), context.adapter)
      .ingest(context.accepted.assignmentId, "delivery-1", delivery);
    const late = await new ResultCaptureService(new DurableStore(context.path), context.adapter)
      .ingest(context.accepted.assignmentId, "delivery-late", delivery);

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(late.duplicate, true);
    assert.equal((JSON.parse(await readFile(context.path, "utf8")) as DurableState).capturedResults?.length, 1);
    await assert.rejects(
      firstService.ingest(context.accepted.assignmentId, "delivery-1", {
        kind: "adapter_result", result: { status: "succeeded", output: "changed" },
      }),
      /conflicts with its first payload/,
    );
    await assert.rejects(
      firstService.ingest(context.accepted.assignmentId, "delivery-conflict", {
        kind: "adapter_result", result: { status: "failed", error: "late conflict", retryable: false },
      }),
      /already has a different authoritative result/,
    );
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("concurrent conflicting deliveries persist exactly one authoritative result", async () => {
  const context = await fixture();
  try {
    const deliveries = [
      { kind: "adapter_result", result: { status: "succeeded", output: "winner-a" } } as const,
      { kind: "adapter_result", result: { status: "failed", error: "winner-b", retryable: false } } as const,
    ];
    const settled = await Promise.allSettled(deliveries.map((delivery, index) =>
      new ResultCaptureService(new DurableStore(context.path), context.adapter)
        .ingest(context.accepted.assignmentId, `racing-delivery-${index}`, delivery)));

    assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
    const state = JSON.parse(await readFile(context.path, "utf8")) as DurableState;
    assert.equal(state.capturedResults?.length, 1);
    assert.match(state.capturedResults?.[0]?.deliveryId ?? "", /^racing-delivery-[01]$/);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("does not capture a nonterminal adapter result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-result-"));
  try {
    const path = join(directory, "state.json");
    const store = new DurableStore(path);
    const adapter = new FakeAgentAdapter([{
      statuses: ["running", "succeeded"], result: { status: "succeeded", output: "later" },
    }]);
    const launch = new LaunchService(store, adapter);
    const accepted = await launch.accept(request);
    await launch.dispatchPending();
    const collected = await new ResultCaptureService(store, adapter).collect(accepted.assignmentId, "delivery-1");
    assert.deepEqual(collected, { duplicate: false });
    assert.equal((JSON.parse(await readFile(path, "utf8")) as DurableState).capturedResults?.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("records terminal adapter absence as stopped without result", async () => {
  const context = await fixture();
  try {
    context.adapter.result = async () => undefined;
    const captured = await new ResultCaptureService(context.store, context.adapter)
      .collect(context.accepted.assignmentId, "delivery-missing");
    assert.deepEqual(captured.result?.claim, { status: "stopped_without_result", completeness: "missing" });
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("records malformed adapter results and terminal status mismatches without inventing output", async () => {
  const malformed = await fixture();
  try {
    malformed.adapter.result = async () => { throw new Error("invalid provider payload"); };
    const captured = await new ResultCaptureService(malformed.store, malformed.adapter)
      .collect(malformed.accepted.assignmentId, "delivery-malformed");
    assert.deepEqual(captured.result?.claim, {
      status: "malformed", completeness: "malformed", error: "invalid provider payload",
    });
  } finally {
    await rm(malformed.directory, { recursive: true, force: true });
  }

  const mismatch = await fixture();
  try {
    mismatch.adapter.result = async () => ({ status: "failed", error: "conflict", retryable: false });
    const captured = await new ResultCaptureService(mismatch.store, mismatch.adapter)
      .collect(mismatch.accepted.assignmentId, "delivery-mismatch");
    assert.deepEqual(captured.result?.claim, {
      status: "malformed",
      completeness: "malformed",
      error: 'Adapter result status "failed" did not match observed status "succeeded"',
    });
  } finally {
    await rm(mismatch.directory, { recursive: true, force: true });
  }
});

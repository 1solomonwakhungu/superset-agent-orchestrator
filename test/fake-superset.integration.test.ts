import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LaunchService, type LaunchAcceptance } from "../src/launch-service.js";
import { ResultCaptureService } from "../src/result-capture.js";
import { DurableStore } from "../src/store.js";
import { SupersetProcessAdapter, SupersetProcessError } from "../src/superset-process-adapter.js";

const fixture = resolve("test/fixtures/fake-superset.mjs");
const now = () => new Date("2000-01-01T00:00:00.000Z");

test("fake Superset proves completion, failure, cancellation, restart recovery, and exact attribution", async () => {
  await withHarness({
    scripts: [
      { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "exact answer" } },
      { statuses: ["failed"], result: { status: "failed", error: "agent failed", retryable: false } },
      { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "too late" } },
    ],
  }, async ({ adapter, statePath, calls }) => {
    const store = new DurableStore(statePath);
    const launches = new LaunchService(store, adapter, now);
    const accepted: LaunchAcceptance[] = [];
    for (const [index, task] of ["complete", "fail", "cancel"].entries()) {
      accepted.push(await launches.accept(request(index, task)));
    }
    await launches.dispatchPending();
    const [completeAcceptance, failAcceptance, cancelAcceptance] = accepted;
    assert.ok(completeAcceptance && failAcceptance && cancelAcceptance);

    const restartedStore = new DurableStore(statePath);
    const restartedAdapter = adapter.restart();
    const capture = new ResultCaptureService(restartedStore, restartedAdapter, now);
    await capture.collect(completeAcceptance.assignmentId, "delivery-complete-pending");
    const completed = await capture.collect(completeAcceptance.assignmentId, "delivery-complete");
    const failed = await capture.collect(failAcceptance.assignmentId, "delivery-failed");
    const cancelAssignment = await restartedStore.assignmentForResult(cancelAcceptance.assignmentId);
    await restartedAdapter.cancel({ runId: cancelAssignment.runId! }, "operator request");
    const cancelled = await capture.collect(cancelAcceptance.assignmentId, "delivery-cancelled");

    assert.equal(completed.result?.claim.output, "exact answer");
    assert.equal(failed.result?.claim.error, "agent failed");
    assert.equal(cancelled.result?.claim.stopReason, "operator request");
    assert.deepEqual(completed.result?.attribution, { agent: "agent-0", task: "complete" });
    assert.equal(completed.result?.workspaceId, "workspace-0");
    const freshStore = new DurableStore(statePath);
    await freshStore.assignmentForResult(completeAcceptance.assignmentId);
    const persisted = freshStore.snapshot().capturedResults ?? [];
    assert.equal(persisted.length, 3);
    for (const [index, result] of persisted.entries()) {
      const acceptedLaunch = accepted[index];
      assert.ok(acceptedLaunch);
      assert.equal(result.assignmentId, acceptedLaunch.assignmentId);
      assert.equal(result.batchId, acceptedLaunch.batchId);
      assert.equal(result.sessionId, acceptedLaunch.sessionId);
      assert.equal(result.workspaceId, `workspace-${index}`);
      assert.equal(result.workspacePath, `/workspaces/${index}`);
      assert.equal(result.attempt, 1);
      assert.match(result.attemptId, /^attempt_/);
      assert.match(result.runId, /^fake-/);
    }
    assert.equal((await calls()).filter(({ command }) => command === "launch").length, 3);
  });
});

test("fake Superset timeout and malformed output fail deterministically without retries", async () => {
  for (const [scenario, expectedCode] of [
    [{ hangCommands: ["status"], defaultScript: successScript() }, "PROVIDER_UNAVAILABLE"],
    [{ malformedCommands: ["status"], defaultScript: successScript() }, "PROVIDER_PROTOCOL_ERROR"],
  ] as const) {
    await withHarness(scenario, async ({ adapter, calls }) => {
      const handle = await adapter.launch({ idempotencyKey: "one", prompt: "one", workspacePath: "/tmp/one" });
      await assert.rejects(adapter.status(handle), (error: unknown) => {
        assert.equal(error instanceof SupersetProcessError && error.code, expectedCode);
        return true;
      });
      assert.equal((await calls()).filter(({ command }) => command === "status").length, 1);
    }, 250);
  }
});

test("fake Superset covers every process adapter typed error", async () => {
  const cases = [
    [{ launchError: "rejected", defaultScript: successScript() }, "launch", "LAUNCH_REJECTED"],
    [{ cancelUnsupported: true, defaultScript: successScript() }, "cancel", "CANCEL_UNSUPPORTED"],
    [{ malformedCommands: ["find"], defaultScript: successScript() }, "find", "PROVIDER_PROTOCOL_ERROR"],
  ] as const;
  for (const [scenario, operation, code] of cases) {
    await withHarness(scenario, async ({ adapter, calls }) => {
      await assert.rejects(async () => {
        if (operation === "launch") await adapter.launch({ idempotencyKey: "one", prompt: "one", workspacePath: "/tmp/one" });
        if (operation === "find") await adapter.findByIdempotencyKey("one");
        if (operation === "cancel") {
          const handle = await adapter.launch({ idempotencyKey: "one", prompt: "one", workspacePath: "/tmp/one" });
          await adapter.cancel(handle);
        }
      }, (error: unknown) => {
        assert.equal(error instanceof SupersetProcessError && error.code, code);
        return true;
      });
      assert.equal((await calls()).filter(({ command }) => command === operation).length, 1);
    });
  }
});

test("provider requests use stdin, exclude ambient secrets and proxy credentials, and redact diagnostics", async () => {
  const secret = "provider-secret-canary";
  const proxySecret = "http://user:password@proxy.invalid";
  process.env.PROVIDER_SECRET_CANARY = secret;
  process.env.HTTPS_PROXY = proxySecret;
  try {
    await withHarness({
      launchError: secret,
      captureEnvironment: ["PROVIDER_SECRET_CANARY", "HTTPS_PROXY"],
      defaultScript: successScript(),
    }, async ({ adapter, calls }) => {
      const prompt = "p".repeat(200_000);
      await assert.rejects(
        adapter.launch({ idempotencyKey: "large", prompt, workspacePath: "/tmp/large" }),
        (error: unknown) => {
          assert.equal(error instanceof SupersetProcessError && error.code, "LAUNCH_REJECTED");
          assert.equal(error instanceof Error && error.message.includes(secret), false);
          return true;
        },
      );
      const [call] = await calls();
      assert.ok(call);
      assert.equal(call.payload.prompt.length, 200_000);
      assert.equal(call.argv.includes(prompt), false);
      assert.equal(call.environment.PROVIDER_SECRET_CANARY, undefined);
      assert.equal(call.environment.HTTPS_PROXY, undefined);
    });

    await withHarness({
      malformedCommands: ["find"], malformedStderr: secret, defaultScript: successScript(),
    }, async ({ adapter }) => {
      await assert.rejects(adapter.findByIdempotencyKey("one"), (error: unknown) => {
        assert.equal(error instanceof SupersetProcessError && error.code, "PROVIDER_PROTOCOL_ERROR");
        assert.equal(error instanceof Error && error.message.includes(secret), false);
        return true;
      });
    });
  } finally {
    delete process.env.PROVIDER_SECRET_CANARY;
    delete process.env.HTTPS_PROXY;
  }
});

test("fake Superset serializes concurrent provider state transactions", async () => {
  await withHarness({ defaultScript: successScript() }, async ({ adapter, calls }) => {
    const handles = await Promise.all(Array.from({ length: 40 }, (_, index) => adapter.launch({
      idempotencyKey: `concurrent-${index}`,
      prompt: `prompt-${index}`,
      workspacePath: `/tmp/${index}`,
    })));
    assert.equal(new Set(handles.map(({ runId }) => runId)).size, 40);
    assert.equal((await calls()).filter(({ command }) => command === "launch").length, 40);
  });
});

test("fake Superset completes and attributes a deterministic 100-session batch", async () => {
  await withHarness({ defaultScript: successScript() }, async ({ adapter, statePath, calls }) => {
    const store = new DurableStore(statePath);
    const launches = new LaunchService(store, adapter, now);
    const accepted = await launches.acceptBatch({
      idempotencyKey: "batch-100", clientId: "integration", batchName: "fake-superset",
      assignments: Array.from({ length: 100 }, (_, index) => {
        const { clientId: _clientId, batchName: _batchName, ...assignment } = request(index, `task-${index}`);
        return assignment;
      }),
    });
    assert.equal(new Set(accepted.map(({ batchId }) => batchId)).size, 1);
    await launches.dispatchPending();
    const capture = new ResultCaptureService(store, adapter, now);
    for (const item of accepted) await capture.collect(item.assignmentId, `delivery-${item.assignmentId}`);
    const results = store.snapshot().capturedResults ?? [];
    assert.equal(results.length, 100);
    assert.equal(new Set(results.map(({ runId }) => runId)).size, 100);
    for (const [index, result] of results.entries()) {
      assert.deepEqual(result.attribution, { agent: `agent-${index}`, task: `task-${index}` });
      assert.equal(result.workspaceId, `workspace-${index}`);
      assert.equal(result.claim.output, "ok");
    }
    assert.equal((await calls()).filter(({ command }) => command === "launch").length, 100);
  });
});

function request(index: number, task: string) {
  return {
    idempotencyKey: `key-${index}`, clientId: "integration", batchName: "fake-superset",
    attribution: { agent: `agent-${index}`, task }, prompt: `prompt-${index}`,
    workspaceId: `workspace-${index}`, workspacePath: `/workspaces/${index}`,
  };
}

function successScript() {
  return { statuses: ["succeeded"], result: { status: "succeeded", output: "ok" } };
}

async function withHarness(
  scenario: object,
  run: (harness: {
    adapter: SupersetProcessAdapter & { restart(): SupersetProcessAdapter };
    statePath: string;
    calls(): Promise<Array<{
      command: string;
      payload: any;
      argv: string[];
      environment: Record<string, string | undefined>;
    }>>;
  }) => Promise<void>,
  timeoutMs = 10_000,
) {
  const directory = await mkdtemp(join(tmpdir(), "fake-superset-integration-"));
  const scenarioPath = join(directory, "scenario.json");
  const fakeStatePath = join(directory, "fake-state.json");
  const statePath = join(directory, "orchestrator-state.json");
  await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
  const makeAdapter = () => new SupersetProcessAdapter({
    executable: process.execPath,
    args: [fixture, scenarioPath, fakeStatePath],
    timeoutMs,
  });
  const adapter = makeAdapter() as SupersetProcessAdapter & { restart(): SupersetProcessAdapter };
  adapter.restart = makeAdapter;
  const calls = async () => {
    const state = JSON.parse(await readFile(fakeStatePath, "utf8")) as { calls: Array<{
      command: string;
      payload: any;
      argv: string[];
      environment: Record<string, string | undefined>;
    }> };
    return state.calls;
  };
  try {
    await run({ adapter, statePath, calls });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

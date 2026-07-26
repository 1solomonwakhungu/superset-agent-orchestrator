import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LaunchService, type LaunchAcceptance } from "../src/launch-service.js";
import { LifecycleService } from "../src/lifecycle-service.js";
import { ResultCaptureService } from "../src/result-capture.js";
import { DurableStore } from "../src/store.js";
import { SupersetProcessAdapter, SupersetProcessError } from "../src/superset-process-adapter.js";
import type { WorkspaceAuthorizer } from "../src/security.js";

const fixture = resolve("test/fixtures/fake-superset.mjs");
const now = () => new Date("2000-01-01T00:00:00.000Z");
const authorizer: WorkspaceAuthorizer = {
  authorize: async (workspaceId) => ({
    workspaceId, projectId: "fake-project", canonicalPath: `/workspaces/${workspaceId.slice("workspace-".length)}`,
    revalidate: async () => undefined,
  }),
};
test("fake Superset proves completion, failure, cancellation, restart recovery, and exact attribution", async () => {
  await withHarness({
    scripts: [
      { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "exact answer" } },
      { statuses: ["failed"], result: { status: "failed", error: "agent failed", retryable: false } },
      { statuses: ["running", "succeeded"], result: { status: "succeeded", output: "too late" } },
    ],
  }, async ({ adapter, statePath, calls }) => {
    const store = new DurableStore(statePath);
    const launches = new LaunchService(store, adapter, authorizer, now);
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
  for (const [scenario, expectedCode, timeoutMs] of [
    [{ hangCommands: ["status"], defaultScript: successScript() }, "PROVIDER_UNAVAILABLE", 2_000],
    [{ malformedCommands: ["status"], defaultScript: successScript() }, "PROVIDER_PROTOCOL_ERROR", 10_000],
  ] as const) {
    await withHarness(scenario, async ({ adapter, calls }) => {
      const handle = await adapter.launch(adapterRequest("one", "one", "/tmp/one"));
      await assert.rejects(async () => adapter.status(handle), (error: unknown) => {
        assert.equal(error instanceof SupersetProcessError && error.code, expectedCode);
        return true;
      });
      assert.equal((await calls()).filter(({ command }) => command === "status").length, 1);
    }, timeoutMs);
  }
});

test("caller cancellation kills a hung fake Superset process that ignores termination", async () => {
  await withHarness({ hangCommands: ["status"], ignoreTermination: true, defaultScript: successScript() }, async ({ adapter }) => {
    const handle = await adapter.launch(adapterRequest("abort", "abort", "/tmp/abort"));
    const controller = new AbortController();
    const reason = new Error("lifecycle deadline exceeded");
    const startedAt = Date.now();
    const status = adapter.status(handle, controller.signal);
    setTimeout(() => controller.abort(reason), 50).unref();

    await assert.rejects(status, (error: unknown) => error === reason);
    assert.ok(Date.now() - startedAt < 2_000, "provider process survived cancellation escalation");
  }, 10_000);
});

test("accepted launches recover after one-shot timeout and malformed responses without duplicate execution", async () => {
  for (const action of ["hang", "malformed"] as const) {
    await withHarness({
      faults: [{ id: `first-launch-${action}`, command: "launch", occurrence: 1, action }],
      defaultScript: successScript(),
    }, async ({ adapter, statePath, fakeState, calls }) => {
      const store = new DurableStore(statePath);
      const accepted = await new LaunchService(store, adapter, authorizer, now).accept(request(0, action));

      await new LaunchService(store, adapter, authorizer, now).dispatchPending();
      assert.equal(Object.keys((await fakeState()).runs).length, 1);

      const restartedStore = new DurableStore(statePath);
      await new LaunchService(restartedStore, adapter.restart(10_000), authorizer, now).dispatchPending();
      const assignment = await restartedStore.assignmentForResult(accepted.assignmentId);
      assert.equal(assignment.status, "launched");
      assert.equal(assignment.runId, "fake-001");

      const ledger = await calls();
      assert.deepEqual(ledger.map(({ command }) => command), ["launch", "find"]);
      assert.deepEqual(ledger[0]?.fault, { id: `first-launch-${action}`, action });
      assert.deepEqual(ledger[0]?.response, { runId: "fake-001" });
      assert.equal(Object.keys((await fakeState()).runs).length, 1);
    }, action === "hang" ? 2_000 : 10_000);
  }
});

test("fake Superset covers every process adapter typed error", async () => {
  const cases = [
    [{ launchError: "rejected", defaultScript: successScript() }, "launch", "LAUNCH_REJECTED"],
    [{ malformedCommands: ["find"], defaultScript: successScript() }, "find", "PROVIDER_PROTOCOL_ERROR"],
  ] as const;
  for (const [scenario, operation, code] of cases) {
    await withHarness(scenario, async ({ adapter, calls }) => {
      await assert.rejects(async () => {
        if (operation === "launch") await adapter.launch(adapterRequest("one", "one", "/tmp/one"));
        if (operation === "find") await adapter.findByIdempotencyKey("one");
      }, (error: unknown) => {
        assert.equal(error instanceof SupersetProcessError && error.code, code);
        return true;
      });
      assert.equal((await calls()).filter(({ command }) => command === operation).length, 1);
    });
  }
});

test("fake Superset rolls back durable cancellation when the provider reports it unsupported", async () => {
  await withHarness({ cancelUnsupported: true, defaultScript: successScript() }, async ({ adapter, statePath, calls }) => {
    const store = new DurableStore(statePath);
    const launches = new LaunchService(store, adapter, authorizer, now);
    const accepted = await launches.accept(request(0, "unsupported-cancel"));
    await launches.dispatchPending();
    const before = await store.worker(accepted.sessionId);

    const outcome = await new LifecycleService(store, adapter).cancelSession(
      accepted.sessionId,
      "user_requested",
      "operator request",
    );

    assert.deepEqual(outcome, {
      sessionId: accepted.sessionId,
      error: "CANCEL_UNSUPPORTED",
      message: "The backend rejected cancellation as unsupported",
      status: before?.status,
    });
    const restored = await store.worker(accepted.sessionId);
    assert.equal(restored?.status, before?.status);
    assert.equal(restored?.cancelRequestedAt, undefined);
    assert.equal(restored?.cancellationDeliveryPending, undefined);
    assert.equal(restored?.stopReason, undefined);
    assert.equal(restored?.stopDetail, undefined);
    assert.equal((await calls()).filter(({ command }) => command === "cancel").length, 1);
  });
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
        adapter.launch(adapterRequest("large", prompt, "/tmp/large")),
        (error: unknown) => {
          assert.equal(error instanceof SupersetProcessError && error.code, "LAUNCH_REJECTED");
          assert.equal(error instanceof Error && error.message.includes(secret), false);
          return true;
        },
      );
      const [call] = await calls();
      assert.ok(call);
      assert.equal(call.payload.prompt?.length, 200_000);
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
    const handles = await Promise.all(Array.from({ length: 40 }, (_, index) =>
      adapter.launch(adapterRequest(`concurrent-${index}`, `prompt-${index}`, `/tmp/${index}`))));
    assert.equal(new Set(handles.map(({ runId }) => runId)).size, 40);
    assert.equal((await calls()).filter(({ command }) => command === "launch").length, 40);
  });
});

test("fake Superset deduplicates concurrent launches with the same provider key", async () => {
  await withHarness({ defaultScript: successScript() }, async ({ adapter, fakeState, calls }) => {
    const handles = await Promise.all(Array.from({ length: 40 }, () =>
      adapter.launch(adapterRequest("same-key", "same prompt", "/tmp/same"))));
    assert.deepEqual(new Set(handles.map(({ runId }) => runId)), new Set(["fake-001"]));
    assert.equal(Object.keys((await fakeState()).runs).length, 1);
    assert.equal((await calls()).filter(({ command }) => command === "launch").length, 40);
    assert.deepEqual(await adapter.findByIdempotencyKey("same-key"), { runId: "fake-001" });
  });
});

test("fake Superset completes and attributes a deterministic 100-session batch", async () => {
  await withHarness({ defaultScript: successScript() }, async ({ adapter, statePath, calls }) => {
    const store = new DurableStore(statePath);
    const launches = new LaunchService(store, adapter, authorizer, now);
    const accepted = await launches.acceptBatch({
      idempotencyKey: "batch-100", clientId: "integration", batchName: "fake-superset",
      assignments: Array.from({ length: 100 }, (_, index) => {
        const item = request(index, `task-${index}`);
        return {
          idempotencyKey: item.idempotencyKey,
          attribution: item.attribution,
          prompt: item.prompt,
          workspaceId: item.workspaceId,
        };
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
    workspaceId: `workspace-${index}`,
  };
}

function successScript() {
  return { statuses: ["succeeded"], result: { status: "succeeded", output: "ok" } };
}

function adapterRequest(idempotencyKey: string, prompt: string, workspacePath: string) {
  return { idempotencyKey, prompt, workspacePath, environment: {}, revalidateWorkspace: async () => undefined };
}

async function withHarness(
  scenario: object,
  run: (harness: {
    adapter: SupersetProcessAdapter & { restart(timeoutMs?: number): SupersetProcessAdapter };
    statePath: string;
    calls: () => Promise<Array<{
      command: string;
      payload: { prompt?: string };
      argv: string[];
      environment: Record<string, string | undefined>;
      response?: unknown;
      failure?: unknown;
      fault?: { id: string; action: string };
    }>>;
    fakeState: () => Promise<{ runs: Record<string, unknown> }>;
  }) => Promise<void>,
  timeoutMs = 10_000,
) {
  const directory = await mkdtemp(join(tmpdir(), "fake-superset-integration-"));
  const scenarioPath = join(directory, "scenario.json");
  const fakeStatePath = join(directory, "fake-state.json");
  const statePath = join(directory, "orchestrator-state.json");
  await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
  const makeAdapter = (adapterTimeoutMs = timeoutMs) => new SupersetProcessAdapter({
    executable: process.execPath,
    args: [fixture, scenarioPath, fakeStatePath],
    timeoutMs: adapterTimeoutMs,
  });
  const adapter = makeAdapter() as SupersetProcessAdapter & { restart(timeoutMs?: number): SupersetProcessAdapter };
  adapter.restart = makeAdapter;
  const readFakeState = async () => JSON.parse(await readFile(fakeStatePath, "utf8")) as {
    runs: Record<string, unknown>;
    calls: Array<{
      command: string;
      payload: { prompt?: string };
      argv: string[];
      environment: Record<string, string | undefined>;
      response?: unknown;
      failure?: unknown;
      fault?: { id: string; action: string };
    }>;
  };
  const calls = async () => (await readFakeState()).calls;
  try {
    await run({ adapter, statePath, calls, fakeState: readFakeState });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

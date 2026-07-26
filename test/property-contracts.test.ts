import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import type { LaunchRequest } from "../src/agent-adapter.js";
import { FakeAgentAdapter, type FakeRunScript } from "../src/fake-agent-adapter.js";
import { DurableStore, type LaunchStatus } from "../src/store.js";

const propertyOptions = { seed: 346, numRuns: 100, endOnFailure: true } as const;
const environment = {};
const revalidateWorkspace = async () => undefined;

const request = (idempotencyKey: string, prompt = "fixture prompt"): LaunchRequest => ({
  idempotencyKey,
  prompt,
  workspacePath: "/tmp/fixture-workspace",
  environment,
  revalidateWorkspace,
});

test("checked adapter fixtures replay deterministically and enforce idempotency", async () => {
  const scripts = JSON.parse(await readFile(new URL("./fixtures/adapter-runs.json", import.meta.url), "utf8")) as FakeRunScript[];
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (key) => {
    const adapter = new FakeAgentAdapter(scripts);
    const first = await adapter.launch(request(key));
    assert.deepEqual(await adapter.launch(request(key)), first);
    await assert.rejects(adapter.launch(request(key, "different prompt")), /different launch request/);
    assert.equal(adapter.launches.length, 1);
  }), propertyOptions);
});

test("adapter idempotency ignores object property order but rejects semantic changes", async () => {
  const scripts = JSON.parse(await readFile(new URL("./fixtures/adapter-runs.json", import.meta.url), "utf8")) as FakeRunScript[];
  const adapter = new FakeAgentAdapter(scripts);
  const first = await adapter.launch({
    idempotencyKey: "ordered-key", prompt: "fixture prompt", workspacePath: "/tmp/fixture-workspace",
    environment, revalidateWorkspace,
  });
  const reordered: LaunchRequest = {
    workspacePath: "/tmp/fixture-workspace", prompt: "fixture prompt", idempotencyKey: "ordered-key",
    revalidateWorkspace, environment,
  };
  assert.deepEqual(await adapter.launch(reordered), first);
  assert.equal(adapter.launches.length, 1);
});

test("failed launch-intent persistence leaves in-memory state unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launch-persist-failure-"));
  try {
    const path = join(directory, "state.json");
    const initial = new DurableStore(path);
    await initial.reserveLaunch({
      idempotencyKey: "failure-key", requestHash: "a".repeat(64), sessionId: "session-1",
      batchId: "batch-1", workerId: "worker-1", attribution: { agent: "codex", task: "test" },
    });
    const store = new DurableStore(path, undefined, undefined, undefined, undefined, undefined, async () => {
      throw new Error("injected persistence failure");
    });
    await assert.rejects(store.updateLaunch("failure-key", "dispatching", {
      diagnostic: "token=must-not-survive",
      securityAudit: {
        requesterId: "client-1",
        operation: "launch_dispatch",
        decision: "failed",
        reasonCode: "PERSISTENCE_FAILURE",
        correlationId: "failure-key",
      },
    }), /injected persistence failure/);
    assert.equal(store.launchIntents()[0]?.status, "reserved");
    assert.deepEqual(store.securityAuditEvents(), []);
    assert.equal(new DurableStore(path).launchIntents().length, 0, "an unloaded verifier has no stale in-memory state");
    const verifier = new DurableStore(path);
    await verifier.reconcile();
    assert.equal(verifier.launchIntents()[0]?.status, "reserved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recent session queries and default process identity checks execute", async () => {
  const directory = await mkdtemp(join(tmpdir(), "store-query-coverage-"));
  try {
    const store = new DurableStore(join(directory, "state.json"));
    await store.createBatch("recent", "client-1", [{ agent: "codex", task: "test" }]);
    assert.equal(store.recentSessions(1).length, 1);
    assert.equal(DurableStore.processStartedAt(999_999), undefined);
    await store.reconcile();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("launch state transitions accept only monotonic paths and require a run ID when bound", async () => {
  const allowed: Record<LaunchStatus, readonly LaunchStatus[]> = {
    reserved: ["reserved", "dispatching", "unknown_outcome"],
    dispatching: ["dispatching", "unknown_outcome", "bound"],
    unknown_outcome: ["unknown_outcome", "bound"],
    bound: ["bound"],
  };
  await fc.assert(fc.asyncProperty(
    fc.constantFrom<LaunchStatus>("reserved", "dispatching", "unknown_outcome", "bound"),
    fc.constantFrom<LaunchStatus>("reserved", "dispatching", "unknown_outcome", "bound"),
    async (current, target) => {
      const directory = await mkdtemp(join(tmpdir(), "launch-property-"));
      try {
        const store = new DurableStore(join(directory, "state.json"));
        await store.reserveLaunch({
          idempotencyKey: "property-key", requestHash: "a".repeat(64), sessionId: "session-1",
          batchId: "batch-1", workerId: "worker-1", attribution: { agent: "codex", task: "test" },
        });
        if (current === "dispatching" || current === "bound") {
          await store.updateLaunch("property-key", "dispatching");
        }
        if (current === "unknown_outcome" || current === "bound") {
          await store.updateLaunch("property-key", "unknown_outcome");
        }
        if (current === "bound") {
          await store.updateLaunch("property-key", "bound", { runId: "run-1" });
        }
        const options = target === "bound" ? { runId: "run-1" } : {};
        if (!allowed[current].includes(target)) {
          await assert.rejects(store.updateLaunch("property-key", target, options), /Invalid launch transition/);
        } else {
          assert.equal((await store.updateLaunch("property-key", target, options)).status, target);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  ), propertyOptions);
});

test("compatibility fixture is sanitized and fail-closed", async () => {
  const fixture = await readFile(new URL("./fixtures/compatibility-probe.json", import.meta.url), "utf8");
  const report = JSON.parse(fixture) as { classification: string; mutationAllowed: boolean; probeCommand: string };
  assert.equal(report.classification, "unknown");
  assert.equal(report.mutationAllowed, false);
  assert.equal(report.probeCommand, "npm run compatibility:probe");
  assert.doesNotMatch(fixture, /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|token|credential)/i);
});

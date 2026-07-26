import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { LaunchCoordinator, type AttributedLaunchRequest } from "../src/launch-coordinator.js";
import { RedactionPolicy, SecurityError } from "../src/security.js";
import { RegisteredWorkspaceAuthorizer, type WorkspaceInventory } from "../src/security.js";
import { DurableStore } from "../src/store.js";

const authorizer = {
  authorize: async (workspaceId: string) => ({
    workspaceId, projectId: "project-test", canonicalPath: "/worktrees/per-331", revalidate: async () => undefined,
  }),
};

const request: AttributedLaunchRequest = {
  idempotencyKey: "tenant-a:assignment-17:attempt-1",
  sessionId: "session-1",
  batchId: "batch-1",
  workerId: "worker-1",
  attribution: { agent: "codex", task: "PER-331 implementation" },
  prompt: "Implement PER-331",
  workspaceId: "workspace-per-331",
};

const script = { statuses: ["running", "succeeded"] as const, result: { status: "succeeded", output: "complete" } as const };

test("request hashes are canonical across nested property insertion order", () => {
  const reordered: AttributedLaunchRequest = {
    ...request,
    attribution: { task: request.attribution.task, agent: request.attribution.agent },
    resume: { token: "resume-token", adapter: "codex" },
  };
  const conventional: AttributedLaunchRequest = {
    ...request,
    attribution: { agent: request.attribution.agent, task: request.attribution.task },
    resume: { adapter: "codex", token: "resume-token" },
  };
  assert.equal(LaunchCoordinator.requestHash(reordered), LaunchCoordinator.requestHash(conventional));
  assert.notEqual(LaunchCoordinator.requestHash(conventional), LaunchCoordinator.requestHash({
    ...conventional, resume: { adapter: "codex", token: "different-token" },
  }));
});

test("request hashes normalize optional schema fields and reject unknown fields", () => {
  assert.equal(
    LaunchCoordinator.requestHash(request),
    LaunchCoordinator.requestHash({ ...request, resume: undefined } as unknown as AttributedLaunchRequest),
  );
  assert.throws(
    () => LaunchCoordinator.requestHash({ ...request, command: "rm -rf /" } as AttributedLaunchRequest),
    /Unrecognized key/,
  );
  assert.throws(
    () => LaunchCoordinator.requestHash({
      ...request,
      attribution: { ...request.attribution, token: "secret" },
    } as AttributedLaunchRequest),
    /Unrecognized key/,
  );
});

test("request hashes change for every semantic launch field but not the idempotency key", () => {
  const baseline = LaunchCoordinator.requestHash(request);
  assert.equal(baseline, LaunchCoordinator.requestHash({ ...request, idempotencyKey: "another-key" }));
  for (const changed of [
    { ...request, prompt: "Different prompt" },
    { ...request, workspaceId: "workspace-other" },
    { ...request, sessionId: "session-other" },
    { ...request, batchId: "batch-other" },
    { ...request, workerId: "worker-other" },
    { ...request, attribution: { ...request.attribution, agent: "opencode" } },
    { ...request, attribution: { ...request.attribution, task: "Different task" } },
    { ...request, resume: { adapter: "codex", token: "resume-token" } },
  ]) {
    assert.notEqual(baseline, LaunchCoordinator.requestHash(changed));
  }
});

async function harness(run: (path: string, store: DurableStore, adapter: FakeAgentAdapter) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-idempotency-"));
  const path = join(directory, "state.json");
  const store = new DurableStore(path);
  const adapter = new FakeAgentAdapter([script]);
  try {
    await store.reconcile();
    await run(path, store, adapter);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("repeated requests return one bound run with exact attribution", async () => {
  await harness(async (_path, store, adapter) => {
    const coordinator = new LaunchCoordinator(store, adapter, authorizer);
    const first = await coordinator.launch(request);
    const repeated = await coordinator.launch(request);

    assert.equal(adapter.launches.length, 1);
    assert.equal(first.runId, "fake-1");
    assert.deepEqual(repeated, first);
    assert.deepEqual(first.attribution, request.attribution);
    assert.equal(first.sessionId, request.sessionId);
    assert.equal(first.batchId, request.batchId);
    assert.equal(first.workerId, request.workerId);
  });
});

test("same idempotency key with different semantic input is rejected", async () => {
  await harness(async (_path, store, adapter) => {
    const coordinator = new LaunchCoordinator(store, adapter, authorizer);
    await coordinator.launch(request);
    await assert.rejects(coordinator.launch({ ...request, prompt: "Different task" }), /different launch request/);
    assert.equal(adapter.launches.length, 1);
  });
});

test("crash after durable reservation retries without losing attribution", async () => {
  await harness(async (path, store, adapter) => {
    const crashing = new LaunchCoordinator(store, adapter, authorizer, { afterReservation: () => { throw new Error("crash after reservation"); } });
    await assert.rejects(crashing.launch(request), /crash after reservation/);
    assert.equal(adapter.launches.length, 0);

    const restartedStore = new DurableStore(path);
    await restartedStore.reconcile();
    const recovered = await new LaunchCoordinator(restartedStore, adapter, authorizer).launch(request);
    assert.equal(adapter.launches.length, 1);
    assert.equal(recovered.status, "bound");
    assert.deepEqual(recovered.attribution, request.attribution);
  });
});

test("crash after external acceptance discovers and binds the same run", async () => {
  await harness(async (path, store, adapter) => {
    const crashing = new LaunchCoordinator(store, adapter, authorizer, {
      afterExternalAcceptance: () => { throw new Error("crash after external acceptance"); },
    });
    await assert.rejects(crashing.launch(request), /crash after external acceptance/);
    assert.equal(adapter.launches.length, 1);
    assert.equal(store.launchIntents()[0]?.status, "unknown_outcome");

    const restartedStore = new DurableStore(path);
    await restartedStore.reconcile();
    const [recovered] = await new LaunchCoordinator(restartedStore, adapter, authorizer).reconcile();
    assert.equal(adapter.launches.length, 1);
    assert.equal(recovered?.runId, "fake-1");
    assert.deepEqual(recovered?.attribution, request.attribution);
  });
});

test("unknown outcome is not retried when backend absence is not proven", async () => {
  await harness(async (_path, store, adapter) => {
    const coordinator = new LaunchCoordinator(store, adapter, authorizer, {
      afterExternalAcceptance: () => { throw new Error("connection reset"); },
    });
    await assert.rejects(coordinator.launch(request), /connection reset/);

    const recovered = await new LaunchCoordinator(store, adapter, authorizer).launch(request);
    assert.equal(adapter.launches.length, 1);
    assert.equal(recovered.runId, "fake-1");
  });
});

test("unknown outcome remains unresolved when backend cannot rediscover acceptance", async () => {
  await harness(async (path, store, adapter) => {
    const crashing = new LaunchCoordinator(store, adapter, authorizer, {
      afterExternalAcceptance: () => { throw new Error("connection reset"); },
    });
    await assert.rejects(crashing.launch(request), /connection reset/);

    const restartedStore = new DurableStore(path);
    await restartedStore.reconcile();
    const blindAdapter = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "findByIdempotencyKey") return async () => undefined;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      new LaunchCoordinator(restartedStore, blindAdapter, authorizer).launch(request),
      /remains unknown_outcome/,
    );
    assert.equal(adapter.launches.length, 1);
  });
});

test("audit persistence failure remains reserved before adapter acceptance", async () => {
  await harness(async (_path, store, adapter) => {
    const appendSecurityAudit = store.appendSecurityAudit.bind(store);
    let failAllowedIntent = true;
    store.appendSecurityAudit = async (input, now) => {
      if (failAllowedIntent && input.reasonCode === "launch_intent") {
        failAllowedIntent = false;
        throw new Error("audit storage unavailable");
      }
      return appendSecurityAudit(input, now);
    };
    const coordinator = new LaunchCoordinator(store, adapter, authorizer);

    await assert.rejects(coordinator.launch(request), /audit storage unavailable/);
    assert.equal(store.launchIntents()[0]?.status, "reserved");
    assert.equal(adapter.launches.length, 0);

    const recovered = await coordinator.launch(request);
    assert.equal(recovered.status, "bound");
    assert.equal(adapter.launches.length, 1);
  });
});

test("coordinator rejects every unbounded or control-bearing persisted identity before reservation", async () => {
  await harness(async (_path, store, adapter) => {
    const coordinator = new LaunchCoordinator(store, adapter, authorizer);
    for (const invalid of [
      { ...request, idempotencyKey: "x".repeat(257) },
      { ...request, sessionId: "session\nforged" },
      { ...request, attribution: { agent: "codex", task: "x".repeat(1025) } },
      { ...request, resume: { adapter: "fake", token: "x".repeat(4097) } },
    ]) {
      await assert.rejects(coordinator.launch(invalid), SecurityError);
    }
    assert.deepEqual(store.launchIntents(), []);
    assert.equal(adapter.launches.length, 0);
  });
});

test("coordinator redaction policy prevents literal canaries in reservation, diagnostics, and audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-idempotency-canary-"));
  const path = join(directory, "state.json");
  const literal = "low-entropy-coordinator-secret";
  const store = new DurableStore(path, undefined, undefined, undefined, new RedactionPolicy([literal]));
  const adapter = new FakeAgentAdapter([script]);
  try {
    await store.reconcile();
    const coordinator = new LaunchCoordinator(store, adapter, authorizer);
    await coordinator.launch({
      ...request,
      prompt: `prompt ${literal}`,
      attribution: { agent: "codex", task: `task ${literal}` },
    });
    assert.doesNotMatch(JSON.stringify(store.snapshot()), new RegExp(literal));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adapter failure and recovered binding append truthful chained outcomes", async () => {
  await harness(async (_path, store, adapter) => {
    const failing = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "launch") return async () => { throw new Error("provider failed"); };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(new LaunchCoordinator(store, failing, authorizer).launch(request), /provider failed/);
    assert.deepEqual(store.securityAuditEvents().map(({ decision, reasonCode }) => `${decision}:${reasonCode}`), [
      "allowed:launch_intent",
      "failed:POLICY_DENIED",
    ]);
    assert.equal(store.launchIntents()[0]?.status, "unknown_outcome");
  });

  await harness(async (_path, store, adapter) => {
    const crashing = new LaunchCoordinator(store, adapter, authorizer, {
      afterExternalAcceptance: () => { throw new Error("response lost"); },
    });
    await assert.rejects(crashing.launch(request), /response lost/);
    await new LaunchCoordinator(store, adapter, authorizer).reconcile();
    assert.deepEqual(store.securityAuditEvents().map(({ decision, reasonCode }) => `${decision}:${reasonCode}`), [
      "allowed:launch_intent",
      "failed:POLICY_DENIED",
      "allowed:launch_recovered",
    ]);
  });
});

test("outcome audit persistence failure cannot advance the durable binding", async () => {
  await harness(async (_path, store, adapter) => {
    const updateLaunch = store.updateLaunch.bind(store);
    store.updateLaunch = async (key, status, options, now) => {
      if (options?.securityAudit?.reasonCode === "launch_started") throw new Error("outcome audit unavailable");
      return updateLaunch(key, status, options, now);
    };
    await assert.rejects(new LaunchCoordinator(store, adapter, authorizer).launch(request), /outcome audit unavailable/);
    assert.equal(store.launchIntents()[0]?.status, "unknown_outcome");
    assert.equal(store.launchIntents()[0]?.runId, undefined);
    assert.equal(adapter.launches.length, 1);
  });
});

test("coordinator re-reads authoritative registration at launch and aborts reassignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-registration-race-"));
  const projectPath = join(directory, "project");
  const workspacePath = join(projectPath, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspacePath, { recursive: true }));
  const originalWorkspace = {
    id: request.workspaceId,
    organizationId: "organization-1",
    projectId: "project-1",
    hostId: "host-1",
    name: "workspace",
    branch: "branch",
    type: "worktree",
    createdByUserId: "owner-1",
    taskId: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    worktreePath: workspacePath,
    worktreeExists: true,
    projectName: "project",
    hostName: "host",
  };
  let inventory: WorkspaceInventory = {
    hostId: "host-1",
    organizationId: "organization-1",
    projects: [{ id: "project-1", name: "project", slug: "project", repoCloneUrl: null, githubRepositoryId: null, setUp: "yes", path: projectPath }],
    workspaces: [originalWorkspace],
  };
  const store = new DurableStore(join(directory, "state.json"));
  const adapter = new FakeAgentAdapter([script]);
  const authorizer = new RegisteredWorkspaceAuthorizer(async () => inventory);
  const coordinator = new LaunchCoordinator(store, adapter, authorizer, {
    afterReservation: () => {
      inventory = { ...inventory, workspaces: [{ ...originalWorkspace, createdByUserId: "owner-2" }] };
    },
  });
  try {
    await assert.rejects(coordinator.launch(request), /registration changed before launch/);
    assert.equal(adapter.launches.length, 0);
    assert.equal(store.launchIntents()[0]?.status, "reserved");
    assert.equal(store.securityAuditEvents().at(-1)?.decision, "denied");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy launch intents without workspace identity load but cannot recover", async () => {
  await harness(async (_path, store, adapter) => {
    const legacy = await store.reserveLaunch({
      idempotencyKey: "legacy-key",
      requestHash: "a".repeat(64),
      sessionId: "legacy-session",
      batchId: "legacy-batch",
      workerId: "legacy-worker",
      attribution: { agent: "codex", task: "legacy" },
    });
    await adapter.launch({
      idempotencyKey: legacy.intent.idempotencyKey,
      prompt: "legacy",
      workspacePath: "/legacy",
      environment: {},
      revalidateWorkspace: async () => undefined,
    });
    const recovered = await new LaunchCoordinator(store, adapter, authorizer).reconcile();
    assert.deepEqual(recovered, []);
    assert.equal(store.launchIntents()[0]?.status, "reserved");
    assert.equal(store.securityAuditEvents().at(-1)?.reasonCode, "INTEGRITY_FAILURE");
  });
});

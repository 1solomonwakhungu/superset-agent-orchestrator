import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/store.js";
import { withTemporaryDirectory } from "./support/deterministic.js";

/**
 * Schema and malformed-payload rejection at the durable persistence boundary.
 * The store must refuse to interpret a state file it cannot fully validate, and
 * must never overwrite bytes it refused to read.
 */

const AT = "2026-07-01T00:00:00.000Z";
const HEX64 = "a".repeat(64);

type JsonState = Record<string, unknown>;

/** A structurally complete state exercising every record kind the schema knows. */
function validState(): JsonState {
  return {
    version: 1,
    sessions: [{ id: "session-1", clientId: "client-1", createdAt: AT, lastSeenAt: AT }],
    batches: [{
      id: "batch-1", name: "overnight", sessionId: "session-1", createdAt: AT, updatedAt: AT,
      idempotencyKey: "key-1", clientId: "client-1", requestFingerprint: HEX64,
    }],
    workers: [
      {
        id: "worker-1", batchId: "batch-1", sessionId: "session-1", status: "running",
        pid: 4242, processStartedAt: "Wed Jul  1 00:00:00 2026",
        attribution: { agent: "codex", task: "migrate" }, startedAt: AT, position: 0,
      },
      {
        id: "worker-2", batchId: "batch-1", sessionId: "session-1", status: "succeeded",
        attribution: { agent: "opencode", task: "review" }, startedAt: AT, completedAt: AT,
        result: { output: "done" }, position: 1,
      },
    ],
    diagnostics: [{
      id: "orphan:worker-3", kind: "orphan", workerId: "worker-3",
      message: "Worker references a missing durable batch", detectedAt: AT,
    }],
    assignments: [{
      id: "assignment-1", idempotencyKey: "key-1", requestFingerprint: HEX64,
      batchId: "batch-1", sessionId: "session-1", status: "launched",
      attribution: { agent: "codex", task: "migrate" }, prompt: "Do the work",
      workspaceId: "workspace-1", workspacePath: "/tmp/workspace-1",
      attemptId: "attempt-1", attempt: 1, acceptedAt: AT, updatedAt: AT, runId: "run-1",
    }],
    auditEvents: [{
      id: "assignment-1:launch_accepted", assignmentId: "assignment-1",
      type: "launch_accepted", occurredAt: AT,
    }],
    launchIntents: [{
      idempotencyKey: "key-1", requestHash: HEX64, sessionId: "session-1", batchId: "batch-1",
      workerId: "worker-1", attribution: { agent: "codex", task: "migrate" },
      status: "bound", createdAt: AT, updatedAt: AT, runId: "run-1",
    }],
    capturedResults: [{
      deliveryId: "delivery-1", deliveryFingerprint: HEX64, assignmentId: "assignment-1",
      batchId: "batch-1", sessionId: "session-1", workspaceId: "workspace-1",
      workspacePath: "/tmp/workspace-1", attemptId: "attempt-1", attempt: 1, runId: "run-1",
      attribution: { agent: "codex", task: "migrate" },
      claim: { status: "succeeded", completeness: "complete", output: "done" },
      verifiedArtifacts: [], capturedAt: AT,
    }],
    reconciledAt: AT,
  };
}

function mutate(change: (state: JsonState) => void): JsonState {
  const state = validState();
  change(state);
  return state;
}

const array = (state: JsonState, key: string): JsonState[] => state[key] as JsonState[];
const first = (state: JsonState, key: string): JsonState => {
  const record = array(state, key)[0];
  if (record === undefined) throw new Error(`Fixture is missing ${key}[0]`);
  return record;
};

/** Every case is a payload a hostile or corrupted writer could leave behind. */
const rejectedStates: Array<[string, unknown]> = [
  ["a non-object document", ["not", "a", "state"]],
  ["an unknown state version", mutate((state) => { state.version = 2; })],
  ["a missing required collection", mutate((state) => { delete state.workers; })],
  ["a duplicate session ID", mutate((state) => { array(state, "sessions").push({ ...first(state, "sessions") }); })],
  ["a duplicate batch ID", mutate((state) => { array(state, "batches").push({ ...first(state, "batches") }); })],
  ["a duplicate worker ID", mutate((state) => { array(state, "workers").push({ ...first(state, "workers") }); })],
  ["a duplicate assignment ID", mutate((state) => { array(state, "assignments").push({ ...first(state, "assignments") }); })],
  ["a duplicate audit event ID", mutate((state) => { array(state, "auditEvents").push({ ...first(state, "auditEvents") }); })],
  ["a duplicate launch idempotency key", mutate((state) => {
    array(state, "launchIntents").push({ ...first(state, "launchIntents"), workerId: "worker-2" });
  })],
  ["a duplicate result delivery ID", mutate((state) => {
    array(state, "capturedResults").push({ ...first(state, "capturedResults"), attemptId: "attempt-2" });
  })],
  ["two authoritative results for one attempt", mutate((state) => {
    array(state, "capturedResults").push({ ...first(state, "capturedResults"), deliveryId: "delivery-2" });
  })],
  ["a running worker without a PID", mutate((state) => { delete first(state, "workers").pid; })],
  ["a running worker without a process start token", mutate((state) => { delete first(state, "workers").processStartedAt; })],
  ["a non-positive worker PID", mutate((state) => { first(state, "workers").pid = 0; })],
  ["a bound launch intent without a run ID", mutate((state) => { delete first(state, "launchIntents").runId; })],
  ["a launch request hash that is not a SHA-256 digest", mutate((state) => {
    first(state, "launchIntents").requestHash = "not-a-digest";
  })],
  ["a delivery fingerprint that is not a SHA-256 digest", mutate((state) => {
    first(state, "capturedResults").deliveryFingerprint = HEX64.toUpperCase();
  })],
  ["a result claiming verified artifacts the orchestrator never verified", mutate((state) => {
    first(state, "capturedResults").verifiedArtifacts = [{ path: "out.txt" }];
  })],
  ["a zero attempt number", mutate((state) => { first(state, "capturedResults").attempt = 0; })],
  ["an unknown worker status", mutate((state) => { array(state, "workers")[1] = { ...first(state, "workers"), id: "worker-9", status: "cancelled" }; })],
  ["an unknown assignment status", mutate((state) => { first(state, "assignments").status = "queued"; })],
  ["an unknown diagnostic kind", mutate((state) => { first(state, "diagnostics").kind = "suspicious"; })],
  ["an unknown audit event type", mutate((state) => { first(state, "auditEvents").type = "launch_maybe"; })],
  ["an unknown result completeness", mutate((state) => {
    (first(state, "capturedResults").claim as JsonState).completeness = "probably";
  })],
  ["a timestamp that is not ISO-8601", mutate((state) => { first(state, "sessions").createdAt = "yesterday"; })],
  ["an empty required identifier", mutate((state) => { first(state, "batches").name = ""; })],
  ["an empty attribution agent", mutate((state) => {
    (first(state, "workers").attribution as JsonState).agent = "";
  })],
  ["a prompt-less assignment", mutate((state) => { delete first(state, "assignments").prompt; })],
  ["a numeric identifier where a string is required", mutate((state) => { first(state, "sessions").id = 7; })],
];

test("valid durable state loads with every record kind intact", async () => {
  await withTemporaryDirectory("orchestrator-schema", async (directory) => {
    const path = join(directory, "state.json");
    await writeFile(path, JSON.stringify(validState()));
    const store = new DurableStore(path, () => true);
    const summary = await store.reconcile(new Date(AT));

    assert.deepEqual(summary, {
      sessionsRecovered: 1,
      batchesRecovered: 1,
      workersRecovered: 2,
      runningWorkers: 1,
      diagnosticsAdded: 0,
      reconciledAt: AT,
    });
    const snapshot = store.snapshot();
    assert.equal(snapshot.assignments.length, 1);
    assert.equal(snapshot.capturedResults?.length, 1);
    assert.equal(snapshot.launchIntents[0]?.status, "bound");
  });
});

test("malformed durable state is rejected without discarding the file", async () => {
  await withTemporaryDirectory("orchestrator-schema", async (directory) => {
    for (const [description, state] of rejectedStates) {
      const path = join(directory, `${description.replaceAll(/[^a-z0-9]+/gi, "-")}.json`);
      const bytes = JSON.stringify(state, null, 2);
      await writeFile(path, bytes);
      const store = new DurableStore(path, () => true);

      await assert.rejects(
        () => store.reconcile(new Date(AT)),
        (error: unknown) => error instanceof Error && /Cannot load orchestrator state/.test(error.message),
        `must reject ${description}`,
      );
      assert.equal(await readFile(path, "utf8"), bytes, `must preserve the file that contained ${description}`);
    }
  });
});

test("unreadable and truncated state documents fail closed", async () => {
  await withTemporaryDirectory("orchestrator-schema", async (directory) => {
    for (const [description, bytes] of [
      ["truncated JSON", '{"version":1,"sessions":['],
      ["empty file", ""],
      ["binary noise", "  not json"],
    ] as const) {
      const path = join(directory, `${description.replaceAll(" ", "-")}.json`);
      await writeFile(path, bytes);
      await assert.rejects(
        () => new DurableStore(path).reconcile(),
        (error: unknown) => error instanceof Error && /Cannot load orchestrator state/.test(error.message),
        description,
      );
      assert.equal(await readFile(path, "utf8"), bytes, description);
    }
  });
});

test("a missing state file starts empty instead of failing", async () => {
  await withTemporaryDirectory("orchestrator-schema", async (directory) => {
    const path = join(directory, "nested", "absent.json");
    const store = new DurableStore(path);
    const summary = await store.reconcile(new Date(AT));
    assert.equal(summary.sessionsRecovered, 0);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...emptyState(), reconciledAt: AT });
  });
});

test("forward-compatible fields are dropped rather than trusted", async () => {
  await withTemporaryDirectory("orchestrator-schema", async (directory) => {
    const path = join(directory, "state.json");
    const state = validState();
    state.futurePolicy = { allowRemoteWorkspaces: true };
    (state.sessions as JsonState[])[0]!.futureFlag = "ignore-me";
    await writeFile(path, JSON.stringify(state));

    const store = new DurableStore(path, () => true);
    await store.reconcile(new Date(AT));
    const snapshot = store.snapshot() as unknown as JsonState;
    assert.equal("futurePolicy" in snapshot, false, "unknown top-level policy must not survive a load");
    assert.equal("futureFlag" in (snapshot.sessions as JsonState[])[0]!, false);
  });
});

test("prototype-polluting payloads cannot escape the parser", async () => {
  await withTemporaryDirectory("orchestrator-schema", async (directory) => {
    const path = join(directory, "state.json");
    await writeFile(path, JSON.stringify({
      ...validState(),
      ["__proto__"]: { polluted: "yes" },
      constructor: { prototype: { polluted: "yes" } },
    }));

    const store = new DurableStore(path, () => true);
    await store.reconcile(new Date(AT));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined);
  });
});

function emptyState(): Record<string, unknown> {
  return {
    version: 1,
    sessions: [],
    batches: [],
    workers: [],
    diagnostics: [],
    assignments: [],
    auditEvents: [],
    launchIntents: [],
    capturedResults: [],
  };
}

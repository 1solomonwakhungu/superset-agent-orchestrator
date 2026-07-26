import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { BatchQueryError, DurableStore, type BatchAssignment } from "../src/store.js";
import { PROPERTY_SEEDS, SeededRandom, steadyClock, withTemporaryDirectory } from "./support/deterministic.js";

/**
 * Property-style coverage for the durable batch domain. Each property runs over
 * a fixed seed list, so the generated cases are varied but reproducible: no
 * clock, network, or ambient machine state participates.
 */

const AGENTS = ["codex", "opencode", "claude-code", "fake"] as const;

function assignments(random: SeededRandom, count: number): BatchAssignment[] {
  return Array.from({ length: count }, (_, index) => ({
    agent: random.pick(AGENTS),
    task: `${random.word("task")}#${index}`,
  }));
}

async function storeIn(directory: string, name: string): Promise<DurableStore> {
  return new DurableStore(join(directory, `${name}.json`));
}

async function drainPages(
  store: DurableStore,
  batchId: string,
  limit: number,
): Promise<string[]> {
  const collected: string[] = [];
  let cursor: string | undefined;
  // A bounded loop: pagination must terminate, and the bound proves it does.
  for (let page = 0; page <= 500; page += 1) {
    const result = await store.getBatch(batchId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    collected.push(...result.sessions.map(({ id }) => id));
    if (result.nextCursor === undefined) return collected;
    cursor = result.nextCursor;
  }
  throw new Error("Pagination did not terminate within the expected page bound");
}

test("property: pagination enumerates every session exactly once in creation order", async () => {
  await withTemporaryDirectory("orchestrator-property", async (directory) => {
    for (const seed of PROPERTY_SEEDS) {
      const random = new SeededRandom(seed);
      const store = await storeIn(directory, `pagination-${seed}`);
      const size = random.integer(1, 60);
      const created = await store.createBatch(
        random.word("batch"),
        random.word("client"),
        assignments(random, size),
        undefined,
        steadyClock()(),
      );
      const expected = created.sessions.map(({ id }) => id);

      for (const limit of [1, 2, 7, size, 250]) {
        const paged = await drainPages(store, created.batch.id, limit);
        assert.deepEqual(paged, expected, `seed ${seed} limit ${limit}`);
        assert.equal(new Set(paged).size, paged.length, `seed ${seed} limit ${limit} duplicated a session`);
      }
    }
  });
});

test("property: cursors are opaque, batch-bound, and reject tampering", async () => {
  await withTemporaryDirectory("orchestrator-property", async (directory) => {
    for (const seed of PROPERTY_SEEDS) {
      const random = new SeededRandom(seed);
      const store = await storeIn(directory, `cursor-${seed}`);
      const clock = steadyClock();
      const left = await store.createBatch("left", "client", assignments(random, 8), undefined, clock());
      const right = await store.createBatch("right", "client", assignments(random, 8), undefined, clock());

      const page = await store.getBatch(left.batch.id, { limit: 3 });
      assert.notEqual(page.nextCursor, undefined);
      const cursor = page.nextCursor as string;

      await assert.rejects(
        () => store.getBatch(right.batch.id, { limit: 3, cursor }),
        (error: unknown) => error instanceof BatchQueryError && error.code === "invalid_cursor",
        `seed ${seed}: a cursor must not cross batches`,
      );

      const forged = Buffer.from(JSON.stringify({ batchId: left.batch.id, offset: -1 }), "utf8").toString("base64url");
      for (const bad of [forged, "not-base64url!!", Buffer.from("{}", "utf8").toString("base64url"), ""]) {
        await assert.rejects(
          () => store.getBatch(left.batch.id, { limit: 3, cursor: bad }),
          (error: unknown) => error instanceof BatchQueryError,
          `seed ${seed}: cursor ${JSON.stringify(bad)} must be refused`,
        );
      }
    }
  });
});

test("property: identical idempotent requests never create a second batch", async () => {
  await withTemporaryDirectory("orchestrator-property", async (directory) => {
    for (const seed of PROPERTY_SEEDS) {
      const random = new SeededRandom(seed);
      const store = await storeIn(directory, `idempotency-${seed}`);
      const clock = steadyClock();
      const name = random.word("batch");
      const clientId = random.word("client");
      const key = random.word("key");
      const requested = assignments(random, random.integer(1, 12));

      const first = await store.createBatch(name, clientId, requested, key, clock());
      assert.equal(first.duplicate, false);

      for (let repeat = 0; repeat < 3; repeat += 1) {
        const again = await store.createBatch(name, clientId, requested, key, clock());
        assert.equal(again.duplicate, true, `seed ${seed}`);
        assert.equal(again.batch.id, first.batch.id, `seed ${seed}`);
        assert.deepEqual(
          again.sessions.map(({ id }) => id),
          first.sessions.map(({ id }) => id),
          `seed ${seed}`,
        );
      }

      // A different client may reuse the same key: scoping is per client.
      const otherClient = await store.createBatch(name, `${clientId}-other`, requested, key, clock());
      assert.equal(otherClient.duplicate, false);
      assert.notEqual(otherClient.batch.id, first.batch.id);

      // The same client with different work must be refused, not silently merged.
      await assert.rejects(
        () => store.createBatch(name, clientId, [...requested, { agent: "codex", task: "extra" }], key, clock()),
        (error: unknown) => error instanceof BatchQueryError && error.code === "idempotency_conflict",
        `seed ${seed}`,
      );

      const snapshot = store.snapshot();
      const batchesForKey = snapshot.batches.filter((batch) => batch.idempotencyKey === key && batch.clientId === clientId);
      assert.equal(batchesForKey.length, 1, `seed ${seed}: exactly one batch per client and key`);
    }
  });
});

test("property: status counts partition the batch and never exceed its size", async () => {
  await withTemporaryDirectory("orchestrator-property", async (directory) => {
    for (const seed of PROPERTY_SEEDS) {
      const random = new SeededRandom(seed);
      const store = await storeIn(directory, `status-${seed}`);
      const size = random.integer(1, 40);
      const created = await store.createBatch("statuses", "client", assignments(random, size), undefined, steadyClock()());

      const status = await store.batchStatus(created.batch.id, { limit: 250 });
      const counts = Object.values(status.summary.counts).reduce((sum, count) => sum + count, 0);
      assert.equal(counts, size, `seed ${seed}`);
      assert.equal(status.summary.total, size, `seed ${seed}`);
      assert.equal(status.summary.counts.requested, size, `seed ${seed}: acceptance does not imply execution`);
      assert.equal(status.summary.settled, 0, `seed ${seed}`);
      assert.equal(status.summary.complete, false, `seed ${seed}`);
      assert.equal(status.summary.partiallyComplete, false, `seed ${seed}`);
      assert.deepEqual(status.sessions.map(({ status: state }) => state), Array.from({ length: size }, () => "requested"));
    }
  });
});

test("property: ID queries preserve caller order and separate unknown IDs", async () => {
  await withTemporaryDirectory("orchestrator-property", async (directory) => {
    for (const seed of PROPERTY_SEEDS) {
      const random = new SeededRandom(seed);
      const store = await storeIn(directory, `ids-${seed}`);
      const clock = steadyClock();
      const mine = await store.createBatch("mine", "client", assignments(random, random.integer(2, 20)), undefined, clock());
      const other = await store.createBatch("other", "client", assignments(random, 3), undefined, clock());

      const known = random.shuffle(mine.sessions.map(({ id }) => id));
      const foreign = other.sessions.map(({ id }) => id).slice(0, 2);
      const absent = [random.word("session")];
      const requested = random.shuffle([...known, ...foreign, ...absent]);

      const page = await store.getBatch(mine.batch.id, { ids: requested });
      assert.deepEqual(
        page.sessions.map(({ id }) => id),
        requested.filter((id) => known.includes(id)),
        `seed ${seed}: known IDs keep caller order`,
      );
      assert.deepEqual(
        page.unknownIds,
        requested.filter((id) => !known.includes(id)),
        `seed ${seed}: foreign and absent IDs are reported, never invented`,
      );
      assert.equal(page.nextCursor, undefined, `seed ${seed}: ID queries are not paginated`);

      await assert.rejects(
        () => store.getBatch(mine.batch.id, { ids: [...known, known[0] as string] }),
        (error: unknown) => error instanceof BatchQueryError && error.code === "duplicate_ids",
        `seed ${seed}`,
      );
      await assert.rejects(
        () => store.getBatch(mine.batch.id, { ids: known, cursor: "anything" }),
        (error: unknown) => error instanceof BatchQueryError && error.code === "invalid_cursor",
        `seed ${seed}`,
      );
    }
  });
});

test("property: request limits are enforced before any durable write", async () => {
  await withTemporaryDirectory("orchestrator-property", async (directory) => {
    const store = await storeIn(directory, "limits");
    const random = new SeededRandom(31);

    for (const size of [0, 251, 400]) {
      await assert.rejects(
        () => store.createBatch("too-big", "client", assignments(random, size), undefined, steadyClock()()),
        (error: unknown) => error instanceof BatchQueryError && error.code === "invalid_request",
        `size ${size}`,
      );
    }
    assert.deepEqual(store.snapshot().batches, [], "a refused request must not persist state");

    const boundary = await store.createBatch("exactly-250", "client", assignments(random, 250), undefined, steadyClock()());
    assert.equal(boundary.sessions.length, 250);

    for (const limit of [0, -1, 251, 1.5, Number.NaN]) {
      await assert.rejects(
        () => store.getBatch(boundary.batch.id, { limit }),
        (error: unknown) => error instanceof BatchQueryError && error.code === "invalid_cursor",
        `limit ${limit}`,
      );
    }
    await assert.rejects(
      () => store.getBatch("unknown-batch"),
      (error: unknown) => error instanceof BatchQueryError && error.code === "not_found",
    );
  });
});

test("property: query measurements report the work actually performed", async () => {
  await withTemporaryDirectory("orchestrator-property", async (directory) => {
    const measurements: Array<{ operation: string; examined: number; returned: number }> = [];
    const store = new DurableStore(
      join(directory, "measured.json"),
      undefined,
      ({ operation, examined, returned }) => measurements.push({ operation, examined, returned }),
      () => 0,
    );
    const random = new SeededRandom(97);
    const created = await store.createBatch("measured", "client", assignments(random, 30), undefined, steadyClock()());

    await store.getBatch(created.batch.id, { limit: 10 });
    await store.batchStatus(created.batch.id, { limit: 10 });
    await store.batchResults(created.batch.id, { ids: [created.sessions[0]?.id as string, "absent"] });

    assert.deepEqual(measurements, [
      { operation: "batch_get", examined: 10, returned: 10 },
      { operation: "batch_status", examined: 10, returned: 10 },
      { operation: "batch_results", examined: 2, returned: 1 },
    ]);
  });
});

test("property: results separate delivered payloads from unavailable sessions", async () => {
  await withTemporaryDirectory("orchestrator-property", async (directory) => {
    const store = await storeIn(directory, "results");
    const random = new SeededRandom(11);
    const created = await store.createBatch("results", "client", assignments(random, 6), undefined, steadyClock()());

    const results = await store.batchResults(created.batch.id, { limit: 250 });
    assert.deepEqual(results.results, [], "nothing is complete before execution");
    assert.deepEqual(
      results.unavailable.map(({ sessionId }) => sessionId),
      created.sessions.map(({ id }) => id),
    );
    assert.deepEqual(results.unknownIds, []);
    assert.equal("nextCursor" in results, false);
  });
});

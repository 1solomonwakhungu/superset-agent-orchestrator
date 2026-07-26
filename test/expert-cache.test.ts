import assert from "node:assert/strict";
import test from "node:test";
import { ExpertCache, rankStaticExperts, type CachePolicy } from "../src/expert-cache.js";

test("enforces the byte cap and never evicts the static hot set", () => {
  const cache = new ExpertCache({
    capacityBytes: 30,
    policy: "lru",
    admissionControl: false,
    staticExperts: [{ id: "core", sizeBytes: 10 }],
  });
  assert.equal(cache.access({ id: "a", sizeBytes: 10 }), false);
  assert.equal(cache.access({ id: "b", sizeBytes: 10 }), false);
  assert.equal(cache.access({ id: "a", sizeBytes: 10 }), true);
  cache.access({ id: "c", sizeBytes: 10 });

  assert.deepEqual(cache.snapshot().residentIds, ["a", "c", "core"]);
  assert.equal(cache.snapshot().residentBytes, 30);
  assert.equal(cache.snapshot().evictions, 1);
});

test("admission control rejects a one-off scan instead of evicting a hot expert", () => {
  const cache = new ExpertCache({ capacityBytes: 10, policy: "lfu" });
  cache.access({ id: "hot", sizeBytes: 10 });
  for (let index = 0; index < 4; index += 1) cache.access({ id: "hot", sizeBytes: 10 });
  cache.access({ id: "scan", sizeBytes: 10 });

  assert.equal(cache.has("hot"), true);
  assert.equal(cache.has("scan"), false);
  assert.equal(cache.snapshot().rejections, 1);
});

test("all policies remain bounded under a long mixed-size trace", () => {
  for (const policy of ["lru", "lfu", "gdsf", "hybrid"] satisfies CachePolicy[]) {
    const cache = new ExpertCache({ capacityBytes: 256, policy, admissionControl: false });
    for (let index = 0; index < 10_000; index += 1) {
      const expert = index % 31;
      cache.access({
        id: `expert-${expert}`,
        sizeBytes: 8 + expert % 5,
        fetchCost: 1 + expert % 3,
      });
      assert.ok(cache.snapshot().residentBytes <= 256);
    }
  }
});

test("GDSF retains a frequently reused expensive expert", () => {
  const cache = new ExpertCache({ capacityBytes: 20, policy: "gdsf", admissionControl: false });
  cache.access({ id: "expensive", sizeBytes: 10, fetchCost: 10 });
  cache.access({ id: "cheap", sizeBytes: 10, fetchCost: 1 });
  cache.access({ id: "expensive", sizeBytes: 10, fetchCost: 10 });
  cache.access({ id: "new", sizeBytes: 10, fetchCost: 1 });
  assert.deepEqual(cache.snapshot().residentIds, ["expensive", "new"]);
});

test("hot-set profiler is deterministic and cost/size aware", () => {
  const trace = [
    { id: "large", sizeBytes: 20, fetchCost: 1 },
    { id: "small", sizeBytes: 5, fetchCost: 2 },
    { id: "small", sizeBytes: 5, fetchCost: 2 },
    { id: "medium", sizeBytes: 10, fetchCost: 2 },
  ];
  assert.deepEqual(rankStaticExperts(trace, 15).map(({ id }) => id), ["small", "medium"]);
});

test("rejects invalid configuration and inconsistent expert metadata", () => {
  assert.throws(() => new ExpertCache({ capacityBytes: 5, policy: "lru", staticExperts: [
    { id: "core", sizeBytes: 6 },
  ] }), /exceeds/);
  const cache = new ExpertCache({ capacityBytes: 10, policy: "lru" });
  cache.access({ id: "a", sizeBytes: 5 });
  assert.throws(() => cache.access({ id: "a", sizeBytes: 6 }), /size changed/);
});

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
  const cache = new ExpertCache({ capacityBytes: 128, policy: "lfu", staticExperts: [
    { id: "reserved", sizeBytes: 118 },
  ] });
  cache.access({ id: "hot", sizeBytes: 10 });
  for (let index = 0; index < 4; index += 1) cache.access({ id: "hot", sizeBytes: 10 });
  cache.access({ id: "scan", sizeBytes: 10 });

  assert.equal(cache.has("hot"), true);
  assert.equal(cache.has("scan"), false);
  assert.equal(cache.snapshot().rejections, 1);
});

test("mixed-size admission compares total reuse value", () => {
  const cache = new ExpertCache({ capacityBytes: 128, policy: "lru", staticExperts: [
    { id: "reserved", sizeBytes: 108 },
  ] });
  cache.access({ id: "left", sizeBytes: 10 });
  cache.access({ id: "right", sizeBytes: 10 });
  cache.access({ id: "candidate", sizeBytes: 20, fetchCost: 2 });
  cache.access({ id: "candidate", sizeBytes: 20, fetchCost: 2 });
  cache.access({ id: "candidate", sizeBytes: 20, fetchCost: 2 });

  assert.equal(cache.has("candidate"), true);
  assert.equal(cache.has("left"), false);
  assert.equal(cache.has("right"), false);
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

  const evicted = new ExpertCache({ capacityBytes: 128, policy: "lru", admissionControl: false,
    staticExperts: [{ id: "reserved", sizeBytes: 123 }] });
  evicted.access({ id: "a", sizeBytes: 5 });
  evicted.access({ id: "b", sizeBytes: 5 });
  assert.throws(() => evicted.access({ id: "a", sizeBytes: 4 }), /size changed/);
});

test("hybrid policy computes recency at eviction time", () => {
  const cache = new ExpertCache({ capacityBytes: 128, policy: "hybrid", admissionControl: false,
    staticExperts: [{ id: "reserved", sizeBytes: 108 }] });
  cache.access({ id: "old", sizeBytes: 10 });
  cache.access({ id: "recent", sizeBytes: 10 });
  cache.access({ id: "new", sizeBytes: 10 });
  assert.deepEqual(cache.snapshot().residentIds, ["new", "recent", "reserved"]);
});

test("unique scans keep cache bookkeeping bounded in observable memory", () => {
  const cache = new ExpertCache({ capacityBytes: 128, policy: "lfu" });
  for (let index = 0; index < 10_000; index += 1) {
    cache.access({ id: `scan-${index}`, sizeBytes: 128 });
  }
  assert.equal(cache.snapshot().residentBytes, 128);
  assert.equal(cache.snapshot().residentIds.length, 1);
});

test("scan history cannot reset a resident expert frequency", () => {
  const cache = new ExpertCache({ capacityBytes: 128, policy: "lfu", staticExperts: [
    { id: "reserved", sizeBytes: 108 },
  ] });
  cache.access({ id: "hot", sizeBytes: 10 });
  for (let index = 0; index < 10; index += 1) cache.access({ id: "hot", sizeBytes: 10 });
  cache.access({ id: "cold", sizeBytes: 10 });
  cache.access({ id: "scan-a", sizeBytes: 20 });
  cache.access({ id: "scan-b", sizeBytes: 20 });
  cache.access({ id: "candidate", sizeBytes: 10, fetchCost: 2 });
  cache.access({ id: "candidate", sizeBytes: 10, fetchCost: 2 });
  assert.equal(cache.has("hot"), true);
});

test("GDSF inflation ages old entries across repeated evictions", () => {
  const cache = new ExpertCache({ capacityBytes: 20, policy: "gdsf", admissionControl: false });
  for (const id of ["a", "z", "c", "d"]) cache.access({ id, sizeBytes: 10 });
  assert.deepEqual(cache.snapshot().residentIds, ["c", "d"]);
});

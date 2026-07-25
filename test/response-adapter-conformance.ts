import assert from "node:assert/strict";
import test from "node:test";
import type { RunResult } from "../src/agent-adapter.js";

export interface ResponseAdapterConformanceFixtures {
  name: string;
  map(input: unknown): RunResult | undefined;
  running: unknown;
  succeeded: unknown;
  failed: unknown;
  cancelled: unknown;
  malformed: unknown;
  expectedResume: { adapter: string; token: string };
}

export function responseAdapterConformance(fixtures: ResponseAdapterConformanceFixtures): void {
  test(`${fixtures.name}: launch identity remains non-terminal`, () => {
    assert.equal(fixtures.map(fixtures.running), undefined);
  });

  test(`${fixtures.name}: exact result and run attribution conform`, () => {
    assert.deepEqual(fixtures.map(fixtures.succeeded), {
      status: "succeeded",
      output: "exact answer",
      resume: fixtures.expectedResume,
    });
  });

  test(`${fixtures.name}: failure and cancellation are terminal`, () => {
    assert.equal(fixtures.map(fixtures.failed)?.status, "failed");
    assert.equal(fixtures.map(fixtures.cancelled)?.status, "cancelled");
  });

  test(`${fixtures.name}: malformed responses fail closed`, () => {
    assert.throws(() => fixtures.map(fixtures.malformed));
  });
}

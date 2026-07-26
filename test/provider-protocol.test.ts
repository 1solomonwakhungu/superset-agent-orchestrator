import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROVIDER_OUTPUT_LENGTH,
  parseProviderCancellation,
  parseProviderResult,
  parseProviderStatus,
  ProviderProtocolError,
} from "../src/provider-protocol.js";

test("strict provider lifecycle schemas accept only the documented protocol", () => {
  assert.deepEqual(parseProviderStatus({
    runId: "run-1",
    status: "running",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }), { runId: "run-1", status: "running", updatedAt: "2026-07-25T00:00:00.000Z" });
  assert.deepEqual(parseProviderResult({ status: "succeeded", output: "exact" }), {
    status: "succeeded",
    output: "exact",
  });
  assert.deepEqual(parseProviderCancellation({ status: "accepted" }), { status: "accepted" });
  assert.equal(parseProviderCancellation(undefined), undefined);
});

test("provider lifecycle schemas reject unknown fields, invalid timestamps, and invalid variants", () => {
  for (const operation of [
    () => parseProviderStatus({ runId: "run-1", status: "running", updatedAt: "today" }),
    () => parseProviderStatus({ runId: "run-1", status: "running", updatedAt: "2026-07-25T00:00:00Z", extra: true }),
    () => parseProviderResult({ status: "failed", error: "no", retryable: "yes" }),
    () => parseProviderCancellation({ status: "accepted", requestId: "foreign" }),
  ]) {
    assert.throws(operation, (error) => error instanceof ProviderProtocolError && /malformed/.test(error.message));
  }
});

test("provider result output is bounded before it can reach durable storage", () => {
  const oversized = { status: "succeeded", output: "x".repeat(MAX_PROVIDER_OUTPUT_LENGTH + 1) };
  assert.throws(
    () => parseProviderResult(oversized),
    (error) => error instanceof ProviderProtocolError && /(malformed|oversized)/.test(error.message),
  );
});

test("non-JSON provider values fail closed", () => {
  assert.throws(
    () => parseProviderResult({ status: "succeeded", output: "ok", invalid: 1n }),
    (error) => error instanceof ProviderProtocolError && /malformed/.test(error.message),
  );
});

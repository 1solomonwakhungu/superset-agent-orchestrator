import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policyUrl = new URL("../docs/workspace-lease-and-writer-safety.md", import.meta.url);
const policy = await readFile(policyUrl, "utf8");

test("writer admission requires durable and OS-level exclusive authority", () => {
  assert.match(policy, /exclusively holds both the durable writer lease and the operating-system\s+lease lock/);
  assert.match(policy, /At most one writer generation may be authoritative/);
  assert.match(policy, /partial unique writer index is mandatory defense in depth, but it is\s+not the cross-process fencing mechanism/);
  assert.match(policy, /exactly one launch intent and one\s+child/);
});

test("expiry cannot release a live writer and recovery fails closed", () => {
  assert.match(policy, /time expiry alone never transfers or releases write authority/);
  assert.match(policy, /PID alone and elapsed time are never proof/);
  assert.match(policy, /Without a\s+supported handoff, quarantine and deny new writers while the process lives/);
  assert.match(policy, /identity is reused, incomplete, contradictory, unavailable, or the launch\s+outcome is unknown, set `quarantined`/);
});

test("generation and compare-and-set fencing revoke stale owners", () => {
  assert.match(policy, /monotonically increasing integer/);
  assert.match(policy, /Heartbeat uses compare-and-set on lease ID,\s+generation, token digest/);
  assert.match(policy, /A stale owner receives\s+`LEASE_FENCED`/);
  assert.match(policy, /A later generation fences every prior owner/);
});

test("shared read-only access requires mechanical write prevention", () => {
  assert.match(policy, /Read-only sharing is allowed only when/);
  assert.match(policy, /OS-enforced sandbox/);
  assert.match(policy, /immutable isolated copy or snapshot/);
  assert.match(policy, /sentinel write test\s+that fails inside the workspace and its Git metadata/);
  assert.match(policy, /prompts, `cwd`, Git status checks, user intent, post-run diff checks, or a database\s+`read_only` flag are not mechanical prevention/);
  assert.match(policy, /`READ_ONLY_ENFORCEMENT_UNAVAILABLE`/);
});

test("the refusal contract is closed, typed, and side-effect free", () => {
  for (const code of [
    "WORKSPACE_WRITER_BUSY",
    "WORKSPACE_IDENTITY_CHANGED",
    "READ_ONLY_ENFORCEMENT_UNAVAILABLE",
    "LEASE_FENCED",
    "LEASE_RECOVERY_AMBIGUOUS",
    "LEASE_STATE_CORRUPT",
    "WORKSPACE_POLICY_DENIED",
  ]) {
    assert.ok(policy.includes(`| \`${code}\` |`), `missing refusal code ${code}`);
  }

  assert.match(policy, /`layer: "policy"`/);
  assert.match(policy, /It causes zero adapter launches and zero workspace\s+mutations/);
});

test("MVP has no unsafe override or alternate authority path", () => {
  assert.match(policy, /MVP has no `force`, `override`, `steal`, `ignore_expiry`/);
  assert.match(policy, /Unknown request fields are rejected/);
  assert.match(policy, /Operational urgency does not create write\s+authority/);
  assert.match(policy, /writer launch and\s+shared read-only agent launch remain disabled/);
});

test("lease policy retains threat-model traceability and release tests", () => {
  for (const id of ["C-LEASE-01", "C-LEASE-02", "T-LEASE-01", "T-LEASE-02", "T-LEASE-03"])
    assert.match(policy, new RegExp(`\\b${id}\\b`));

  for (const heading of [
    "## Acquisition protocol",
    "## Heartbeat rules",
    "## Release rules",
    "## Restart, crash, and stale-owner recovery",
    "## Safety checks",
    "## Typed refusal contract",
    "## No override",
  ])
    assert.ok(policy.includes(heading), `missing ${heading}`);
});

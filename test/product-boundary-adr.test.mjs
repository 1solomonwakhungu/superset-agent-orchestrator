import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adrUrl = new URL(
  "../docs/adr/0002-product-boundary-and-mvp-gates.md",
  import.meta.url,
);

async function readAdr() {
  return readFile(adrUrl, "utf8");
}

test("product boundary keeps a backend-neutral core and Superset adapter", async () => {
  const adr = await readAdr();

  assert.match(adr, /backend-agnostic orchestration core/i);
  assert.match(adr, /Superset-specific first\s+adapter/i);
  assert.match(adr, /Hermes is one optional MCP client example/i);
  assert.match(adr, /not a generic launch wrapper/i);
  assert.match(adr, /Working name: .*provisional/i);
});

test("unsupported Superset lifecycle narrows the MVP", async () => {
  const adr = await readAdr();

  for (const capability of [
    "status",
    "exact result",
    "stop reason",
    "cancellation",
    "backend recovery",
  ]) {
    assert.match(adr, new RegExp(capability, "i"), capability);
  }

  assert.match(adr, /launch-ledger technical preview/i);
  assert.match(adr, /unknown_outcome/);
  assert.match(adr, /UNSUPPORTED_OPERATION/);
  assert.match(adr, /must not be marketed as[\s\S]*orchestration or promoted to GA/i);
});

test("ADR defines users, jobs, scope, and measurable decision gates", async () => {
  const adr = await readAdr();

  for (const heading of [
    "## Target users",
    "## Jobs to be done",
    "## Narrowed MVP scope",
    "## Non-goals",
    "## Explicit deferrals",
    "### Go:",
    "### Narrow:",
    "### Pause:",
    "### Kill:",
  ]) {
    assert.ok(adr.includes(heading), heading);
  }

  for (const [label, pattern] of [
    ["30-session", /30-session/i],
    ["30 of 30", /30 of 30/i],
    ["within 60 seconds", /within\s+60\s+seconds/i],
    ["100 percent", /100 percent/i],
    ["zero remote requests", /zero remote requests/i],
    ["2027-01-24", /2027-01-24/],
  ]) {
    assert.match(adr, pattern, label);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const threatModelUrl = new URL(
  "../docs/security/local-control-plane-threat-model.md",
  import.meta.url,
);
const threatModel = await readFile(threatModelUrl, "utf8");

const definitions = (prefix) =>
  new Set(
    [...threatModel.matchAll(new RegExp(`\\*\\*(${prefix}-[A-Z]+-\\d{2}):`, "g"))].map(
      ([, id]) => id,
    ),
  );

test("every P0 threat maps to defined controls and adversarial tests", () => {
  const controls = definitions("C");
  const tests = new Set(
    [...threatModel.matchAll(/^\| (T-[A-Z]+-\d{2}) \|/gm)].map(([, id]) => id),
  );
  const rows = [...threatModel.matchAll(/^\| (THR-[A-Z]+-\d{2}) \|.*\| P0 \| ([^|]+) \| ([^|]+) \|$/gm)];

  assert.ok(rows.length >= 18, `expected at least 18 P0 threats, found ${rows.length}`);

  for (const [, threatId, controlList, testList] of rows) {
    const controlIds = [...controlList.matchAll(/C-[A-Z]+-\d{2}/g)].map(([id]) => id);
    const testIds = [...testList.matchAll(/T-[A-Z]+-\d{2}/g)].map(([id]) => id);

    assert.ok(controlIds.length > 0, `${threatId} has no control`);
    assert.ok(testIds.length > 0, `${threatId} has no adversarial test`);
    for (const id of controlIds) assert.ok(controls.has(id), `${threatId} references undefined ${id}`);
    for (const id of testIds) assert.ok(tests.has(id), `${threatId} references undefined ${id}`);
  }
});

test("the model covers required boundaries and explicit MVP exclusions", () => {
  for (const heading of [
    "## Assets",
    "## Actors",
    "## Trust boundaries and data flow",
    "## Authorization and capability model",
    "## Explicit MVP tool exclusions",
    "## Redaction rules",
    "## Audit event contract",
    "## Adversarial test inventory",
  ]) {
    assert.ok(threatModel.includes(heading), `missing ${heading}`);
  }

  for (const area of ["Path", "Command", "Prompt", "Secret", "Workspace", "Confused deputy", "Audit"])
    assert.match(threatModel, new RegExp(`\\| ${area.replace(" ", "[ -]")}`), `missing ${area} threat coverage`);

  assert.match(threatModel, /arbitrary shell, terminal, command/);
  assert.match(threatModel, /`workspaces_delete`/);
  assert.match(threatModel, /MUST NOT be registered in MVP/);
});

test("redaction and audit rules prohibit raw sensitive payloads", () => {
  assert.match(threatModel, /Redact before logs, audit, persistence,\s+diagnostics, errors, and MCP responses/);
  assert.match(threatModel, /Prompts and full results are\s+not audit fields/);
  assert.match(threatModel, /If mutation intent cannot be persisted, the\s+mutation fails closed/);
  assert.match(threatModel, /Agent prose, prompts, results, environment values, and secrets\s+are excluded/);
});

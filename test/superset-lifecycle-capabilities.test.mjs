import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractUrl = new URL(
  "../config/superset-lifecycle-capabilities.json",
  import.meta.url,
);

test("stable Superset lifecycle capabilities fail closed", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));
  const operations = contract.stable.operations;

  assert.equal(operations.launch, "beta");
  for (const [operation, classification] of Object.entries(operations)) {
    if (operation !== "launch") {
      assert.equal(classification, "unavailable", operation);
    }
  }
  assert.equal(contract.stable.unsupportedBehavior, "fail-closed");
});

test("private experiment cannot become an implicit stable fallback", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));

  assert.equal(contract.experiment.classification, "private");
  assert.equal(contract.experiment.enabledByDefault, false);
  assert.equal(
    contract.experiment.operations.singularDurableFinalResult,
    "unavailable",
  );
});

test("contract prohibits private persistence and terminal-output parsing", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));

  assert.ok(contract.prohibitedSources.includes("superset-private-database"));
  assert.ok(contract.prohibitedSources.includes("agent-temporary-log"));
  assert.ok(contract.prohibitedSources.includes("terminal-replay-buffer"));
});

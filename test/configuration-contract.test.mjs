import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("../config/orchestrator.schema.json", import.meta.url);
const contractUrl = new URL("../docs/configuration-and-discovery.md", import.meta.url);

test("configuration schema is valid JSON with closed objects", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.superset.additionalProperties, false);
  assert.equal(schema.properties.timeouts.additionalProperties, false);
  assert.equal(schema.properties.environment.additionalProperties, false);
  assert.equal(schema.$defs.timeout.minimum, 1);
  assert.equal(schema.$defs.environmentName.pattern, "^[A-Za-z_][A-Za-z0-9_]*$");
});

test("contract defines deterministic conflict and environment policy", async () => {
  const contract = await readFile(contractUrl, "utf8");

  assert.match(contract, /More than one distinct candidate is a conflict/);
  assert.match(contract, /MUST NOT select the\s+first candidate/);
  assert.match(contract, /newly constructed environment, never the complete/);
  assert.match(contract, /never values/);
  assert.match(contract, /MUST NOT contain organization names, usernames, hostnames/);
});

test("tracked contract contains no local machine identity or absolute user path", async () => {
  const files = await Promise.all([
    readFile(schemaUrl, "utf8"),
    readFile(contractUrl, "utf8"),
  ]);
  const content = files.join("\n");

  assert.doesNotMatch(content, /\/Users\//);
  assert.doesNotMatch(content, /[A-Z]:\\Users\\/i);
  assert.doesNotMatch(content, /1solomonwakhungu|65043605/);
});

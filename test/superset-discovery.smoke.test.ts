import assert from "node:assert/strict";
import { test } from "node:test";
import { SupersetDiscoveryAdapter } from "../src/superset-discovery.js";

test("real Superset CLI responses match supported discovery schemas", async () => {
  const executable = process.env.SUPERSET_ORCHESTRATOR_EXECUTABLE;
  const result = await new SupersetDiscoveryAdapter({
    ...(executable === undefined ? {} : { executable }), timeoutMs: 10_000,
  }).discover();
  assert.match(result.version, /^\d+\.\d+\.\d+/);
  assert.ok(result.host.running && result.host.healthy);
  assert.ok(result.projects.length > 0);
  assert.ok(result.workspaces.every(({ hostId }) => hostId === result.host.hostId));
  assert.ok(result.presets.length > 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { SupersetDiscoveryAdapter } from "../src/superset-discovery.js";

test("real Superset CLI responses match supported discovery schemas", {
  skip: process.env.SUPERSET_ORCHESTRATOR_REAL_SMOKE !== "1"
    ? "set SUPERSET_ORCHESTRATOR_REAL_SMOKE=1 to run the real-system smoke test"
    : false,
}, async () => {
  const executable = process.env.SUPERSET_ORCHESTRATOR_EXECUTABLE ?? "superset";
  const result = await new SupersetDiscoveryAdapter({ executable, timeoutMs: 10_000 }).discover();
  assert.match(result.version, /^\d+\.\d+\.\d+/);
  assert.ok(result.host.running && result.host.healthy);
  assert.ok(result.projects.length > 0);
  assert.ok(result.workspaces.every(({ hostId }) => hostId === result.host.hostId));
  assert.ok(result.presets.length > 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { SupersetDiscoveryAdapter } from "../src/superset-discovery.js";

const smokeEnabled = process.env.SUPERSET_DISCOVERY_SMOKE === "1";

test("real Superset CLI responses match supported discovery schemas", {
  skip: smokeEnabled
    ? false
    : "requires an installed Superset CLI and a healthy local Desktop host; generic CI validates the injected-runner contract",
}, async () => {
  const executable = process.env.SUPERSET_ORCHESTRATOR_EXECUTABLE ?? "superset";
  const result = await new SupersetDiscoveryAdapter({ executable, timeoutMs: 10_000 }).discover();
  assert.match(result.version, /^\d+\.\d+\.\d+/);
  assert.ok(result.host.running && result.host.healthy);
  assert.ok(result.projects.length > 0);
  assert.ok(result.workspaces.every(({ hostId }) => hostId === result.host.hostId));
  assert.ok(result.presets.length > 0);
});

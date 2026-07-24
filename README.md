# superset-agent-orchestrator

Local-first MCP server for durable orchestration of parallel coding agents through
Superset.

## Recovery

The server reconciles its durable JSON state before accepting MCP requests and periodically while
it runs. Existing worker processes remain tracked by PID and process start token; vanished processes
are marked `unknown_outcome` and are never relaunched merely because a server or client restarted.
State writes are locked, synced, and atomically renamed. A corrupt state file is left untouched.

Recovery tools:

* `recent_sessions` lists durable sessions independently of the connected client.
* `reopen_batch` restores the newest exact-name batch with sessions, workers, results, and attribution.
* `batches_create` durably accepts up to 250 attributed sessions and returns stable IDs immediately.
* `batches_get`, `batches_status`, and `batches_results` provide indexed, ordered pagination without per-agent polling.
* `recovery_diagnostics` reports orphan, unknown-outcome, and missing-result records.

Set `SUPERSET_ORCHESTRATOR_STATE` to choose the state file. By default it is stored at
`~/.local/share/superset-agent-orchestrator/state.json`.

## Configuration contract

The portable configuration schema is published at
[`config/orchestrator.schema.json`](config/orchestrator.schema.json). Discovery,
precedence, environment isolation, diagnostics, and redaction behavior are defined
in [`docs/configuration-and-discovery.md`](docs/configuration-and-discovery.md).

Run the zero-dependency contract checks with:

```sh
node --test test/configuration-contract.test.mjs
```

## Architecture

- [Authoritative session state machine](docs/session-state-machine.md)
- [Versioned client-independent MCP tool contract](docs/mcp-tool-contract.md)
- [Durable storage, migration, retention, export, and recovery policy](docs/durable-storage.md)
- [Local control-plane threat model](docs/security/local-control-plane-threat-model.md)
- [Idempotency and reconciliation contract](docs/idempotency-and-reconciliation.md)

The MCP contract publishes typed TypeScript/Zod schemas and a client-neutral JSON Schema catalog. It defines asynchronous launch, stable IDs, batches of 100 sessions, pagination, bounded wait, cancellation, results, and restart recovery. The contract is normative; tools not listed under Recovery above are not yet registered runtime handlers.

## Agent adapter boundary

`AgentAdapter` isolates core orchestration from coding-agent lifecycle APIs. It provides launch, status, terminal result, cancellation, and resume metadata operations. Provider-specific response formats are normalized in adapter modules before they reach core domain code.

`FakeAgentAdapter` accepts ordered run scripts and a caller-controlled clock. Integration tests can therefore drive queued, running, succeeded, failed, and cancelled paths without timing or network dependencies.

Run `npm run verify` to type-check the complete implementation and execute all tests.

## Superset discovery

`SupersetDiscoveryAdapter` uses the supported Superset CLI JSON interface to
discover the healthy local host and its projects, workspaces, and agent presets.
Every child command is launched with an argument array and no shell. Discovery
probes the CLI version, applies per-command timeouts, validates structured
responses, and rejects ambiguous or remote-only results with normalized errors.

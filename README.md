# superset-agent-orchestrator

Local-first MCP server for durable orchestration of parallel coding agents through
Superset.

## Product status

The backend-neutral core and fake adapter exercise complete lifecycle semantics,
but the stable public Superset interface currently supports only local discovery
and launch. It does not provide agent status, exact results, stop reasons,
cancellation, or backend recovery. Superset is therefore limited to a
launch-ledger technical preview that reports unobservable work as
`unknown_outcome`; it is not a general-availability orchestration backend.

See the [product boundary and measurable release gates](docs/adr/0002-product-boundary-and-mvp-gates.md).

## Development

Requirements: Node.js 22, npm 10 or later, and Python 3.11.

```sh
npm ci
npm audit --audit-level=high
npm run check
```

The aggregate check enforces formatting for workflows and repository guidance,
type-aware lint across production TypeScript and tests, strict type checking, the
production build, TypeScript tests and coverage thresholds, and Python monitor
tests. It also regenerates the MCP schema and fails if the checked-in artifact is
stale.

## Recovery

The server reconciles its durable JSON state before accepting MCP requests and periodically while
it runs. Existing worker processes remain tracked by PID and process start token; vanished processes
are marked `unknown_outcome` and are never relaunched merely because a server or client restarted.
State writes are locked, synced, and atomically renamed. A corrupt state file is left untouched.

Recovery tools:

- `recent_sessions` lists durable sessions independently of the connected client.
- `reopen_batch` restores the newest exact-name batch with sessions, workers, results, and attribution.
- `batches_create` durably accepts up to 250 attributed sessions and returns stable IDs immediately.
- `batches_get`, `batches_status`, and `batches_results` provide indexed, ordered pagination without per-agent polling.
- `recovery_diagnostics` reports orphan, unknown-outcome, and missing-result records.

Lifecycle tools:

- `sessions_cancel` and `batches_cancel` persist one cancellation intent before
  provider I/O and preserve the first reason. One active claimant performs each
  attempt; unknown delivery may be retried through an idempotent provider stop
  after restart. Unsupported backends return `CANCEL_UNSUPPORTED` without
  changing state.
- `batches_wait` waits at most 30 seconds and returns exact partial counts on
  timeout rather than an error.
- `sessions_set_deadline` and `deadlines_enforce` expire overdue nonterminal
  sessions as `failed` with stop reason `deadline_exceeded`. The server also
  sweeps deadlines on a background interval.

Set `SUPERSET_ORCHESTRATOR_STATE` to choose the state file. By default it is
stored at `~/.local/share/superset-agent-orchestrator/state.json`.
`SUPERSET_ORCHESTRATOR_DEADLINE_MS` sets the background deadline sweep interval
and defaults to 5000 milliseconds.

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

- [Product boundary and MVP decision gates](docs/adr/0002-product-boundary-and-mvp-gates.md)
- [Authoritative session state machine](docs/session-state-machine.md)
- [Versioned client-independent MCP tool contract](docs/mcp-tool-contract.md)
- [Durable storage, migration, retention, export, and recovery policy](docs/durable-storage.md)
- [Local control-plane threat model](docs/security/local-control-plane-threat-model.md)
- [Idempotency and reconciliation contract](docs/idempotency-and-reconciliation.md)
- [Workspace lease and writer-safety policy](docs/workspace-lease-and-writer-safety.md)

The MCP contract publishes typed TypeScript/Zod schemas and a client-neutral JSON Schema catalog. It defines asynchronous launch, stable IDs, batches of 100 sessions, pagination, bounded wait, cancellation, deadlines, results, and restart recovery. The versioned lifecycle tools listed above are registered runtime handlers; other normative tools remain contract-only until their implementations land.

## Agent adapter boundary

`AgentAdapter` isolates core orchestration from coding-agent lifecycle APIs. It provides launch, status, terminal result, cancellation, and resume metadata operations. Provider-specific response formats are normalized in adapter modules before they reach core domain code.

`FakeAgentAdapter` accepts ordered run scripts and a caller-controlled clock. Integration tests can therefore drive queued, running, succeeded, failed, and cancelled paths without timing or network dependencies.

Run `npm run verify` to type-check the complete implementation and execute all tests.

## Contributions

Changes must use pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
required checks and [SECURITY.md](SECURITY.md) for private vulnerability
reporting.

## Superset discovery

`SupersetDiscoveryAdapter` uses the supported Superset CLI JSON interface to
discover the healthy local host and its projects, workspaces, and agent presets.
Every child command is launched with an argument array and no shell. Discovery
probes the CLI version, applies per-command timeouts, validates structured
responses, and rejects ambiguous or remote-only results with normalized errors.

Discovery schema coverage runs offline. `test/fixtures/` holds sanitized Superset
1.16.1 responses that are replayed through the real adapter, so `npm run verify`
is deterministic on machines without the CLI installed.

The live smoke test runs only when `SUPERSET_DISCOVERY_SMOKE=1` or
`SUPERSET_ORCHESTRATOR_REQUIRE_LIVE_DISCOVERY=1` is set. The latter makes a
missing executable a failure. An executable selected through discovery or
`SUPERSET_ORCHESTRATOR_EXECUTABLE` that is broken, unhealthy, or returns a
malformed response also fails the opted-in test.

## Agency availability monitor

Read-only HTTPS synthetic monitoring for the agency properties. A run records
HTTP status, latency, TLS certificate expiry, and a configured content
signature. It also evaluates per-service SLOs and maintains deduplicated
incident and recovery history.

The repository deliberately contains no scheduler and sends no notifications.
Run it manually or from CI. Runtime state and reports are local artifacts and
must not be published from a private environment.

Python 3.11 or newer is the only requirement.

```sh
python3 -m agency_monitor check \
  --config config/services.json \
  --state var/state.json \
  --output var/status.json

python3 -m agency_monitor report \
  --config config/services.json \
  --state var/state.json \
  --output var/weekly-report.md
```

`check` exits nonzero if a service fails or breaches its availability SLO.
The JSON output is always written, including on failure. To keep CI synthetic
checks network-independent, use the checked-in fixture configuration:

```sh
python3 -m agency_monitor check --config tests/fixtures/services.json \
  --state /tmp/agency-state.json --output /tmp/agency-status.json
```

Each service has an HTTPS URL, expected status, regular-expression content
signature, timeout, certificate warning window, and rolling SLO policy. The
production URLs are private operational configuration. Do not include cluster
names, internal addresses, credentials, or tunnel identifiers.

See [`docs/incident-runbook.md`](docs/incident-runbook.md) for diagnosis and
recovery procedures.

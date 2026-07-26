# superset-agent-orchestrator

Local-first MCP server for durable orchestration of parallel coding agents through
Superset.

Performance benchmarks and the safe-default controlled load runner are documented
in [performance and load testing](docs/performance-and-load-testing.md).

## Product status

The backend-neutral core and fake adapter exercise complete lifecycle semantics,
but the stable public Superset interface currently supports only local discovery
and launch. It does not provide agent status, exact results, stop reasons,
cancellation, or backend recovery. Superset is therefore limited to a
launch-ledger technical preview that reports unobservable work as
`unknown_outcome`; it is not a general-availability orchestration backend.

See the [product boundary and measurable release gates](docs/adr/0002-product-boundary-and-mvp-gates.md).

The repository also contains the [MiniCPM5-1B reproducibility environment](docs/minicpm5-reproducible-environment.md).

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

The server reconciles its durable JSON state before accepting MCP requests and
periodically while it runs. Existing worker processes remain tracked by PID and
process start token; vanished processes are marked `unknown_outcome` and are
never relaunched merely because a server or client restarted. State writes are
locked, synced, and atomically renamed. A corrupt state file is left untouched.

Writer admission uses two independent layers: an exclusive cross-process
operating-system lock on a key derived from the workspace, and a transactional
SQLite lease with a monotonically increasing generation. Generations are never
reused. The bearer fencing token is random per generation and only its digest is
stored, so it never reaches the prompt, audit log, or an MCP response. Heartbeat,
release, and every controlled action compare-and-set on lease ID, generation,
token digest, owner identity, state, and row version, so a stale owner is fenced.

Expiry alone never releases a lease. `WorkspaceSafetyTool` reconciles a workspace
only with evidence: it preserves the lease while another process may hold the
lock, quarantines a lease whose owner is alive or whose identity is unverifiable,
and retires a generation only when the exact owner PID and process start token
are proven absent after expiry. Quarantine is cleared by one fixed repair flow
that retires the old generation and never assigns an active lease. Admissions,
denials, quarantines, repairs, and recoveries are append-only audit events.

Writer launch remains disabled: canonical workspace identity resolution and
read-only sandbox enforcement are still outstanding. See
[the lease policy](docs/workspace-lease-and-writer-safety.md) and
[the enforcement evidence](evidence/per-343/lease-enforcement.json).

Recovery tools:

- `recent_sessions` lists durable sessions independently of the connected
  client.
- `reopen_batch` restores the newest exact-name batch with sessions, workers,
  results, and attribution.
- `batches_create` durably accepts up to 250 attributed sessions and returns
  stable IDs immediately.
- `batches_get`, `batches_status`, and `batches_results` provide indexed, ordered
  pagination without per-agent polling.
- `recovery_diagnostics` reports orphan, unknown-outcome, and missing-result records.

Lifecycle tools:

- `sessions_cancel` and `batches_cancel` persist cancellation intent before the
  provider call. Repeated and concurrent requests issue exactly one stop command.
  Unsupported backends return `CANCEL_UNSUPPORTED` without changing state.
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

The MCP contract publishes typed TypeScript/Zod schemas and a client-neutral JSON
Schema catalog. It defines asynchronous launch, stable IDs, batches of 100
sessions, pagination, bounded wait, cancellation, deadlines, results, and restart
recovery. The versioned lifecycle tools listed above are registered runtime
handlers; other normative tools remain contract-only until their implementations
land.

## Agent adapter boundary

`AgentAdapter` isolates core orchestration from coding-agent lifecycle APIs. It
provides launch, status, terminal result, cancellation, and resume metadata
operations. Provider-specific response formats are normalized in adapter modules
before they reach core domain code.

`FakeAgentAdapter` accepts ordered run scripts and a caller-controlled clock.
Integration tests can therefore drive queued, running, succeeded, failed, and
cancelled paths without timing or network dependencies.

Run `npm run verify` to type-check the complete implementation and execute all tests.

Real Superset and Codex verification is opt-in because it launches an agent in an exact isolated worktree. See [the real-system harness guide](docs/real-superset-codex-e2e.md) for safety gates, commands, evidence, and currently unsupported lifecycle operations.

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

The live smoke test additionally runs the real CLI when it is installed. It is
skipped only when the executable cannot be found at all; a CLI that is present
but broken, unhealthy, or returning malformed responses still fails the suite. To
require the live run, set `SUPERSET_ORCHESTRATOR_REQUIRE_LIVE_SMOKE=1` or point
`SUPERSET_ORCHESTRATOR_EXECUTABLE` at a specific binary.

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

## macOS cleanup

`cleanup.py` inventories and removes stale temporary files and selected
development caches. It is deliberately a dry-run unless `--execute` is supplied.

```sh
python3 cleanup.py
python3 cleanup.py --execute
```

Potentially destructive or disruptive operations require separate flags:

```sh
python3 cleanup.py --execute --include-downloads
python3 cleanup.py --execute --empty-trash
python3 cleanup.py --execute --docker-prune
python3 cleanup.py --execute --eject-installers
```

Review dry-run output before execution. Downloads are moved to Trash, not
deleted. Broad `~/Library/Caches` deletion is intentionally excluded; only known
build and package cache directories are cleaned. The Hermes task queue is
validated and reported but not rewritten. LM Studio model locations are measured
but never removed.

Disk images are eligible for detachment only when `hdiutil` identifies a mounted
image backed by a `.dmg` file smaller than 5 GiB and the volume contains a
top-level `.app` or `.pkg`. Ambiguous images are reported and skipped. Physical
external drives are never considered by this logic.

The utility has no runtime dependencies beyond Python 3.9+ and standard macOS
command-line tools. Run its tests and optional development checks with:

```sh
python3 -m unittest -v
ruff check cleanup.py test_cleanup.py
mypy --strict cleanup.py test_cleanup.py
```

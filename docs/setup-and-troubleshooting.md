# Setup and Troubleshooting

## Prerequisites

- macOS 14 or Ubuntu 24.04
- Node.js 22 or 24 and npm 10
- Python 3.11 for the aggregate repository checks
- Superset Desktop/CLI for live discovery and agent launch

## Build and configure stdio

```sh
npm ci
npm run build
```

Configure any stdio-capable MCP client with an absolute path:

```json
{
  "mcpServers": {
    "superset-orchestrator": {
      "command": "node",
      "args": [
        "/absolute/path/to/superset-agent-orchestrator/dist/src/server.js"
      ],
      "env": {
        "SUPERSET_ORCHESTRATOR_STATE": "/absolute/private/path/state.json"
      }
    }
  }
}
```

MCP messages use stdout. Logs belong on stderr; clients must not parse stderr as
protocol output.

## Client-neutral workflow

1. Create durable batch/session ledger records and persist every returned ID.
2. Query aggregate status/results instead of polling records independently.
3. Recover by durable ID after a client or server restart.
4. Treat unsupported operations and `unknown_outcome` as honest capability results.
5. Verify tests, code, pull requests, and external state independently.

Live Superset launch is disabled by default. To operate it against a trusted
local Superset Desktop installation, add these variables to the MCP server
environment:

```json
{
  "SUPERSET_ORCHESTRATOR_ENABLE_LIVE_SUPERSET": "1",
  "SUPERSET_ORCHESTRATOR_STATE": "/absolute/private/path/state.json",
  "SUPERSET_ORCHESTRATOR_LIVE_RUN_STATE": "/absolute/private/path/superset-runs.json"
}
```

The live adapter uses `~/.superset/bin/superset` for discovery and
`~/.superset/mcp/local-server.mjs` for launch and response retrieval by default.
It authorizes only workspaces currently registered to the healthy local Superset
host. Launch idempotency survives an orchestrator restart because the exact
Superset terminal session ID is persisted before acceptance is returned.
Cancellation is not supported by this adapter.

## Runtime environment

`src/server.ts` reads these variables:

| Variable                                             | Purpose                       |
| ---------------------------------------------------- | ----------------------------- |
| `SUPERSET_ORCHESTRATOR_STATE`                        | Durable state path            |
| `SUPERSET_ORCHESTRATOR_REDACTION_CANARIES`           | Additional redaction canaries |
| `SUPERSET_ORCHESTRATOR_RECONCILE_MS`                 | Reconciliation interval       |
| `SUPERSET_ORCHESTRATOR_DEADLINE_MS`                  | Deadline sweep interval       |
| `SUPERSET_ORCHESTRATOR_PROVIDER_EXECUTABLE`          | Test provider executable      |
| `SUPERSET_ORCHESTRATOR_PROVIDER_ARGS`                | Test provider arguments       |
| `SUPERSET_ORCHESTRATOR_PROVIDER_TIMEOUT_MS`          | Test provider timeout         |
| `SUPERSET_ORCHESTRATOR_ENABLE_PROVIDER_TEST_TOOLS`   | Explicit test-tool opt-in     |
| `SUPERSET_ORCHESTRATOR_PROVIDER_TEST_WORKSPACE_ROOT` | Allowed test workspace root   |
| `SUPERSET_ORCHESTRATOR_ENABLE_LIVE_SUPERSET`         | Enable live local adapter     |
| `SUPERSET_ORCHESTRATOR_DISCOVERY_EXECUTABLE`         | Superset CLI path override    |
| `SUPERSET_ORCHESTRATOR_DISCOVERY_ARGS`               | Superset CLI prefix arguments |
| `SUPERSET_ORCHESTRATOR_LIVE_MCP_SERVER`              | Local MCP bridge override     |
| `SUPERSET_ORCHESTRATOR_LIVE_RUN_STATE`               | Live session identity state   |

The [portable configuration schema](../config/orchestrator.schema.json) defines a
broader contract; not every schema field is wired into the current server.
Provider tools are disabled by default and are not part of the versioned public
contract. Live mode enables them for local operations.

## Troubleshooting

| Symptom                             | Action                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Executable missing or ambiguous     | Set one exact local executable; see [discovery](configuration-and-discovery.md).                 |
| Workspace ambiguous or remote-only  | Register/select one healthy local workspace; relay fallback is prohibited.                       |
| Provider JSON malformed             | Stop and inspect stderr; malformed output fails closed.                                          |
| State corrupt                       | Preserve the file and use [recovery diagnostics](durable-storage.md); do not overwrite evidence. |
| Lease stale or quarantined          | Follow the single repair flow in the [lease policy](workspace-lease-and-writer-safety.md).       |
| `CANCEL_UNSUPPORTED`                | The selected adapter cannot cancel; do not report cancellation.                                  |
| `unknown_outcome` or missing result | Verify the terminal in Superset and preserve the live run-state file.                            |
| Live smoke skipped                  | Install/configure Superset, then opt in explicitly; the offline suite remains valid.             |
| Unsupported OS/runtime              | Use macOS/Linux and Node.js 22/24; see [compatibility](compatibility.md).                        |
| MCP JSON is contaminated            | Ensure application logs go to stderr, never stdout.                                              |
| Provider tools absent               | Enable live Superset mode or the isolated fixture mode explicitly.                               |

Run `npm run check` for the complete offline quality gate. Live and real-agent
checks are opt-in and must remain reported as blocked when the required backend
capability or authorization is absent.

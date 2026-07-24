# superset-agent-orchestrator

Local-first MCP server for durable orchestration of parallel coding agents through
Superset.

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

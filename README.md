# superset-agent-orchestrator
Local-first MCP server for durable orchestration of parallel coding agents through Superset

## Workspace leases

`WorkspaceLeaseStore` provides transactional SQLite workspace leases, monotonically
increasing fencing tokens, owner heartbeats, crash-safe takeover, and durable audit
events. Protected writes must call `assert_writer` inside the same transaction as
the write so an expired process cannot write after a replacement takes ownership.

Inspect or operate leases with the safety tool:

```console
workspace-safety --database state.db acquire /path/to/workspace worker-1 --ttl 30
workspace-safety --database state.db heartbeat /path/to/workspace worker-1 1 --ttl 30
workspace-safety --database state.db status /path/to/workspace
workspace-safety --database state.db audit /path/to/workspace
workspace-safety --database state.db release /path/to/workspace worker-1 1
```

Run tests with `python -m pytest`.

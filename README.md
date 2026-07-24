# superset-agent-orchestrator
Local-first MCP server for durable orchestration of parallel coding agents through Superset

## Recovery

The server reconciles its durable JSON state before accepting MCP requests and periodically while
it runs. Existing worker processes remain tracked by PID; vanished processes are marked
`unknown_outcome` and are never relaunched merely because a server or client restarted. State
writes are locked, synced, and atomically renamed. A corrupt state file is left untouched for diagnosis.

Recovery tools:

* `recent_sessions` lists durable sessions independently of the connected client.
* `reopen_batch` restores the newest exact-name batch with sessions, workers, results, and attribution.
* `recovery_diagnostics` reports orphan, unknown-outcome, and missing-result records.

Set `SUPERSET_ORCHESTRATOR_STATE` to choose the state file. By default it is stored at
`~/.local/share/superset-agent-orchestrator/state.json`.

```sh
npm install
npm test
npm start
```

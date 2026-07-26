# Idempotency And Reconciliation Contract

Status: normative reliability specification

This contract extends the authoritative session state machine. It governs the
uncertain interval around an external launch and is independent of any MCP client.

## Idempotency Key

Every logical launch attempt carries a caller-generated, non-secret
`idempotencyKey`, unique within the orchestrator's durable store. A recommended
shape is `<tenant>:<assignment-id>:<attempt-number>`. The key is immutable and is
included in every adapter dispatch and lookup. It is not a prompt hash.

Before external I/O, the orchestrator atomically persists one launch intent with:

- the key and SHA-256 hash of canonical semantic input;
- session, batch, and worker IDs;
- exact agent and task attribution;
- status, timestamps, and the eventual backend run ID.

Repeating the key with identical semantic input returns the original intent and
run. Reusing it with changed input is a conflict. At most one backend run may own a
key. Adapters must implement atomic backend deduplication and authoritative lookup
by key. An adapter that cannot satisfy both operations cannot safely support
automatic launch retry.

## Crash Boundaries

| Durable state | External fact | Recovery action |
| --- | --- | --- |
| No intent | No dispatch possible | Accept a new request |
| `reserved` | Dispatch did not begin, or is not known to have begun | Lookup key, then dispatch with the same key only when absence is authoritative |
| `dispatching` | Acceptance may have occurred | Lookup key; never issue a differently keyed launch |
| `unknown_outcome` | Transport failed after dispatch began | Keep non-terminal, lookup with backoff, and do not claim failure or completion |
| `bound` | Exact backend run ID is durable | Query only that run; never relaunch |

The implementation writes `dispatching` before adapter launch. A thrown adapter
call is therefore an unknown outcome, not proof of launch failure. If the process
dies after backend acceptance but before binding the run ID, startup lookup binds
the already accepted run by the same key.

## Startup Algorithm

1. Acquire the single-writer state lock and validate the complete durable file.
2. Stop startup on corrupt or structurally inconsistent state. Never replace it.
3. Rebuild unique indexes for durable IDs and idempotency keys.
4. Preserve terminal records and their immutable attribution and results.
5. For each non-bound launch intent, query the adapter by idempotency key.
6. Bind an exact match to its stored session, batch, worker, agent, and task IDs.
7. If authoritative absence is returned for `reserved`, dispatch once with the same
   key. For `dispatching` or `unknown_outcome`, automated startup reconciliation
   only records absence and waits for policy or operator retry because acceptance
   may be temporarily unobservable.
8. Reconcile each bound execution by its run ID. A live exact identity stays
   active; a matching terminal observation advances the state machine; unresolved
   identity enters or remains `lost`/`unknown_outcome` without fabricating a result.
9. Diagnose orphan references and quarantine foreign execution identities. Never
   infer attribution from list position, prompt text, process ID, or timestamps.
10. Persist the reconciliation watermark and diagnostics atomically, then serve.

## Decisions

| Condition | Classification | Retry decision |
| --- | --- | --- |
| Stored worker lacks its durable session or batch | Orphan | Do not launch; retain record and diagnostic for repair |
| Backend reports a different run for a bound session | Foreign execution | Quarantine; do not attach or cancel automatically |
| Dispatch returned a transport error | Unknown outcome | Lookup same key; no new attempt number until resolved |
| Lookup finds the key | Accepted launch | Bind exact run and continue reconciliation |
| Lookup authoritatively proves absence before dispatch | Not launched | Dispatch once using the existing key |
| Bound run is temporarily unobservable | Lost | Backoff and query same run; never relaunch |
| Terminal failure is proven and policy permits retry | Failed attempt | Create a new attributed attempt and new key; retain prior attempt |
| Completion lacks a durable result | Missing result | Do not fabricate completion output; retain diagnostic |

Retries are new attempts, not mutations. They receive new worker/session attempt
identity and a new idempotency key while retaining a causal link to the prior
attempt. A retry cannot overwrite the original attribution or result.

## Attribution Invariant

Results are joined only through the immutable chain
`idempotencyKey -> runId -> workerId -> batchId/sessionId`, all reserved before
dispatch. The stored `agent` and `task` travel with that chain. Reconciliation may
add evidence but cannot rewrite identity or infer ownership from backend ordering.

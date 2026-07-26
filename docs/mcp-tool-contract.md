# MCP tool contract 1.0

## Status and scope

This document defines the client-independent MCP surface for local Superset orchestration. The contract version is `1.0`; it is independent of the package and MCP protocol versions. Every request states `contract_version`, every response echoes it, and unsupported versions fail with `UNSUPPORTED_CONTRACT_VERSION`. Additive optional fields are compatible within 1.x. Removing fields, changing meanings, or adding required inputs needs a new major version.

The schemas are implemented in [`src/tool-contract.ts`](../src/tool-contract.ts) and published for non-TypeScript clients in [`config/mcp-tools.schema.json`](../config/mcp-tools.schema.json). The catalog contains complete structural input and output schemas, plus `x-semantic-rules` for cross-field requirements that JSON Schema 2020-12 cannot express, such as uniqueness by idempotency-key property. Generic clients and servers must enforce both. `x-error-definitions` publishes each error code's fixed layer and retry policy. These tools are a normative contract, not a claim that every handler is implemented. Existing recovery tools remain experimental until migrated.

The existing recovery spike persists a different client/worker projection. It is not wire-compatible with this contract and remains available only through its experimental tools. A future handler must migrate or deterministically project that state into contract sessions; `batches_recover` must not read legacy records as if they already satisfied the 1.0 schema.

## Tools

| Tool | Semantics |
| --- | --- |
| `orchestrator_discover` | Lists available local hosts, local workspaces, and agent presets without changing host state. Discovery is local-only and fails closed. |
| `sessions_launch` | Durably accepts 1 to 100 independent assignments and immediately returns stable session IDs in `requested` or `launching`. Completion is never awaited. |
| `batches_launch` | Atomically preflights and accepts 1 to 100 assignments as a durable batch, then launches each session independently. |
| `sessions_status` | Returns one ordered status outcome for each of 1 to 100 unique session IDs. |
| `sessions_results` | Returns currently available immutable artifacts and completeness for each requested session without waiting. |
| `sessions_cancel` | Requests cancellation for each session. A concurrent terminal transition wins; unsupported provider cancellation is a typed item error. |
| `batches_cancel` | Requests cancellation for every session in 1 to 100 batches and returns one item per batch. Item-level outcomes match `sessions_cancel`. |
| `batches_get` | Pages a durable batch snapshot by immutable batch ID. |
| `batches_wait` | Waits at most 30 seconds for up to 100 batches and returns current snapshots. Timeout is data, not an error. |
| `batches_recover` | Reopens durable state by immutable batch ID after client or server restart and never relaunches merely because a process restarted. |

Generic clients need no Hermes concepts, prompt conventions, or workspace paths. They discover opaque IDs, launch assignments, poll status, read results, and recover by stable IDs. Public lifecycle states are `requested`, `launching`, `running`, `canceling`, `lost`, `completed`, `failed`, and `canceled`; provider-specific terms such as `queued`, `succeeded`, and `cancelled` stay behind the adapter boundary.

## Envelopes and errors

Successful calls return `contract_version`, server-generated `request_id`, `data`, and `warnings`. A whole-request validation, discovery, storage, or integrity failure returns the version, request ID, and one typed `error`, and sets MCP `isError: true`. Array tools instead return ordered per-item errors for resource-specific failures; one missing session must not hide 99 valid outcomes and does not set `isError` for the whole call.

An error has a closed `code`, fixed `layer`, fixed `retryable` policy, safe human message, optional redacted `details`, and optional opaque `cause_id`. Details must follow the redaction rules in [configuration and discovery](configuration-and-discovery.md): no prompts, result bodies, environment values, credentials, home paths, or resume tokens. Codes and policies are machine-readable in `errorDefinitions`.

Local-routing errors preserve the existing meanings of `AMBIGUOUS_WORKSPACE`, `REMOTE_WORKSPACE`, `DUPLICATE_WORKSPACE`, and `WORKSPACE_UNAVAILABLE`. Runtime capabilities not yet demonstrated are explicit outcomes: `CANCEL_UNSUPPORTED`, `ARTIFACT_MISSING`, and `SESSION_LOST`. Clients must not infer remote fallback, successful cancellation, or recoverable output from transport success.

## Batch and pagination semantics

Explicit `session_ids`, `batch_ids`, and launch assignment arrays contain 1 to 100 entries. IDs and assignment idempotency keys are unique; duplicates reject the whole request rather than being silently deduplicated. Outputs preserve request or assignment order. The 100-session maximum makes one full-size batch a single logical operation, not 100 client round trips.

`batches_launch` validates schema, local routing, policy, and writer conflicts for the complete submission before durable acceptance. A preflight failure accepts nothing. After acceptance, each session progresses independently, so runtime failures are represented per session. Retrying the same idempotency key returns the original identity and must not launch another execution.

List pages default to 50 and allow at most 100 items. Cursors are opaque, bind to the batch and filters, and use stable durable batch sequence order. A mismatched or expired cursor returns `INVALID_ARGUMENT`. `has_more` is true exactly when `next_cursor` is present. Batches may eventually contain more than 100 sessions even though one launch call cannot.

`batches_wait` accepts `timeout_ms` from 0 through 30000 and `until` of `any_terminal` or `all_terminal`. It returns immediately when the condition holds, otherwise returns the latest snapshot with `timed_out: true`; timeout never changes session state. Implementations aggregate state and must not create one polling loop per session.

## Cancellation and deadline semantics

Cancellation is ordered so state is never optimistic. The orchestrator checks provider capability, then persists cancellation intent, then issues the stop command, then records the provider's own terminal observation.

- A backend that does not advertise supported cancellation returns `CANCEL_UNSUPPORTED` and changes no durable state. A backend that advertises support and then rejects the command is rolled back to its pre-cancel state, so a session is never parked in `canceling` on a promise the provider will not keep.
- A session with no bound execution identity is canceled locally only when launch has not started. If launch is in flight, cancellation remains durable until the exact run identity is bound or launch fails.
- Repeated and concurrent cancellation preserves one durable intent and the first reason. One active claimant performs each delivery attempt; an unknown delivery may be retried after restart and therefore requires an idempotent provider stop operation.
- A transport failure during the stop command returns `PROVIDER_UNAVAILABLE` and retains `canceling`, because delivery is genuinely unknown.
- Terminal state is monotonic. A completion that beat cancellation stays `completed` with stop reason `succeeded_before_cancellation`; a cancellation confirmation that arrives after another terminal outcome is recorded as a late observation and cannot regress state. A late result is retained only when no result was captured with the winning outcome.
- A canceled or failed session keeps whatever output the run produced, marked `partial`, `empty`, or `missing`. Output presence never changes the terminal state.

Deadlines are orchestrator-owned facts. Expiry is a `failed` outcome with stop reason `deadline_exceeded`; there is no separate timed-out state. The expiry transition is claimed under the durable single-writer lock before the provider is asked to stop, so concurrent sweeps expire and report each session exactly once and a provider failure never blocks expiry. If expiry wins while launch is in flight, the exact late-bound run identity and stop/reconciliation intent are persisted and resumed after restart without regressing the deadline outcome. A terminal session is never expired and refuses a new deadline.

## Examples

Immediate single launch:

```json
{
  "request": {
    "contract_version": "1.0",
    "assignments": [{
      "assignment_id": "docs",
      "label": "Update docs",
      "prompt": "Document the public API",
      "workspace_id": "ws_local_01",
      "agent_preset_id": "codex_default",
      "access_mode": "writer",
      "idempotency_key": "release-42-docs"
    }]
  },
  "response": {
    "contract_version": "1.0",
    "request_id": "req_01",
    "data": { "sessions": [{ "assignment_id": "docs", "session_id": "ses_01", "state": "requested" }] },
    "warnings": []
  }
}
```

Atomic batch launch uses the same assignment shape:

```json
{
  "contract_version": "1.0",
  "name": "release-42",
  "idempotency_key": "release-42",
  "assignments": [
    { "label": "API", "prompt": "Implement API", "workspace_id": "ws_1", "agent_preset_id": "codex", "access_mode": "writer", "idempotency_key": "release-42-api" },
    { "label": "Review", "prompt": "Review API", "workspace_id": "ws_2", "agent_preset_id": "codex", "access_mode": "read_only", "idempotency_key": "release-42-review" }
  ]
}
```

Mixed status preserves input order and remains a successful MCP call:

```json
{
  "contract_version": "1.0",
  "request_id": "req_03",
  "data": { "items": [
    { "session_id": "ses_done", "session": { "session_id": "ses_done", "workspace_id": "ws_1", "agent_preset_id": "codex", "state": "completed", "version": 4, "stop_reason": "succeeded", "artifact_manifest_id": "manifest_1", "created_at": "2026-07-24T18:00:00Z", "updated_at": "2026-07-24T18:02:00Z" } },
    { "session_id": "ses_missing", "error": { "code": "SESSION_NOT_FOUND", "layer": "orchestration", "message": "Session was not found", "retryable": false } }
  ] },
  "warnings": []
}
```

Results do not wait for unrelated sessions:

```json
{
  "contract_version": "1.0",
  "request_id": "req_04",
  "data": { "items": [
    { "session_id": "ses_done", "state": "completed", "complete": true, "artifacts": [{ "artifact_id": "art_1", "media_type": "text/markdown", "uri": "file:///safe/artifacts/art_1.md" }] },
    { "session_id": "ses_running", "state": "running", "complete": false, "artifacts": [] }
  ] },
  "warnings": []
}
```

A full-size status call supplies exactly 100 unique IDs. A 101st ID fails with `LIMIT_EXCEEDED`; repeated IDs fail with `DUPLICATE_ID`. A large recovered batch is read with `batches_recover` using `{ "contract_version": "1.0", "batch_id": "batch_01", "limit": 100 }`, then the returned opaque `next_cursor` until `has_more` is false.

Bounded wait timeout:

```json
{
  "contract_version": "1.0",
  "request_id": "req_05",
  "data": { "items": [{ "batch_id": "batch_01", "timed_out": true, "counts": { "requested": 0, "launching": 0, "running": 1, "canceling": 0, "lost": 0, "completed": 99, "failed": 0, "canceled": 0 } }] },
  "warnings": []
}
```

If completion races cancellation, `sessions_cancel` returns the observed `completed` session and does not regress it to `canceling` or `canceled`. On restart, `batches_recover` binds to the persisted session and execution IDs and never launches replacements. If local relay resolution fails, discovery returns a typed routing failure and performs no cloud lookup or remote retry.

## Contract verification

Contract tests must validate documented examples and closed schemas; acceptance of exactly 100 and rejection of 0, 101, duplicate IDs, and duplicate idempotency keys; ordered mixed outcomes; cursor invariants; wait bounds; lifecycle vocabulary; fixed error policy; unknown-field rejection; immediate launch states; and version rejection. Handler integration tests must additionally prove idempotent stable IDs, atomic preflight, no remote fallback, cancellation races, restart recovery without relaunch, pagination without omissions, and protocol recovery after an invalid call.

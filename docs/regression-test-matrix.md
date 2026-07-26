# Resilience and adversarial regression matrix

This matrix defines deterministic P0 regression coverage. Every fixture uses a
temporary registry, state file, workspace, and synthetic secret. No test invokes
the live Superset CLI, reads user data, changes cron, or enters an unrelated repo.

| P0 failure | Deterministic injection | Required invariant |
| --- | --- | --- |
| Interrupted launch after durable acceptance | SIGKILL a child at each launch boundary, recover in a fresh process | One durable assignment and at most one provider run |
| Concurrent dispatch | Two stores contend while one provider launch is blocked | The lock serializes calls; adapter idempotency prevents duplicate runs after stale-lock recovery |
| Cancellation race | Duplicate cancellation and cancellation after completion | One immutable terminal adapter result |
| Stale or forged launch event | Replay or mismatch aggregate or event type | No state or audit mutation |
| Backward wall-clock adjustment | Generate a valid transition before the prior timestamp | Transition succeeds without regressing materialized time |
| Late or conflicting result | Race two deliveries for one attempt | One immutable authoritative result |
| Corrupt registry bytes | Open a non-SQLite fixture | Fail closed without replacing bytes |
| Falsified migration ledger | Claim the current version with missing objects or gaps | Fail closed before serving data |
| Migration failure | Precreate a conflicting schema object | Transaction rolls back all migration changes |
| Stale writer lease | Expire an unreleased writer and run retention | Time alone never revokes writer authority |
| Hostile backend JSON | Invalid, oversized, unknown-field, and prototype-key corpus | Reject or strip unsafe structure before inventory is trusted |
| Cross-workspace result | Race conflicting deliveries with exact attribution | Reject before persistence |
| Hostile identifiers | NUL, control, option, traversal, and prototype names | Reject or preserve strictly as inert data |
| Secret canary | Synthetic token in rejected backend/error payloads | Error text does not disclose backend payload |

The launch interruption matrix uses `test/fixtures/launch-process-worker.ts` to
terminate a child with `SIGKILL` and recover through a fresh process. Race and
event tests are in `test/resilience-regression.test.ts`; corruption and migration
tests are in `test/storage-adversarial.test.ts`; hostile inputs are in
`test/security-adversarial-corpus.test.ts`; exact result attribution is covered
by `test/result-capture.test.ts`.

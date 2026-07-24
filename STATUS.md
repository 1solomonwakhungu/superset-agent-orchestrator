# Status

## PER-330 durable storage

- Added a product-owned SQLite registry with 7 domain tables and a migration ledger.
- Added transactional migrations, backup-gated rollback, retention cleanup, export, verified backup, and fail-closed corruption handling.
- Added tests for empty and prior schemas, rollback, constraints, history, cleanup, export, backup, and corruption.
- Verification: `npm run verify` passes the build and all 21 tests.
- Next: complete pull request delivery.

PER-332 agent adapter implementation and verification are complete.

- Added the provider-neutral launch, status, result, cancellation, and resume
  metadata contract.
- Added Codex terminal response normalization outside the core contract.
- Added a deterministic scripted fake covering all terminal paths and lifecycle
  invariants.
- Verification: `npm run verify` passed 7 tests, `node --test
  test/configuration-contract.test.mjs` passed 3 tests,
  `./scripts/verify-per-323.sh` passed, and `git diff --check` passed.
- Pull request: https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/5
- Verified PR head: `8349e99e0515168c66b672e88d7469faf7d3fa95`.
- Merge commit: `1a2e61ec2dac707f6b180b46490f0f441e102fe8`.
- GitHub reported the exact head clean and mergeable with no required checks.
- Next: reconcile PER-332 in Linear.

PER-341 startup reconciliation and batch recovery are complete.

- Added durable startup and periodic reconciliation without worker relaunch.
- Added recent-session, named batch reopen, and recovery diagnostic MCP tools.
- Added strict state validation, process identity checks, serialized synced writes,
  and orphan, unknown-outcome, and missing-result diagnostics.
- Verification: `npm run verify` passed 13 tests, `node --test
  test/configuration-contract.test.mjs` passed 3 tests, and `git diff --check` passed.
- Pull request: https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/7
- Verified PR head: `3a217ac7e2acd2bd36d41bad43e6383666ac94c4`.
- GitHub reported the exact head clean and mergeable with no required checks.
- Next: merge PR 7 and reconcile PER-341 in Linear.

PER-338 durable idempotent asynchronous launch implementation is complete locally.

- Added durable acceptance with stable session, batch, and assignment IDs.
- Added adapter idempotency keys, asynchronous dispatch recovery, and lifecycle audit events.
- Added concurrent repeated-key prevention and crash injection at all five launch boundaries.
- Verification: `npm run verify` passed 19 tests, `node --test
  test/configuration-contract.test.mjs` passed 3 tests,
  `./scripts/verify-per-323.sh` passed, and `git diff --check` passed.
- Pull request: https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/11
- Next: verify the merged prerequisite integration, push the conflict resolution,
  verify exact-head checks, and merge.

PER-325 local control-plane threat model implementation and verification are
complete.

- Defined assets, actors, trust boundaries, capabilities, abuse cases, and residual
  risk for the local MCP, Superset, agent-process, storage, and result boundaries.
- Mapped 18 P0 threats to enforceable controls and 29 adversarial tests across
  path, command, prompt, secret, workspace, confused-deputy, routing, audit, state,
  resource, lifecycle, and executable-provenance attacks.
- Excluded arbitrary commands, workspace deletion, raw filesystem/Git/database,
  relay, secret, and dynamic-plugin escape hatches from the MVP.
- Specified fail-closed redaction, owner-only persistence, mutation intent/outcome
  audit events, event injection resistance, and tamper evidence.
- Verification: `npm run verify` passed 20 tests, the independent configuration
  contract passed 3 tests, strict local-routing evidence verified, Markdown lint
  passed with 0 issues, and `git diff --check` passed.
- Next: open, validate, and merge the PER-325 pull request, then reconcile Linear.

PER-331 idempotency and restart recovery implementation is complete locally.

- Added a durable semantic request reservation keyed before external launch.
- Added adapter lookup and deduplication by idempotency key, exact execution
  binding, and immutable session, batch, worker, agent, and task attribution.
- Added startup recovery and explicit unknown-outcome, orphan, foreign execution,
  missing-result, and retry decisions without fabricated completion.
- Added deterministic tests for crashes after reservation and after external
  acceptance, repeated requests, conflicting key reuse, backend rediscovery, and
  unresolved outcomes. Each path proves at most one external launch.
- Verification: `npm run verify` passed 20 tests, `node --test
  test/configuration-contract.test.mjs` passed 3 tests,
  `./scripts/verify-per-323.sh` passed, and `git diff --check` passed.
- Next: commit, push, open the PER-331 pull request, verify its exact head, merge,
  verify `main`, and mark Linear Done.

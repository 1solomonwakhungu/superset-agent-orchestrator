# Status

## PER-351 performance and load validation

- Added reproducible 100-session fake-backend and staged 30-agent controlled-load
  harnesses with machine-readable and reviewer-readable reports.
- The fake benchmark accepted, completed, attributed, persisted, queried, and
  restart-recovered 100/100 results with 0 failures and 0 attribution mismatches.
- Measured launch p95 28.195 ms, indexed-query p95 0.126 ms, 115,343,360-byte RSS,
  683.715 CPU ms, 0 descriptor growth, and 11.732 ms restart recovery.
- The 30-real-agent run is blocked: only this assigned writer workspace is in
  scope, while the harness requires 30 authorized isolated workspaces and public
  Superset APIs cannot observe completion, results, cancellation, recovery, or
  aggregate agent resource use. The safe dry-run launched 0 paid agents.
- Hardened CLI argument handling and fail-closed report validation so incomplete,
  failed, aborted, misattributed, or internally inconsistent runs cannot pass.
- Verification after merging current `origin/main`: typecheck, 107/107 non-live
  tests, the 100-session benchmark, safe 30-session dry-run, both report
  verifications, build, and Markdown lint passed.
  The repository suite passes except for its pre-existing live discovery smoke
  test, which requires the unavailable and out-of-scope Superset executable.
- Next: provision 30 explicitly authorized isolated workspaces, then run the paid
  staged load command under operator supervision.

## PER-258 agency availability monitoring

- Completed: Implemented and verified the PER-258 monitor, production service
  configuration, incident state machine, weekly report, fixture tests, CI, and
  runbook.
- Next: Push, merge after exact-head CI, and verify the merged main.
- Key results: 5/5 live properties returned HTTP 200 with matching content and
  valid TLS at 2026-07-25T03:00:23Z to 03:00:24Z, 3/3 monitor tests and 101/101
  repository tests passed, all sampled SLOs were 100%, and 0 schedulers or
  notification integrations exist. Evidence is under `evidence/per-258/`.

## PER-230 vllm-mlx soak safety gate

- Completed: PER-230 pre-test validation and safety-gate report.
- Result: Three-hour soak skipped because net swap grew 2,065.69 MiB in 5m48s before model start, exceeding the 2 GiB hard-stop threshold.
- Safety: No model started, port 8001 remained closed, and all three protected hashes were unchanged.
- Next: Merge the report and return PER-230 to Backlog with exact blocker evidence.

## PER-350 second real response adapter

- Selected the enabled OpenCode preset without enabling or invoking Claude.
- Added documented OpenCode assistant-response normalization while preserving
  the existing core domain and MCP contracts.
- Added shared Codex/OpenCode conformance coverage for launch identity, exact
  result, attribution, terminal states, and fail-closed malformed responses.
- Documented the supported boundary and unsupported lifecycle/features.
- Verification: `npm run verify` passed 101/101 tests, focused Markdown lint,
  strict local-routing verification, and `git diff --check` passed.
- Next: deliver through the PER-350 pull request and verify merged `main`.

## PER-333 workspace lease and writer safety

- Defined exclusive cross-process writer admission using a durable generation and
  continuously held OS lock over stable canonical worktree identity.
- Defined acquisition, heartbeat, two-phase release, fencing, crash recovery,
  quarantine, evidence-based operator repair, and typed fail-closed refusals.
- Allowed shared read-only work only behind verified mechanical write prevention;
  unsupported agent launches remain disabled rather than relying on prompts.
- Prohibited every warning, force, expiry, configuration, request, and state-edit
  override and added contract tests for the critical safety invariants.
- Verification: focused policy tests passed 7/7; `npm run verify` passed 81/81;
  Markdown lint, strict local-routing verification, and `git diff --check` passed.
- Next: deliver through the PER-333 pull request and verify fetched `main`.

## PER-327 compatibility evidence matrix

- Added a versioned, machine-readable matrix for OS, Node, npm, MCP SDK,
  transport, Superset Desktop/CLI, and agent-preset combinations.
- Added a sanitized, non-mutating environment probe and tests that enforce
  immutable evidence, bounded claims, and actionable fail-closed unknowns.
- Documented exact current claims, repeatable operation probes, revalidation
  triggers, and unsupported/unknown-combination policy.
- Verification: `npm ci` succeeded; `npm run compatibility:probe` produced an
  actionable sanitized `unknown`; `npm run verify` passed all 63 tests;
  `./scripts/verify-per-323.sh` passed; the focused lifecycle suite passed all
  3 tests; Markdown lint and `git diff --check` passed.
- Next: deliver through pull request and verify merged `main` before reconciling
  PER-327.

## PER-326 product boundary

- Accepted a backend-neutral orchestration core with a version-gated Superset
  adapter and Hermes only as an optional client example.
- Narrowed Superset to a launch-ledger technical preview because supported status,
  exact result, stop reason, cancellation, and backend recovery are unavailable.
- Defined target users and jobs, MVP scope, non-goals, deferrals, and measurable
  Go, Narrow, Pause, and Kill gates.
- Added contract tests that prevent the unsupported lifecycle boundary from being
  omitted or reframed as general-availability orchestration.
- Next: run full verification and deliver through the PER-326 pull request.

## PER-328 MCP tool contract

- Added the versioned client-independent discovery, launch, batch, status,
  result, cancellation, bounded-wait, and recovery contract.
- Published generated JSON Schemas, typed error policy, cross-field semantic
  rules, 100-session limits, opaque pagination, and generic-client examples.
- Verification after integration with current `main`: `npm run schema` passes,
  `npm run verify` passes all 59 tests, and `git diff --check` passes.
- Next: push, open and safely merge the pull request, then reconcile Linear.

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

PER-340 exact result capture and attribution are implemented locally.

- Added fail-closed Codex response validation and exact empty/partial handling.
- Added durable result claims with assignment, batch, session, workspace,
  attempt, run, and task attribution.
- Added idempotent duplicate/late delivery and conflicting-delivery rejection.
- Kept agent claims separate from independently verified artifacts.
- Verification pending final review and pull request delivery.

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

PER-339 batch status and result APIs are implemented and verified locally.

- Added durable idempotent acceptance for up to 250 attributed sessions with
  stable IDs returned before execution completes.
- Added indexed batch get, mixed-state status, partial results, opaque
  pagination, cross-process freshness, and query instrumentation.
- Added deterministic duplicate, unknown-ID, ordering, attribution,
  idempotency-conflict, 100-plus session, and cursor tests.
- Verification: `npm run verify` passed 19 tests, `node --test
  test/configuration-contract.test.mjs` passed 3 tests,
  `./scripts/verify-per-323.sh` passed, and `git diff --check` passed.
- Next: commit, open the PER-339 pull request, verify the exact head, and merge.

PER-322 lifecycle and result API research and verification are complete locally.

- Pinned primary-source evidence to `superset-sh/superset@b0d3411`.
- Classified public launch as Beta and all ordinary post-launch lifecycle,
  result, cancellation, and backend recovery operations as unavailable.
- Quarantined private canary/dev ACP capabilities and excluded private database,
  temporary-log, transcript, and terminal-output parsing from stable design.
- Added a fail-closed machine-readable capability contract.
- Verification: `npm run verify` passed 20 tests, focused Markdown lint passed,
  and `git diff --check` passed.
- Next: deliver PER-322 through pull request.

PER-337 supported Superset discovery implementation is complete.

- Added structured parsers for projects, workspaces, local host status, agent
  presets, and CLI versions.
- Added explicit `--local` routing, host correlation, version probing,
  per-command timeouts, isolated child environments, and normalized errors.
- Child commands use argument arrays with `shell: false`; large JSON responses
  use permission-restricted temporary capture and guaranteed cleanup.
- Verification: `npm run verify` passed 22 tests, including a real Superset
  1.16.1 smoke test for all documented discovery schemas.
- Next: open, verify, and merge the PER-337 pull request.

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

# Status

## PER-345 canonical hash and PER-342 tool compatibility, 2026-07-26

- Strictly schema-normalized launch requests before versioned canonical hashing;
  unknown top-level and nested fields now fail closed.
- Added equality and inequality coverage for optional normalization, key order,
  every semantic field, and the intentionally excluded idempotency key.
- Reviewed the five PER-342 lifecycle tools into an exact post-merge snapshot
  without relaxing the command, path, filesystem, process, or plugin deny policy.
- Verification: focused security/idempotency tests passed 54/54; `npm run verify`
  passed 167 tests with 1 explicit optional skip, coverage, Python 3/3, and schema
  checks; `git diff --check` passed.
- Next: open and merge the companion PR into the primary PER-345 branch. Linear
  remains owned by the final integrator.

## PER-345 companion state/auth/hash hardening, 2026-07-26

- Added fail-closed absolute state-path checks for a dedicated owner-only `0700`
  directory and existing owner-only `0600` regular state file, rejecting symlink,
  nonregular, permissive, and wrong-owner objects before lock/read/write boundaries.
- Added exact external Superset worktree grants bound to workspace ID, project ID,
  and canonical path while retaining local registration, owner, path, device, and
  inode revalidation.
- Added domain-separated recursive canonical launch-request hashing and adversarial
  tests for insertion-order equivalence, exact grants, identity drift, retargeting,
  state permissions, symlinks, nonregular files, and relative paths.
- Verification: focused security/idempotency tests passed 52/52; `npm run verify`
  passed 165 tests with one explicit skip, coverage, schema, and Python checks.
- Next: deliver the companion PR into the primary PER-345 branch and verify its CI.

## PER-345 companion redaction hardening, 2026-07-26

- Added bounded structured redaction with 20-level and 1,000-entry limits,
  accessor-safe traversal, and prototype-pollution-safe output construction.
- Added common password/API, AWS access/session, Slack, npm, JWT, GitHub,
  authorization, private-key, sensitive-key, and configured-canary redaction.
- Audit fields now strip Unicode bidi and zero-width formatting controls, and
  every persisted state object schema rejects unknown fields.
- Verification: focused security tests passed 33/33; `npm run verify` passed
  159 tests with one explicit skip, coverage and generated-schema checks, and
  3/3 Python tests; lint, typecheck, build, and `git diff --check` passed.
- Next: merge the companion PR into the primary PER-345 branch after CI.

## PER-352 cross-platform compatibility CI

- Added exact-head macOS 14 and Ubuntu 24.04 CI lanes for Node.js 22 and 24 with
  npm 10.9.8, plus a report job that accepts only four passing same-commit results.
- Added real portable filesystem, process, timeout, signal, and process-identity
  tests and removed ambient-working-directory assumptions from stdio tests.
- Made the Superset Desktop smoke skip visible and justified on generic runners.
- Made Windows explicitly unsupported in package metadata, startup, probe policy,
  matrix evidence, documentation, and tests.
- Verification: `npm run verify` passed 106 runnable tests with one explicit
  Superset Desktop skip; `npm run compatibility:probe` returned the expected
  actionable unknown; focused Markdown lint and `git diff --check` passed.
- Fixed exact-head checkout attribution, fail-closed detected lane validation,
  and stale machine-readable Linux/Node 24 evidence at `3fd2ce6`.
- The PR's latest exact-head run passed all four macOS 14/Ubuntu 24.04 and
  Node.js 22/24 lanes plus the generated compatibility report job.
- Pull request: https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/32
- Next: independently verify and merge PR 32, then verify fetched `main` before
  closing PER-352.

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

PER-336 embedded persistence implementation is in progress.

- Added typed repositories for every durable SQLite entity.
- Added transactional repository operations and atomic logical export.
- Added read-only full integrity diagnostics and executable export/integrity commands.
- Added repository, rollback, corruption, export, and CLI verification coverage.
- Current verification: `npm run verify` passed 94/94 tests.
- Next: reconcile current main, commit, push, open and merge the verified PR, then verify main.

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

PER-345 path, command, environment, and audit security controls are implemented
locally.

- Added `src/security.ts`: typed `SecurityError` codes, canonical workspace
  authorization through the registered local inventory, device and inode identity
  revalidation before spawn, bounded text validation, pinned executable and fixed
  argument-vector checks, data-operand checks, an exact-case child environment
  allowlist, and recursive cycle-safe secret redaction.
- Added `src/tool-security.ts`: the reviewed MVP tool snapshot plus exclusion of
  shell, terminal, destructive, raw filesystem, raw Git, environment, secret,
  database, relay, process-kill, and dynamic-plugin capabilities. `src/server.ts`
  now asserts every registration and the whole surface before connecting.
- Added a durable security audit trail in `src/store.ts`: normalized bounded
  redacted fields, policy version, sequence numbers, a SHA-256 event chain, and
  `verifySecurityAuditChain` for tamper detection. Launch acceptance and dispatch
  record an allowed intent before every external launch and a typed denial for
  every refusal.
- Launch requests now carry `workspaceId` only. The canonical path is derived from
  Superset's local inventory, never supplied by a client.
- Added `docs/security/path-command-environment-audit-controls.md` mapping each
  implemented control and its proving test.
- Hardened the implementation review gaps: real process spawning now requires a
  canonical absolute regular-file executable; relative inventory paths fail closed;
  adapters receive only the child environment allowlist and must revalidate the
  workspace at their actual launch boundary; result claims are redacted before
  persistence and egress; and typed audit integrity checks run on load and append
  against a persisted chain head so suffix truncation is detected.
- Verification: `npm run verify` passed 110 tests including 18 new adversarial
  tests for traversal, symlink and prefix escape, time-of-check/time-of-use
  retargeting, shell-free spawning, executable and argument injection, malicious
  environment seeding, secret canaries in state and audit, audit chain tampering,
  and tool-surface drift. `npm run schema` produced no snapshot change and
  `./scripts/verify-per-323.sh`, Markdown lint for `docs/security`, and
  `git diff --check` passed.
- Next: commit and push the hardening follow-up, open the PER-345 pull request, and
  reconcile Linear from the parent factory.
- PR 28 follow-up integrated `origin/main`, kept transient workspace discovery
  failures retryable, and prevented pre-adapter audit failures from becoming
  unknown external outcomes. Discovery tests now use an explicitly pinned
  executable, and the external CLI smoke test is opt-in.
- Verification: `npm run verify` passed 123 tests with 1 explicit external smoke
  skip; `npm run check`, `npm run schema`, `./scripts/verify-per-323.sh`, security
  Markdown lint, Python bytecode compilation, and `git diff --check` passed. The
  merged PER-258 Python suite passed 2/3 under Apple system Python; its TLS
  recovery fixture fails because LibreSSL ignores the subprocess `SSL_CERT_FILE`.
- Final review hardening made launch acceptance and successful outcomes atomic
  with their hash-chained security audit records, rejects a removed audit trail,
  bounds result claims and live discovery output to 4 MiB, isolates retryable
  workspace failures per assignment, and adds deterministic background shutdown.
- Final verification after integrating current `origin/main`: `npm run verify`
  passed 135 tests with 1 opt-in smoke
  skip; the final 60-test security/launch/discovery/platform focus passed 20
  consecutive runs (1,200/1,200); the repository quality gate passed formatting,
  lint, typecheck, build, tests, coverage, Python 3.11 tests, and schema diff; routing
  contract, security Markdown lint, Python
  bytecode compilation, and `git diff --check` passed.
- Verifier follow-up: fresh workspace inventory binding now rejects registration,
  host/organization, owner, project/path, device, and inode drift at launch and
  recovery; executable provenance rejects symlinks, unsafe POSIX modes/owners,
  and replacement; all launch identities and metadata are explicitly bounded.
- One injected redaction policy now covers raw and encoded literal canaries across
  state, audit, diagnostics, errors, results, logs, and MCP egress. Coordinator
  started/failed/recovered outcomes are atomic with their audit records, legacy
  intents fail closed, and audit fields are well-formed and at most 256 characters.
- Follow-up verification: full `npm run check` passed 145 tests with one opt-in
  smoke skip, coverage at 95.35% statements/86.78% branches/90.29% functions/
  95.35% lines, and Python 3.11 tests 3/3; the focused 71-test suite passed 20
  consecutive runs (1,420/1,420), with schema no-diff, routing, Markdown lint,
  compileall, and `git diff --check` also passing.

PER-336 embedded persistence and migrations is complete and verified locally.

- Reconciled the feature branch with `origin/main` at `90cef0d` via a clean merge
  commit. No conflicts, no force push, no history rewrite, no data deleted.
- Durable schema is at version 2 with `batches`, `assignments`, `sessions`,
  `results`, `events`, `workspace_leases`, `idempotency_records`, and the
  `schema_migrations` ledger, all `STRICT`.
- Migrations apply each forward step and its ledger row inside one
  `BEGIN IMMEDIATE` transaction. An unknown future schema fails closed.
  `rollback(target, backupPath)` requires and integrity-verifies a distinct
  backup before stepping down.
- Typed transactional repositories cover every durable entity, roll entities and
  events back together, and fail closed on malformed persisted JSON.
- `exportJson` writes a versioned logical export atomically. `checkIntegrity`
  opens the registry read-only and verifies SQLite integrity, foreign keys,
  contiguous migration ledger, and required tables, triggers, and indexes.
- Corruption diagnostics fail closed at startup and in the CLI without
  replacing, truncating, or salvaging the original bytes.
- Verification after clean install: `npm ci` exit 0 (2 moderate audit findings,
  pre-existing), `npm run build` exit 0, `npm run check` exit 0, `npm test`
  106/106 passing, storage/migration/corruption suites 12/12 passing.
- Next: PR review and merge. Linear is owned by the parent factory.

PER-336 attempt 2 makes discovery verification deterministic without a Superset install.

- Root cause: `test/superset-discovery.smoke.test.ts` unconditionally shelled out
  to the optional `superset` executable, so the suite failed with
  `SupersetDiscoveryError UNAVAILABLE` on any machine without it.
- `test/fixtures/superset-discovery-recorded.json` holds real CLI payloads
  captured by `npm run discovery:record`. The recorder reuses the adapter's own
  `runProcess`, which spools stdout to a temp file. This matters because the
  Superset CLI truncates large payloads when its stdout is a pipe.
- The recorded contract test always runs and replays the fixture through the
  real adapter and schemas, so schema coverage no longer depends on the
  executable. The live test runs only when the executable resolves on the search
  path.
- Availability is decided by resolving the executable, not by interpreting an
  adapter error. A present but broken Superset still fails.
- `SUPERSET_ORCHESTRATOR_REQUIRE_LIVE_DISCOVERY=1` turns an absent executable
  from a skip into a failure.
- Guard cases proved by running them: absent plus require flag fails
  (`... is set but no Superset executable was found on PATH`); present but
  malformed fails (`MALFORMED_RESPONSE`); present but unhealthy host fails
  (`UNAVAILABLE`).
- Verification after `rm -rf node_modules dist` and `npm ci` (exit 0):
  `npm run build` exit 0, `npm run check` exit 0, `npm test` 107/107 passing
  with Superset present, and 106 passing plus 1 truthfully skipped with Superset
  absent from PATH. Focused persistence and migration
  (`storage`, `repositories`, `server-restart`) 11/11 passing. Corruption
  fail-closed (`storage-cli`) 2/2 passing.
- Next: PR review and merge. Linear is owned by the parent factory.

PER-336 merge-readiness review fixes are complete locally.

- Expired unreleased writer leases remain durable and continue fencing later writers until evidence-based reconciliation releases them.
- Startup validates exact schema definitions and foreign keys before repositories are exposed, and validates an existing prior schema before applying migrations.
- Each migration rechecks the ledger while holding `BEGIN IMMEDIATE`; migration SQL and its ledger row remain atomic.
- CLI export uses one read-only validated snapshot and never migrates or otherwise modifies the source registry.
- Integrity diagnostics reject altered tables, indexes, and triggers by exact canonical definition rather than object name alone.
- Discovery fixture recording now pseudonymizes commands and arguments and replaces environment values.
- Verification: clean `npm ci` passed with 2 pre-existing moderate audit findings; build and typecheck passed; 110 tests ran with 109 passing, 0 failing, and 1 optional live-discovery skip; schema generation, compatibility probe, PER-323 routing verification, and `git diff --check` passed.
- Next: commit, push, and verify PR 26 exact-head checks and merge state. Do not merge; independent verifier owns merge.

PER-336 is reconciled with the repository quality gates from `cbd44e1`.

- Preserved the storage CLI, discovery recorder, compatibility report, platform declaration, and all format, type-aware lint, typecheck, build, coverage, Python, and schema gates while resolving generated lock metadata.
- Existing prior schemas now undergo exact schema and foreign-key validation before migration; rejected registries remain at their original ledger version.
- Verified backups now pass full page, foreign-key, ledger, and canonical-schema checks before rollback starts.
- Invalid negative, non-finite, or infinite retention durations fail before the registry opens.
- Recorded discovery remains deterministic while live discovery requires explicit smoke opt-in or the required-live setting.
- Verification: clean `npm ci` passed with 2 pre-existing moderate advisories; focused persistence tests passed 18/18; `npm run check` passed formatting, ESLint, typecheck, build, 119 tests (118 pass, 0 fail, 1 optional live skip), coverage, Python 3/3, and schema no-diff; `git diff --check` passed.
- Next: commit and push the current-main integration, verify exact-head Quality and Compatibility checks and review threads, then leave PR 26 unmerged for independent verification.

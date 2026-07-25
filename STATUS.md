# Status

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

## PER-349 real Superset and Codex end-to-end tests

- Added an opt-in real-system harness with explicit workspace identity, linked
  Git worktree, clean-checkout, Codex preset, and launch authorization gates.
- Relay-outage discovery and launch use dead proxies with loopback retained in
  `NO_PROXY`; command evidence includes versions, timings, resources, hashes,
  selected non-secret observations, failures, and workspace/session attribution.
- Result, cancellation, and backend recovery remain fail-closed and explicitly
  unsupported on Superset CLI 1.16.1. A real run cannot claim the exact sentinel
  passed without a supported result API.
- Executable fake-Superset tests prove preflight, launch/receipt attribution,
  unsupported lifecycle reporting, sentinel redaction, workspace isolation, and
  opt-in refusal.
- Verification: `npm run verify` passed build and all 92 tests; focused harness
  tests passed 3/3; `git diff --check` passed.
- Real preflight passed against Superset CLI 1.16.1 with zero failures.
- Authorized relay-outage launch passed in 86.97 ms and returned session
  `4236efff-a9c8-4941-9eb8-00a657ead0ec`; target HEAD/status remained unchanged.
- Real classification is `blocked`, not passed: exact sentinel retrieval and
  backend restart recovery are unsupported, while cancellation passed through
  the explicitly allowed unsupported-cancel outcome.
- Next: deliver the commits through an unmerged pull request.

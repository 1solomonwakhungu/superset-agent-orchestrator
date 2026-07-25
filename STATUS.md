# Status

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

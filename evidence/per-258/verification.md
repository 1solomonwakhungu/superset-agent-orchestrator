# PER-258 verification

Verification was completed from this isolated worktree on 2026-07-24 CDT.
The monitor made only HTTPS GET and TLS handshake requests. No scheduler,
notification, credential, or mutating integration was created.

## Deterministic verification

```sh
python3 -m unittest discover -s tests -v
npm ci
npm run verify
git diff --check
```

Results: all 3 monitor tests passed, including a local TLS fixture with two
deduplicated content-signature failures followed by a recorded recovery. The
full repository build and all 101 repository tests passed. The diff check
passed.

## Live verification

```sh
python3 -m agency_monitor check \
  --config config/services.json \
  --state evidence/per-258/live-state.json \
  --output evidence/per-258/live-status.json
python3 -m agency_monitor report \
  --config config/services.json \
  --state evidence/per-258/live-state.json \
  --output evidence/per-258/weekly-report.md
```

At `2026-07-25T03:00:23Z` through `2026-07-25T03:00:24Z`, agency,
compliance, notes, pricing, and ROI each returned HTTP 200, matched the
configured content signature, and presented a valid certificate expiring at
`2026-09-11T20:12:15Z`. Latencies were 243.3 ms, 183.2 ms, 226.3 ms,
149.5 ms, and 172.2 ms respectively. There were no open incidents, and each
one-sample SLO evaluation was 100% and met its configured target.

Artifacts:

- `evidence/per-258/live-status.json`: machine-readable current status
- `evidence/per-258/live-state.json`: retained check and incident history
- `evidence/per-258/weekly-report.md`: human-readable weekly report

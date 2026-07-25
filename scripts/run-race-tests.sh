#!/usr/bin/env bash
# Repeats the concurrency-sensitive suites so an ordering-dependent defect shows
# up as a reproducible failure rather than an occasional one. Every run is
# offline and self-contained; see docs/flaky-test-policy.md for how to act on a
# failure here.
set -euo pipefail

REPEATS="${RACE_REPEATS:-10}"
RACE_SUITES=(
  "test/idempotency-and-leases.test.ts"
  "test/state-transitions.test.ts"
  "test/launch-idempotency.test.ts"
  "test/launch-service.test.ts"
  "test/server-restart.test.ts"
  "test/reconciliation.test.ts"
)

cd "$(dirname "$0")/.."

failures=0
for ((run = 1; run <= REPEATS; run += 1)); do
  printf 'race run %d/%d\n' "$run" "$REPEATS"
  if ! npx tsx --test "${RACE_SUITES[@]}" > "${TMPDIR:-/tmp}/race-run-$run.log" 2>&1; then
    failures=$((failures + 1))
    printf 'FAILED run %d; output follows\n' "$run"
    cat "${TMPDIR:-/tmp}/race-run-$run.log"
  fi
done

if ((failures > 0)); then
  printf '%d of %d race runs failed\n' "$failures" "$REPEATS" >&2
  exit 1
fi

printf 'all %d race runs passed\n' "$REPEATS"

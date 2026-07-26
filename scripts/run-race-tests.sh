#!/usr/bin/env bash
# Repeats the concurrency-sensitive suites so an ordering-dependent defect shows
# up as a reproducible failure rather than an occasional one. Every run is
# offline and self-contained; see docs/flaky-test-policy.md for how to act on a
# failure here.
set -euo pipefail

REPEATS="${RACE_REPEATS:-10}"
MAX_REPEATS=100
RUN_TIMEOUT_MS="${RACE_RUN_TIMEOUT_MS:-120000}"
RACE_SUITES=(
  "test/idempotency-and-leases.test.ts"
  "test/state-transitions.test.ts"
  "test/launch-idempotency.test.ts"
  "test/launch-service.test.ts"
  "test/server-restart.test.ts"
  "test/reconciliation.test.ts"
)

cd "$(dirname "$0")/.."

if [[ ! "$REPEATS" =~ ^[1-9][0-9]{0,2}$ ]] || ((10#$REPEATS > MAX_REPEATS)); then
  printf 'RACE_REPEATS must be an integer from 1 to %d\n' "$MAX_REPEATS" >&2
  exit 2
fi
if [[ ! "$RUN_TIMEOUT_MS" =~ ^[1-9][0-9]{3,5}$ ]] || ((10#$RUN_TIMEOUT_MS > 600000)); then
  printf 'RACE_RUN_TIMEOUT_MS must be an integer from 1000 to 600000\n' >&2
  exit 2
fi

TSX="./node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  printf 'local tsx binary is unavailable; run npm ci first\n' >&2
  exit 2
fi

LOG_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-race.XXXXXX")"
trap 'rm -rf "$LOG_DIRECTORY"' EXIT

failures=0
for ((run = 1; run <= REPEATS; run += 1)); do
  printf 'race run %d/%d\n' "$run" "$REPEATS"
  if ! node scripts/run-with-timeout.mjs "$RUN_TIMEOUT_MS" "$TSX" --test "${RACE_SUITES[@]}" > "$LOG_DIRECTORY/race-run-$run.log" 2>&1; then
    failures=$((failures + 1))
    printf 'FAILED run %d; output follows\n' "$run"
    cat "$LOG_DIRECTORY/race-run-$run.log"
  fi
done

if ((failures > 0)); then
  printf '%d of %d race runs failed\n' "$failures" "$REPEATS" >&2
  exit 1
fi

printf 'all %d race runs passed\n' "$REPEATS"

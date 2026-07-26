# Flaky-test policy

A flaky test is one that produces different results across runs of the **same
commit, on the same platform, with no input change**. In this repository a flake
is treated as a defect report against either the test or the product, never as
noise to be retried away.

This policy exists because the orchestrator's core promises are about
exactly-once effects under contention. A test that passes only sometimes is
frequently the first observable symptom of a real ordering defect.

## Never do this

- Do not add a retry wrapper, a `--test-retries` style flag, or a loop that
  re-runs an assertion until it passes.
- Do not add a `sleep` to "settle" a race. Inject a clock or await the durable
  effect instead.
- Do not delete a failing test to unblock a merge.
- Do not mark an offline test skipped without a linked issue and an owner.
  Explicitly opt-in integration tests must state their activation condition in
  the skip message.

## Triage, in order

1. **Reproduce deliberately.** Run `RACE_REPEATS=50 npm run test:race`. For a
   suite outside the race list, run it directly with
   `npx tsx --test <file>` in a loop. A property-style failure reports its seed;
   re-run that seed first.
2. **Classify the cause.**
   - *Product defect*: a genuine race, a missing lock, a non-idempotent write, or
     an unbounded wait. Fix the product. The test stays as written.
   - *Test defect*: dependence on wall-clock time, ambient environment, ordering
     between files, a shared temporary path, or an unawaited promise. Fix the
     test using `steadyClock`, `SeededRandom`, and `withTemporaryDirectory`.
   - *Environment*: a genuinely platform-specific behaviour, such as POSIX file
     modes. Guard the case explicitly with a documented skip condition and state
     the platform in the skip message.
3. **Record it.** Open an issue titled `flaky: <test name>` with the failing
   output, the platform, the Node version, and the reproduction command.

## Quarantine

Quarantine is a last resort with an expiry, not a parking space.

- A test may be quarantined only with `{ skip: "flaky: <issue link>" }` in its
  options object, so the reason is visible in the run output.
- Quarantine requires a named owner and a fix deadline of **5 working days**.
- At most **two** tests may be quarantined at once. A third flake blocks merges
  until one is resolved: that is the signal that the suite, or the code beneath
  it, needs attention rather than more tolerance.
- Quarantining a test in `idempotency-and-leases.test.ts`, `state-transitions.ts`,
  or any security case is not permitted. Those cases guard the correctness and
  safety claims the product is built on; if one is unreliable, the release is
  blocked until the cause is understood.

## Determinism budget for new tests

Before merging a new test, confirm it:

- takes its time from an injected clock, not `Date.now()` or `setTimeout` racing
  against real work;
- takes its randomness from `SeededRandom` with a fixed seed;
- writes only inside `withTemporaryDirectory`;
- does not depend on another test file having run first;
- opens no network socket and requires no installed Superset CLI;
- asserts an exact outcome, including the exact refusal message where one is
  part of the contract.

A test that cannot meet all six does not belong in the default suite.

## Ownership

The author of a change owns the flakes it introduces. If ownership is unclear
after a bisect, the tracker issue is assigned to the maintainer of the module
under test. Flake issues are reviewed at the same cadence as functional bugs and
are not deprioritized for being intermittent.

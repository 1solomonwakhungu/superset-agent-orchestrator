# Testing strategy

The orchestrator is a durable, local-first coordinator for other people's agent
processes. Its correctness claims are about identity, exactly-once effects, and
refusal to invent data. The suite is therefore built to be **deterministic and
offline**: no network, no wall-clock dependence, no reliance on an installed
Superset CLI, and no shared machine state between cases.

## Ground rules

1. **Offline by construction.** Nothing in `npm test` opens a socket. The only
   processes spawned are `process.execPath` (the local Node binary) in the
   security tests, which exercise the real `runProcess` isolation controls.
2. **Time is injected.** Store and service constructors take a clock. Tests use
   `steadyClock()` from `test/support/deterministic.ts`, which advances by a
   fixed step, so timestamps are ordered and exact rather than approximate.
3. **Randomness is seeded.** Property-style tests draw from `SeededRandom`
   (mulberry32) over the fixed seed list `PROPERTY_SEEDS`. A failure is
   replayable from its seed; widening the list widens the search without making
   any single run nondeterministic.
4. **Filesystem state is disposable.** Every case that touches disk runs inside
   `withTemporaryDirectory`, which removes the directory afterwards.
5. **Tests assert behaviour that exists.** No product code is added to satisfy a
   test. Where a control is absent, the gap is recorded in the relevant ADR or
   threat model rather than mocked into existence.

The real discovery integration smoke test is excluded from default runs. Set
`SUPERSET_ORCHESTRATOR_EXECUTABLE` to an explicit executable path to opt in.

## Layers

| Layer | Files | What it pins down |
| --- | --- | --- |
| Domain invariants (property-style) | `domain-invariants.property.test.ts` | Pagination totality and ordering, cursor opacity and batch binding, per-client idempotency scoping, status partitioning, ID-query ordering, request bounds, query measurements |
| Persistence schema | `durable-state-schema.test.ts` | Every malformed durable-state document the schema must refuse, and that a refused file is never overwritten |
| MCP contract | `mcp-schema-contract.test.ts`, `tool-contract.test.ts` | Closed request and response objects, the full state-to-stop-reason matrix, the typed error table, catalog determinism |
| Compatibility fixtures | `compatibility-fixtures.test.ts`, `fixtures/compat/*.json` | Frozen provider payloads and older state files keep mapping to the recorded outcomes |
| State machine | `state-transitions.test.ts` | Launch-intent and assignment transitions, terminal immutability, result-capture identity guards, reconciliation |
| Concurrency and exclusivity | `idempotency-and-leases.test.ts` | Single-winner outcomes under contention, one active writer lease per workspace, migration guards |
| Security controls | `security-controls.test.ts` | Child-environment allowlist, no shell interpretation, output bounds, deadlines, owner-only file modes, parameterized SQL, payload redaction |
| Adapters | `codex-response-adapter.test.ts`, `opencode-response-adapter.test.ts`, `response-adapter-conformance.test.ts` | Provider normalization and malformed-payload refusal |
| Policy and documentation | `*.test.mjs` | Threat model, lease policy, product boundary, and compatibility matrix stay traceable |

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Full suite, no coverage instrumentation |
| `npm run test:coverage` | Runs the full suite with c8 coverage over all source files and enforced thresholds |
| `npm run test:race` | Builds, then repeats the concurrency-sensitive suites (`RACE_REPEATS`, default 10) |
| `npm run check` | Formatting, type-aware lint, typecheck, production build, JS tests, coverage, Python tests, and schema no-diff |
| `npm run verify` | Full `check`, then the repeated race suite |

## Coverage threshold

`npm run test:coverage` uses c8's all-files instrumentation and fails below
**85% lines/statements, 80% branches, and 65% functions** over the complete
source tree, including modules not imported by a test. The current verifier run
measured 97.05% lines/statements, 89.51% branches, and 95.52% functions.

The thresholds sit just under the measured values rather than at them. The
margin is deliberate and bounded:

- Two POSIX file-mode cases skip on Windows as a defensive portability measure,
  although Windows is outside the compatibility matrix's supported envelope.
- A threshold pinned exactly at the current number turns any unrelated refactor
  into a red build, which trains people to raise the number rather than write
  the missing test.

Raise the thresholds when a change lifts the measured value durably; never lower
them to make a build pass. If coverage drops, the correct response is a test for
the uncovered branch or a deliberate, reviewed decision recorded in the PR.

Uncovered remainders today are narrow and intentional: a couple of defensive
`catch` arms whose only trigger is a filesystem fault injected below the Node
API, and MCP server wiring exercised end to end by `batch-server.test.ts` through
a spawned process rather than in-process instrumentation.

## Adding tests

- Put shared deterministic helpers in `test/support/`, not in a test file.
- Add a compatibility fixture whenever a provider payload shape is relied upon;
  fixtures are the change-detector for provider drift.
- Prefer a table of cases with an explicit label per row over several near
  identical test functions.
- Assert the exact refusal, not merely that something threw.

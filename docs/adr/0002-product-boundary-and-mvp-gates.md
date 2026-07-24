# ADR 0002: Product boundary and MVP decision gates

- Status: Accepted
- Date: 2026-07-24
- Decision owners: Superset Agent Orchestrator maintainers
- Scope: product boundary and release authorization
- Working name: Local Coding Agent Orchestrator, provisional

## Context

The original concept was a standalone, local-first MCP control plane for parallel
coding agents through Superset. Its differentiated promise was not launch alone.
It combined asynchronous launch with durable batches, attributed status and exact
results, restart recovery, cancellation, and mechanical workspace safety.

The prerequisite evidence changes what can be promised:

- The public Superset Beta CLI supports local discovery and launch. It does not
  expose ordinary agent session list/get, status, exact final result, stop reason,
  cancellation, or backend recovery. Private databases, transcripts, temporary
  logs, terminal output, private host routes, and canary-only ACP are not stable
  substitutes.[^lifecycle]
- Strict local workspace discovery works with the relay unavailable. Mutations
  require exact, pre-resolved local workspace identity and must fail closed on a
  remote, missing, duplicate, or ambiguous target.[^routing]
- The local server uses the production-supported MCP TypeScript SDK v1 line over
  process-spawned stdio. Network transport is outside the MVP.[^transport]
- The control plane can launch powerful processes. Mutation tools require the P0
  path, command, environment, ownership, routing, audit, storage, resource, and
  lifecycle controls in the threat model. Arbitrary commands and destructive
  workspace operations are excluded.[^security]

The repository contains backend-neutral lifecycle abstractions and deterministic
fake-backed orchestration. Those abstractions express the product contract; they
do not prove that Superset can satisfy it.

## Decision

Build a **backend-agnostic orchestration core with a Superset-specific first
adapter**, not a generic launch wrapper and not a Superset-independent workflow
engine.

The core owns:

- stable batch, assignment, attempt, session, result, event, and lease identities;
- asynchronous, idempotent requests and bounded batch reads;
- capability declarations and typed unsupported outcomes;
- monotonic state transitions and explicit `unknown_outcome` reconciliation;
- requester ownership, attribution, retention, redaction, and audit policy;
- concurrency ceilings and exclusive writer-workspace policy;
- adapter contracts for discovery, launch, status, result, cancellation, and
  backend recovery.

The Superset adapter owns:

- version-gated parsing of supported public CLI JSON;
- explicit local project, workspace, and agent-preset discovery;
- exact local target resolution with no relay fallback;
- supported launch and opaque Superset session identifiers;
- honest capability reporting and `UNSUPPORTED_OPERATION` failures.

The Superset adapter does not emulate missing lifecycle operations. An adapter may
be released as a supported orchestration backend only when it passes the lifecycle
gates below. Until then, Superset is limited to a launch-ledger technical preview:
the server may discover and launch, durably preserve launch attribution, and later
report that the outcome is unobservable. It must not expose or imply backend
status, exact result, stop reason, cancellation, retry, resume, or process
recovery.

Hermes is one optional MCP client example. It receives no privileged contract,
memory behavior, tool alias, or core dependency. Any conforming stdio MCP client
must observe the same schemas and behavior.

## Target users

### Primary MVP user

A developer or engineering lead who already uses Superset local workspaces and
runs multiple coding-agent assignments, needs the controlling MCP client to stay
responsive, and values durable attribution and mechanical writer isolation over
automatic workflow breadth.

The user is comfortable with a local, single-operator technical preview and with
manually reconciling a Superset launch whose post-launch state is unobservable.
The preview is not suitable when unattended completion, exact answer collection,
or emergency cancellation is required.

### Secondary users after the lifecycle gate

- MCP-client authors needing one stable local batch-orchestration contract;
- teams evaluating multiple supported agent backends behind one core;
- CI or homelab operators after headless operation and stronger isolation are
  separately proven.

Researchers and Hermes users may evaluate examples, but they do not define MVP
requirements.

## Jobs to be done

### Jobs served by the narrowed technical preview

1. Discover one exact local Superset project, workspace, and agent preset without
   silently routing through the public relay.
2. Submit bounded, independently attributed launches without holding one MCP call
   open per worker.
3. Recover the orchestrator's own batch, assignment, workspace, prompt digest,
   launch receipt, and opaque session ID after a client or server restart.
4. Prevent the orchestrator from knowingly scheduling two writer launches into
   one canonical worktree.
5. Distinguish accepted launch from completed work and surface an unobservable
   launch as `unknown_outcome`, never as success.

### Jobs blocked from the Superset-backed MVP

1. Observe authoritative in-progress or terminal agent status.
2. Retrieve and attribute an exact final assistant result.
3. Explain a normalized stop reason.
4. Cancel one agent turn or session safely.
5. Reattach to or recover a backend process, transcript, or result.
6. Retry automatically based on inferred failure or completion.
7. Verify code, pull requests, checks, deployment, or external state.

These blocked jobs are central to the full product promise. The launch-ledger
preview is evidence gathering, not the general-availability MVP.

## Narrowed MVP scope

The first releasable Superset-backed technical preview contains only:

- stdio MCP transport on the supported Node.js and SDK lines;
- closed configuration and capability discovery;
- public-CLI local discovery and version-gated launch;
- server-generated batch, assignment, attempt, and launch-record IDs;
- asynchronous launch acceptance with immutable attribution;
- durable registry metadata and restart reconciliation;
- explicit states such as `launch_accepted`, `unobservable`,
  `unknown_outcome`, `launch_failed`, and `policy_denied`;
- exact-ID, fail-closed local routing and no relay fallback;
- one exclusive writer lease per canonical worktree with no override;
- hard request, batch, queue, launch-rate, and concurrency ceilings;
- owner-only state, structural redaction, and mutation intent/outcome audit;
- a deterministic fake adapter for complete core lifecycle tests;
- capability-driven `UNSUPPORTED_OPERATION` responses for every unavailable
  Superset lifecycle operation.

An implementation may register only tools whose complete P0 controls and tests
pass. If writer lease, process identity, audit, redaction, or resource controls
are not implemented, the corresponding launch tool remains unregistered.

## Non-goals

- Selecting a permanent product, package, domain, or repository name.
- Replacing Superset Desktop, its host service, or Git worktrees.
- Becoming a generic workflow, DAG, queue, CI, deployment, or agent runtime.
- Providing a synchronous wait-until-answer wrapper around `agents create`.
- Claiming completion from process existence, PTY exit, terminal disappearance,
  hooks, titles, scrollback, or agent prose.
- Parsing private Superset data, temporary agent logs, native transcripts, or
  private host protocols in the stable product.
- Automatic retry, resume, result verification, PR creation, merge, deployment,
  workspace creation/deletion, raw Git, raw filesystem, or arbitrary commands.
- Relay, remote host, multi-host, HTTP, web UI, TUI, multi-user, or cross-client
  delegation support.
- Claiming an OS sandbox, read-only agent execution, Windows support, or broad
  agent-harness compatibility without separate evidence.

## Explicit deferrals

| Capability | Why deferred | Promotion evidence |
| --- | --- | --- |
| Superset status, result, stop reason, cancellation, and backend recovery | No supported public contract | All lifecycle go criteria below pass on a documented versioned surface |
| Bounded batch wait | Waiting on an unobservable backend fabricates progress semantics | Authoritative status and terminal result exist |
| Automatic retry or resume | An unknown outcome can duplicate side effects | Backend idempotency plus status/result/recovery evidence |
| A second production backend | Core seam exists, but breadth is not MVP value | One candidate passes the same adapter conformance and security gates |
| Workspace creation and deletion | Expands destructive path and collision boundary | Superseding threat review and disposable-fixture tests |
| Shared read-only workspaces | Agent harnesses can still write | OS-enforced read-only isolation and race tests |
| Verification integrations | Separate product boundary and credentials | Narrow ADR with independent evidence semantics |
| Streamable HTTP and remote access | Adds authentication and network attack surface | Concrete use case and superseding transport/security ADR |
| Private ACP experiment | Canary/dev only and no singular durable result | Never promoted implicitly; public support or explicit research-only ADR |
| Packaging and public GA | Product contract is not met by Superset | Go criteria pass and release evidence is retained |

## Decision gates

Gates are evaluated against one immutable commit and dependency lockfile. A passing
fake-adapter test proves the core, not the Superset adapter. A worker or client
self-report is never evidence.

### Go: authorize a Superset-backed MVP release

Every criterion is required:

1. A documented, versioned public Superset surface provides session list/get,
   authoritative agent status, structured final assistant content with an
   explicit completion boundary, normalized stop reason, idempotent cancellation,
   and stated restart recovery and retention behavior.
2. Adapter conformance tests pass 100 percent for launch, partial completion,
   success, failure, cancellation, restart, reattachment, late result, duplicate
   request, and unknown-session cases. There are zero inferred terminal outcomes.
3. In a relay-blocked controlled fixture, 100 percent of discovery, launch,
   status, result, cancel, and recovery requests use the intended local host; a
   network capture records zero relay or remote requests.
4. A 30-session mixed-duration batch returns launch receipts without waiting for
   completion, exposes completed results independently, and attributes 30 of 30
   status, result, workspace, assignment, attempt, and stop-reason records
   correctly.
5. After client restart and server restart during active work, 30 of 30 sessions
   reconcile without duplicate launch; every session becomes authoritative
   running, terminal, or explicitly backend-reported unrecoverable within 60
   seconds.
6. Cancellation of at least 30 controlled sessions, including completion races,
   affects 30 of 30 intended process groups and zero unrelated sentinel
   processes. Terminal state and stop reason agree in every case.
7. Two concurrent writer requests against every path-alias fixture produce
   exactly one external launch. Crash recovery never admits a second writer; an
   ambiguous lease quarantines the workspace.
8. All P0 threat-model tests pass on macOS and Linux, the registered tool snapshot
   contains no excluded capability, and synthetic secrets appear zero times in
   state, audit, logs, errors, diagnostics, or MCP output.
9. Packaged stdio protocol smoke tests pass on Node.js 22 and 24 on macOS and
   Linux, and the supported Superset version matrix has no unexplained schema or
   behavior differences.
10. Thirty-session resource testing stays within documented default ceilings,
    rejects the 31st launch when the configured limit is 30, drains cleanly, and
    leaves zero untracked child processes.

### Narrow: continue only the launch-ledger technical preview

Narrow when launch and local routing are supported but any post-launch lifecycle
operation is unavailable. All of these preview criteria are still required:

1. Version-gated local discovery and launch fixtures pass 100 percent with relay
   access blocked and zero remote requests.
2. Fifty repeated idempotent requests per assignment create at most one external
   launch, preserve one immutable receipt, and never auto-relaunch after restart.
3. Restart tests recover 100 percent of orchestrator-owned launch metadata and
   classify every unobservable active record as `unknown_outcome` within 60
   seconds.
4. Every unavailable lifecycle call returns typed `UNSUPPORTED_OPERATION` before
   adapter side effects, and the tool descriptions and README label the preview
   as unable to report completion, exact result, cancellation, or recovery.
5. Every exposed mutation passes its mapped P0 controls, and unresolved writer
   safety disables writer launch rather than weakening the policy.

The preview may be used for controlled learning. It must not be marketed as
durable end-to-end agent orchestration or promoted to GA.

### Pause: stop feature expansion and investigate

Pause new mutation or distribution work when any one condition occurs:

- a pinned Superset CLI output or routing contract changes without a reviewed
  adapter update;
- any local-only test makes a relay or remote request;
- any duplicate launch, cross-workspace launch, lease ambiguity without
  quarantine, attribution mismatch, untracked child, or synthetic-secret leak is
  observed;
- more than 1 percent of 100 controlled launches lack an immutable launch receipt
  or remain unreconciled beyond the documented 60-second window;
- a P0 test, packaged stdio smoke lane, state migration, audit-chain check, or
  exact supported-version fixture fails;
- the only path forward requires a private API, transcript/log parsing, arbitrary
  command, destructive workspace tool, or weakened fail-closed control.

Resume only after a root-cause record, regression test, clean full gate run, and
maintainer approval on the exact candidate commit.

### Kill: end the Superset-backed product path

Kill the stable Superset adapter and stop representing Superset as an MVP backend
when any one condition is true:

1. Superset removes or makes remote-only the version-gated public local discovery
   or launch path, with no documented replacement.
2. Authoritative status, exact result, cancellation, and restart recovery remain
   unavailable at the first of 2027-01-24 or two consecutive public Superset
   release reviews after this ADR. Revalidate the date if a public roadmap names
   a later supported delivery.
3. Meeting the lifecycle contract requires shipping private database, temporary
   log, native transcript, terminal scraping, or private host-client integration.
4. Two independent P0 incidents occur in controlled or real preview use, or one
   incident causes cross-workspace mutation, credential disclosure, destructive
   loss outside the selected workspace, or silent remote execution.
5. A 30-session controlled run cannot stay within safe documented host ceilings
   without removing the asynchronous batch value proposition.

Killing the Superset adapter does not automatically kill the backend-neutral core.
Continue that core only if another backend passes every Go criterion and user
validation shows the durable batch and workspace-safety jobs are valuable. If no
backend passes within the same review window, archive the product rather than ship
a generic launch wrapper.

## Consequences

The architecture preserves the differentiated durable, asynchronous, attributed,
and workspace-safe control-plane contract without pretending the first backend
implements it. Superset-specific changes stay behind a narrow adapter and can be
replaced without changing core identities or state semantics.

The immediate product is materially smaller than the dossier proposed. It cannot
answer "what did the agents say?", stop an agent, or prove completion. This is an
intentional no-go for a full Superset-backed MVP and an authorization only for a
clearly labeled, fail-closed technical preview after its own security gates pass.

Naming remains provisional. The current repository name describes the experiment
and does not reserve a package, product, domain, or trademark.

## Evidence

[^lifecycle]: [Superset lifecycle and result API evidence](../superset-lifecycle-result-api-evidence.md)
[^routing]: [Strict local routing during relay failure](../local-routing-relay-failure.md)
[^transport]: [ADR 0001: MCP SDK and local transport contract](0001-mcp-sdk-and-local-transport.md)
[^security]: [Local control-plane threat model](../security/local-control-plane-threat-model.md)

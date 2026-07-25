# Local control-plane threat model

Status: normative MVP security design  
Scope: the local MCP server, its durable registry, the Superset integration
adapter, and coding-agent launch and control requests  
Last reviewed: 2026-07-24

## Security objective

The orchestrator is a local control plane for programs that can read and change
developer's repositories. Its primary security objective is to ensure that an MCP
request can affect only an explicitly selected, locally registered workspace, by
an allowed operation, with bounded authority and an attributable audit record.

The server does not make an untrusted coding agent safe. It constrains where and
how that agent can be launched, limits ambient authority, prevents one request
from borrowing another request's authority, and avoids leaking sensitive data
through results, errors, state, or logs.

This document is a release gate. Every control marked P0 MUST be implemented and
its mapped test MUST pass before the corresponding mutation tool is exposed in
the MVP. A schema or prompt instruction alone is not an enforceable control.

## Assumptions and scope

### In scope

- stdio MCP requests and responses;
- project, workspace, agent-preset, session, and batch identifiers;
- Superset CLI or supported local API invocation;
- child-process arguments, executable selection, environment, and lifecycle;
- prompts and agent-returned text;
- durable batches, sessions, results, leases, events, and configuration;
- concurrent readers and writers;
- cancellation and bounded waiting;
- local files touched by the server or launched agent;
- operator-visible diagnostics and audit records.

### Security assumptions

- The operating-system account running the server is trusted to administer the
  product. Another process with equal account privileges can read or alter the
  product's files and is outside the sandbox guarantee.
- Superset's registered local project and workspace inventory is the authority
  for valid targets. Client-supplied paths are not authoritative.
- The Superset adapter and configured agent executable are trusted dependencies,
  but their output is untrusted input to the control plane.
- Local repositories, prompts, issue text, source files, agent responses, CLI
  output, and MCP client-provided metadata can all be malicious.
- Git, agent harnesses, hooks, compilers, and tests may execute repository code.
  Workspace confinement reduces scope but is not an OS sandbox.
- MVP uses process-spawned stdio. Any network transport requires a separate
  authentication, authorization, origin, replay, and TLS threat review.

### Out of scope

- Protecting the user from a fully compromised operating-system account;
- proving the semantic correctness of generated code;
- vulnerabilities inside Superset or an agent harness after invocation;
- cloud relay and multi-host authorization;
- automatic merging, deployment, package publication, or credential rotation;
- strong process isolation such as a VM, container, or macOS sandbox profile.

These exclusions do not permit the server to add equivalent capabilities through
a generic command, path, environment, or prompt parameter.

## Assets

| Asset | Required property |
| --- | --- |
| Repositories and worktrees | Integrity, availability, target confinement |
| Source, prompts, and results | Confidentiality, integrity, attribution |
| Credentials and environment | Confidentiality, least privilege |
| Superset project/workspace inventory | Integrity, freshness, local provenance |
| Durable registry and leases | Integrity, availability, crash consistency |
| Session and batch identifiers | Unforgeability, ownership binding |
| Agent executable and adapter configuration | Integrity, trusted provenance |
| Audit events | Integrity, completeness, useful redaction |
| Host CPU, memory, processes, disk, and API quota | Availability, bounded use |

## Actors

| Actor | Trust level and authority |
| --- | --- |
| Local operator | Trusted administrator who starts and configures the server |
| MCP client | Authenticated by process ancestry only in stdio MVP; authorized per connection, not trusted to supply paths or commands |
| Orchestrator | Policy-enforcement point and audit source |
| Superset adapter/host | Trusted target resolver and lifecycle backend; all returned data is parsed defensively |
| Coding-agent harness | Powerful child process with only the granted workspace and filtered environment |
| Repository content | Untrusted data that may contain prompt injection or executable hooks |
| Agent response | Untrusted data, never an authorization decision or proof of completion |
| Other local process | Outside protocol trust; must not gain access through open sockets or permissive state files |
| Remote service | Untrusted and unreachable through the control plane in local-only MVP routing |

## Trust boundaries and data flow

```text
untrusted MCP input
        |
        | B1: schema, identity, authorization, size limits
        v
local orchestration server
        |             \
        | B2           \ B3: durable state and audit permissions/redaction
        v               v
Superset adapter      product-owned registry
        |
        | B4: exact executable, argv, filtered environment, local target
        v
Superset local host / coding-agent process
        |
        | B5: untrusted status, diagnostics, and result normalization
        v
bounded, redacted MCP response
```

- **B1 MCP boundary:** every field is untrusted. Validate closed schemas, type,
  length, count, identifier syntax, and request ownership before side effects.
- **B2 target boundary:** resolve opaque IDs through a fresh local Superset
  inventory. The resolved canonical path and host provenance are policy inputs;
  a client path is never passed through.
- **B3 storage boundary:** state and audit files contain sensitive metadata. Use
  owner-only permissions, atomic durable writes, validation on read, and
  redaction before persistence.
- **B4 process boundary:** use a pinned executable and fixed operation templates,
  an argument vector without a shell, a minimal environment, explicit working
  directory, and resource/lifecycle ceilings.
- **B5 result boundary:** CLI output and agent text are untrusted, size bounded,
  attributed to immutable IDs, redacted, and never interpreted as a new control
  request.

## Authorization and capability model

The stdio server grants one client connection access only to policy-enabled tools.
The server assigns an unguessable `requester_id` when the connection starts. It
binds each created batch, assignment, session, result, and lease to that identity.
Control and result operations require both the object ID and matching owner. IDs
are locators, not bearer authorization.

A launch capability is the tuple:

```text
(requester_id, operation, project_id, workspace_id, access_mode,
 agent_preset_id, batch_id, policy_version, expiry)
```

The server constructs it only after validation. Prompts, agent responses, labels,
repository files, prior sessions, and Superset output cannot add or alter fields.
Retries reuse the original immutable capability and require a new attempt ID.
Cancellation permits stopping only an owned session; it grants no launch or path
authority. Restart recovery restores the same ownership and capability bindings.

The MVP has no cross-client delegation. A future shared or network server must add
strong client authentication, explicit grants, revocation, and tenant isolation
before preserving sessions across identities.

## P0 threat matrix

Priority definitions: P0 can cause unauthorized code execution, cross-workspace
access, destructive loss, credential disclosure, control-plane takeover, or loss
of the security audit trail. P1 is important hardening that does not independently
cross those boundaries under the stated assumptions.

| ID | Area | Abuse case and impact | Priority | Enforceable controls | Adversarial tests |
| --- | --- | --- | --- | --- | --- |
| THR-PATH-01 | Path | A client supplies `../`, an absolute path, symlink alias, case alias, or prefix-collision path to launch outside the selected workspace. | P0 | C-PATH-01, C-PATH-02 | T-PATH-01, T-PATH-02 |
| THR-PATH-02 | Path | A registered workspace is replaced or retargeted between validation and launch, causing time-of-check/time-of-use escape. | P0 | C-PATH-02, C-PATH-03 | T-PATH-03 |
| THR-CMD-01 | Command | Metacharacters or option injection in IDs, labels, presets, or prompts reaches a shell or changes the invoked Superset operation. | P0 | C-CMD-01, C-CMD-02 | T-CMD-01, T-CMD-02 |
| THR-CMD-02 | Command | A client selects an arbitrary executable, subcommand, working directory, argument, environment variable, or terminal command. | P0 | C-CMD-02, C-ENV-01, C-TOOLS-01 | T-CMD-03, T-ENV-01, T-TOOLS-01 |
| THR-PROMPT-01 | Prompt | Issue text, source, or an earlier result tells the orchestrator to switch repository, expose secrets, call another tool, or treat agent text as authorization. | P0 | C-PROMPT-01, C-AUTH-01 | T-PROMPT-01, T-DEPUTY-02 |
| THR-PROMPT-02 | Prompt | An oversized or malformed prompt/result exhausts memory, corrupts framing, injects control characters, or poisons logs. | P0 | C-INPUT-01, C-RESULT-01, C-AUDIT-02 | T-PROMPT-02, T-RESULT-01 |
| THR-SECRET-01 | Secret | The full parent environment, credential files, command output, prompt, result, error, or audit event exposes tokens and keys. | P0 | C-ENV-01, C-REDACT-01, C-STORE-01 | T-ENV-01, T-SECRET-01, T-SECRET-02 |
| THR-SECRET-02 | Secret | A prompt asks the agent to read outside the workspace or a symlink inside the workspace resolves to credential material. | P0 | C-PATH-01, C-PROMPT-01, C-TOOLS-01 | T-PATH-02, T-SECRET-03 |
| THR-WORKSPACE-01 | Workspace | Concurrent writer sessions share a worktree, corrupt state, overwrite work, or commit another session's changes. | P0 | C-LEASE-01, C-LEASE-02 | T-LEASE-01, T-LEASE-02 |
| THR-WORKSPACE-02 | Workspace | A stale, forged, or crash-orphaned lease permits a second writer or blocks a workspace indefinitely. | P0 | C-LEASE-02, C-STORE-02 | T-LEASE-02, T-LEASE-03 |
| THR-WORKSPACE-03 | Workspace | A delete/reset/clean/checkout tool or a disguised generic command destroys a workspace or unrelated user data. | P0 | C-TOOLS-01, C-CMD-02 | T-TOOLS-01, T-TOOLS-02 |
| THR-DEPUTY-01 | Confused deputy | A client guesses a session/batch ID and reads, cancels, retries, or redirects another client's work. | P0 | C-AUTH-01, C-ID-01 | T-DEPUTY-01 |
| THR-DEPUTY-02 | Confused deputy | Agent or adapter output is parsed as a path, command, tool request, capability, status transition, or proof of verification. | P0 | C-PROMPT-01, C-RESULT-01, C-STATE-01 | T-DEPUTY-02, T-STATE-01 |
| THR-DEPUTY-03 | Confused deputy | A local target silently resolves through a remote relay or to a different host/project with broader authority. | P0 | C-ROUTE-01, C-PATH-02 | T-ROUTE-01, T-ROUTE-02 |
| THR-AUDIT-01 | Audit | A mutation occurs without an attributable event, or untrusted text forges/truncates subsequent records. | P0 | C-AUDIT-01, C-AUDIT-02 | T-AUDIT-01, T-AUDIT-02 |
| THR-STATE-01 | State | Tampered or corrupted durable state grants ownership, changes a workspace target, rewinds a terminal state, or triggers relaunch after restart. | P0 | C-STORE-02, C-STATE-01 | T-STATE-01, T-STATE-02 |
| THR-RESOURCE-01 | Availability | A client launches unbounded agents or leaves children running after timeout/cancel, exhausting host resources. | P0 | C-LIMIT-01, C-LIFECYCLE-01 | T-LIMIT-01, T-LIFECYCLE-01 |
| THR-SUPPLY-01 | Process | PATH or configuration substitution launches an attacker-controlled Superset/agent binary. | P0 | C-CMD-01, C-CONFIG-01 | T-CMD-02, T-CONFIG-01 |

## P1 threat inventory

| ID | Abuse case | Required hardening |
| --- | --- | --- |
| THR-P1-01 | Session names or timing reveal repository activity to another same-user process. | Document same-user boundary; minimize retained metadata and retention. |
| THR-P1-02 | Disk exhaustion prevents state or audit persistence. | Reserve/monitor capacity, fail closed before mutation when the audit intent cannot persist. |
| THR-P1-03 | Malicious CLI output exploits a parser edge case. | Strict versioned schemas, bounded parsing, fuzz normalized adapter input. |
| THR-P1-04 | Cancellation races with completion and misattributes a result. | Compare-and-set transitions and immutable attempt/result IDs. |
| THR-P1-05 | Read-only tasks execute repository tooling that writes files. | Treat `read-only` as a scheduling claim until OS-enforced; expose only non-executing discovery/read adapters or use a read-only sandbox. |
| THR-P1-06 | Sensitive data remains in old state backups. | Defined retention, secure owner-only cleanup, and no secrets by design. |

## Enforceable MVP controls

### Target and path controls

**C-PATH-01: no client paths.** Mutation schemas accept opaque project and
workspace IDs, not filesystem paths, working directories, file URLs, or globs.
Reject unknown fields. If a future file-scoped operation is added, canonicalize
the existing target and candidate with descriptor-based APIs, reject symlinks,
and compare path components rather than string prefixes.

**C-PATH-02: authoritative local resolution.** Immediately before each launch,
resolve IDs through Superset's local inventory and require the workspace to be a
descendant of the selected registered project after canonicalization. Require an
exact local host identity. Unknown, stale, duplicate, remote, or ambiguous
resolution fails closed.

**C-PATH-03: bind target identity at use.** Record canonical path plus stable file
identity where the platform supports it. Open/inspect the target after lease
acquisition and recheck identity immediately before process spawn. A changed
symlink, mount, inode/file ID, owner, or registration aborts the launch.

### Command, process, and configuration controls

**C-CMD-01: fixed executable provenance.** Discover the Superset executable only
through the documented configuration contract, canonicalize it, require a regular
non-symlink executable owned by the expected user or trusted installation, and
record its path and version. Never search the request-provided `PATH` at launch.

**C-CMD-02: allowlisted argv templates.** Map each MCP tool to one fixed adapter
operation and construct an argument array. Never invoke a shell, `eval`, command
string, terminal emulator, package script, or client-selected subcommand. Insert
`--` before data operands where supported and reject data beginning with an option
where it is not. Prompt bytes use stdin or a dedicated data channel, not command
interpolation.

**C-ENV-01: minimal environment.** Build child environment from an empty map and
an explicit cross-platform allowlist needed for local execution. Do not inherit
tokens, cloud credentials, SSH/GPG agent sockets, proxy credentials, dynamic
loader variables, `NODE_OPTIONS`, shell startup controls, or arbitrary
client-supplied variables. Configuration may reference approved credential
providers in a future design, but raw secret values are never an MCP field.

**C-CONFIG-01: trusted configuration.** Configuration and policy files must be
regular, non-symlink, owner-controlled files with no group/other write access.
Validate a closed schema and reject unknown security settings. Security policy is
loaded before MCP service and cannot be weakened by a request or repository file.

### Prompt, result, identity, and state controls

**C-PROMPT-01: prompt is data.** Apply length and encoding validation, bind the
prompt to the preauthorized immutable capability, and label repository/client
content as untrusted context. The server never executes tool requests, paths,
commands, policy changes, verification claims, or credentials found in prompt or
result text. Prompt instruction is defense in depth, not the authorization layer.

**C-INPUT-01: bounded closed schemas.** Reject unknown fields, control characters
outside allowed text fields, invalid Unicode, oversized strings, excessive batch
counts, duplicate IDs, and unsupported enum values before state mutation. Set
documented per-prompt, per-result, per-request, and batch limits.

**C-RESULT-01: untrusted attributed results.** Parse adapter status with a strict,
versioned schema. Store result text as opaque bounded data tied to immutable
requester, assignment, session, attempt, workspace, and adapter IDs. Never infer
completion, verification, a follow-up action, or a new target from prose. Truncate
only at a UTF-8 boundary and mark truncation explicitly.

**C-ID-01: server-generated identifiers.** Use cryptographically random,
non-sequential IDs with type prefixes. Reject client-selected IDs except a bounded
idempotency key scoped to requester and operation. Compare exact identifiers.

**C-AUTH-01: object ownership.** Bind every object and workspace lease to the
connection requester and immutable launch capability. Check ownership and allowed
transition on every get, result, cancel, retry, wait, and recovery operation. Do
not authorize by knowing an ID, batch name, prompt contents, or agent response.

**C-STATE-01: monotonic state machine.** Permit only documented transitions using
serialized compare-and-set updates. Terminal states cannot return to running and
restart cannot relaunch an existing attempt. Adapter text cannot set ownership,
target, capability, or verification state.

### Workspace and lifecycle controls

**C-LEASE-01: exclusive writer lease.** Acquire a durable exclusive lease keyed
stable canonical workspace identity before recording launch intent. One writer is
allowed per worktree across all clients, batches, and server instances. There is
no warning-only override in MVP. Hold the lease until the child reaches a terminal
state and reconciliation records it.

**C-LEASE-02: crash-safe lease recovery.** Persist owner, process identity, process
start token, attempt, acquired/renewed times, and expiry atomically. On restart,
reconcile process identity before reclaiming. PID alone is insufficient. An
ambiguous lease quarantines the workspace and requires explicit operator repair;
it never permits a second writer.

**C-LIMIT-01: hard ceilings.** Enforce configured global, per-client, per-project,
per-workspace, and batch concurrency plus request size, queue depth, launch rate,
result size, wait duration, and retention bounds. Validate atomically with lease
and launch-intent creation. Reject rather than silently exceed a limit.

**C-LIFECYCLE-01: bounded child control.** Spawn a process group with tracked
identity, deadlines, and cancellation escalation. Cancel only the recorded group,
never an unvalidated PID. Reconcile after interruption and report
`unknown_outcome` rather than relaunch or claim success.

### Routing and tool-surface controls

**C-ROUTE-01: strict local routing.** Every adapter operation carries explicit
local routing and verifies returned host provenance. No fallback to relay, remote
host, default organization, or a similarly named project. A relay request or
ambiguous route is a typed terminal error and audit event.

**C-TOOLS-01: capability-minimal surface.** Register only reviewed structured
tools. The MVP exclusions below are absent from registration, implementation,
aliases, and generic escape hatches. Unknown tool calls fail before adapter use.

### Secret handling and persistence

**C-REDACT-01: structural redaction.** Redact before logs, audit, persistence,
diagnostics, errors, and MCP responses. Match case-insensitive sensitive key names
(`authorization`, `cookie`, `token`, `secret`, `password`, `api_key`, private-key
fields), bearer/basic credentials, common provider token formats, PEM blocks, and
configured literal canaries. Replace values with `[REDACTED:<class>]`; never hash
or partially reveal them. Redaction is recursive, cycle safe, length bounded, and
applied to exception causes and child stdout/stderr. Prompts and full results are
not audit fields.

**C-STORE-01: sensitive-data minimization.** Persist only the prompt/result data
required by the product contract. State and audit files use owner-only directories
and mode `0600`, with restrictive creation umask. Never persist the inherited
environment, credentials, shell history, full command output, or raw error object.
Document retention and allow owner-authorized deletion of product records without
adding workspace deletion.

**C-STORE-02: durable validated state.** Serialize writers with a lock; write,
sync, and atomically rename state. Validate the complete state before use and keep
corrupt data untouched for operator recovery. Security-critical records include
schema/policy version and append-only event linkage. Invalid ownership, target,
lease, or transition data places affected objects in quarantine.

### Audit controls

**C-AUDIT-01: mutation intent and outcome.** Before an external side effect,
durably record an intent event. Then record success, rejection, failure,
reconciliation, and terminal outcome. If mutation intent cannot be persisted, the
mutation fails closed. Events include timestamp, event ID, requester ID, tool,
object IDs, project/workspace IDs, access mode, policy version, adapter/executable
version, decision/reason code, prior/new state, and correlation ID.

**C-AUDIT-02: injection-safe append-only events.** Use structured serialization,
not interpolated lines. Normalize or reject control characters, bound every field,
redact before writing, and maintain a per-installation hash chain or equivalent
tamper-evident sequence over canonical event bytes. Audit export verifies gaps and
chain integrity. Agent prose, prompts, results, environment values, and secrets
are excluded.

## Explicit MVP tool exclusions

The following tools and equivalent aliases MUST NOT be registered in MVP:

- arbitrary shell, terminal, command, script, REPL, or executable invocation;
- client-supplied argv, environment, working directory, executable, or adapter
  subcommand;
- `workspaces_delete` or any recursive delete, trash, reset, clean, checkout,
  restore, force-remove, or worktree-prune operation;
- arbitrary filesystem read/write/search outside structured, workspace-bound
  adapter operations;
- raw Git mutation, commit, push, force-push, merge, credential, or hook tools;
- package install/publish, deployment, remote-host, relay, SSH, or network-fetch
  escape hatches;
- raw database query, state edit, lease override, audit deletion, process kill by
  PID, or secret/environment inspection;
- dynamic tool registration or prompt-selected plugins.

MVP may expose structured discovery, asynchronous launch, status, bounded result
retrieval, cancellation by owned session ID, recovery, and safety diagnostics only
after their P0 controls pass. Workspace creation needs a separate path/branch/
collision design and is not implicitly approved here. Read-only mode must not be
advertised as enforced if the launched harness can write.

Adding an excluded capability requires a new threat review, a narrow structured
contract, explicit operator approval where destructive, least-privilege policy,
audit coverage, rollback/recovery behavior, and adversarial tests. Convenience or
prompt instructions are not justification.

## Redaction rules

Redaction runs at ingress for fields not required in raw form and again at every
egress or persistence sink. The second pass is mandatory because secrets can enter
through repository content, child output, adapter errors, and exception metadata.

| Data | Durable registry | Audit | MCP response |
| --- | --- | --- | --- |
| Prompt | Encrypted-at-rest design required before production persistence; otherwise disabled or minimal bounded text | ID, byte count, and digest only | Returned only to owning client when contract requires it, after redaction |
| Agent result | Bounded, owner-only, redacted; encryption decision required before production | ID, status, byte count, and digest only | Owning client only, bounded and redacted |
| Environment | Never | Allowlisted key names only, never values | Never |
| Child argv | Fixed operation and non-sensitive identifiers only | Structured redacted argv metadata | Only safe diagnostic fields |
| stdout/stderr/error | Redacted bounded diagnostic excerpt only when necessary | Typed code and redacted bounded excerpt | Typed code and redacted bounded excerpt |
| Secret-like field | Never | `[REDACTED:<class>]` | `[REDACTED:<class>]` |

Redaction failure fails closed for the affected sink. Diagnostics report that data
was suppressed, not the data itself. Tests use synthetic canaries and verify that
neither raw nor encoded canaries appear in state, audit, exceptions, snapshots,
MCP output. Redaction does not make storing unnecessary data acceptable.

## Audit event contract

Required mutation events are `request_received`, `request_rejected`,
`launch_intent`, `launch_started`, `launch_failed`, `state_transition`,
`cancel_intent`, `cancel_outcome`, `lease_acquired`, `lease_quarantined`,
`lease_released`, `reconciliation`, `policy_denied`, and `result_recorded`.

Audit identity in stdio MVP means server installation ID, connection/requester ID,
and best-effort parent process metadata captured by the server, not a user name
asserted by the client. Batch labels and client-provided actor names are data, not
identity. Timestamps use UTC plus a monotonic sequence. Every denial identifies
stable reason code without echoing rejected secret/path/command payloads.

Audit retention is configurable by the local operator but cannot be changed by an
MCP request. Rotation preserves chain continuity. Audit records are never treated
as an authorization source without full integrity verification.

## Adversarial test inventory

The tests below are implementation release gates. Unit tests use a fake Superset
adapter and fake child launcher; integration tests capture exact argv, environment,
working directory, state, audit, and MCP output. Platform path and process tests
run on every supported operating system. No test invokes a real destructive tool.

| Test ID | Required assertion |
| --- | --- |
| T-PATH-01 | Reject absolute, parent-relative, UNC/device, mixed-separator, NUL, Unicode/case alias, sibling-prefix, nonexistent, and unregistered targets before adapter or spawn. |
| T-PATH-02 | Reject symlink and junction escape chains, including links created inside a registered workspace to a synthetic secret outside it. |
| T-PATH-03 | Swap or retarget the validated directory before spawn; identity recheck aborts, audits the race, and creates no child. |
| T-CMD-01 | Inject shell metacharacters, newlines, quotes, leading options, substitutions, and response-file syntax in every text/ID field; captured spawn is shell-free fixed argv and causes no sentinel side effect. |
| T-CMD-02 | Poison `PATH`, executable config, aliases, and symlinks; only the validated pinned binary can run and provenance mismatch fails closed. |
| T-CMD-03 | Fuzz launch requests with executable, argv, cwd, environment, subcommand, and unknown fields; closed schema rejects all before side effects. |
| T-ENV-01 | Seed parent/client environment with synthetic cloud, GitHub, SSH, proxy, loader, and runtime secrets; child capture receives only the exact allowlist and no secret values. |
| T-PROMPT-01 | Prompt/result demands another workspace, command, secret, tool, or policy override; immutable capability and captured adapter target remain unchanged. |
| T-PROMPT-02 | Invalid UTF-8, control characters, framing strings, deep objects, and over-limit prompt/result sizes are rejected or explicitly truncated without parser, log, or memory failure. |
| T-SECRET-01 | Place unique synthetic tokens in nested inputs, environment, stdout, stderr, errors, and causes; assert absence from state, audit, logs, diagnostics, and MCP output. |
| T-SECRET-02 | Exercise sensitive key names, bearer/basic credentials, provider-token patterns, PEM blocks, cycles, arrays, mixed case, split chunks, and encoded canaries; expected structural placeholders remain. |
| T-SECRET-03 | Ask the agent/adapter to return an external secret-file path and contents; no server file read occurs and returned synthetic secret is redacted. |
| T-LEASE-01 | Race two writers from separate clients/batches/server processes for one canonical worktree; exactly one launch intent and child succeeds. |
| T-LEASE-02 | Use path aliases and concurrent lease renewal/release; canonical identity remains exclusive and compare-and-set prevents stale-owner release. |
| T-LEASE-03 | Crash before and after spawn, reuse a PID with a different start token, and restart; live ownership is recovered, ambiguity quarantines, and no duplicate launch occurs. |
| T-TOOLS-01 | Enumerate MCP tools and invoke common aliases; no shell, terminal, delete, reset, clean, raw filesystem, raw Git, environment, database, relay, or dynamic-plugin tool exists. |
| T-TOOLS-02 | Search registered handlers and adapter operations for generic command or recursive deletion paths; static allowlist snapshot fails on additions without security review. |
| T-DEPUTY-01 | Cross-client read, wait, cancel, retry, recovery, guessed sequential ID, batch-name collision, and idempotency-key reuse all return indistinguishable authorization-safe errors and cause no mutation. |
| T-DEPUTY-02 | Adapter output contains valid-looking IDs, state JSON, tool calls, paths, verification claims, and commands; all remain opaque result text and cannot mutate authority or state. |
| T-ROUTE-01 | Make local host unavailable while relay is reachable; operation returns typed local-unavailable error with zero remote requests. |
| T-ROUTE-02 | Return remote, stale, duplicate, or wrong-host inventory records; resolution fails closed before lease or spawn and records a redacted policy denial. |
| T-AUDIT-01 | For every allowed, denied, failed, cancelled, reconciled, and completed mutation, assert required intent/outcome events, immutable IDs, reason codes, ordering, and ownership attribution. |
| T-AUDIT-02 | Inject CR/LF, terminal escapes, delimiters, huge fields, and secret canaries; structured records cannot forge events, remain bounded/redacted, and chain verification detects edit/delete/reorder. |
| T-STATE-01 | Fuzz illegal transitions and adapter-forged authority fields; compare-and-set rejects them, terminal states stay terminal, and restart never relaunches an attempt. |
| T-STATE-02 | Truncate, reorder, alter, symlink, permission-weaken, and schema-corrupt state; startup fails or quarantines safely without replacing evidence or launching children. |
| T-LIMIT-01 | Race requests at every global/client/project/workspace/batch boundary and exceed size/rate/queue/wait limits; counters remain atomic and no excess child starts. |
| T-LIFECYCLE-01 | Timeout/cancel a child tree, race completion, and substitute PID identity; only the owned process group is signaled, terminal result is deterministic, and unrelated sentinel lives. |
| T-CONFIG-01 | Use unknown keys, repository-local policy, symlink config, wrong owner/mode, and request-time override; startup or request fails closed with redacted diagnostics. |
| T-RESULT-01 | Return oversized, malformed, invalid-status, mismatched-session, duplicated, and late adapter results; parser bounds input and attribution/state cannot change. |

## P0 traceability and release evidence

The threat matrix is the authoritative threat-to-control-to-test map. CI MUST fail
if a P0 row lacks at least one control and one test, references an undefined ID,
or if an excluded tool appears in the registered tool snapshot. Implementation
PRs that satisfy controls must cite control and test IDs in their description.

Before MVP release, retain these artifacts per supported platform:

1. Exact commit and dependency lockfile digest.
2. Registered MCP tool snapshot.
3. Passing P0 unit, integration, restart, race, and redaction test report.
4. Captured sanitized argv/environment and proof of zero relay requests.
5. State and audit permission checks plus audit-chain verification.
6. Residual-risk sign-off for agent execution without an OS sandbox.

## Residual risk and secure defaults

An allowed writer agent can intentionally damage files inside its leased workspace,
run repository code, make network requests using credentials it independently
discovers, and consume resources below configured ceilings. The MVP control plane
does not claim sandboxing. Operators should use disposable isolated worktrees,
minimal host credentials, repository protections, and independent verification.

Secure defaults are stdio only, strict local routing, no network listener, no
generic command, no workspace deletion, one writer per worktree, minimal child
environment, conservative concurrency and size limits, owner-only state/audit,
fail-closed ambiguity, and no warning-only policy override.

## Review triggers

Repeat this threat review before adding a network transport, multi-user service,
remote host or relay, workspace creation/deletion, generic terminal operation,
new agent/backend adapter, automatic retry, shared read-only execution, plugin,
secret provider, OS sandbox claim, verification mutation, Git/PR/deployment tool,
or any change to identity, persistence, routing, executable discovery, or leases.

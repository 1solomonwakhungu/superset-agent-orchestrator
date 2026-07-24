# Workspace lease and writer-safety policy

Status: normative MVP safety contract

Scope: agent launches and every process that can access a selected workspace

Last reviewed: 2026-07-24

## Safety invariant

The orchestrator MUST NOT launch a process with write-capable access to a worktree
unless it exclusively holds both the durable writer lease and the operating-system
lease lock for that worktree's stable canonical identity. Authority is the current
lease generation, not possession of a workspace ID, process ID, session ID, token,
timestamp, or database row alone.

At most one writer generation may be authoritative for a worktree. A stale owner
cannot renew, release, or use a later generation. Expiry makes a lease eligible
for reconciliation; time expiry alone never transfers or releases write authority.

This policy refines `C-LEASE-01` and `C-LEASE-02` in the local control-plane threat
model. Failure to implement every MUST and pass `T-LEASE-01` through `T-LEASE-03`
keeps writer launch unregistered.

## Access model

Every launch declares exactly one immutable `access_mode` before lease acquisition.
There is no implicit mode and no mode change during an attempt.

| Mode | Workspace view | Admission rule | Lifetime |
| --- | --- | --- | --- |
| `writer` | Canonical registered worktree, write capable | One exclusive lease and OS lock for the stable identity | Through proven terminal process state and durable release |
| `read_only` | Verified read-only sandbox or immutable isolated copy | Shared only when writes are mechanically denied | Through sandbox teardown |

### Writer

A writer is any process that can modify the worktree, Git metadata used by the
worktree, generated files, or repository state. A task label, prompt, agent claim,
or planned command does not make a capable process read-only. Agent harnesses,
hooks, tests, compilers, language servers, and Git commands are writers unless the
entire process tree receives only a mechanically read-only view.

Writers for different worktrees may run concurrently. Worktrees are distinct only
after authoritative resolution proves distinct canonical identities. Branch name,
repository ID, display path, case-folded alias, symlink spelling, or client-supplied
path is not a workspace identity.

### Read-only

Read-only sharing is allowed only when the launcher proves one of these mechanisms:

1. An OS-enforced sandbox exposes the complete workspace and its Git metadata as
   read-only to the process and every descendant, with no writable bind, overlay,
   file descriptor, or escape path back to the source.
2. An immutable isolated copy or snapshot is created without writable links to the
   source and is discarded after the attempt.
3. A structured in-process reader performs an allowlisted non-executing operation
   without launching repository code and opens source files read-only.

The mechanism MUST be identified in trusted configuration, verified immediately
before launch, inherited by every descendant, and covered by a sentinel write test
that fails inside the workspace and its Git metadata. File permission bits,
prompts, `cwd`, Git status checks, user intent, post-run diff checks, or a database
`read_only` flag are not mechanical prevention.

If no approved mechanism is available, return `READ_ONLY_ENFORCEMENT_UNAVAILABLE`.
Do not silently promote the request to writer. The current Superset launch adapter
has no proven read-only sandbox, so shared read-only agent launch remains disabled.

## Stable workspace identity

Immediately before acquisition, resolve the opaque workspace ID through the fresh
local Superset inventory and reject missing, remote, duplicate, or ambiguous
records. Canonicalize the existing worktree without following a client-selected
path. Record:

- local host installation identity;
- registered project and workspace IDs;
- canonical path components;
- filesystem volume/device and root directory file identity where supported;
- worktree Git common-directory and worktree-git-directory identities;
- ownership and registration revision observed at resolution.

The lease key is a collision-resistant digest of the versioned stable identity,
not a raw path. All path aliases for one worktree MUST map to the same key. A
changed symlink, mount, root file identity, Git metadata identity, owner, local
host, or registration revision before spawn returns `WORKSPACE_IDENTITY_CHANGED`,
quarantines any provisional lease, and launches no child.

## Lease record and authority

The durable `workspace_leases` record contains at least:

```text
lease_id, workspace_key, mode, state, generation, fencing_token_digest,
requester_id, batch_id, assignment_id, session_id, attempt_id,
server_instance_id, process_id, process_start_token, process_group_id,
acquired_at, heartbeat_at, expires_at, released_at, quarantine_reason,
policy_version, row_version
```

`lease_id` and the bearer fencing token are cryptographically random. Only a digest
of the token is persisted. `generation` is a monotonically increasing integer
allocated for the workspace under the same serializable transaction that creates
the lease. It is never reused, including after release or cleanup.

Write authority requires all of these facts at the instant of each controlled
mutation or lifecycle action:

- the caller presents the token for the current generation;
- immutable requester, session, attempt, workspace, and server ownership match;
- the lease is `active`, not `releasing`, `released`, or `quarantined`;
- the owning process identity matches PID plus process start token and process
  group identity;
- the server still owns the exclusive OS lock handle;
- the canonical workspace identity still matches the lease key.

The token is passed only through a dedicated private launcher channel, never the
prompt, argv, environment, logs, audit, result, or MCP response. A process that
cannot participate in fenced mutation is confined by the continuously held OS
lock and exclusive admission. Future out-of-process mutation services MUST reject
every operation carrying a generation lower than the latest durable generation.

## Acquisition protocol

Acquisition is ordered and fail closed:

1. Validate the closed request schema, requester ownership, immutable capability,
   limits, access mode, and local workspace resolution.
2. Open the owner-only lease-lock file derived from `workspace_key`; reject a
   symlink, unexpected owner, permissive mode, non-regular file, or identity change.
3. Try to acquire its exclusive non-blocking OS advisory lock. A busy or uncertain
   lock returns `WORKSPACE_WRITER_BUSY`. The lock implementation MUST work across
   orchestrator processes, not only within one Node.js process.
4. Under the durable store's serializable write transaction, inspect all leases
   for the key. Any active, releasing, unverified expired, or quarantined writer
   denies acquisition. A released lease does not.
5. Allocate the next generation, create the lease and `lease_acquired` audit event,
   and commit them atomically before any external launch intent or child creation.
6. Revalidate workspace and lock-file identities. Persist launch intent bound to
   the lease ID and generation.
7. Spawn the process in a new tracked process group. Atomically bind PID, process
   start token, and process-group identity before reporting launch acceptance.
8. If any step fails, create the typed denial or failure event. Release the OS lock
   only when no child could have started; otherwise enter recovery or quarantine.

The durable partial unique writer index is mandatory defense in depth, but it is
not the cross-process fencing mechanism. The transaction and exclusive OS lock
together ensure racing server instances produce exactly one launch intent and one
child for a canonical worktree.

## Heartbeat rules

The owning server renews an active lease at a configured interval no greater than
one third of its lease duration. Heartbeat uses compare-and-set on lease ID,
generation, token digest, owner identity, process identity, state, and `row_version`.
It updates `heartbeat_at`, `expires_at`, and `row_version` in one transaction.

Heartbeat failure immediately removes the owner's authority to initiate new
controlled mutations. The owner retains the OS lock, attempts bounded
reconciliation, and does not let another writer in. Token mismatch, generation
mismatch, changed process identity, lost lock ownership, workspace identity change,
or durable conflict quarantines the workspace. A stale owner receives
`LEASE_FENCED` and MUST stop/cancel its process group when safely supported; it
can never reacquire authority by writing a later timestamp.

Clock movement cannot grant authority. Durations use a monotonic clock within one
server lifetime; persisted UTC times support diagnosis and restart eligibility
only. Expiry is never sufficient proof that the process stopped or the lock owner
vanished.

## Release rules

Normal release is a two-phase, compare-and-set operation:

1. Prove the exact owned process group reached an authoritative terminal state and
   no descendant or writable helper remains. Persist the terminal observation.
2. Change `active` to `releasing` using lease ID, generation, token, process
   identity, and row version. Reject stale callers with `LEASE_FENCED`.
3. Persist `lease_released` and state `released` atomically, then close the OS lock
   handle. If persistence fails, retain the lock and reconcile.

Client disconnect, cancellation request, MCP timeout, missing heartbeat, wall-clock
expiry, server shutdown request, adapter error, terminal text, or disappearance
from one process listing does not release a writer. Shutdown keeps the child and
lease tracked or proves terminal state before release.

## Restart, crash, and stale-owner recovery

Startup completes lease reconciliation before registering mutation tools:

1. Validate storage and lock-file ownership and integrity. Corruption fails startup
   or quarantines the affected workspace without replacing evidence.
2. For each non-released writer lease, attempt the workspace OS lock non-blocking.
   Failure means another instance or process may still own it; preserve the lease
   and deny new writers.
3. Reconcile PID, process start token, process group, backend identity, and canonical
   workspace identity. PID alone and elapsed time are never proof.
4. If the exact process is alive, preserve its generation, reacquire tracking only
   through a supported authenticated handoff, and continue heartbeats. Without a
   supported handoff, quarantine and deny new writers while the process lives.
5. If the exact process and descendants are authoritatively absent and this
   server owns the OS lock, mark the old generation `released` through recovery,
   audit the evidence, close the lock, and permit a later acquisition with a
   higher generation.
6. If identity is reused, incomplete, contradictory, unavailable, or the launch
   outcome is unknown, set `quarantined`, retain or acquire the lock where possible,
   and return `LEASE_RECOVERY_AMBIGUOUS`.

A later generation fences every prior owner even if an old process resumes. Before
any controlled action, the old process fails current-generation validation. The
OS lock prevents generation advance while a live owner still holds it. These two
layers ensure stale owners cannot retain write authority and active writers cannot
be displaced by expiry.

Operator recovery is evidence-based, not an override. The only MVP repair flow is:
stop mutation service, prove all process identities for the workspace absent,
verify canonical identity and durable integrity, preserve an audit/registry backup,
and invoke a fixed repair operation that quarantines the old generation and permits
normal acquisition of a higher generation. Repair never assigns an active lease,
steals a live lock, bypasses a check, reuses a generation, or launches a process.

## Safety checks

The server exposes a read-only safety diagnostic that reports only bounded,
non-secret facts and never changes authority. Writer admission MUST independently
rerun all checks instead of trusting an earlier diagnostic.

| Check | Required safe result |
| --- | --- |
| `target.local` | Exact registered local host, project, and workspace |
| `target.identity` | Canonical root and Git identities stable before spawn |
| `lease.lock` | Owner-only regular lock file and exclusive lock held |
| `lease.store` | One current generation, valid ownership, no ambiguity |
| `lease.process` | Exact PID/start-token/group evidence or no process before launch |
| `access.enforcement` | Writer confinement or approved read-only mechanism verified |
| `state.integrity` | Registry valid, lock acquired, atomic audit write available |
| `policy.fixed` | Trusted version loaded; no request/repository override fields |
| `limits` | All atomic concurrency and resource ceilings available |

Any unknown result is unsafe. Checks run before durable reservation and again at
the documented time-of-use boundaries. A failed audit-intent write denies launch.

## Typed refusal contract

Safety refusals use the common MCP error envelope with `layer: "policy"`,
`category: "conflict" | "unsupported" | "invalid_state"`, `retryable: false`, and
one stable code below. Messages are bounded and do not reveal paths, tokens, PIDs,
other requester identities, prompts, or lock contents.

| Code | Category | Meaning |
| --- | --- | --- |
| `WORKSPACE_WRITER_BUSY` | `conflict` | Another or uncertain writer authority exists |
| `WORKSPACE_IDENTITY_CHANGED` | `invalid_state` | Canonical target or Git identity changed |
| `READ_ONLY_ENFORCEMENT_UNAVAILABLE` | `unsupported` | No approved mechanical read-only boundary exists |
| `LEASE_FENCED` | `conflict` | Caller does not own the current generation |
| `LEASE_RECOVERY_AMBIGUOUS` | `invalid_state` | Process, lock, target, or durable evidence is inconclusive |
| `LEASE_STATE_CORRUPT` | `invalid_state` | Lease state failed integrity or schema validation |
| `WORKSPACE_POLICY_DENIED` | `invalid_state` | Another mandatory safety check failed |

Every refusal records `policy_denied` or `lease_quarantined` with the code,
workspace ID, request correlation, requester attribution, policy version, and
current generation when safe. It causes zero adapter launches and zero workspace
mutations. Authorization-safe callers receive the same busy response whether the
conflicting owner exists or is merely undisclosed.

## No override

MVP has no `force`, `override`, `steal`, `ignore_expiry`, warning acknowledgment,
environment variable, configuration switch, prompt phrase, administrator MCP
tool, alternate launch route, or direct state edit that bypasses this policy.
Unknown request fields are rejected. Repository configuration cannot weaken the
policy. A client cannot choose TTL, generation, lock path, token, process identity,
or recovery decision.

If the lease store, OS lock, process identity, read-only enforcement, target
identity, audit sink, or reconciliation evidence is unavailable or ambiguous, the
safe result is refusal or quarantine. Operational urgency does not create write
authority.

## Required verification

Release evidence MUST include:

- `T-LEASE-01`: simultaneous acquisitions from separate clients, batches, and
  server processes against path/case/symlink aliases yield exactly one lease,
  launch intent, and child;
- `T-LEASE-02`: renewal and release races prove compare-and-set fencing, monotonically
  increasing generations, and stale-token inability to mutate or release;
- `T-LEASE-03`: crashes at every acquisition and release boundary, PID reuse,
  owner restart, clock jump, lock loss, and unknown backend outcome either preserve
  the live owner or quarantine, never launch a duplicate;
- read-only sentinel tests on every supported platform prove writes fail in the
  worktree, Git metadata, renamed paths, descendants, and inherited process tree;
- static schema/tool/config tests prove no override field or alternate writer
  launch path exists;
- exact audit assertions prove every admission, denial, quarantine, recovery, and
  release is attributable and contains no fencing token or sensitive path.

Contract-document tests establish this design boundary. They do not establish that
the runtime enforcement exists. Until the race, crash, process, sandbox, and audit
tests pass against an implementation on each supported platform, writer launch and
shared read-only agent launch remain disabled.

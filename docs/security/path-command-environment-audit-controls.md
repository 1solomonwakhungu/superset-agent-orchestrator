# Path, command, environment, and audit control implementation

Status: implemented MVP controls
Scope: workspace authorization, child-process construction, secret redaction, and
the security audit trail
Last reviewed: 2026-07-26

This document records how the P0 controls in
[local-control-plane-threat-model.md](local-control-plane-threat-model.md) are
enforced in code, and which test proves each one. The threat model remains the
authoritative threat-to-control-to-test map.

## Enforcement points

| Control | Implementation | Proof |
| --- | --- | --- |
| C-PATH-01 no client paths | `AsynchronousLaunchRequest` and `AttributedLaunchRequest` accept `workspaceId` only; `opaqueWorkspaceId` rejects absolute, parent-relative, separator, drive, home, whitespace, control-character, and over-long targets | T-PATH-01 |
| C-PATH-02 authoritative local resolution | `RegisteredWorkspaceAuthorizer.authorize` resolves the ID through a fresh Superset inventory, requires exactly one workspace and one project, requires the active local `hostId` and `organizationId`, canonicalizes both paths with `realpath`, and requires component containment | T-PATH-01, T-PATH-02 |
| C-PATH-03 bind target identity at use | `WorkspaceGrant.revalidate` re-reads inventory and verifies host, organization, workspace/project IDs and paths, owner, availability, canonical containment, device, and inode immediately before adapter launch; both coordinators pass the same check into the adapter launch boundary | T-PATH-03 |
| C-CMD-01 fixed executable provenance | Discovery retains documented configuration/PATH selection, then `pinExecutable` requires a canonical absolute regular executable owned by the current user or root with no group/other write bits; `revalidateExecutable` compares device, inode, owner, and path before `spawn` | T-CMD-02 |
| C-CMD-02 allowlisted argv templates | Discovery uses fixed argument arrays with `shell: false`; `assertFixedArguments` rejects NUL, control, and newline bytes; `assertDataOperand` rejects option-leading operands and line or tab separators | T-CMD-01, T-CMD-02, T-CMD-03 |
| C-ENV-01 minimal environment | `childEnvironment` builds the child environment from an empty map and an exact-case allowlist of 15 names; cloud, Git, SSH, proxy, loader, and runtime-option variables are never inherited | T-ENV-01 |
| C-INPUT-01 bounded closed schemas | Both launch entry points explicitly validate prompt, client, batch, workspace, idempotency, session, batch, worker, attribution, and resume fields before mutation; identity fields reject whitespace, controls, over-limit values, and credentials | T-CMD-03, T-INPUT-01 |
| C-TOOLS-01 capability-minimal surface | `tool()` in `server.ts` runs `assertSafeToolNames` at each registration and `assertRegisteredToolNames` before the transport connects, so the live surface must equal the reviewed snapshot | T-TOOLS-01, T-TOOLS-02 |
| C-REDACT-01 structural redaction | An injected `RedactionPolicy` owned by `DurableStore` applies provider-pattern and configured literal-canary redaction to launch metadata, prompts, diagnostics, audit fields, errors, and result claims before persistence | T-SECRET-01, T-SECRET-02 |
| C-STORE-01 sensitive-data minimization | Prompt, client, batch, attribution, diagnostic, and result fields are policy-redacted before persistence; credentials in immutable identity/idempotency fields are rejected rather than transformed; the state directory is created with mode `0700` and the state file with mode `0600` | T-SECRET-01, T-INPUT-01 |
| C-AUDIT-01 mutation intent and outcome | Both launch paths durably record intent before external launch and atomically record started, failed/unknown, and recovered binding outcomes with their state mutation; audit persistence failure cannot advance the corresponding state | T-AUDIT-01 |
| C-AUDIT-02 injection-safe append-only events | Audit fields are structurally serialized, ANSI stripped, control-character normalized, bounded to 256 characters, and chained with a SHA-256 hash over canonical event bytes; `verifySecurityAuditChain` detects edits, deletions, and reordering | T-AUDIT-02 |

## Typed security failures

`SecurityError` carries a stable code used as the audit reason code, so denials
never echo the rejected payload:

| Code | Meaning | Retryable |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Request text or identifier failed closed validation | no |
| `WORKSPACE_UNAVAILABLE` | Registered workspace or project is absent or unusable | yes |
| `AMBIGUOUS_WORKSPACE` | Inventory returned duplicate or unresolvable identities | no |
| `REMOTE_WORKSPACE` | Target belongs to another host or organization | no |
| `POLICY_DENIED` | Target escapes its project, or the capability is excluded | no |
| `INTEGRITY_FAILURE` | Target identity changed between validation and use | no |

A launch denied at revalidation returns its intent to `reserved` and records the
race, because no child process was created.

## Deliberate limits

- Redaction policy is injected by the embedding runtime. A default policy covers
  structural/provider formats; deployments must inject their known literal canaries.
- Redaction removes secrets from the persisted prompt, so the dispatched prompt
  is the redacted text. Encrypted-at-rest prompt storage is still required
  before production persistence, as the threat model states.
- The audit chain is per state file. Rotation and export verification are not yet
  implemented.
- Lease exclusivity, concurrency ceilings, and child lifecycle control remain the
  scope of their own controls and are not part of this change.

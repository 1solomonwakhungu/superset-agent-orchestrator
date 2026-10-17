# Public Readiness

## Decision

The repository is ready for implementation review as an experimental,
local-only technical preview. It is not ready to be described as a public MVP,
a general-availability Superset backend, or a supported release.

## Architecture

```text
Generic stdio MCP client
        -> closed MCP tool schemas and server
        -> durable orchestration and lifecycle services
        -> capability-driven agent adapter boundary
        -> Superset CLI, opt-in local MCP bridge, or deterministic provider fixture
        -> isolated local workspace and coding-agent process
```

The core is backend- and client-independent; Superset is the first adapter.
Durable state, reconciliation, leases, fencing, bounded concurrency, redaction,
and fail-closed local routing support asynchronous batch semantics. The
authoritative decisions are [ADR-0001](adr/0001-mcp-sdk-and-local-transport.md),
[ADR-0002](adr/0002-product-boundary-and-mvp-gates.md), the
[MCP contract](mcp-tool-contract.md), and the [threat model](security/local-control-plane-threat-model.md).

## Dependency evidence

The five P0 prerequisite implementations are present in `main`:

| Dependency | Issue   | Merged evidence                                                                                                                                                                                                                                      |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-087      | PER-348 | [PR 34](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/34), [PR 54](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/54)                                                                                   |
| N-088      | PER-349 | [PR 31](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/31), [PR 46](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/46)                                                                                   |
| N-089      | PER-350 | [PR 21](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/21)                                                                                                                                                                     |
| N-090      | PER-351 | [PR 35](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/35), [PR 61](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/61), [PR 64](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/64) |
| N-091      | PER-352 | [PR 32](https://github.com/1solomonwakhungu/superset-agent-orchestrator/pull/32)                                                                                                                                                                     |

## Contract status

| Surface                                     | Status                         | Boundary                                                              |
| ------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| TypeScript, Zod, and generated JSON schemas | Normative                      | Client-independent contract                                           |
| Fake/provider lifecycle                     | Tested, experimental           | Does not prove Superset support                                       |
| `batches_create/get/status/results`         | Legacy experimental projection | Migration to contract 1.0 remains                                     |
| Recovery and lifecycle runtime tools        | Experimental                   | Durable fixture coverage                                              |
| `provider_*` tools                          | Operational, opt-in            | Disabled unless live Superset or fixture mode is enabled              |
| Live Superset discovery and launch          | Technical preview              | `SUPERSET_ORCHESTRATOR_ENABLE_LIVE_SUPERSET=1`; registered workspaces |
| Live Superset status and final response     | Technical preview              | Local MCP bridge `agents_responses`; `waiting_for_input` surfaced     |
| Live Superset launch recovery               | Technical preview              | Session ID bound to idempotency key; unknown outcomes fail closed     |
| Superset cancellation                       | Unsupported                    | Returns `CANCEL_UNSUPPORTED`; no bridge stop operation is used        |
| Superset process/transcript recovery        | Unsupported                    | Only the orchestrator's own binding is recovered                      |
| Public writer launch                        | Disabled                       | Fixture route requires explicit opt-in and a contained test root      |

## Requirement-to-test traceability

| Requirement                             | Deterministic evidence                                                                               | Real status                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| Stable asynchronous launch identities   | `tool-contract.test.ts`, `launch-service.test.ts`, `launch-idempotency.test.ts`                      | Live Superset session ID binding  |
| Crash-safe live launch idempotency      | `superset-local-mcp-adapter.test.ts`, `superset-local-mcp-transport.test.ts`                         | Fake bridge; fails closed         |
| Live bridge transport and handshake     | `superset-local-mcp-transport.test.ts`                                                               | Fake stdio MCP bridge             |
| Live status, input wait, final response | `superset-local-mcp-adapter.test.ts`, `result-capture.test.ts`, `provider-protocol.test.ts`          | Manual 1.17 run: running status   |
| Atomic and idempotent batches           | `idempotency-and-leases.test.ts`, `batch-store.test.ts`, `fake-superset.integration.test.ts`         | Fixture only                      |
| 100-session aggregation and attribution | `performance-harness.test.ts`, `result-capture.test.ts`, `fake-superset.integration.test.ts`         | 100/100 fixture benchmark         |
| Restart without duplicate launch        | `reconciliation.test.ts`, `server-restart.test.ts`, `resilience-regression.test.ts`                  | Manual Superset 1.17 run          |
| Cancellation and deadline races         | `lifecycle-service.test.ts`, `lifecycle-server.test.ts`, `fake-superset.integration.test.ts`         | Superset cancellation unsupported |
| Workspace exclusivity and fencing       | `workspace-leases.test.ts`, `workspace-lease-concurrency.test.ts`, `repositories.test.ts`            | Writer launch disabled            |
| Local discovery and routing             | `superset-discovery.test.ts`, `superset-discovery.smoke.test.ts`                                     | Superset 1.17 discovery smoke     |
| Path, command, and environment security | `security-controls.test.ts`, `security-adversarial-corpus.test.ts`, `security-threat-model.test.mjs` | Deterministic                     |
| Platform support                        | `platform-compatibility.test.ts`, `compatibility-matrix.test.mjs`                                    | macOS/Linux, Node 22/24 CI        |
| Response adapter seam                   | `opencode-response-adapter.test.ts`, `response-adapter-conformance.test.ts`                          | Normalization boundary only       |
| Load and backpressure                   | `concurrency-scheduler.test.ts`, `performance-harness.test.ts`                                       | Real 30-agent run blocked         |

Worker prose and launch receipts are not completion evidence. Code, test, pull
request, and external-system state must be verified independently.

## Readiness checklist

- [x] N-087 through N-091 implementations merged
- [x] Generic MCP-client contract and Hermes-independent architecture
- [x] Deterministic lifecycle, security, and recovery coverage
- [x] macOS/Linux CI on Node.js 22 and 24
- [x] Security, setup, troubleshooting, and contribution guidance
- [x] Opt-in live Superset launch, status, and final response through the local MCP bridge
- [ ] Authoritative, versioned Superset lifecycle and response API
- [ ] Superset cancellation
- [ ] Superset process and transcript recovery
- [ ] Enabled writer launch with enforced isolation
- [ ] Successful authorized 30-real-agent run
- [ ] Published package, supported release, and versioning policy

## Known limitations

- The live adapter depends on Superset Desktop's local MCP bridge
  (`agents_create`, `agents_responses`), which is not a versioned public API.
  It has been exercised manually against Superset 1.17 only.
- Cancellation is unsupported. `provider_sessions_cancel` returns
  `CANCEL_UNSUPPORTED` for live sessions.
- The bridge cannot list sessions, so a launch whose outcome is unknown (the
  bridge timed out or died after `agents_create` was sent) cannot be reconciled.
  The adapter keeps a write-ahead pending record and fails the retry with
  `LAUNCH_REJECTED` instead of starting a second agent; verify it in Superset.
  Bridge `isError` results count as unknown outcomes, so a launch Superset
  refused for an ordinary reason also needs this manual check.
- A session waiting for input is reported as `waiting_for_input`. It stays
  non-terminal and is subject to the session deadline.
- Backend recovery restores the orchestrator's session binding, not the Superset
  process or transcript.
- `unknown_outcome` is an intentional honest terminal classification.
- Public writer launch and OS-enforced read-only sharing are disabled; the
  contained provider fixture is test-only.
- The real 30-agent test and aggregate resource telemetry remain blocked.
- Windows, HTTP transport, remote hosts, and relay fallback are unsupported.
- Legacy recovery projections are not yet migrated to contract 1.0.
- Private ACP and provider tools are experimental or test-only.
- Codex/OpenCode adapters prove normalization, not full live backend support.

The server, schemas, persistence, tests, and runtime contain no Hermes
dependency. Hermes appears only in historical planning material and may be an
ordinary MCP client; its prompts, memories, Discord behavior, aliases, and
skills are not part of this product contract.

Versioning and publication are intentionally deferred. Do not change package
metadata, create a tag or changelog, publish a package, or interpret internal
`0.1.0` metadata as a supported release as part of this readiness gate.

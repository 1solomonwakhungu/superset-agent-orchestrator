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
        -> Superset public CLI or deterministic provider fixture
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

| Surface                                         | Status                         | Boundary                                                            |
| ----------------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| TypeScript, Zod, and generated JSON schemas     | Normative                      | Client-independent contract                                         |
| Fake/provider lifecycle                         | Tested, experimental           | Does not prove Superset support                                     |
| `batches_create/get/status/results`             | Legacy experimental projection | Migration to contract 1.0 remains                                   |
| Recovery and lifecycle runtime tools            | Experimental                   | Durable fixture coverage                                            |
| `provider_*` tools                              | Test-only                      | Disabled without explicit opt-in                                    |
| Superset discovery and launch adapters          | Technical preview              | Separate harness capability; not exposed by production MCP handlers |
| Superset status, result, cancellation, recovery | Unsupported                    | Fails honestly                                                      |
| Public writer launch                            | Disabled                       | Fixture route requires explicit opt-in and a contained test root    |

## Requirement-to-test traceability

| Requirement                             | Deterministic evidence                                                                               | Real status                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| Stable asynchronous launch identities   | `tool-contract.test.ts`, `launch-service.test.ts`, `launch-idempotency.test.ts`                      | Superset launch receipt only      |
| Atomic and idempotent batches           | `idempotency-and-leases.test.ts`, `batch-store.test.ts`, `fake-superset.integration.test.ts`         | Fixture only                      |
| 100-session aggregation and attribution | `performance-harness.test.ts`, `result-capture.test.ts`, `fake-superset.integration.test.ts`         | 100/100 fixture benchmark         |
| Restart without duplicate launch        | `reconciliation.test.ts`, `server-restart.test.ts`, `resilience-regression.test.ts`                  | Fixture/provider only             |
| Cancellation and deadline races         | `lifecycle-service.test.ts`, `lifecycle-server.test.ts`, `fake-superset.integration.test.ts`         | Superset cancellation unsupported |
| Workspace exclusivity and fencing       | `workspace-leases.test.ts`, `workspace-lease-concurrency.test.ts`, `repositories.test.ts`            | Writer launch disabled            |
| Local discovery and routing             | `superset-discovery.test.ts`, `superset-discovery.smoke.test.ts`                                     | Discovery/launch only             |
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
- [ ] Authoritative Superset lifecycle and exact response API
- [ ] Superset cancellation and restart recovery
- [ ] Enabled writer launch with enforced isolation
- [ ] Successful authorized 30-real-agent run
- [ ] Published package, supported release, and versioning policy

## Known limitations

- Superset exposes discovery and launch metadata only; acceptance is not completion.
- Exact ordinary-session responses, cancellation, and backend recovery are unavailable.
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

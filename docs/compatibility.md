# Compatibility evidence and policy

Status: PER-327 evidence matrix, version `2026-07-24`

The machine-readable source of truth is
[`config/compatibility-matrix.v1.json`](../config/compatibility-matrix.v1.json).
It records exact combinations rather than implying support for a Cartesian
product of operating systems, runtimes, Superset versions, SDKs, transports, and
agent presets.

## Evidence classes

| Class | Meaning | Mutation policy |
| --- | --- | --- |
| `verified` | A repeatable probe passed for the exact recorded combination. | Only the recorded operations are eligible. |
| `contract-supported` | Primary documentation supports the combination, but a required lane remains. | Run operation-specific probes first. |
| `experimental` | Commit-pinned private research, opt-in and disabled by default. | Never use in the stable adapter. |
| `unsupported` | A known incompatible dimension or excluded operation. | Reject before mutation. |
| `unknown` | Qualifying evidence does not exist for the exact combination. | Reject before mutation. |

No patch, minor, operating-system, preset, or Desktop/CLI compatibility is
transitive. A range is supported only when the matrix names the range and its
automated probes pass. Documentation can establish `contract-supported`, not
`verified`.

## Current claims

The sole verified Superset pair is Desktop `1.16.1` with bundled CLI `1.16.1` on
the recorded macOS environment. Relay-blocked probes verified explicit local
workspace list/get behavior and fail-closed missing-workspace behavior. Public
Superset evidence supports configured-agent discovery and launch metadata only.
Launch success is not completion or result evidence.

Node.js 22 and 24 with npm 10 and MCP SDK `1.29.0` are tested on the exact
`macos-14` and `ubuntu-24.04` runner images by
[`Compatibility`](../.github/workflows/compatibility.yml). Each exact-head run
executes the build and complete test suite, records the detected OS, architecture,
Node, and npm versions, and generates a report only when all four lanes pass.
The workflow report is the real-results compatibility document; a failed or
missing lane cannot generate it. Superset Desktop-specific claims remain separate
because generic runners do not provide a configured local Desktop host.

Windows is explicitly unsupported. Package installation and server startup reject
it until native path, process, signal, discovery, filesystem, and stdio lanes are
validated.

MCP SDK v2 prereleases, Streamable HTTP, and legacy HTTP+SSE are unsupported for
the MVP. Superset session listing, status, exact result, stop reason,
cancellation, and backend recovery are unsupported on current public surfaces.
Private ACP is experimental and does not establish support for ordinary terminal
agents.

## Repeatable probes

Run the non-mutating environment probe from a clean checkout:

```sh
npm ci
npm run compatibility:probe
```

A sanitized execution from the delivery checkout is preserved at
[`evidence/per-327/environment-probe.json`](../evidence/per-327/environment-probe.json).
It intentionally demonstrates the actionable `unknown` result when Desktop and
preset dimensions are not supplied.

To supply optional compatibility dimensions without exposing installation paths:

```sh
SUPERSET_DESKTOP_VERSION=1.16.1 \
SUPERSET_AGENT_PRESET=Codex \
npm run compatibility:probe
```

Set `SUPERSET_CLI` only when the CLI is not on `PATH`. The report records that an
override was used but never records its value. It emits operating-system release,
architecture, Node, npm, exact lockfile SDK, transport, Superset versions, and
preset identity. It does not enumerate users, environment values, organizations,
hosts, projects, workspaces, repositories, prompts, transcripts, results, process
arguments, or credentials.

The probe never mutates and never promotes itself to `verified`. It returns
`contract-supported` only when every supplied dimension is inside the declared
envelope. Each operation then needs its own evidence:

```sh
npm run verify
./scripts/verify-per-323.sh
npm test -- test/superset-lifecycle-capabilities.test.mjs
```

The routing probe blocks relay through an unreachable loopback proxy while
exempting loopback traffic. Run mutating launch sentinels only in a disposable,
isolated workspace. Record preset identity separately from its executable and
version. A launch probe may prove discovery and launch metadata only.

Before marking stdio `verified`, an automated client must spawn the compiled
server and check negotiation, server identity and capabilities, tool schemas, a
read-only call, survival after an invalid call, a second valid call, protocol-only
stdout, diagnostics-only stderr, and bounded cleanup. Unit tests do not replace
that packaged probe.

## Unsupported and unknown combinations

Both classes fail before any launch, creation, update, deletion, cancellation, or
fallback. The stable implementation must return `UNSUPPORTED_COMBINATION` with:

- `classification`: `unsupported` or `unknown`;
- `detected`: sanitized detected dimensions;
- `unsupportedDimensions`: each rejected or unverified dimension;
- `supportedAlternatives`: exact known alternatives;
- `probeCommand`: `npm run compatibility:probe`.

The operator can then install a named supported version, provide the missing
dimension, or run and submit the specified probes. The orchestrator must not
silently downgrade, switch transport, select another preset or host, retry via
relay/cloud, accept an unknown output shape, or enable a private API.

Revalidate after any OS lane, Node/npm, SDK lockfile, negotiated protocol,
Superset Desktop/CLI, preset/harness, or upstream evidence revision change. A
Desktop/CLI mismatch is `unknown` until that exact pair passes. Unknown command
output or JSON shape is also `unknown` and fails closed.

## Primary evidence

- MCP SDK v1, stdio, Node, npm, and platform contract:
  [`ADR 0001`](adr/0001-mcp-sdk-and-local-transport.md), merged at
  `0678406d2b57c812cea91604d16ec494f8cb0b22`.
- Superset public and private lifecycle boundaries:
  [`Superset lifecycle and result API evidence`](superset-lifecycle-result-api-evidence.md),
  upstream `superset-sh/superset@b0d3411665ff5b9241dee7aef0e23a19c265dfbc`,
  merged at `22d3cf68236a4f3666c2fdf69c63f0251e0dfb7a`.
- Relay-blocked local routing observations:
  [`Strict local routing during relay failure`](local-routing-relay-failure.md),
  merged at `0701437b5d031c67f4fbc33cf604acf2b6b80d57`.
- Time-varying official sources reviewed on 2026-07-24: the
  [MCP TypeScript SDK v1.x README](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/README.md),
  [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
  [Node.js release policy](https://nodejs.org/en/about/previous-releases), and
  [`@modelcontextprotocol/sdk` registry metadata](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest).

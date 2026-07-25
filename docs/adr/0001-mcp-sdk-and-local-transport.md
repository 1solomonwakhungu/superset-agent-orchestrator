<!-- markdownlint-disable MD013 -->

# ADR 0001: MCP SDK and local transport contract

- Status: Accepted
- Date: 2026-07-24
- Decision owners: Superset Agent Orchestrator maintainers
- Scope: MVP local MCP server

## Context

The orchestrator needs a production-supported TypeScript MCP SDK, a local transport, a Node.js baseline, and an upgrade policy. These choices must not add network exposure or bind the MVP to prerelease APIs without a concrete product need.

This decision was checked against the official sources on 2026-07-24:

1. The [MCP TypeScript SDK main README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md) identifies v2 as beta and says v1.x remains the supported production release until v2 is stable. It also promises v1 bug and security fixes for at least six months after v2 ships.
2. The [MCP TypeScript SDK v1.x README](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/README.md) documents `@modelcontextprotocol/sdk`, its Zod peer dependency, stdio for local process-spawned integrations, and Streamable HTTP for remote servers.
3. The [MCP 2025-06-18 transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) defines stdio and Streamable HTTP. It says clients should support stdio whenever possible and requires HTTP servers to validate `Origin`; local HTTP servers should bind only to `127.0.0.1` and implement authentication.
4. The [Node.js release policy](https://nodejs.org/en/about/previous-releases) says production applications should use Active LTS or Maintenance LTS releases. Node.js 22 and 24 are LTS on the decision date.
5. The [`@modelcontextprotocol/sdk` registry metadata](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest) reports v1.29.0 as the current release, requires Node.js 18 or newer, and accepts Zod `^3.25 || ^4.0` on the decision date.

Registry metadata is time-varying. The lockfile, rather than this observed version, will be authoritative for an implementation checkout.

## Decision

### SDK

Use the latest stable `@modelcontextprotocol/sdk` v1.x release available when the implementation lockfile is created. Declare the dependency with a v1-compatible range and commit the generated lockfile. Do not use v2 beta packages in the MVP.

Use Zod 4 for new schemas. The v1 SDK accepts both supported Zod lines, but selecting one line prevents mixed schema imports and reduces migration ambiguity.

### Transport

Support stdio only for the MVP.

The MCP client launches one local orchestrator process and owns its lifetime. Stdio directly matches that topology, requires no listening socket, authentication scheme, origin policy, port allocation, or HTTP session routing, and is the protocol-defined transport for local process-spawned integrations.

The server must reserve `stdout` exclusively for newline-delimited MCP JSON-RPC messages. Diagnostics and structured logs must go to `stderr`. Closing stdin or receiving normal process termination must trigger orderly transport and resource cleanup.

Do not implement legacy HTTP+SSE. Do not expose Streamable HTTP, including on loopback, without a superseding ADR and the upgrade conditions below.

### Runtime and package manager

- Runtime: Node.js 22 LTS, with `engines.node` set to `>=22 <25` for the MVP.
- Compatibility: CI must run on Node.js 22 and 24 LTS. Node.js 22 is the development and release baseline; Node.js 24 is the forward-compatibility lane.
- Package manager: npm 10, declared with the root `packageManager` field. Commit `package-lock.json` and use `npm ci` in CI and release verification.
- Modules: ESM TypeScript compiled to JavaScript before release execution. Production startup must not depend on a TypeScript runtime loader.
- Platforms: smoke tests must pass on macOS and Linux. Windows support is not claimed until a native Windows stdio lane passes.

Node.js 22 is stricter than the SDK's Node.js 18 minimum. It provides an LTS runtime while avoiding a requirement that every adopter immediately move to the newest LTS line.

## Protocol verification contract

Implementation is not complete until an automated smoke client spawns the packaged server through the SDK's stdio client transport and verifies all of the following:

1. Initialization succeeds and negotiates a protocol version supported by both peers.
2. The initialization result reports the expected server name, version, and declared capabilities.
3. `tools/list` returns the expected tool names and valid input schemas.
4. One read-only tool call succeeds and its result validates against the documented result contract.
5. One invalid tool call returns an MCP/JSON-RPC error without terminating the server.
6. A second valid request succeeds after that error.
7. No non-protocol bytes appear on `stdout`; a diagnostic emitted by the server appears only on `stderr`.
8. Closing the client transport ends the child process and releases owned resources within a bounded timeout.

Run this smoke test against built artifacts on every pull request in each supported Node.js and operating-system lane. Unit tests with in-memory transports may supplement it but do not replace it.

## Upgrade policy and triggers

Dependabot or Renovate may propose stable v1 patch and minor updates. Merge only after the full test matrix and packaged stdio smoke test pass. Treat any SDK update that changes negotiated protocol versions, exported transport paths, schemas, error shapes, or lifecycle behavior as a compatibility change requiring explicit review.

Evaluate v2 when all of these are true:

- The official SDK marks v2 stable and production-supported.
- The target MCP specification is final rather than a release candidate or draft.
- The v2 migration guide and stable API documentation are published.
- Required features have no unresolved upstream blocker.
- A migration branch passes the complete protocol smoke contract against every client compatibility fixture.

Adopt v2 only through a superseding ADR. Do not wait until v1 support ends: open the evaluation when v2 becomes stable, and complete migration or record a supported alternative at least 90 days before the announced end of v1 security support.

Reconsider Streamable HTTP only when a concrete requirement demands an independently running server, multiple concurrent client connections to one process, remote access, or HTTP-specific deployment infrastructure. A proposal must define authentication and authorization, `Origin` validation, `127.0.0.1` binding for local use, session ownership and cleanup, CSRF and DNS-rebinding defenses, port discovery, and equivalent protocol tests before implementation.

Review the Node.js baseline when Node.js 22 enters Maintenance LTS or twelve months after this decision, whichever comes first. Remove a runtime only in a semver-major release unless it is end-of-life or has a known security defect.

## Consequences

The MVP gets the production-supported SDK line and the smallest client-independent local attack surface. Its lifecycle follows the MCP host process, and interoperability can be tested end to end without network setup.

The MVP cannot serve clients that only connect by URL or share one daemon across independent hosts. Adding those capabilities requires a deliberate transport and security design rather than an accidental listening socket.

# Superset lifecycle and result API evidence

Status: PER-322 research decision, 2026-07-24

Upstream evidence revision: [`superset-sh/superset@b0d3411`][upstream-revision]

## Decision

Do not claim a supported Superset session lifecycle or exact-result integration.
The current public surfaces can launch an agent and return its session identifier,
but none can list launched sessions, read agent status or stop reason, retrieve
an exact final result, cancel a turn, or recover a result.

The least-brittle stable path is therefore:

1. Use the public Beta CLI with `--json` and explicit local routing for discovery
   and launch only.
2. Persist the returned `kind`, `sessionId`, workspace, prompt attribution, and
   timestamps in the orchestrator-owned registry.
3. Report post-launch lifecycle capabilities as unavailable. Do not infer them
   from host health, terminal existence, process state, or workspace state.
4. Keep the provider-neutral `AgentAdapter` boundary. Add a production Superset
   adapter only when Superset publishes a supported lifecycle and result surface.
5. Permit the private ACP path only in an opt-in, version-pinned research adapter
   for canary/dev builds. It must never be selected automatically or represented
   as production support.

This is a no-go for the proposed Superset-backed MVP's exact-result,
cancellation, and recovery requirements. Durable orchestration can continue with
fake or independently supported agent adapters, but ordinary Superset terminal
agents cannot satisfy the core result contract today.

## Evidence standard

The classification in this memo means:

| Class | Meaning |
| --- | --- |
| Supported | Documented public surface suitable for its stated operation. |
| Beta | Documented public CLI surface, explicitly subject to change. |
| Private | Repository implementation not offered as a public contract. |
| Unavailable | No qualifying public operation was found at the pinned revision. |

The public CLI documentation is explicitly **Beta** and says commands and flags
are still evolving.[^cli-beta] The public TypeScript SDK is **early alpha**, is
not meant for production, and may be removed.[^sdk-alpha] These labels apply even
where an operation exists.

## Operation matrix

| Lifecycle operation | Public CLI | Public SDK | Public MCP | Private implementation | Stable architecture |
| --- | --- | --- | --- | --- | --- |
| Launch ordinary agent | Beta | Early alpha | Supported cloud tool | Host launch routes | Beta CLI, version-gated |
| List configured agents | Beta | Early alpha | Supported cloud tool | Host settings | Discovery only, not sessions |
| List launched sessions | Unavailable | Unavailable | Unavailable | Terminal and ACP lists | No-go |
| Get one session | Unavailable | Unavailable | Unavailable | ACP get; terminal summaries | No-go |
| Read agent status | Unavailable | Unavailable | Unavailable | ACP status; coarse PTY state | No-go |
| Read exact final result | Unavailable | Unavailable | Unavailable | ACP message stream, no durable singular result | No-go |
| Read stop reason | Unavailable | Unavailable | Unavailable | ACP `lastStopReason`; PTY exit only | No-go |
| Cancel current turn | Unavailable | Unavailable | Unavailable | ACP cancel | No-go |
| Kill ordinary terminal | Unavailable | Unavailable | Unavailable | Private terminal kill | No-go |
| Reattach/recover result | Unavailable | Unavailable | Unavailable | Partial ACP resurrection; PTY adoption | No-go |

`agents list` is a list of configured host agent rows, not running sessions. The
CLI documentation separately states that there is no session list and that a
freshly launched session can be invisible until opened through a manually built
deep link.[^cli-agents][^cli-no-session-list]

## Public launch path

The CLI documents `agents create` as starting a configured agent in a fresh
terminal session. Its public output is launch metadata: `kind`, `sessionId`, and
`label`.[^cli-agent-create] `terminals create` similarly returns only
`terminalId` and `status`.[^cli-terminal-create]

The SDK exposes the same narrow shape. Its `Agents` resource implements only
configuration `list` and session `create`; its `Terminals` resource implements
only `create`.[^sdk-agents][^sdk-terminals] The public MCP tool registry likewise
offers `agents_list`, `agents_create`, and `terminals_create`, with no lifecycle
read or control tool.[^mcp-tools][^mcp-register]

The identifier returned at launch is necessary for attribution, but it is not
evidence that the agent completed. `superset status` concerns the local host
daemon, and `superset stop` terminates that daemon. Neither is an agent-session
status or cancellation path.[^cli-host-status][^cli-host-stop]

### Stable launch contract

For a version-gated CLI adapter, a successful launch may produce only:

```json
{
  "backend": "superset-cli",
  "operation": "launch",
  "kind": "terminal",
  "sessionId": "opaque Superset identifier",
  "lifecycle": "unobservable",
  "result": "unavailable",
  "cancellation": "unavailable",
  "recovery": "registry-metadata-only"
}
```

The orchestrator may recover its own launch record after restart. It must not
describe that as recovering the Superset process, transcript, or final answer.

## Result path

### Public result path: unavailable

No public CLI command, SDK method, MCP tool, or documented stable host API
returns an ordinary terminal agent's final answer. The launch response cannot be
promoted into a result response.

The private terminal subsystem does not close this gap. It exposes a PTY byte
stream and coarse fields such as `exited` and `exitCode`, not structured agent
turns.[^private-terminal-summary][^private-terminal-exit] Detached output replay
is capped at 64 KiB, evicts old data, and clears replayed data after attachment.
It therefore cannot guarantee complete output or identify an exact final
answer.[^private-terminal-buffer][^private-terminal-eviction][^private-terminal-clear]

### Quarantined ACP result experiment

The internal ACP subsystem has structured statuses, message history,
`lastStopReason`, and a cancel operation.[^acp-state][^acp-api] Its manager records
the adapter's stop reason and emits final state after a prompt finishes.[^acp-final]
This permits an experiment to fold protocol messages into final assistant
content without terminal scraping.

ACP still has no singular, immutable `getFinalResult(sessionId)` record. Its host
journal is bounded to 5,000 envelopes, native transcript history is not
paginated, and cursor continuity does not survive restart.[^acp-history]

Most importantly, ACP is not a public solution. It is enabled only in canary and
dev builds, stable builds do not enable it, and the typed host-client package is
private.[^acp-channel][^acp-gate][^private-host-client] The experiment must be:

- opt-in and disabled by default;
- pinned to an inspected Superset commit and canary/dev build;
- isolated behind a private adapter with a visible `experimental` capability;
- based only on typed ACP protocol messages and state frames;
- prohibited from writing user data or claiming stable compatibility;
- removed or revised whenever upstream changes invalidate the pin.

ACP evidence applies to its ACP harness, not ordinary Codex or Claude terminal
sessions.

## Cancellation path

### Public cancellation path: unavailable

No public session cancellation operation was found. Stopping the whole Superset
host is not cancellation and would disrupt unrelated work. Sending terminal
keystrokes or operating-system signals from outside a supported API is also not
a normalized turn-cancellation contract.

The private terminal router has `killSession`, which disposes a PTY.[^private-kill]
That is terminal destruction, not agent-turn cancellation, and is excluded from
the stable adapter.

### Quarantined ACP cancellation experiment

ACP cancellation settles outstanding permission requests as cancelled and sends
`session/cancel` through the adapter.[^acp-cancel] This is the only source-backed
turn cancellation found. It inherits every ACP private/canary restriction above
and cannot be used as the production cancellation path.

## Recovery and reattachment

The product documentation says terminal sessions survive desktop app restarts,
but does not expose an external recovery operation.[^terminal-persistence]
Internally, a WebSocket may adopt a live PTY while the daemon still owns it. If
the daemon has lost the PTY, Superset can instead spawn a replacement shell under
the same terminal identifier.[^private-pty-recovery] Replacement is not recovery
of the original agent turn or answer.

ACP registry rows become `offline` after a host restart and may be resurrected
through `session/load`. Completed native transcript content can replay, but an
in-flight turn, pending permissions, and process-local callbacks do not
survive.[^acp-recovery] This is partial, private recovery only.

The stable orchestrator recovery boundary is therefore its own registry:

- recover launch attribution and the opaque Superset session identifier;
- mark an interrupted unobservable session `unknown_outcome`;
- never relaunch automatically merely because the result is unavailable;
- require operator reconciliation or an independently supported adapter;
- never infer completion from terminal disappearance or host restart.

## Fallback and no-go boundaries

### Allowed fallback

- Keep the public Beta CLI launch adapter version-gated and capability-driven.
- Return typed `UNSUPPORTED_OPERATION` for status, result, stop reason,
  cancellation, and backend recovery.
- Preserve orchestrator-owned launch records and explicit unknown outcomes.
- Use the repository's fake adapter for deterministic lifecycle behavior.
- Use another agent backend only if it publishes the required lifecycle contract.
- Run the ACP experiment only under the quarantine described above.

### No-go

- Reading or reverse-engineering Superset SQLite tables.
- Parsing Codex, Claude, or other agent temporary logs or native transcripts.
- Treating terminal scrollback, replay bytes, title, hooks, process existence,
  exit code, or signal as the exact final agent result.
- Calling private tRPC routes or WebSockets from the stable adapter.
- Shipping the private `@superset/host-client` package as a dependency.
- Treating a deep link as session discovery or recovery.
- Treating host `status` or host `stop` as agent status or cancellation.
- Automatically falling through from a failed local path to cloud or relay.
- Claiming ordinary terminal support from ACP-only evidence.

## Promotion gate

A stable Superset lifecycle adapter remains blocked until Superset publishes a
documented, versioned surface that provides all of the following:

1. Session list/get with workspace and launch attribution.
2. Agent-level status and terminal state semantics.
3. Structured final assistant content with an explicit completion boundary.
4. Normalized stop reason and error data.
5. Idempotent turn or session cancellation semantics.
6. Recovery behavior and retention guarantees across client and host restarts.
7. Local routing guarantees and compatibility/versioning policy.

Until then, exact result capture and cancellation are explicit no-go findings for
the stable Superset integration.

## Primary sources

[^cli-beta]: [CLI reference: Beta warning][cli-beta].
[^cli-agents]: [CLI reference: configured agents][cli-agents].
[^cli-no-session-list]: [CLI reference: no session list][cli-no-session-list].
[^cli-agent-create]: [CLI reference: agent create][cli-agent-create].
[^cli-terminal-create]: [CLI reference: terminal create][cli-terminal-create].
[^cli-host-status]: [CLI reference: host status][cli-host-status].
[^cli-host-stop]: [CLI reference: host stop][cli-host-stop].
[^sdk-alpha]: [SDK reference: early-alpha warning][sdk-alpha].
[^sdk-agents]: [SDK source: Agents resource][sdk-agents].
[^sdk-terminals]: [SDK source: Terminals resource][sdk-terminals].
[^mcp-tools]: [MCP reference: public agent and terminal tools][mcp-tools].
[^mcp-register]: [MCP source: complete tool registration][mcp-register].
[^private-terminal-summary]: [Host source: terminal summary][private-terminal-summary].
[^private-terminal-exit]: [Host source: terminal exit frame][private-terminal-exit].
[^private-terminal-buffer]: [Host source: 64 KiB replay buffer][private-terminal-buffer].
[^private-terminal-eviction]: [Host source: replay eviction][private-terminal-eviction].
[^private-terminal-clear]: [Host source: replay clearing][private-terminal-clear].
[^private-kill]: [Host source: private terminal kill route][private-kill].
[^terminal-persistence]: [Product docs: terminal persistence][terminal-persistence].
[^private-pty-recovery]: [Host source: PTY adoption or replacement][private-pty-recovery].
[^acp-state]: [ACP source: status and stop-reason state][acp-state].
[^acp-api]: [ACP source: get, messages, prompt, and cancel API][acp-api].
[^acp-final]: [Host source: final ACP stop-reason state][acp-final].
[^acp-cancel]: [Host source: ACP cancellation][acp-cancel].
[^acp-channel]: [ACP implementation note: channel restrictions][acp-channel].
[^acp-gate]: [ACP implementation note: stable-build gate][acp-gate].
[^acp-history]: [ACP implementation note: history limits][acp-history].
[^acp-recovery]: [ACP implementation note: restart recovery][acp-recovery].
[^private-host-client]: [Private host-client package manifest][private-host-client].

[upstream-revision]: https://github.com/superset-sh/superset/tree/b0d3411665ff5b9241dee7aef0e23a19c265dfbc
[cli-beta]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/cli/cli-reference.mdx#L1-L8
[cli-agents]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/cli/cli-reference.mdx#L767-L801
[cli-no-session-list]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/cli/cli-reference.mdx#L732-L763
[cli-agent-create]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/cli/cli-reference.mdx#L803-L827
[cli-terminal-create]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/cli/cli-reference.mdx#L831-L856
[cli-host-status]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/cli/cli-reference.mdx#L231-L248
[cli-host-stop]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/cli/cli-reference.mdx#L203-L228
[sdk-alpha]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/sdk/reference.mdx#L1-L8
[sdk-agents]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/sdk/src/resources/agents.ts#L13-L51
[sdk-terminals]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/sdk/src/resources/terminals.ts#L9-L25
[mcp-tools]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/mcp-server.mdx#L294-L305
[mcp-register]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/mcp-v2/src/tools/register.ts#L7-L63
[private-terminal-summary]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/terminal/terminal.ts#L403-L435
[private-terminal-exit]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/terminal/terminal.ts#L153-L162
[private-terminal-buffer]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/terminal/terminal.ts#L164-L177
[private-terminal-eviction]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/terminal/terminal.ts#L574-L581
[private-terminal-clear]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/terminal/terminal.ts#L641-L675
[private-kill]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/trpc/router/terminal/terminal.ts#L180-L220
[terminal-persistence]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/apps/docs/content/docs/terminal-integration.mdx#L20-L25
[private-pty-recovery]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/terminal/terminal.ts#L1495-L1566
[acp-state]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/session-protocol/src/state.ts#L10-L24
[acp-api]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/session-protocol/src/api.ts#L116-L169
[acp-final]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/runtime/acp-sessions/acp-sessions.ts#L360-L426
[acp-cancel]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/src/runtime/acp-sessions/acp-sessions.ts#L443-L453
[acp-channel]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/docs/acp-sessions.md#L29-L37
[acp-gate]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/docs/acp-sessions.md#L191-L202
[acp-history]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/docs/acp-sessions.md#L112-L163
[acp-recovery]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-service/docs/acp-sessions.md#L64-L110
[private-host-client]: https://github.com/superset-sh/superset/blob/b0d3411665ff5b9241dee7aef0e23a19c265dfbc/packages/host-client/package.json#L1-L14

# OpenCode response adapter

## Selection

OpenCode is the second enabled real agent preset. On 2026-07-24, `superset
agents list --local --json` reported the built-in `opencode` preset using the
`opencode` executable and argv prompt transport. It was selected instead of
Claude because Claude must remain disabled, and instead of less documented
presets because OpenCode publishes a typed SDK and session API.

The implementation consumes the documented OpenCode SDK response shape:
`{ info: AssistantMessage, parts: Part[] }`. It maps that provider response to
the existing `RunResult` and `ResumeMetadata` contracts. No core domain or MCP
contract changed.

Primary evidence:

- <https://opencode.ai/docs/sdk/#sessions>
- <https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts>

## Supported boundary

- An assistant message without `time.completed` is non-terminal.
- A completed assistant message produces the exact ordered, non-ignored text.
- The OpenCode session ID becomes the provider-specific resume token.
- Documented aborts map to cancellation.
- Documented provider, API, unknown, and output-length errors map to failure.
- Part session and message IDs must match the enclosing assistant message.
- Unknown error variants and malformed attribution fail closed.

## Unsupported features

This response adapter does not launch or supervise the OpenCode process, scrape
terminal output, read OpenCode private storage, infer completion from process
exit, merge tool output into the final answer, stream partial text, or implement
OpenCode session cancellation. Those operations require a separately versioned
execution adapter and supported Superset lifecycle surface.

OpenCode structured output, attachments, reasoning, tool calls, subtasks,
snapshots, patches, and usage accounting remain outside `RunResult`. The adapter
does not silently flatten them into text. Empty final text is preserved as an
exact empty result.

The shared conformance suite runs the same launch/non-terminal, exact-result,
attribution, terminal-state, and malformed-response assertions against Codex and
OpenCode. Claude has no adapter, fixture, executable invocation, or test path.

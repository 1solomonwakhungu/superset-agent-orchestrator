# Real Superset and Codex end-to-end harness

The opt-in real-system lane validates supported behavior against an exact local Superset worktree and Codex preset. It is intentionally separate from `npm test` because it launches a real agent.

## Safety gates

The harness refuses to inspect live tools or launch unless:

- `SUPERSET_REAL_E2E_PREFLIGHT=1` explicitly authorizes preflight, or `SUPERSET_REAL_E2E=1` explicitly authorizes launch;
- `SUPERSET_REAL_E2E_WORKSPACE_ID` resolves to exactly one local workspace;
- `SUPERSET_REAL_E2E_WORKSPACE_PATH` exactly matches its canonical path;
- the target is an existing `worktree`, not a main workspace;
- the harness repository is inside that workspace;
- the authorized Superset workspace is an enclosing Git top level whose linked-worktree Git directory is distinct from its shared common directory;
- exactly one Codex preset is configured; and
- the target repository is clean;
- the detected Superset CLI is the capability-vetted version 1.16.1; and
- the report path is outside the authorized worktree;
- the configured Superset and exact `codex` executables are available and respond to bounded `--version` probes; and
- the Codex preset command is exactly `codex`, with no wrapper or local-model startup arguments.

Every child process uses an argument array with shell interpolation disabled, bounded output, and a hard timeout. On timeout, the harness kills the complete process group and records the timeout without retaining raw output. The launch prompt forbids tools and file changes. The launch command names only the authorized workspace ID, and the receipt is attributed to those explicit command arguments. Git HEAD and complete status are compared during preflight and immediately before and after launch acceptance.

## Commands

Run non-mutating preflight first:

```sh
SUPERSET_REAL_E2E_PREFLIGHT=1 \
SUPERSET_REAL_E2E_WORKSPACE_ID='<uuid>' \
SUPERSET_REAL_E2E_WORKSPACE_PATH='<absolute-worktree-path>' \
npm run test:real:preflight
```

Then run the real launch:

```sh
SUPERSET_REAL_E2E=1 \
SUPERSET_REAL_E2E_WORKSPACE_ID='<uuid>' \
SUPERSET_REAL_E2E_WORKSPACE_PATH='<absolute-worktree-path>' \
npm run test:real
```

Set `SUPERSET_REAL_E2E_REPORT` to choose the report path. It must be outside the authorized worktree. By default, each report receives a unique name under the operating system's temporary directory. `SUPERSET_REAL_E2E_COMMAND_TIMEOUT_MS` and `SUPERSET_REAL_E2E_LAUNCH_TIMEOUT_MS` may lower, but never raise, the 20-second command and 30-second launch limits.

## Evidence semantics

The report captures runtime and vetted Superset version, configured Codex preset identity, linked-worktree proof, target hashes, scenario timings, process exit details, output hashes and byte counts, selected non-secret observed output, resource usage, failures, and the launch session identity. Full tool output, executable paths, discovery output, workspace paths, configured secrets, and the sentinel are not persisted. Codex is invoked directly only as `codex --version`, which validates availability without starting a model; the agent launch remains exclusively through Superset. Relay access is made unavailable with dead loopback proxies while loopback itself remains in `NO_PROXY`.

Superset CLI 1.16.1 supports local discovery and launch, but exposes no supported public terminal-agent status, final-result, cancellation, or session-rediscovery command. Those stages are reported as `UNSUPPORTED_OPERATION`. Because launch acceptance is asynchronous, real mode records workspace state at the launch receipt but reports post-completion isolation as unsupported. The suite cannot claim the exact sentinel passed or post-completion isolation until a supported completion and result transport exists; it records a blocked classification instead of inspecting private databases, logs, or terminal scrollback.

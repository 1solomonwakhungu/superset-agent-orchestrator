# Real Superset and Codex end-to-end harness

The opt-in real-system lane validates supported behavior against an exact local Superset worktree and Codex preset. It is intentionally separate from `npm test` because it launches a real agent.

## Safety gates

The harness refuses to launch unless:

- `SUPERSET_REAL_E2E=1` explicitly authorizes the launch;
- `SUPERSET_REAL_E2E_WORKSPACE_ID` resolves to exactly one local workspace;
- `SUPERSET_REAL_E2E_WORKSPACE_PATH` exactly matches its canonical path;
- the target is an existing `worktree`, not a main workspace;
- the harness repository is inside that workspace;
- the repository root is the target Git top level and uses a linked-worktree Git directory distinct from the shared common directory;
- exactly one Codex preset is configured; and
- the target repository is clean.

Every child process uses an argument array with shell interpolation disabled. The launch prompt forbids tools and file changes. The launch command names only the authorized workspace ID. Git HEAD and complete status are compared before and after the run.

## Commands

Run non-mutating preflight first:

```sh
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

Set `SUPERSET_REAL_E2E_REPORT` to choose the report path. The default is `artifacts/real-e2e-report.json`; `artifacts/` is not committed.

## Evidence semantics

The report captures runtime and Superset versions, configured Codex preset identity, linked-worktree proof, target hashes, scenario timings, process exit details, output hashes and byte counts, selected non-secret observed output, resource usage, failures, and the launch session identity. Full discovery output and the sentinel are not persisted because they can expose unrelated local metadata. It does not invoke Codex directly. Relay access is made unavailable with dead loopback proxies while loopback itself remains in `NO_PROXY`.

Superset CLI 1.16.1 supports local discovery and launch, but exposes no supported public terminal-agent status, final-result, cancellation, or session-rediscovery command. Those stages are reported as `UNSUPPORTED_OPERATION`. The suite cannot claim the exact sentinel passed until a supported result transport exists; it records a blocked classification instead of inspecting private databases, logs, or terminal scrollback.

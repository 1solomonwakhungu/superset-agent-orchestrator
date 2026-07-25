# Strict local routing during relay failure

This report covers PER-323 / N-062. It records the behavior of Superset Desktop
and its bundled CLI when relay access is unavailable, then defines the
fail-closed resolution contract required by the orchestrator.

## Test environment

| Component | Version |
| --- | --- |
| Superset Desktop | 1.16.1 (build 1.16.1) |
| Bundled Superset CLI | 1.16.1 |
| macOS | 26.5.1 (25F80) |
| Node.js | 22.23.1 |
| npm | 10.9.8 |

The bundled CLI was invoked through `/Users/solomonwakhungu/.superset/bin/superset`.
The local host service reported a healthy loopback endpoint at
`http://127.0.0.1:<ephemeral-port>` before relay isolation.

The source dossier required by the issue,
`/Users/solomonwakhungu/Downloads/superset-agent-orchestrator-handoff`, was not
present on the test machine. The target repository contained only its initial
README. This report therefore distinguishes observed behavior from the
proposed orchestrator contract and does not infer undocumented behavior.

## Routing matrix

`Explicit local` means the CLI offers `--local`. `Exact ID` means the operation
can avoid name ambiguity but does not necessarily prevent cloud-assisted host
discovery. `Relay required` means the controlled test failed when relay access
was redirected to an unreachable proxy.

| Operation | Selector | Observed route | Relay unavailable behavior | Orchestrator requirement |
| --- | --- | --- | --- | --- |
| Host service status | none | relay-sensitive despite reporting a loopback endpoint normally | Failed | Treat as relay-dependent discovery, not proof that the local host is down |
| List hosts | organization | relay | Failed | Do not use for a local-only request |
| List projects | `--local` or `--host` | explicit local or selected host | Procedure defined; not executed because project data is organization-backed | Require `--local` for local-only resolution |
| Create project | `--local` or `--host` | explicit local or selected host | Mutating case not executed under read-only task classification | Require `--local`; never retry through relay |
| Set up project | `--local` or `--host` | explicit local or selected host | Mutating case not executed | Require `--local`; never retry through relay |
| List workspaces | `--local`, `--host`, project, search | explicit local when `--local` is supplied | Succeeded with relay unavailable | Always supply `--local`; filter locally and require one exact result |
| Get workspace | workspace UUID or `SUPERSET_WORKSPACE_ID` | exact ID; CLI may search reachable hosts | Succeeded for a local UUID; missing UUID failed | Pre-resolve from `list --local`, then require returned host ID to equal the local host ID |
| Create workspace | `--local` or `--host`, project ID | explicit local or selected host | Mutating case not executed | Require `--local`; never retry through relay |
| Update workspace | workspace UUID | exact ID; no `--local` option | Not executed because it mutates state | Pre-resolve exact local UUID; reject non-local or unresolved targets before update |
| Delete workspace | workspace UUID plus `--local` or `--host` | explicit local when `--local` is supplied | Destructive case not executed | Require `--local`; never retry through relay |
| Open workspace | workspace UUID | desktop deep link; no `--local` option | Not executed because it opens UI | Pre-resolve exact local UUID before producing or opening the deep link |
| List agents | `--local` or `--host` | explicit local or selected host | Procedure defined | Require `--local` |
| Create agent | workspace UUID | exact ID; no `--local` option | Invalid UUID failed before creation | Pre-resolve exact local UUID; do not fall back to a remote match |
| Create terminal | workspace UUID | exact ID; no `--local` option | Invalid UUID failed before creation | Pre-resolve exact local UUID; do not fall back to a remote match |

Task CRUD is organization-scoped rather than host/workspace-scoped and is not a
local routing operation. It must not be used as evidence that workspace
resolution is local.

## Controlled procedure

The test uses an unreachable loopback proxy as a relay sink while exempting
loopback destinations. It does not stop the Superset host service, modify user
data, or require firewall changes.

```sh
export HTTPS_PROXY=http://127.0.0.1:9
export HTTP_PROXY=http://127.0.0.1:9
export ALL_PROXY=http://127.0.0.1:9
export NO_PROXY=127.0.0.1,localhost

superset status --json
superset hosts list --json
superset workspaces list --local --search '<exact-local-name>' --json
superset workspaces get '<exact-local-uuid>' --json
SUPERSET_WORKSPACE_ID=00000000-0000-0000-0000-000000000000 \
  superset workspaces get --json
superset terminals create \
  --workspace 00000000-0000-0000-0000-000000000000 \
  --command true --json
```

Expected observations:

| Command | Exit | Evidence |
| --- | ---: | --- |
| `superset status --json` | 1 | `Unable to connect` |
| `superset hosts list --json` | 1 | `Unable to connect` |
| `superset workspaces list --local --search ... --json` | 0 | Exactly one local workspace |
| `superset workspaces get '<exact-local-uuid>' --json` | 0 | Returned the requested UUID and local host ID |
| Missing workspace get | 1 | `Workspace not found on any reachable host` |
| Terminal create for missing workspace | 1 | `Workspace not found on any reachable host` and no terminal created |

The observed CLI errors are human-readable strings, not stable typed errors.
The orchestrator must normalize them into the contract below and must not use
the phrase "reachable host" as permission to select a remote host.

## Typed failure contract

Every local-only operation first resolves a workspace from a snapshot produced
by `superset workspaces list --local --json`. Resolution succeeds only when one
workspace matches the requested UUID and its `hostId` equals the local host ID.

```ts
type LocalWorkspaceResolutionFailure =
  | {
      code: "AMBIGUOUS_WORKSPACE";
      requested: string;
      candidateIds: string[];
    }
  | {
      code: "REMOTE_WORKSPACE";
      workspaceId: string;
      hostId: string;
      localHostId: string;
    }
  | {
      code: "DUPLICATE_WORKSPACE";
      requested: string;
      duplicateIds: string[];
    }
  | {
      code: "WORKSPACE_UNAVAILABLE";
      requested: string;
      cause: "NOT_FOUND" | "LOCAL_HOST_DOWN" | "LOCAL_QUERY_FAILED";
    };
```

Resolution rules:

1. UUID is the only accepted identity for mutating operations.
2. A name or branch yielding multiple candidates returns
   `AMBIGUOUS_WORKSPACE`. It never selects the first candidate.
3. Repeated records for the same logical identity return
   `DUPLICATE_WORKSPACE`, even if all records are local.
4. A known workspace on a different host returns `REMOTE_WORKSPACE` for a
   local-only request.
5. No local match, local host failure, or malformed local response returns
   `WORKSPACE_UNAVAILABLE` with the appropriate cause.
6. None of these failures triggers a cloud lookup, remote retry, workspace
   creation, agent creation, terminal creation, update, or deletion.

## Evidence and limitations

The machine had 114 local workspace records. Five records shared the name
`main`, proving that workspace name alone is not unique. Only one host was
visible, so a real remote-only workspace was not available for a non-mutating
`REMOTE_WORKSPACE` observation. Remote, ambiguous, and duplicate outcomes are
therefore contract-level cases to exercise in orchestrator unit tests once the
resolver exists, while unavailable resolution was observed directly.

Mutating success paths were intentionally not run because PER-323 is classified
as read-only research and validation. The commands and required assertions are
specified so they can be run in a disposable fixture organization without
risking user projects or workspaces.

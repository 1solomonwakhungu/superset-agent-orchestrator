# Durable storage policy

## Ownership and location

The orchestrator owns a standalone SQLite registry. It never opens, imports, copies, or derives a path from Superset Desktop's databases, manifests, logs, or temporary files. Configuration must point `OrchestratorStorage` at an orchestrator-specific path. The default deployment location should be the platform application-data directory under `superset-agent-orchestrator/registry.sqlite`, not a Superset directory.

SQLite is embedded in the supported Node runtime. The registry enables foreign keys, a five-second busy timeout, WAL journaling, and full synchronous writes. A missing dedicated registry directory is created as `0700`; a preexisting directory must already be owner-only, belong to the process's effective user where ownership is available, and is never silently chmodded. Before SQLite opens, a new registry is created as `0600`; preexisting registry and sidecar files must already belong to the effective user and be singly linked, regular, non-symlink `0600` files or startup fails without chmodding them. New SQLite sidecars are normalized and ownership-checked through no-follow file descriptors inside the private directory. Backup and export follow the same dedicated-directory and ownership rules, preventing access while SQLite or the atomic writer creates the file; completed output files are `0600`.

## Schema

Schema version 3 stores:

| Table | Durable purpose |
| --- | --- |
| `batches` | Requester, policy, status, and terminal lifecycle |
| `assignments` | Batch attribution, exact workspace, prompt, and expected output |
| `sessions` | Adapter identity, backend identity, attempt, and state |
| `results` | One attributed terminal result per session |
| `events` | Ordered, immutable lifecycle and audit history |
| `workspace_leases` | Fenced lease generation, owner process identity, state, and heartbeat |
| `workspace_fencing` | Highest writer generation ever allocated per workspace |
| `idempotency_records` | Scoped request hash and replay response |
| `schema_migrations` | Applied schema versions |

Foreign keys prevent orphaned attribution. `(assignment_id, attempt)` prevents duplicate attempts. A partial unique index mechanically prevents two non-released writers in one workspace. The fencing ledger survives cleanup and rollback so generations are never reused. Event update and delete triggers enforce append-only history.

## Migrations and rollback

Startup runs `PRAGMA quick_check` before applying migrations. Each forward migration and its migration-ledger entry run in one `BEGIN IMMEDIATE` transaction. An unknown future schema fails closed rather than being guessed or rewritten.

Forward migrations are the production path. Rollback is an operator recovery action, not an automatic startup behavior. `rollback(target, backupPath)` requires a distinct backup path, creates and integrity-checks that backup first, and rolls migrations down one transaction at a time. A failed migration or rollback retains the last committed schema. Restore the verified backup instead of attempting manual table repair.

## Retention and cleanup

Defaults are 30 days for prompt/result payloads and 7 days for idempotency records. Deployments may lengthen these periods. Legal or operational policy should disable scheduled cleanup when records must be retained.

Cleanup is transactional and conservative:

- Expired terminal assignments lose prompt and expected-output payloads.
- Expired results lose response text and artifact payloads.
- Assignment, session, result, batch, requester, workspace, timestamps, states, and stop reasons remain for attribution.
- Events are never deleted or changed.
- Released workspace leases are deleted only after the configured result-retention period. Expiry alone never releases or deletes a writer lease; reconciliation must first prove release.
- Idempotency records are deleted after their explicit expiry or configured maximum age.
- A `retention.cleanup_completed` event records cleanup counts.

Run export and backup before shortening retention. Cleanup is idempotent and never deletes an active batch or session identity.

## Export and backup

`exportJson(path)` writes an atomic, UTF-8, versioned logical export containing every table and the schema version. Exports can be inspected without SQLite and are intended for portability and support. Sensitive prompt and result payloads remain present until retention cleanup, so exports require the same access controls as the live registry.

Backup and export destinations must not already exist. This avoids overwriting or
chmodding an unrelated file and rejects hard-link aliases of the live registry
or any existing SQLite sidecar.

The operator CLI exposes both supported diagnostics without opening Superset private storage:

```sh
superset-agent-orchestrator-storage export \
  --database "$HOME/.local/share/superset-agent-orchestrator/registry.sqlite" \
  --output "$HOME/.local/share/superset-agent-orchestrator-exports/export.json"
superset-agent-orchestrator-storage integrity-check \
  --database "$HOME/.local/share/superset-agent-orchestrator/registry.sqlite"
```

Integrity checks require an already owner-only source directory, registry, and sidecars, then open the registry read-only and verify all SQLite integrity results, foreign keys, the contiguous migration ledger, and exact table, trigger, and index definitions. The command exits nonzero on any failure and never migrates, chmods, or repairs the live registry.

The permission checks prevent exposure to other operating-system users. They do
not defend against another process already running as the same user replacing
directory entries; operators must keep the dedicated directory under that
user's exclusive control and stop same-user writers before diagnostics or
recovery.

`backup(path)` checkpoints WAL, uses SQLite `VACUUM INTO` for a consistent online physical backup, and opens the result read-only to verify SQLite page integrity, foreign keys, the contiguous migration ledger, and exact canonical schema definitions. A backup never targets the live database path. Operators should keep periodic backups outside the registry directory and test restores using the exact application version that created them.

## Corruption and recovery

Startup fails closed on malformed pages, failed integrity checks, invalid schema, or migration errors. It does not delete, recreate, truncate, or silently skip the live file. Preserve the live database and its `-wal` and `-shm` companions, stop writers, copy them for investigation, then restore the newest verified backup. A logical export is a secondary recovery source. Automatic salvage is prohibited because partial recovery can break attribution or append-only history.

Do not use Superset private storage as a recovery source. Backend reconciliation must use supported adapter APIs and write normalized observations into this registry.

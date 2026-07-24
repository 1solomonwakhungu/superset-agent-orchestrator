# Durable storage policy

## Ownership and location

The orchestrator owns a standalone SQLite registry. It never opens, imports, copies, or derives a path from Superset Desktop's databases, manifests, logs, or temporary files. Configuration must point `OrchestratorStorage` at an orchestrator-specific path. The default deployment location should be the platform application-data directory under `superset-agent-orchestrator/registry.sqlite`, not a Superset directory.

SQLite is embedded in the supported Node runtime. The registry enables foreign keys, a five-second busy timeout, WAL journaling, and full synchronous writes. File creation uses owner-only directory permissions where the platform honors POSIX modes.

## Schema

Schema version 2 stores:

| Table | Durable purpose |
| --- | --- |
| `batches` | Requester, policy, status, and terminal lifecycle |
| `assignments` | Batch attribution, exact workspace, prompt, and expected output |
| `sessions` | Adapter identity, backend identity, attempt, and state |
| `results` | One attributed terminal result per session |
| `events` | Ordered, immutable lifecycle and audit history |
| `workspace_leases` | Time-bounded read or exclusive writer ownership |
| `idempotency_records` | Scoped request hash and replay response |
| `schema_migrations` | Applied schema versions |

Foreign keys prevent orphaned attribution. `(assignment_id, attempt)` prevents duplicate attempts. A partial unique index mechanically prevents two active writers in one workspace. Event update and delete triggers enforce append-only history.

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
- Expired or released workspace leases are deleted.
- Idempotency records are deleted after their explicit expiry or configured maximum age.
- A `retention.cleanup_completed` event records cleanup counts.

Run export and backup before shortening retention. Cleanup is idempotent and never deletes an active batch or session identity.

## Export and backup

`exportJson(path)` writes an atomic, UTF-8, versioned logical export containing every table and the schema version. Exports can be inspected without SQLite and are intended for portability and support. Sensitive prompt and result payloads remain present until retention cleanup, so exports require the same access controls as the live registry.

`backup(path)` checkpoints WAL, uses SQLite `VACUUM INTO` for a consistent online physical backup, and opens the result read-only for `PRAGMA integrity_check`. A backup never targets the live database path. Operators should keep periodic backups outside the registry directory and test restores using the exact application version that created them.

## Corruption and recovery

Startup fails closed on malformed pages, failed integrity checks, invalid schema, or migration errors. It does not delete, recreate, truncate, or silently skip the live file. Preserve the live database and its `-wal` and `-shm` companions, stop writers, copy them for investigation, then restore the newest verified backup. A logical export is a secondary recovery source. Automatic salvage is prohibited because partial recovery can break attribution or append-only history.

Do not use Superset private storage as a recovery source. Backend reconciliation must use supported adapter APIs and write normalized observations into this registry.

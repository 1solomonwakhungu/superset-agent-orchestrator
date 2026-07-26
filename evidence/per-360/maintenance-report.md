# PER-360 maintenance report

Date: 2026-07-26

## Result

- Free disk space increased from 437.0 GiB to 453.5 GiB during the cleanup run.
- The measured increase in free space was 16.5 GiB.
- Seven known package-cache paths under the uv and npm caches were removed.
- Docker cleanup ran with `docker system prune -f` and no Docker command error was
  reported.
- Zero Downloads entries were old enough to move to Trash.
- 94 age-qualified operating-system temporary paths could not be removed because
  macOS returned `Permission denied` or `Operation not permitted`; they remain in
  place and no privilege escalation was attempted.
- Four transient runtime paths disappeared between enumeration and removal.

## Safety boundaries

- `~/Documents/Hermes/artifacts/overnight_task_queue.json` was valid JSON, current,
  and left unchanged.
- Hermes artifacts, skills, profiles, configuration, uploads, and worktrees were not
  deleted.
- Trash was not emptied because its contents were not manually classified as safe
  to delete.
- Broad `~/Library/Caches` deletion was not attempted; only known build/package
  caches were eligible.
- LM Studio models were measured at 19.0 GiB and left unchanged.
- The mounted `Nimbalyst 0.70.5-arm64` disk image was not detached because installer
  contents could not be conclusively verified. The system volume was not touched.

## Verification

- The preflight dry run reported 105 candidates totaling 25.5 MiB, zero errors,
  zero old Downloads, and no conclusively verified installer image.
- The execute run reported seven removals, zero Downloads moves, zero image ejects,
  and the permission-protected paths described above.
- A post-run dry run completed with zero errors and 442 bytes of accessible removal
  candidates; protected paths remain visible but inaccessible.
- Post-run volume inspection showed only the system volume and the skipped Nimbalyst
  disk image.

The execute command returns a nonzero status when any candidate cannot be removed.
The 94 failures were permission-protected macOS paths; the report does not count
them as removed and no attempt was made to override operating-system protections.

# PER-363 maintenance report

Date: 2026-07-26

## Result

- Free disk space increased from 431.1 GiB to 438.0 GiB.
- The conservative cleanup reclaimed 6.9 GiB.
- 784 stale temporary, overnight log, and known build/package cache paths were removed.
- 104 protected operating-system paths could not be removed because macOS returned
  `Permission denied` or `Operation not permitted`; they were left in place and no
  privilege escalation was attempted.
- Four runtime paths disappeared between enumeration and removal, which is expected
  for active sockets and temporary files.

## Safety boundaries

- `~/Documents/Hermes/artifacts/overnight_task_queue.json` was valid JSON, current,
  and left unchanged.
- Hermes artifacts, skills, profiles, configuration, uploads, and worktrees were not
  deleted.
- Downloads were not moved, Trash was not emptied, Docker was not pruned, and no
  mounted image was detached because those actions require explicit opt-in flags.
- Broad `~/Library/Caches` deletion was not attempted; only known build/package
  caches were eligible.
- LM Studio models were measured at 19.0 GiB and left unchanged.

## Verification

- `python3 -m unittest -v`: 16 tests passed.
- `python3 cleanup.py`: dry run completed with 892 proposed paths and zero errors.
- `python3 cleanup.py --execute`: completed the bounded cleanup described above.

The execute command returns a nonzero status when any candidate cannot be removed.
The 104 failures were exclusively permission-protected macOS paths; the report does
not treat them as removed or as reclaimed space.

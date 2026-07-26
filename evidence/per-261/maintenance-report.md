# PER-261 maintenance report

Date: 2026-07-26

## Result

- Free disk space remained 454.3 GiB at one-decimal precision.
- The conservative cleanup reclaimed 112.0 KiB.
- Three npm cache trees were removed: `_cacache/content-v2`, `_cacache/tmp`,
  and `_cacache/index-v5`.
- An immediate second execute run removed zero paths and reclaimed zero bytes,
  confirming the bounded cleanup is idempotent.
- 105 stale operating-system paths could not be removed because macOS returned
  `Permission denied` or `Operation not permitted`; they were left in place and
  no privilege escalation was attempted.
- Four active socket paths disappeared between enumeration and removal and were
  reported as skipped rather than removed.

## Safety boundaries

- `~/Documents/Hermes/artifacts/overnight_task_queue.json` was valid JSON,
  current, and left unchanged.
- Hermes artifacts, skills, profiles, configuration, uploads, and worktrees were
  not deleted.
- Downloads were not moved, Trash was not emptied, Docker was not pruned, and no
  mounted image was detached because those actions require explicit opt-in flags.
- Broad `~/Library/Caches` deletion was not attempted; only known build/package
  caches were eligible.
- LM Studio models were measured at 19.0 GiB and left unchanged.

## Verification

- `python3 -m unittest -v`: 16 tests passed.
- `python3 cleanup.py`: dry run completed with 112 proposed paths, 128.2 KiB of
  candidates, and zero errors.
- `python3 cleanup.py --execute`: removed three cache trees and reclaimed 112.0
  KiB; its nonzero exit represented only protected-path removal failures.
- A second `python3 cleanup.py --execute` removed zero paths; its nonzero exit
  again represented only the same 105 protected paths.

The execute command returns a nonzero status when any candidate cannot be
removed. The 105 failures were exclusively permission-protected macOS paths;
the report does not treat them as removed or as reclaimed space.

# macOS Cleanup

`cleanup.py` inventories and removes stale temporary files and selected development caches. It is deliberately a dry-run unless `--execute` is supplied.

```sh
python3 cleanup.py
python3 cleanup.py --execute
```

Potentially destructive or disruptive operations require separate flags:

```sh
python3 cleanup.py --execute --include-downloads
python3 cleanup.py --execute --empty-trash
python3 cleanup.py --execute --docker-prune
python3 cleanup.py --execute --eject-installers
```

Review dry-run output before execution. Downloads are moved to Trash, not deleted. Broad `~/Library/Caches` deletion is intentionally excluded; only known build and package cache directories are cleaned. The Hermes task queue is validated and reported but not rewritten because its schema and archival semantics are not defined here. LM Studio model locations are measured but never removed.

Disk images are eligible for detachment only when `hdiutil` identifies a mounted image backed by a `.dmg` file smaller than 5 GiB and the volume contains a top-level `.app` or `.pkg`. Ambiguous images are reported and skipped. Physical external drives are never considered by this logic.

Run the tests with:

```sh
python3 -m unittest -v
```

The utility has no runtime dependencies beyond Python 3.9+ and standard macOS command-line tools. Optional development checks use Ruff and mypy:

```sh
ruff check cleanup.py test_cleanup.py
mypy --strict cleanup.py test_cleanup.py
```

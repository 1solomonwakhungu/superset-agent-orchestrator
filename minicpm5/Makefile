.PHONY: sync sync-mlx test capture fingerprint report diff-report

sync:
	uv sync --frozen

sync-mlx:
	uv sync --frozen --extra macos-mlx

test:
	uv run --frozen pytest

capture:
	./scripts/run_capture.sh

fingerprint:
	./scripts/run_fingerprint.sh

report:
	uv run --frozen python scripts/report_result.py $(INPUT) --output-dir $(OUTPUT)

diff-report:
	uv run --frozen python scripts/diff_results.py $(LEFT) $(RIGHT)

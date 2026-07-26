.PHONY: sync sync-mlx test capture fingerprint

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

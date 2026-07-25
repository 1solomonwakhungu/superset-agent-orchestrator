.PHONY: sync sync-mlx test capture fingerprint

sync:
	uv sync --frozen

sync-mlx:
	uv sync --frozen --extra macos-mlx

test:
	uv run --frozen pytest

capture:
	uv run --frozen python scripts/capture_env.py

fingerprint:
	uv run --frozen python scripts/logit_fingerprint.py

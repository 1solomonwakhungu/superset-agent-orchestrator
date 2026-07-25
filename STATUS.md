# Status

## Completed

- Added a uv 0.8.3 lock for Python 3.12 across Linux x86-64 and macOS arm64.
- Pinned MiniCPM5-1B, llama.cpp, MLX, container bases, and Python dependencies.
- Added deterministic eight-token logit fingerprint and cross-platform capture.
- Added Linux CPU container and native Apple Silicon setup documentation.

## Verification

- Two independent frozen installs produced identical 29-line manifests.
- Two full MiniCPM5-1B runs produced SHA256 `869e1202f1c042e479ded488fbefc7fd14d83abcb74ff4eeac860b6bdf8e2c45`.
- Unit tests: 2 passed.
- Native MLX import: 0.29.0.

## Remaining

- Execute the Docker build on a host with a running Docker daemon. This host's
  Docker socket was unavailable; remote base manifests were verified instead.

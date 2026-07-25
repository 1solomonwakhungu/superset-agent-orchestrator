# MiniCPM5-1B Reproducible Baseline

This repository pins the software and model inputs for same-hardware
reproducibility experiments with `openbmb/MiniCPM5-1B`.

## Pinned Inputs

- Model: `openbmb/MiniCPM5-1B`
- Model revision: `4e9de7a0778dc1c362e983e6858f0e77542cbdca`
- Python: `3.12.*`
- uv: `0.8.3`
- Python resolution and artifact hashes: `uv.lock`
- llama.cpp and MLX source revisions: `toolchains.lock`

The model revision was resolved from the Hugging Face model API. A revision
pin identifies files, but does not by itself establish model quality,
performance, or architectural research claims.

## Linux CPU

Use x86-64 Linux or build the image explicitly for it:

```sh
docker build --platform linux/amd64 -t minicpm5-baseline:cpu .
docker run --rm --platform linux/amd64 minicpm5-baseline:cpu \
  python scripts/capture_env.py
```

For a native install, install uv 0.8.3 and run:

```sh
uv sync --frozen
```

## Apple Silicon and MLX

Containers do not expose the Apple GPU. On arm64 macOS, install Xcode Command
Line Tools, Python 3.12, and uv 0.8.3, then run:

```sh
xcode-select --install # omit when already installed
uv sync --frozen --extra macos-mlx
```

The Python MLX wheels are version-locked in `uv.lock`. For experiments that
modify or compile MLX itself, clone `MLX_REPOSITORY` and check out the exact
`MLX_COMMIT` in `toolchains.lock`. Record Xcode and macOS versions in the
experiment record because native compiler and framework versions affect bits.

For llama.cpp, clone its repository, check out `LLAMA_CPP_COMMIT`, and record
all CMake flags. A GGUF conversion is a distinct artifact and must record the
source checkpoint revision, conversion command, quantization, and output hash.

## Fingerprint Protocol

Download/cache the pinned checkpoint and run twice on one hardware class:

```sh
scripts/run_fingerprint.sh > artifacts/run-1.json
scripts/run_fingerprint.sh --local-files-only > artifacts/run-2.json
diff -u artifacts/run-1.json artifacts/run-2.json
```

The script uses a fixed sequence of exactly eight token IDs, disables cache and
sampling, runs float32 inference with one intra-op and inter-op thread, and
hashes all logits after canonical little-endian float32 serialization. A clean
diff verifies repeatability for that host and software stack.

Bitwise identity is only an acceptance target within the same hardware class.
It is not assumed across CPU models, BLAS implementations, operating systems,
PyTorch and MLX, or quantization formats. Cross-backend comparisons must store
raw outputs and report explicit numeric tolerances such as maximum absolute and
relative error; they must not substitute a matching SHA256 requirement.

## Lock Reproducibility

Two independent environments should produce identical package manifests:

```sh
UV_PROJECT_ENVIRONMENT=.venv-a uv sync --frozen
UV_PROJECT_ENVIRONMENT=.venv-b uv sync --frozen
uv pip freeze --python .venv-a/bin/python | LC_ALL=C sort > /tmp/freeze-a.txt
uv pip freeze --python .venv-b/bin/python | LC_ALL=C sort > /tmp/freeze-b.txt
diff -u /tmp/freeze-a.txt /tmp/freeze-b.txt
```

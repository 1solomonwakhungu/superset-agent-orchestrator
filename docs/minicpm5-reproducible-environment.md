# MiniCPM5-1B Reproducible Baseline

The `minicpm5/` project pins software and model inputs for same-hardware
reproducibility experiments with `openbmb/MiniCPM5-1B`.

## Pinned Inputs

- Model: `openbmb/MiniCPM5-1B`
- Model revision: `4e9de7a0778dc1c362e983e6858f0e77542cbdca`
- Python: `3.12.*`
- uv: `0.8.3`
- Python resolution and artifact hashes: `minicpm5/uv.lock`
- llama.cpp and MLX source revisions: `minicpm5/toolchains.lock`

The model revision was resolved from the Hugging Face model API. A revision pin
does not establish model quality, performance, or architectural claims.

## Linux CPU

```sh
docker build --platform linux/amd64 -f minicpm5/Dockerfile -t minicpm5-baseline:cpu .
docker run --rm --platform linux/amd64 minicpm5-baseline:cpu python scripts/capture_env.py
```

For a native install, install uv 0.8.3 and run `uv sync --project minicpm5
--frozen`.

## Apple Silicon and MLX

Containers do not expose the Apple GPU. On arm64 macOS, install Xcode Command
Line Tools, Python 3.12, and uv 0.8.3, then run:

```sh
uv sync --project minicpm5 --frozen --extra macos-mlx
```

The Python MLX wheels are version-locked. Experiments that compile MLX or
llama.cpp must check out the exact commit in `toolchains.lock` and record build
flags. A GGUF conversion must record its source checkpoint, conversion command,
quantization, and output hash.

## Fingerprint Protocol

From `minicpm5/`, download/cache the pinned checkpoint and run twice:

```sh
mkdir -p artifacts
scripts/run_fingerprint.sh > artifacts/run-1.json
scripts/run_fingerprint.sh --local-files-only > artifacts/run-2.json
diff -u artifacts/run-1.json artifacts/run-2.json
```

The script uses eight fixed token IDs, disables cache and sampling, runs
float32 inference with one intra-op and inter-op thread, and hashes all logits
after canonical little-endian float32 serialization.

Bitwise identity is an acceptance target only within the same hardware class.
Cross-CPU, BLAS, OS, PyTorch, MLX, and quantization comparisons must store raw
outputs and report explicit maximum absolute and relative error tolerances.

## Lock Reproducibility

From `minicpm5/`:

```sh
UV_PROJECT_ENVIRONMENT=.venv-a uv sync --frozen
UV_PROJECT_ENVIRONMENT=.venv-b uv sync --frozen
uv pip freeze --python .venv-a/bin/python | LC_ALL=C sort > /tmp/freeze-a.txt
uv pip freeze --python .venv-b/bin/python | LC_ALL=C sort > /tmp/freeze-b.txt
diff -u /tmp/freeze-a.txt /tmp/freeze-b.txt
```

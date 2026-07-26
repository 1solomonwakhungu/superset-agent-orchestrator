# syntax=docker/dockerfile:1.7
FROM ghcr.io/astral-sh/uv:0.8.3@sha256:88baae1f9fa298996f8313e44559163c535937406d217f1c8ac9d4b86a2020fd AS uv
FROM python:3.12.11-slim-bookworm@sha256:c00fc7b44d844b6da22861ec24af43968a5200eac4ec607b4725d585165d6b49

ENV PYTHONHASHSEED=0 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    VECLIB_MAXIMUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    TOKENIZERS_PARALLELISM=false \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY --from=uv /uv /uvx /bin/
WORKDIR /workspace
COPY minicpm5/pyproject.toml minicpm5/uv.lock minicpm5/.python-version ./
RUN uv sync --frozen --no-dev \
    && useradd --create-home --uid 10001 baseline
COPY minicpm5/scripts/ scripts/
COPY minicpm5/env/ env/
USER baseline
ENTRYPOINT ["uv", "run", "--frozen", "--no-sync"]
CMD ["python", "scripts/logit_fingerprint.py"]

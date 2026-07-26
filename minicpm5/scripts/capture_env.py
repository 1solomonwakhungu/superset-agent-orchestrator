#!/usr/bin/env python3
"""Capture reproducibility-relevant host and software facts as Markdown."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.metadata
import os
import platform
import shutil
import subprocess
from pathlib import Path

THREAD_ENV_VARS = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "PYTHONHASHSEED",
    "TOKENIZERS_PARALLELISM",
)


def command(*args: str) -> str:
    if not shutil.which(args[0]):
        return "unavailable"
    try:
        return subprocess.run(
            args, check=True, capture_output=True, text=True, timeout=10
        ).stdout.strip() or "unavailable"
    except (OSError, subprocess.SubprocessError):
        return "unavailable"


def cpu_model() -> str:
    if platform.system() == "Darwin":
        return command("sysctl", "-n", "machdep.cpu.brand_string")
    path = Path("/proc/cpuinfo")
    if path.exists():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.lower().startswith("model name") and ":" in line:
                    return line.split(":", 1)[1].strip() or "unavailable"
        except (OSError, UnicodeError):
            return "unavailable"
    return platform.processor() or "unavailable"


def ram_bytes() -> str:
    if platform.system() == "Darwin":
        return command("sysctl", "-n", "hw.memsize")
    path = Path("/proc/meminfo")
    if path.exists():
        try:
            first = path.read_text(encoding="utf-8").splitlines()[0].split()
            return str(int(first[1]) * 1024)
        except (OSError, UnicodeError, IndexError, ValueError):
            return "unavailable"
    return "unavailable"


def blas_info() -> str:
    try:
        import numpy as np

        config = np.__config__.CONFIG
        return str(config.get("Build Dependencies", {}).get("blas", "unavailable"))
    except (ImportError, AttributeError):
        return "unavailable"


def package_versions() -> list[str]:
    names = ("huggingface-hub", "mlx", "mlx-lm", "numpy", "safetensors", "torch", "transformers")
    versions = []
    for name in names:
        try:
            versions.append(f"- `{name}=={importlib.metadata.version(name)}`")
        except importlib.metadata.PackageNotFoundError:
            versions.append(f"- `{name}`: not installed")
    versions.append(f"- uv executable: `{command('uv', '--version')}`")
    return versions


def render() -> str:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    lines = [
        "# Environment Capture",
        "",
        f"- Captured UTC: `{now}`",
        f"- OS: `{platform.platform()}`",
        f"- Kernel: `{platform.release()}`",
        f"- Architecture: `{platform.machine()}`",
        f"- CPU: `{cpu_model()}`",
        f"- Logical cores: `{os.cpu_count() or 'unavailable'}`",
        f"- RAM bytes: `{ram_bytes()}`",
        f"- Python: `{platform.python_version()}`",
        f"- BLAS: `{blas_info()}`",
        "",
        "## Thread Environment",
        "",
    ]
    lines.extend(f"- `{name}={os.environ.get(name, 'unset')}`" for name in THREAD_ENV_VARS)
    lines.extend(["", "## Libraries", "", *package_versions(), ""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="write capture to this path")
    args = parser.parse_args()
    capture = render()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(capture, encoding="utf-8")
    else:
        print(capture, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

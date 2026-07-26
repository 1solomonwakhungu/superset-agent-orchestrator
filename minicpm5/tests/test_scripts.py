from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import numpy as np
import torch


def load_script(name: str):
    path = Path(__file__).parents[1] / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_fingerprint_uses_canonical_float32_bytes() -> None:
    script = load_script("logit_fingerprint.py")
    tensor = torch.tensor([[1.0, -2.5]], dtype=torch.float64)

    expected = __import__("hashlib").sha256(np.array([[1.0, -2.5]], dtype="<f4").tobytes()).hexdigest()
    assert script.fingerprint_logits(tensor) == expected


def test_capture_contains_required_host_fields(monkeypatch) -> None:
    script = load_script("capture_env.py")
    monkeypatch.setenv("OMP_NUM_THREADS", "1")

    capture = script.render()

    for field in ("OS", "Kernel", "Architecture", "CPU", "Logical cores", "RAM bytes", "BLAS"):
        assert f"- {field}:" in capture
    assert "`OMP_NUM_THREADS=1`" in capture
    assert "`torch==" in capture


def test_capture_tolerates_unreadable_proc_files(monkeypatch) -> None:
    script = load_script("capture_env.py")
    monkeypatch.setattr(script.platform, "system", lambda: "Linux")
    monkeypatch.setattr(script.Path, "exists", lambda _path: True)
    monkeypatch.setattr(
        script.Path, "read_text", lambda _path, **_kwargs: (_ for _ in ()).throw(OSError())
    )

    assert script.cpu_model() == "unavailable"
    assert script.ram_bytes() == "unavailable"


def test_fingerprint_wrapper_sets_deterministic_environment(tmp_path) -> None:
    project = Path(__file__).parents[1]
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_uv = fake_bin / "uv"
    fake_uv.write_text(
        "#!/bin/sh\n"
        "test \"$OMP_NUM_THREADS,$MKL_NUM_THREADS,$OPENBLAS_NUM_THREADS,"
        "$VECLIB_MAXIMUM_THREADS,$NUMEXPR_NUM_THREADS,$PYTHONHASHSEED,"
        "$TOKENIZERS_PARALLELISM\" = \"1,1,1,1,1,0,false\"\n"
        "test \"$*\" = \"run --frozen python scripts/logit_fingerprint.py "
        "--local-files-only\"\n",
        encoding="utf-8",
    )
    fake_uv.chmod(0o755)

    completed = subprocess.run(
        ["/bin/sh", "scripts/run_fingerprint.sh", "--local-files-only"],
        cwd=project,
        env={"PATH": str(fake_bin)},
        check=False,
    )

    assert completed.returncode == 0

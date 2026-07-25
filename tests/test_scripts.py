from __future__ import annotations

import importlib.util
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

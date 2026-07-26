#!/usr/bin/env python3
"""Hash deterministic MiniCPM5 logits for same-host reproducibility checks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

MODEL_ID = "openbmb/MiniCPM5-1B"
MODEL_REVISION = "4e9de7a0778dc1c362e983e6858f0e77542cbdca"
# Token IDs are used directly so the fingerprint input remains exactly eight tokens.
PROMPT_TOKEN_IDS = [1, 734, 310, 6324, 338, 263, 1781, 29973]
THREAD_ENV_VARS = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)


def _configure_determinism(torch_module: object) -> None:
    torch_module.set_num_threads(1)
    torch_module.set_num_interop_threads(1)
    torch_module.use_deterministic_algorithms(True)
    for variable in THREAD_ENV_VARS:
        if os.environ.get(variable) != "1":
            raise RuntimeError(f"{variable}=1 is required; use scripts/run_fingerprint.sh")


def fingerprint_logits(logits: object) -> str:
    """Return a portable hash after canonicalizing logits to LE float32."""
    array = logits.detach().to(dtype=__import__("torch").float32).cpu().numpy()
    canonical = array.astype("<f4", copy=False).tobytes(order="C")
    return hashlib.sha256(canonical).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local-files-only", action="store_true")
    args = parser.parse_args()

    import torch
    from transformers import AutoModelForCausalLM

    _configure_determinism(torch)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=args.local_files_only,
        torch_dtype=torch.float32,
    )
    model.eval()
    input_ids = torch.tensor([PROMPT_TOKEN_IDS], dtype=torch.long)
    with torch.inference_mode():
        logits = model(input_ids=input_ids, use_cache=False).logits

    result = {
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "prompt_token_ids": PROMPT_TOKEN_IDS,
        "dtype": "float32",
        "shape": list(logits.shape),
        "sha256": fingerprint_logits(logits),
    }
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"fingerprint failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error

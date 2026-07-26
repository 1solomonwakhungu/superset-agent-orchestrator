#!/usr/bin/env python3
"""Generate deterministic, provenance-complete baseline reports."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
REQUIRED_PROVENANCE = (
    "checkpoint_sha",
    "environment_fingerprint",
    "corpus_hash",
    "harness_commit",
    "decode_config",
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":"))


def normalize(value: Any, precision: int) -> Any:
    if isinstance(value, dict):
        return {key: normalize(item, precision) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize(item, precision) for item in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("result contains a non-finite number")
        rounded = round(value, precision)
        return 0.0 if rounded == 0 else rounded
    return value


def build_report(source: dict[str, Any], precision: int) -> tuple[dict[str, Any], str]:
    if not isinstance(source.get("provenance"), dict):
        raise ValueError("input must contain a provenance object")
    if not isinstance(source.get("results"), dict):
        raise ValueError("input must contain a results object")
    missing = [key for key in REQUIRED_PROVENANCE if key not in source["provenance"]]
    if missing:
        raise ValueError(f"missing provenance fields: {', '.join(missing)}")

    payload = {
        "schema_version": SCHEMA_VERSION,
        "provenance": normalize(source["provenance"], precision),
        "results": normalize(source["results"], precision),
    }
    fingerprint = hashlib.sha256(canonical_json(payload).encode()).hexdigest()
    return {**payload, "result_fingerprint": fingerprint}, fingerprint


def render_markdown(report: dict[str, Any]) -> str:
    provenance = report["provenance"]
    rows = "\n".join(
        f"| {key.replace('_', ' ').title()} | `{canonical_json(provenance[key])}` |"
        for key in REQUIRED_PROVENANCE
    )
    return (
        "# Baseline Result\n\n"
        f"**RESULT fingerprint:** `{report['result_fingerprint']}`\n\n"
        "## Provenance\n\n| Field | Value |\n| --- | --- |\n"
        f"{rows}\n\n## Canonical Results\n\n```json\n"
        f"{json.dumps(report['results'], ensure_ascii=True, sort_keys=True, indent=2)}\n```\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="evaluation result JSON")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--name", default="baseline")
    parser.add_argument("--float-precision", type=int, default=8)
    args = parser.parse_args()
    if not 0 <= args.float_precision <= 15:
        parser.error("--float-precision must be between 0 and 15")

    source = json.loads(args.input.read_text(encoding="utf-8"))
    report, fingerprint = build_report(source, args.float_precision)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / f"{args.name}.json").write_text(
        json.dumps(report, ensure_ascii=True, allow_nan=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.output_dir / f"{args.name}.md").write_text(render_markdown(report), encoding="utf-8")
    (args.output_dir / "RESULT.fingerprint").write_text(fingerprint + "\n", encoding="ascii")
    print(fingerprint)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

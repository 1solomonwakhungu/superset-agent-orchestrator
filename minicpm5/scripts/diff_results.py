#!/usr/bin/env python3
"""Explain differences between two canonical baseline reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def differences(left: Any, right: Any, path: str = "$") -> list[str]:
    if type(left) is not type(right):
        return [f"{path}: type {type(left).__name__} -> {type(right).__name__}"]
    if isinstance(left, dict):
        output = []
        for key in sorted(left.keys() | right.keys()):
            child = f"{path}.{key}"
            if key not in left:
                output.append(f"{child}: added {right[key]!r}")
            elif key not in right:
                output.append(f"{child}: removed {left[key]!r}")
            else:
                output.extend(differences(left[key], right[key], child))
        return output
    if isinstance(left, list):
        output = []
        for index in range(max(len(left), len(right))):
            child = f"{path}[{index}]"
            if index >= len(left):
                output.append(f"{child}: added {right[index]!r}")
            elif index >= len(right):
                output.append(f"{child}: removed {left[index]!r}")
            else:
                output.extend(differences(left[index], right[index], child))
        return output
    return [] if left == right else [f"{path}: {left!r} -> {right!r}"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("left", type=Path)
    parser.add_argument("right", type=Path)
    args = parser.parse_args()
    left = json.loads(args.left.read_text(encoding="utf-8"))
    right = json.loads(args.right.read_text(encoding="utf-8"))
    changed = differences(left, right)
    if not changed:
        print("identical")
        return 0
    print("\n".join(changed))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Materialize the versioned counter-v1 long-context lexical-token stream."""

from __future__ import annotations

import argparse


def materialize(target_tokens: int, seed: int, sentinel: str, expected: str) -> str:
    """Return exactly target_tokens space-delimited ASCII lexical tokens.

    The sentinel and expected value occupy the final two positions. Model-specific
    tokenizer counts must be measured and recorded by the evaluation harness.
    """
    if target_tokens < 2:
        raise ValueError("target_tokens must be at least 2")
    if seed < 0 or not sentinel or not expected or any(" " in x for x in (sentinel, expected)):
        raise ValueError("seed and sentinel fields are invalid")
    filler = (f"c{seed:x}-{index:x}" for index in range(target_tokens - 2))
    return " ".join((*filler, sentinel, expected))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-tokens", type=int, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--sentinel", required=True)
    parser.add_argument("--expected", required=True)
    args = parser.parse_args()
    print(materialize(args.target_tokens, args.seed, args.sentinel, args.expected))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Score one PER-365 corpus response against its frozen gold or verifier."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


CORPUS_FILES = (
    "reasoning.jsonl",
    "code.jsonl",
    "tool-use.jsonl",
    "long-context.jsonl",
    "determinism.jsonl",
)


class VerificationError(ValueError):
    """Raised when a response or executable verifier cannot be evaluated."""


def load_item(corpus_dir: Path, item_id: str) -> dict[str, Any]:
    matches = []
    for filename in CORPUS_FILES:
        for line in (corpus_dir / filename).read_text(encoding="utf-8").splitlines():
            item = json.loads(line)
            if item["id"] == item_id:
                matches.append(item)
    if len(matches) != 1:
        raise VerificationError(f"expected exactly one corpus item with id {item_id!r}")
    return matches[0]


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _score_tool_calls(response: str, gold: dict[str, Any]) -> bool:
    try:
        submitted = json.loads(response)
    except json.JSONDecodeError as error:
        raise VerificationError(f"tool response is not valid JSON: {error}") from error
    calls = submitted.get("calls") if isinstance(submitted, dict) else submitted
    if not isinstance(calls, list):
        raise VerificationError("tool response must be a calls array or an object containing calls")
    expected = gold["calls"]
    if gold["independent_calls_may_commute"]:
        return sorted(map(_canonical, calls)) == sorted(map(_canonical, expected))
    return calls == expected


def _run_code(item: dict[str, Any], candidate: Path) -> bool:
    verifier = item["verifier"]
    timeout = item["metadata"]["timeout_seconds"]
    payload = json.dumps(
        {"entrypoint": verifier["entrypoint"], "cases": verifier["cases"]},
        separators=(",", ":"),
    )
    if verifier["type"] == "python-unittest":
        runner = """import importlib.util,json,sys
p=json.loads(sys.argv[2]); s=importlib.util.spec_from_file_location('candidate',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); f=getattr(m,p['entrypoint'])
for c in p['cases']:
 try: value=f(*c['args'])
 except Exception as e:
  if e.__class__.__name__!=c.get('raises'): raise
  continue
 if 'raises' in c or value!=c['returns']: raise AssertionError((value,c))
"""
        command = [sys.executable, "-I", "-c", runner, str(candidate), payload]
    elif verifier["type"] == "javascript-cases":
        runner = """const {pathToFileURL}=require('node:url');(async()=>{const p=JSON.parse(process.argv[2]),m=await import(pathToFileURL(process.argv[1])),f=m[p.entrypoint];if(typeof f!=='function')throw Error('entrypoint is not a function');for(const c of p.cases){const args=c.args.map(v=>v==='parity'?(n=>n%2?'odd':'even'):v);let value;try{value=await f(...args)}catch(e){if(e.constructor.name!==c.raises)throw e;continue}if(c.raises!==undefined||JSON.stringify(value instanceof Map?[...value]:value)!==JSON.stringify(c.returns))throw Error('case failed')}})().catch(e=>{console.error(e);process.exit(1)})"""
        command = ["node", "-e", runner, str(candidate), payload]
    else:
        raise VerificationError(f"unsupported code verifier {verifier['type']!r}")
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise VerificationError(f"candidate exceeded {timeout}-second timeout") from error
    if completed.returncode not in (0, 1):
        raise VerificationError(completed.stderr.strip() or "code verifier could not run")
    return completed.returncode == 0


def score_item(item: dict[str, Any], response: str | None = None, candidate: Path | None = None) -> bool:
    evidence = item.get("gold") or item.get("verifier")
    evidence_type = evidence["type"]
    if evidence_type in {"python-unittest", "javascript-cases"}:
        if candidate is None:
            raise VerificationError("code items require --candidate")
        return _run_code(item, candidate)
    if response is None:
        raise VerificationError("non-code items require --response or --response-file")
    if evidence_type == "exact":
        return response.strip() == evidence["value"]
    if evidence_type == "json-semantic":
        try:
            return json.loads(response) == evidence["value"]
        except json.JSONDecodeError:
            return False
    if evidence_type == "generated-sentinel":
        return response.strip() == evidence["expected"]
    if evidence_type == "tool-call-sequence":
        return _score_tool_calls(response, evidence)
    raise VerificationError(f"unsupported evidence type {evidence_type!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("item_id")
    parser.add_argument("--corpus-dir", type=Path, default=Path(__file__).resolve().parents[1] / "corpus")
    response_group = parser.add_mutually_exclusive_group()
    response_group.add_argument("--response")
    response_group.add_argument("--response-file", type=Path)
    response_group.add_argument("--candidate", type=Path)
    args = parser.parse_args()
    response = args.response
    if args.response_file is not None:
        response = args.response_file.read_text(encoding="utf-8")
    try:
        passed = score_item(load_item(args.corpus_dir, args.item_id), response, args.candidate)
    except (OSError, VerificationError, json.JSONDecodeError) as error:
        parser.exit(2, f"verification error: {error}\n")
    print("pass" if passed else "fail")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

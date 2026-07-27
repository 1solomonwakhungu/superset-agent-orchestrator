#!/usr/bin/env python3
"""Validate the frozen PER-365 regression corpus without external dependencies."""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import re
from pathlib import Path
from typing import Any


CORPUS_FILES = (
    "reasoning.jsonl",
    "code.jsonl",
    "tool-use.jsonl",
    "long-context.jsonl",
    "determinism.jsonl",
)
NORMATIVE_ASSETS = (
    "corpus/DATASHEET.md",
    "scripts/materialize_long_context.py",
    "scripts/validate_corpus.py",
    "scripts/verify_corpus_output.py",
)
DOMAINS = {name.removesuffix(".jsonl") for name in CORPUS_FILES}
DIFFICULTIES = {"easy", "medium", "hard"}
LICENSES = {"CC0-1.0", "MIT"}
ITEM_FIELDS = {
    "schema_version",
    "id",
    "domain",
    "difficulty",
    "tags",
    "split",
    "prompt",
    "source",
    "license",
    "gold",
    "verifier",
    "metadata",
}
REQUIRED_FIELDS = ITEM_FIELDS - {"gold", "verifier"}


class CorpusValidationError(ValueError):
    """Raised when corpus content or provenance is invalid."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _object(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CorpusValidationError(f"{context}: expected an object")
    return value


def _closed(value: Any, required: set[str], context: str) -> dict[str, Any]:
    result = _object(value, context)
    if set(result) != required:
        raise CorpusValidationError(
            f"{context}: fields must be exactly {sorted(required)}"
        )
    return result


def _non_empty_string(value: Any, context: str) -> None:
    if not isinstance(value, str) or not value:
        raise CorpusValidationError(f"{context}: expected a non-empty string")


def _validate_evidence(evidence: dict[str, Any], context: str) -> None:
    evidence_type = evidence.get("type")
    if evidence_type == "exact":
        value = _closed(evidence, {"type", "value"}, context)["value"]
        _non_empty_string(value, f"{context}.value")
    elif evidence_type == "json-semantic":
        _closed(evidence, {"type", "value"}, context)
    elif evidence_type in {"python-unittest", "javascript-cases"}:
        typed = _closed(evidence, {"type", "entrypoint", "cases"}, context)
        _non_empty_string(typed["entrypoint"], f"{context}.entrypoint")
        if not isinstance(typed["cases"], list) or not typed["cases"]:
            raise CorpusValidationError(f"{context}.cases: expected a non-empty list")
        for index, case_value in enumerate(typed["cases"]):
            case = _object(case_value, f"{context}.cases[{index}]")
            if set(case) not in ({"args", "returns"}, {"args", "raises"}):
                raise CorpusValidationError(f"{context}.cases[{index}]: invalid fields")
            if not isinstance(case["args"], list):
                raise CorpusValidationError(f"{context}.cases[{index}].args: expected a list")
            if "raises" in case:
                _non_empty_string(case["raises"], f"{context}.cases[{index}].raises")
    elif evidence_type == "generated-sentinel":
        typed = _closed(
            evidence,
            {"type", "generator", "target_tokens", "seed", "sentinel", "expected"},
            context,
        )
        if typed["generator"] != "counter-v1":
            raise CorpusValidationError(f"{context}.generator: unsupported generator")
        if not isinstance(typed["target_tokens"], int) or typed["target_tokens"] < 2:
            raise CorpusValidationError(f"{context}.target_tokens: invalid count")
        if not isinstance(typed["seed"], int) or typed["seed"] < 0:
            raise CorpusValidationError(f"{context}.seed: invalid seed")
        for field in ("sentinel", "expected"):
            _non_empty_string(typed[field], f"{context}.{field}")
            if " " in typed[field]:
                raise CorpusValidationError(f"{context}.{field}: spaces are not allowed")
    elif evidence_type == "tool-call-sequence":
        typed = _closed(
            evidence,
            {"type", "tools", "calls", "independent_calls_may_commute"},
            context,
        )
        if not isinstance(typed["tools"], list) or not typed["tools"]:
            raise CorpusValidationError(f"{context}.tools: expected a non-empty list")
        if not isinstance(typed["calls"], list) or not typed["calls"]:
            raise CorpusValidationError(f"{context}.calls: expected a non-empty list")
        if not isinstance(typed["independent_calls_may_commute"], bool):
            raise CorpusValidationError(f"{context}.independent_calls_may_commute: expected bool")
        tool_schemas: dict[str, dict[str, Any]] = {}
        for index, tool_value in enumerate(typed["tools"]):
            tool = _closed(tool_value, {"type", "function"}, f"{context}.tools[{index}]")
            if tool["type"] != "function":
                raise CorpusValidationError(f"{context}.tools[{index}].type: expected function")
            function = _closed(
                tool["function"],
                {"name", "description", "parameters"},
                f"{context}.tools[{index}].function",
            )
            _non_empty_string(function["name"], f"{context}.tools[{index}].function.name")
            _non_empty_string(function["description"], f"{context}.tools[{index}].function.description")
            parameters = _object(
                function["parameters"], f"{context}.tools[{index}].function.parameters"
            )
            tool_schemas[function["name"]] = parameters
        for index, call_value in enumerate(typed["calls"]):
            call = _object(call_value, f"{context}.calls[{index}]")
            if set(call) not in ({"function"}, {"condition", "function"}):
                raise CorpusValidationError(f"{context}.calls[{index}]: invalid fields")
            function = _closed(
                call["function"], {"name", "arguments"}, f"{context}.calls[{index}].function"
            )
            if function["name"] not in tool_schemas:
                raise CorpusValidationError(f"{context}.calls[{index}]: unknown tool")
            arguments = _object(
                function["arguments"], f"{context}.calls[{index}].function.arguments"
            )
            _validate_json_schema_value(
                arguments,
                tool_schemas[function["name"]],
                f"{context}.calls[{index}].function.arguments",
            )
            if "condition" in call:
                condition = _closed(
                    call["condition"],
                    {"path", "operator", "value"},
                    f"{context}.calls[{index}].condition",
                )
                _non_empty_string(condition["path"], f"{context}.calls[{index}].condition.path")
                if condition["operator"] not in {">=", ">", "==", "<", "<="}:
                    raise CorpusValidationError(f"{context}.calls[{index}].condition.operator: invalid")
    else:
        raise CorpusValidationError(f"{context}: unsupported evidence type {evidence_type!r}")


def _validate_json_schema_value(value: Any, schema: dict[str, Any], context: str) -> None:
    """Validate the closed JSON Schema subset used by corpus tool fixtures."""
    schema_type = schema.get("type")
    if schema_type == "object":
        if not isinstance(value, dict):
            raise CorpusValidationError(f"{context}: expected object")
        properties = _object(schema.get("properties"), f"{context}.schema.properties")
        required = schema.get("required", [])
        if not isinstance(required, list) or not all(isinstance(name, str) for name in required):
            raise CorpusValidationError(f"{context}.schema.required: expected string list")
        missing = set(required) - set(value)
        extra = set(value) - set(properties)
        if missing or (schema.get("additionalProperties") is False and extra):
            raise CorpusValidationError(
                f"{context}: schema properties invalid (missing={sorted(missing)}, extra={sorted(extra)})"
            )
        for name, child in value.items():
            if name in properties:
                _validate_json_schema_value(
                    child, _object(properties[name], f"{context}.schema.{name}"), f"{context}.{name}"
                )
    elif schema_type == "string":
        if not isinstance(value, str):
            raise CorpusValidationError(f"{context}: expected string")
        if "enum" in schema and value not in schema["enum"]:
            raise CorpusValidationError(f"{context}: value is not in enum")
        if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None:
            raise CorpusValidationError(f"{context}: value does not match pattern")
        if schema.get("format") == "date":
            try:
                datetime.date.fromisoformat(value)
            except ValueError as error:
                raise CorpusValidationError(f"{context}: invalid date") from error
    elif schema_type == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise CorpusValidationError(f"{context}: expected number")
    elif schema_type == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            raise CorpusValidationError(f"{context}: expected integer")
    elif schema_type == "boolean":
        if not isinstance(value, bool):
            raise CorpusValidationError(f"{context}: expected boolean")
    elif schema_type == "array":
        if not isinstance(value, list):
            raise CorpusValidationError(f"{context}: expected array")
        item_schema = _object(schema.get("items"), f"{context}.schema.items")
        for index, item in enumerate(value):
            _validate_json_schema_value(item, item_schema, f"{context}[{index}]")
    else:
        raise CorpusValidationError(f"{context}.schema: unsupported type {schema_type!r}")


def _validate_item(item: dict[str, Any], expected_domain: str, context: str) -> None:
    unknown = set(item) - ITEM_FIELDS
    missing = REQUIRED_FIELDS - set(item)
    if unknown or missing:
        raise CorpusValidationError(
            f"{context}: schema fields invalid (missing={sorted(missing)}, unknown={sorted(unknown)})"
        )
    if item["schema_version"] != 1:
        raise CorpusValidationError(f"{context}: unsupported schema_version")
    if item["domain"] != expected_domain or item["domain"] not in DOMAINS:
        raise CorpusValidationError(f"{context}: invalid domain")
    if item["difficulty"] not in DIFFICULTIES:
        raise CorpusValidationError(f"{context}: invalid difficulty")
    if item["split"] != "held_out":
        raise CorpusValidationError(f"{context}: split must be held_out")
    for field in ("id", "prompt", "license"):
        if not isinstance(item[field], str) or not item[field].strip():
            raise CorpusValidationError(f"{context}: {field} must be a non-empty string")
    id_prefix = "tool" if expected_domain == "tool-use" else expected_domain
    if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{3}", item["id"]) is None or not item[
        "id"
    ].startswith(f"{id_prefix}-"):
        raise CorpusValidationError(f"{context}: id must be a domain-prefixed stable id")
    if item["license"] not in LICENSES:
        raise CorpusValidationError(f"{context}: unapproved license {item['license']!r}")
    if not isinstance(item["tags"], list) or not item["tags"] or not all(
        isinstance(tag, str) and tag for tag in item["tags"]
    ):
        raise CorpusValidationError(f"{context}: tags must be non-empty strings")
    source = _object(item["source"], f"{context}.source")
    if set(source) != {"name", "revision"} or not all(
        isinstance(source[key], str) and source[key] for key in source
    ):
        raise CorpusValidationError(f"{context}: invalid source provenance")
    _object(item["metadata"], f"{context}.metadata")
    evidence = [field for field in ("gold", "verifier") if field in item]
    if len(evidence) != 1:
        raise CorpusValidationError(f"{context}: exactly one of gold or verifier is required")
    _validate_evidence(_object(item[evidence[0]], f"{context}.{evidence[0]}"), f"{context}.{evidence[0]}")


def validate_corpus(corpus_dir: Path) -> dict[str, int]:
    repository_root = corpus_dir.resolve().parent
    manifest_path = corpus_dir / "manifest.json"
    pin_path = corpus_dir / "manifest.sha256"
    manifest_bytes = manifest_path.read_bytes()
    expected_pin = f"{_sha256(manifest_bytes)}  manifest.json\n"
    if pin_path.read_text(encoding="utf-8") != expected_pin:
        raise CorpusValidationError("manifest.sha256 does not pin manifest.json")

    manifest = _object(json.loads(manifest_bytes), "manifest")
    if set(manifest) != {"corpus_version", "schema_version", "files", "assets"}:
        raise CorpusValidationError("manifest: invalid fields")
    if manifest["corpus_version"] != "per-365-v1" or manifest["schema_version"] != 1:
        raise CorpusValidationError("manifest: unsupported version")
    files = _object(manifest["files"], "manifest.files")
    if set(files) != set(CORPUS_FILES):
        raise CorpusValidationError("manifest: file set does not match corpus contract")
    assets = _object(manifest["assets"], "manifest.assets")
    if set(assets) != set(NORMATIVE_ASSETS):
        raise CorpusValidationError("manifest: normative asset set does not match corpus contract")
    for relative_path in NORMATIVE_ASSETS:
        raw = (repository_root / relative_path).read_bytes()
        if assets[relative_path] != {"bytes": len(raw), "sha256": _sha256(raw)}:
            raise CorpusValidationError(f"{relative_path}: normative asset manifest mismatch")

    seen: set[str] = set()
    counts: dict[str, int] = {}
    for filename in CORPUS_FILES:
        path = corpus_dir / filename
        raw = path.read_bytes()
        if not raw.endswith(b"\n"):
            raise CorpusValidationError(f"{filename}: file must end with a newline")
        records = []
        for line_number, line in enumerate(raw.decode("utf-8").splitlines(), 1):
            try:
                item = _object(json.loads(line), f"{filename}:{line_number}")
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise CorpusValidationError(f"{filename}:{line_number}: invalid JSON: {error}") from error
            _validate_item(item, filename.removesuffix(".jsonl"), f"{filename}:{line_number}")
            item_id = item["id"]
            if item_id in seen:
                raise CorpusValidationError(f"{filename}:{line_number}: duplicate id {item_id!r}")
            seen.add(item_id)
            records.append(item)

        entry = _object(files[filename], f"manifest.files.{filename}")
        actual = {"sha256": _sha256(raw), "bytes": len(raw), "items": len(records)}
        if entry != actual:
            raise CorpusValidationError(
                f"{filename}: manifest mismatch (expected={entry}, actual={actual})"
            )
        if not records:
            raise CorpusValidationError(f"{filename}: slice must not be empty")
        counts[filename.removesuffix(".jsonl")] = len(records)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "corpus_dir",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "corpus",
    )
    args = parser.parse_args()
    try:
        counts = validate_corpus(args.corpus_dir)
    except (CorpusValidationError, OSError, json.JSONDecodeError) as error:
        parser.exit(1, f"corpus validation failed: {error}\n")
    print(f"validated {sum(counts.values())} items across {len(counts)} slices")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

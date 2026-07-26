from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[1]


def load_script(name: str):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def source() -> dict:
    return {
        "provenance": {
            "contract_id": "disklm-eval-v1",
            "checkpoint_sha": "checkpoint-a",
            "tokenizer_hash": "tokenizer-a",
            "template_hash": "template-a",
            "environment_fingerprint": "environment-a",
            "environment_lock": "uv-lock-a",
            "corpus_hash": "corpus-a",
            "dataset_revisions": {"reasoning": "revision-a"},
            "harness_commit": "commit-a",
            "command_arguments": ["--decode", "greedy"],
            "cache_state": "cold",
            "raw_trace_hashes": ["trace-a"],
            "direct_io": False,
            "decode_config": {"strategy": "greedy", "temperature": 0.0},
        },
        "results": {"accuracy": 0.1234567894, "slices": {"code": 0.75}},
    }


def test_report_is_canonical_and_repeatable(source) -> None:
    script = load_script("report_result.py")
    reordered = {"results": source["results"], "provenance": dict(reversed(source["provenance"].items()))}

    first, first_fingerprint = script.build_report(source, 8)
    second, second_fingerprint = script.build_report(reordered, 8)

    assert first == second
    assert first_fingerprint == second_fingerprint
    payload = {
        key: first[key]
        for key in ("schema_version", "float_precision", "provenance", "results")
    }
    assert first_fingerprint == hashlib.sha256(script.canonical_json(payload).encode()).hexdigest()
    assert first["results"]["accuracy"] == 0.12345679


@pytest.mark.parametrize(
    ("section", "field", "replacement"),
    [
        ("provenance", "checkpoint_sha", "checkpoint-b"),
        ("provenance", "environment_fingerprint", "environment-b"),
        ("provenance", "corpus_hash", "corpus-b"),
        ("provenance", "harness_commit", "commit-b"),
        ("provenance", "decode_config", {"strategy": "sampled", "seed": 7}),
        ("results", "accuracy", 0.5),
    ],
)
def test_fingerprinted_inputs_change_hash(source, section, field, replacement) -> None:
    script = load_script("report_result.py")
    changed = copy.deepcopy(source)
    changed[section][field] = replacement
    assert script.build_report(source, 8)[1] != script.build_report(changed, 8)[1]


def test_report_cli_writes_schema_shaped_json_markdown_and_fingerprint(tmp_path, source) -> None:
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps(source), encoding="utf-8")
    output = tmp_path / "reports"
    completed = subprocess.run(
        [sys.executable, ROOT / "scripts/report_result.py", input_path, "--output-dir", output],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads((output / "baseline.json").read_text(encoding="utf-8"))

    assert report["schema_version"] == 1
    assert completed.stdout.strip() == report["result_fingerprint"]
    assert (output / "RESULT.fingerprint").read_text().strip() == report["result_fingerprint"]
    markdown = (output / "baseline.md").read_text(encoding="utf-8")
    for value in ("checkpoint-a", "environment-a", "corpus-a", "commit-a", "greedy"):
        assert value in markdown


def test_diff_reports_changed_input_path(tmp_path, source) -> None:
    script = load_script("report_result.py")
    left = script.build_report(source, 8)[0]
    changed = copy.deepcopy(source)
    changed["provenance"]["corpus_hash"] = "corpus-b"
    right = script.build_report(changed, 8)[0]
    left_path, right_path = tmp_path / "left.json", tmp_path / "right.json"
    left_path.write_text(json.dumps(left), encoding="utf-8")
    right_path.write_text(json.dumps(right), encoding="utf-8")

    completed = subprocess.run(
        [sys.executable, ROOT / "scripts/diff_results.py", left_path, right_path],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    assert "$.provenance.corpus_hash" in completed.stdout
    assert "$.result_fingerprint" in completed.stdout


def test_missing_provenance_is_rejected(source) -> None:
    script = load_script("report_result.py")
    del source["provenance"]["checkpoint_sha"]
    with pytest.raises(ValueError, match="checkpoint_sha"):
        script.build_report(source, 8)


@pytest.mark.parametrize(
    ("field", "value"),
    [("checkpoint_sha", ""), ("corpus_hash", None), ("decode_config", "greedy")],
)
def test_malformed_provenance_is_rejected(source, field, value) -> None:
    script = load_script("report_result.py")
    source["provenance"][field] = value
    with pytest.raises(ValueError, match=field):
        script.build_report(source, 8)


def test_decode_floats_remain_exact_and_precision_is_fingerprinted(source) -> None:
    script = load_script("report_result.py")
    source["provenance"]["decode_config"]["temperature"] = 0.12345678941
    first, first_hash = script.build_report(source, 8)
    changed = copy.deepcopy(source)
    changed["provenance"]["decode_config"]["temperature"] = 0.12345678949
    _, changed_hash = script.build_report(changed, 8)
    _, precision_hash = script.build_report(source, 9)

    assert first["provenance"]["decode_config"]["temperature"] == 0.12345678941
    assert first_hash != changed_hash
    assert first_hash != precision_hash


def test_markdown_renders_optional_fingerprinted_provenance(source) -> None:
    script = load_script("report_result.py")
    source["provenance"]["hardware_class"] = "apple-m2"
    report, _ = script.build_report(source, 8)
    assert '"hardware_class"' in script.render_markdown(report)
    assert "apple-m2" in script.render_markdown(report)


def test_markdown_safely_renders_provenance_delimiters(source) -> None:
    script = load_script("report_result.py")
    source["provenance"]["decode_config"]["stop"] = "`stop|here`"
    report, _ = script.build_report(source, 8)
    markdown = script.render_markdown(report)
    assert '"stop": "`stop|here`"' in markdown
    assert markdown.count("```json") == 2

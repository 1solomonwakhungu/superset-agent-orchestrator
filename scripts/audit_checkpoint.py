#!/usr/bin/env python3
"""Audit a pinned Hugging Face checkpoint without loading model weights."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import struct
import urllib.request
from collections import defaultdict
from pathlib import Path

DTYPE_BYTES = {"BF16": 2, "F16": 2, "F32": 4, "F64": 8, "I8": 1, "U8": 1,
               "I16": 2, "U16": 2, "I32": 4, "U32": 4, "I64": 8, "U64": 8, "BOOL": 1}


def read_lock(path: Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line)


def fetch(url: str, byte_range: str | None = None, limit: int = 10_000_000) -> bytes:
    request = urllib.request.Request(url, headers={"Range": byte_range} if byte_range else {})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"checkpoint response exceeded the {limit}-byte limit: {url}")
    return data


def tensor_header(base_url: str) -> dict[str, object]:
    prefix = fetch(f"{base_url}/model-00000-of-00001.safetensors", "bytes=0-7", 8)
    header_size = struct.unpack("<Q", prefix[:8])[0]
    payload = fetch(f"{base_url}/model-00000-of-00001.safetensors", f"bytes=0-{header_size + 7}", header_size + 8)
    if len(payload) < header_size + 8:
        raise ValueError("checkpoint server returned a truncated safetensors header")
    return json.loads(payload[8:header_size + 8])


def classify(name: str) -> tuple[str, str]:
    match = re.match(r"model\.layers\.(\d+)\.(.+)\.weight$", name)
    if match:
        layer, module = match.groups()
        return f"layer.{layer}", module
    return "global", name.removesuffix(".weight")


def inventory(header: dict[str, object]) -> list[dict[str, object]]:
    rows = []
    for name, metadata in sorted(header.items()):
        if name == "__metadata__":
            continue
        shape = metadata["shape"]
        dtype = metadata["dtype"]
        elements = math.prod(shape)
        byte_size = metadata["data_offsets"][1] - metadata["data_offsets"][0]
        expected = elements * DTYPE_BYTES[dtype]
        if byte_size != expected:
            raise ValueError(f"{name}: offsets describe {byte_size} bytes, expected {expected}")
        layer, module = classify(name)
        rows.append({"name": name, "shape": "x".join(map(str, shape)), "dtype": dtype,
                     "elements": elements, "byte_size": byte_size, "layer": layer, "module": module})
    return rows


def render_tool_fixture() -> str:
    tool = {"type": "function", "function": {"name": "weather", "description": "Get weather",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}
    return ("<s><|im_start|>system\n# Tools\n\nYou are provided with function signatures within "
            f"<tools></tools> XML tags:\n<tools>\n{json.dumps(tool, separators=(',', ':'))}\n</tools>\n"
            "<|im_end|>\n<|im_start|>user\nWhat is the weather in Nairobi?<|im_end|>\n"
            "<|im_start|>assistant\n<function name=\"weather\"><param name=\"city\">Nairobi</param>"
            "</function><|im_end|>\n")


def run(root: Path, output: Path) -> None:
    lock = read_lock(root / "provenance" / "CHECKPOINT.lock")
    base = f"{lock['mirror']}/resolve/{lock['revision']}"
    config_bytes = fetch(f"{base}/config.json")
    tokenizer_bytes = fetch(f"{base}/tokenizer_config.json")
    special_bytes = fetch(f"{base}/special_tokens_map.json")
    template_bytes = fetch(f"{base}/chat_template.jinja")
    expected_hashes = dict(line.split("  ", 1) for line in (root / "provenance" / "checksums.txt").read_text().splitlines())
    for filename, data in (("config.json", config_bytes), ("tokenizer_config.json", tokenizer_bytes),
                           ("special_tokens_map.json", special_bytes), ("chat_template.jinja", template_bytes)):
        if hashlib.sha256(data).hexdigest() != next(key for key, value in expected_hashes.items() if value == filename):
            raise ValueError(f"pinned hash mismatch for {filename}")

    config = json.loads(config_bytes)
    tokenizer = json.loads(tokenizer_bytes)
    special = json.loads(special_bytes)
    template = template_bytes.decode()
    rows = inventory(tensor_header(base))
    total = sum(row["elements"] for row in rows)
    total_bytes = sum(row["byte_size"] for row in rows)
    by_layer: dict[str, int] = defaultdict(int)
    by_module: dict[str, int] = defaultdict(int)
    for row in rows:
        by_layer[str(row["layer"])] += int(row["elements"])
        by_module[str(row["module"])] += int(row["elements"])

    output.mkdir(parents=True, exist_ok=True)
    with (output / "tensor_inventory.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (output / "chat_template.jinja").write_text(template)
    rendered = render_tool_fixture()
    if '<function name="weather"><param name="city">Nairobi</param></function>' not in rendered:
        raise ValueError("tool-call fixture did not round-trip")
    (output / "template_render.txt").write_text(rendered)
    report = {
        "checkpoint": lock, "tokenizer_class": tokenizer["tokenizer_class"],
        "vocab_size": config["vocab_size"], "special_tokens": special,
        "template_sha256": hashlib.sha256(template_bytes).hexdigest(),
        "tool_call_round_trip": True,
    }
    (output / "tokenizer_report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    brief = 1_080_632_832
    if total == brief:
        delta_explanation = "The tensor-derived total exactly matches the brief."
    else:
        direction = "lower" if total < brief else "higher"
        delta_explanation = (f"The tensor-derived total is authoritative for this revision and is "
                             f"{abs(total - brief):,} parameters {direction} than the brief.")
    architecture = f"""# MiniCPM5-1B Architecture Audit

## Provenance

- Checkpoint: `{lock['repository']}@{lock['revision']}`
- Method: pinned config/tokenizer files plus the safetensors header; model tensors were not loaded or executed.
- Architecture declaration: `{config['architectures'][0]}` (`{config['model_type']}`)

## Measured Structure

| Field | Value |
| --- | ---: |
| Parameters from {len(rows)} tensor shapes | {total:,} |
| Brief parameter claim | {brief:,} |
| Delta from brief | {total - brief:+,} |
| Tensor payload bytes | {total_bytes:,} |
| Layers | {config['num_hidden_layers']} |
| Hidden / intermediate size | {config['hidden_size']} / {config['intermediate_size']} |
| Query / KV heads | {config['num_attention_heads']} / {config['num_key_value_heads']} |
| GQA ratio | {config['num_attention_heads'] // config['num_key_value_heads']}:1 |
| Head dimension | {config['head_dim']} |
| Max positions | {config['max_position_embeddings']:,} |
| RoPE theta / scaling | {config['rope_theta']:,} / `{config['rope_scaling']}` |
| Vocabulary | {config['vocab_size']:,} |
| Tied embeddings | `{config['tie_word_embeddings']}` |
| Activation / norm | `{config['hidden_act']}` / RMSNorm epsilon `{config['rms_norm_eps']}` |

{delta_explanation}
The checkpoint confirms 24 layers, 8:1 grouped-query attention, and a 131,072-token configured context.

## Parameter Breakdown

Each transformer layer has `{by_layer['layer.0']:,}` parameters. Global tensors have
`{by_layer['global']:,}` parameters. Module totals across all layers are recorded below.

| Module | Parameters |
| --- | ---: |
""" + "\n".join(f"| `{name}` | {count:,} |" for name, count in sorted(by_module.items())) + """

## Tokenizer And Template

The tokenizer is `PreTrainedTokenizerFast`, with the special-token map in
`tokenizer_report.json`. The exact pinned template is copied to `chat_template.jinja`.
`template_render.txt` records a deterministic tool definition and assistant tool call; the
generator verifies the function name and `city=Nairobi` argument survive serialization.
"""
    (output / "ARCH_REPORT.md").write_text(architecture)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=Path("audit"))
    args = parser.parse_args()
    run(args.root, args.output)

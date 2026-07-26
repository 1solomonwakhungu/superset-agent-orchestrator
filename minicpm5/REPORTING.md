# Deterministic baseline reporting

The reporting tools consume evaluation output without depending on a particular
harness implementation. The input contract is:

```json
{
  "provenance": {
    "checkpoint_sha": "pinned checkpoint revision",
    "environment_fingerprint": "hash of the captured runtime environment",
    "corpus_hash": "hash of the evaluation corpus manifest",
    "harness_commit": "Git commit that produced the input",
    "decode_config": { "strategy": "greedy" }
  },
  "results": { "accuracy": 0.75 }
}
```

Generate canonical JSON, Markdown, and `RESULT.fingerprint`:

```sh
uv run --frozen python scripts/report_result.py result-input.json \
  --output-dir reports/run-001
```

Compare reruns (exit 0 means identical; exit 1 prints every changed path):

```sh
uv run --frozen python scripts/diff_results.py \
  reports/run-001/baseline.json reports/run-002/baseline.json
```

The fingerprint is SHA-256 over canonical JSON containing the schema version,
complete provenance, and normalized results. Object key order and formatting do
not affect it. Finite floats are rounded to eight decimal places by default so
insignificant backend noise does not masquerade as a quality change; use
`--float-precision` to record a different declared tolerance. Changes to the
checkpoint, environment, corpus, harness commit, decode configuration, or
normalized metrics necessarily change the fingerprint. The generated Markdown
embeds the same provenance and results, so it is reproducible without external
context. Validate generated JSON against `report.schema.json`.

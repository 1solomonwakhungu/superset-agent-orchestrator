# MiniCPM5 Regression Corpus v1

## Purpose

This frozen, held-out corpus provides a small regression yardstick for reasoning,
code, typed tool use, long-context retrieval, and deterministic decoding. It is
an evaluation fixture, not training data, and does not establish model quality.

## Composition

The package contains 15 original items: three in each slice. Reasoning covers
arithmetic and short logic. Code tasks have executable case specifications.
Tool-use tasks use the pinned MiniCPM5 OpenAI-style function schema and typed
`function.arguments` objects. Long-context records describe deterministic probes
at 4,096, 32,768, and 131,072 tokens without committing generated filler.
Determinism records have exact or semantic gold answers.

`scripts/materialize_long_context.py` defines `counter-v1`. It emits exactly the
declared number of space-delimited ASCII lexical tokens and inserts the sentinel
and expected value at the deterministic midpoint, leaving filler on both sides.
The query is appended after this stream. This portable count is not a
model-tokenizer claim; each evaluation harness must separately record the
rendered model-token count.

All committed prompts and verifiers were authored for PER-365. CC0-1.0 is used
for prompt-only fixtures and MIT for code, generators, and executable verifier
specifications. There are no copied benchmark items or personal data.

## Intended Use

Run `python3 scripts/validate_corpus.py` before evaluation. BL-05 must measure and
publish the full CPU evaluation wall-clock budget; this package only bounds the
item count and per-item timeout metadata. A configured 131,072-token probe is
not evidence that any runtime completed it.

The committed held-out split detects repository regressions but cannot be secret
from a model trained on the repository. A future private evaluation subset must
remain outside Git; only its content hash, item count, license audit, and access
policy should be published.

## Maintenance

Items are immutable after release. Corrections require a corpus version bump,
new stable IDs where semantics change, regenerated file hashes in
`manifest.json`, and a new `manifest.sha256`. The validator rejects unknown
fields, duplicate IDs, missing gold/verifiers, unapproved licenses, count drift,
byte drift, and an invalid manifest pin.

Tool-call sequence adjudication is explicit about whether independent calls may
commute. Non-unique natural-language answers should use a semantic or executable
verifier instead of exact string matching.

# Experiment registry policy

`registry/experiments.jsonl` is the shared metadata index for MiniCPM5 baseline, DiskLM, CallForge, and FGGUF experiments. It is deliberately a small, reviewable JSONL file rather than a hosted MLOps service.

## Rules

- Every line is a finalized, terminal experiment record. Failed and aborted work is retained.
- Records are immutable. Corrections and reruns receive a new `exp_<uuid>` identifier; never edit, delete, or reuse an existing identifier.
- `parentBaselineFingerprint` is the exact BL-08 result fingerprint. Registration does not itself verify or endorse a research claim.
- DiskLM and CallForge checkpoint lineages remain separate. Artifacts must be content-addressed where possible and large artifacts stay outside Git.
- `config` and `env` must contain enough information to reproduce the run but must not contain credentials, personal paths, usernames, or host identifiers.
- Hypotheses are recorded before interpreting metrics. Registry inclusion is not evidence of quality, performance, novelty, or scalability.
- Concurrent local writers are serialized by a filesystem lock. The supported filesystems are local APFS and Linux filesystems with atomic directory creation.
- Git conflicts must retain every valid unique line. After resolution, run the registry tests; never resolve by discarding one side wholesale.

## Usage

```sh
npm run build
experiment-registry add --registry registry/experiments.jsonl --input experiment.json
experiment-registry query --registry registry/experiments.jsonl --hypothesis "Page alignment reduces reads"
experiment-registry query --registry registry/experiments.jsonl --checkpoint 0123456789abcdef0123456789abcdef01234567
experiment-registry diff --registry registry/experiments.jsonl --baseline-experiment exp_... --experiment exp_...
```

The `add` input includes every schema field except `schemaVersion`; `experimentId` and `timestamp` are optional and generated when omitted. Status must be `succeeded`, `failed`, or `aborted`.

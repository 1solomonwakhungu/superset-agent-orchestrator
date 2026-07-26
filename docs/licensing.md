# DiskLM-1B Licensing And Provenance Memo

This memo is a gate, not legal advice. No training dataset or derivative model is
approved until its exact revision and terms are recorded.

## Base Checkpoint

The program brief identifies `openbmb/MiniCPM5-1B` and expects Apache-2.0, but
PER-373 does not convert that expectation into a verified fact. PER-361 owns the
immutable checkpoint, model-card, and license audit. DiskLM work must import the
PER-361 lock and stop if the repository ID, revision, file hashes, or recorded
license differ. It must preserve the upstream copyright and license notices,
mark modified files, include the Apache-2.0 text when redistribution is allowed,
and avoid implying upstream endorsement. Patent termination and trademark terms
remain applicable.

## Derivatives And Containers

Layout conversion, pruning, routing metadata, and continued-training checkpoints
are separately versioned derivatives. Each manifest records the base lock,
transformation code commit, parameters, source/target container, output hashes,
and notices copied into the distribution. GGUF and safetensors implementation
licenses do not replace the model-weight license.

## Data Gate

Before continued pretraining, record for every dataset: owner, authoritative URL,
exact revision and file hashes, license text, commercial-use and derivative terms,
attribution, personal-data policy, geographic restrictions, and whether trained
weights may be redistributed. “Publicly accessible,” a dataset card, or a
permissive code license is not evidence that training data is licensed. Mixed or
unknown provenance fails closed. Evaluation-only datasets receive the same audit
and are not redistributed unless their terms permit it.

## Source Provenance

The survey bibliography points to papers and first-party specifications. Facts
must be attributed; paper text, figures, and datasets are not copied into model
artifacts. Experiment manifests retain URLs, retrieval dates, Git revisions where
available, and local SHA-256 hashes. Later public novelty statements must say
“not found in the PER-373 searched corpus,” never “no prior work exists.”

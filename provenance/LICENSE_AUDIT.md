# MiniCPM5-1B License Audit

Audited on 2026-07-26 against the pinned Hugging Face revision in
`CHECKPOINT.lock` and the upstream OpenBMB MiniCPM repository.

## Finding

The model card declares `apache-2.0`. The authoritative project license is the
Apache License 2.0 at:

`https://github.com/OpenBMB/MiniCPM/blob/main/LICENSE`

The local repository's `LICENSE` is byte-identical to that primary source at
the time of audit. Apache-2.0 permits commercial use, modification,
distribution, patent use, and private use. Redistribution must include the
license and copyright notice, state significant changes, preserve notices, and
include any upstream NOTICE file if one is supplied. It provides no trademark
permission and includes warranty and liability disclaimers.

No model-specific use restriction was found in the pinned model card. This is
an engineering license inventory, not legal advice.

## Provenance Boundary

The Hugging Face model repository does not contain a standalone license file.
The model card links the project and declares Apache-2.0, so the project license
is the recorded authoritative text. Consumers must repeat this audit if either
the pinned model revision or upstream license source changes.

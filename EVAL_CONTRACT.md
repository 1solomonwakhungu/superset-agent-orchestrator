# DiskLM-1B Evaluation Contract v1

Status: frozen by PER-373. Later experiments must import
`config/disklm-eval-contract.json`; they must not redefine its constants.

## Scope And Change Control

This contract evaluates whether page-aligned parameter layout and lookahead
routing improve cold-storage inference for `openbmb/MiniCPM5-1B` without hiding
quality loss or I/O. It does not pre-register a positive result. One amendment
window closes when DNA-02 completes. Every amendment must change the contract
ID, explain the reason in this file, and preserve the old JSON in Git history.

## Quality Gate

Run WikiText-2-raw-v1 test word perplexity, zero-shot ARC-Easy normalized
accuracy, zero-shot HellaSwag normalized accuracy, and zero-shot exact JSON Schema
validity on `disklm-tool-call-json-schema-v1`. Decode evaluation is greedy with
temperature 0, top-p 1, and the pinned checkpoint chat template; multiple-choice
tasks use log-likelihood scoring. Each suite is compared separately. A candidate
is ineligible if perplexity regresses by more than 1% or any accuracy/validity
rate falls by more than 1 percentage point relative to `dense-resident`. No
cross-suite mean is calculated.

The suite IDs, splits, metrics, and few-shot values are frozen in the JSON. Before
first execution, DNA-02 must freeze exact dataset and lm-evaluation-harness commit
SHAs, preprocessing hashes, licenses, and tool-corpus bytes during the sole
amendment window. An incomplete pin makes the contract non-executable; it is not
permission to choose inputs after viewing results.

## Hardware Matrix

Run on Linux x86-64 with local NVMe and macOS arm64 Apple Silicon. The JSON freezes
required identity fields for each class. DNA-02 must freeze one exact machine
manifest per class during the amendment window. Record CPU/SoC, RAM, storage
model, filesystem, OS/kernel, power mode, page size, direct-I/O alignment, runtime
revision, checkpoint revision, tokenizer hash, chat-template hash, and thermal
state. Results from different hardware classes or manifests are not pooled.

The Linux cold path uses direct I/O when the filesystem supports it. The macOS
path records the supported cache-control mechanism and labels results as
`cold-cache-emulated`; it must not be presented as equivalent to Linux direct
I/O. Warm and cold results are separate series.

## Baselines

1. `dense-resident`: entire dense model resident in memory.
2. `dense-mmap-cold`: unchanged dense layout under a cold-cache protocol.
3. `llm-in-a-flash-style-window`: window reuse without page-aware routing.
4. `activation-sparse-unpacked`: identical sparse decisions in original layout.
5. `page-aligned-no-lookahead`: proposed layout with lookahead disabled.

All baselines use the same checkpoint, tokenizer, prompts, generation settings,
quality suite, seeds, and measurement harness. Unsupported baselines are reported
as missing, not replaced by an easier proxy.

## Metrics

The logical analysis page is 4,096 bytes. Also report the host VM page and the
device/filesystem direct-I/O alignment. Metadata, alignment padding, indexes,
and repeated reads count as transferred bytes.

- `unique_pages_per_decode_token`: distinct logical model-data pages read after
  prefill, divided by measured decode tokens. Report p50, p95, and total.
- `storage_bytes_per_decode_token`: bytes completed by storage reads after
  prefill, including overfetch and repeated reads, divided by decode tokens.
- `useful_parameter_byte_ratio`: bytes in weights selected by the exact forward
  pass for decode token N divided by the union of complete 4,096-byte model-file
  pages first requested for token N. Padding, indexes, unselected weights, and
  speculative lookahead pages are denominator-only. A prefetched page is charged
  to the token whose routing decision first requested it, never reassigned to a
  later consumer. A page resident before token N contributes neither numerator
  nor denominator for N; cold-cache aggregate results remain primary. Repeated
  reads do not enlarge this unique-page denominator and are separately exposed by
  `storage_bytes_per_decode_token`. Metadata is never useful. Shared/tied weight
  bytes count once per token.
- `decode_tokens_per_second`: decode tokens divided by wall-clock decode time;
  prefill and setup are excluded and reported separately.
- `quality_delta`: candidate minus dense baseline under each suite's documented
  direction, with both absolute and relative values.

“UPT” is not used as prior terminology. The PER-373 search found no publication
that defines it, or an equivalent page-usefulness metric, for dense 1B inference.
If retained as project shorthand, it means `useful_parameter_byte_ratio` only.

## Runs And Seeds

Use seeds 17, 29, and 41. Perform one untimed warm-up and at least five measured
runs per seed and hardware class. Preserve every run, including failures. Report
median and p95 with bootstrap 95% confidence intervals; do not select the best
run. Prompt order is deterministically shuffled by seed.

Each result manifest records the Git commit, contract ID, environment lock,
checkpoint/tokenizer/template hashes, dataset revisions, command arguments,
cache state, raw trace hashes, and whether direct I/O was active. A benchmark
must fail closed if its imported contract ID is not `disklm-eval-v1`. Benchmark
code must import the JSON through `scripts/disklm-contract.mjs`; CI rejects
DiskLM benchmark files (identified by `disklm` and `bench`/`benchmark` in their
path) that redefine the page size, seeds, suite IDs, or contract ID.

## Amendments

None.

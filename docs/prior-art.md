# DiskLM-1B Prior-Art Survey

This survey asks a narrow question: does prior work jointly provide a
page-aligned parameter layout, token-dependent routing with useful lookahead, and
a metric for useful parameter bytes per fetched storage page? It separates cited
mechanisms from DiskLM hypotheses. The reproducible row-level comparison is in
`gap-table.csv`; citation keys resolve in `prior-art.bib`.

## Findings

The 28 reviewed works and specifications solve adjacent pieces, but the searched
corpus did not expose the complete joint mechanism. This is a bounded literature
finding, not a novelty claim.

- Contextual and activation sparsity predicts or creates inactive heads, neurons,
  or channels [dejavu; relu-strikes-back; prosparse; cats; turbo-sparse]. It does
  not imply fewer pages unless layout places co-active weights together.
- Pruning reduces stored nonzeros [sparsegpt; wanda], but neither objective packs
  surviving weights by token co-access or physical page.
- Dense-to-MoE conversion creates routable groups [moefication; llama-moe]. MoE
  offload then caches, predicts, or prefetches experts [mixtral-offload;
  moe-infinity; hobbit; moe-speq], generally at whole-expert granularity.
- Flash and heterogeneous systems move selected neuron clusters or scheduled
  blocks [llm-in-a-flash; powerinfer; powerinfer2; flexgen; zero-inference]. LLM
  in a Flash's row-column bundling is the closest explicit contiguous-layout
  precedent; PowerInfer-2 is the closest storage-backed neuron-cluster system.
- Dynamic Input Pruning couples selection to cache residency, while segment
  routing consistency quantifies bounded-future expert-cache locality. Neither
  defines useful parameter bytes per fetched page.
- GGUF and safetensors make tensors indexable and mmap-friendly, not
  token-routable at page granularity. io_uring, O_DIRECT, and SPDK reduce or expose
  I/O overhead but cannot manufacture semantic locality. NVMe FDP governs write
  placement and lifetime grouping; it does not change logical read usefulness.

## Work-By-Work Review

Each statement below is falsifiable by the cited design or an implementation
trace. DRAM and movement details are normalized in `gap-table.csv`.

1. **GLU Variants Improve Transformer** defines dense SwiGLU projections; every
   projection remains logically required and no conditional page read exists.
2. **MoEfication** partitions dense FFN neurons into experts, but does not require
   expert tensors to align with storage pages.
3. **ZeRO-Inference** streams whole layers from CPU or NVMe, so page demand for a
   decode step remains proportional to dense layer size.
4. **FlexGen** schedules tensor blocks across GPU, CPU, and disk for batch
   throughput rather than minimizing pages for one token.
5. **SparseGPT** can leave useful nonzeros dispersed through every matrix page.
6. **Wanda** scores individual weights without a page-occupancy objective.
7. **Deja Vu** predicts contextual heads and neurons, but unchanged tensor layout
   need not reduce storage pages.
8. **ReLU Strikes Back** exploits active-neuron prediction and temporal reuse,
   without requiring co-active neuron weights to share pages.
9. **LLM in a Flash** windows activations and bundles rows with columns into
   contiguous reads, but does not require one useful bundle per page.
10. **PowerInfer** pins hot neurons on GPU and executes cold neurons on CPU; cold
    accesses have no storage-page bound.
11. **Mixtral expert offloading** transfers and caches whole experts, not
    page-local sub-expert groups.
12. **GGUF v3** aligns and indexes tensors but carries no token-dependent page
    routing metadata.
13. **MoE-Infinity** predicts request-level expert use; every cache miss still
    moves a whole expert.
14. **PowerInfer-2** pipelines storage I/O for neuron clusters; clusters not equal
    to aligned pages can overfetch.
15. **ProSparse** creates ReLU activation sparsity; page sparsity occurs only if
    inactive neurons occupy pages separate from active neurons.
16. **CATS** thresholds activations contextually, but its sparsity ratio alone
    cannot establish a lower physical-page count.
17. **Turbo Sparse** reduces activated SwiGLU parameters; one active neuron per
    page remains a counterexample to page locality.
18. **LLaMA-MoE** extracts routable experts without making page occupancy an
    expert-construction objective.
19. **Dynamic Input Pruning** biases selection toward cache-resident channels;
    it optimizes cache traffic, not page-aligned useful-byte occupancy.
20. **HOBBIT** combines adaptive expert prefetch and mixed precision, but moves
    expert representations rather than page-aligned groups.
21. **safetensors** indexes contiguous tensor slices; it does not pack
    token-selected neurons into those slices.
22. **io_uring** can batch and overlap page-sized reads but does not decide which
    model pages are requested.
23. **O_DIRECT** exposes cold-path overfetch by minimizing page-cache effects; it
    cannot make an aligned block semantically useful.
24. **SPDK** lowers NVMe command overhead while returning the same requested LBA
    bytes; layout remains the application's responsibility.
25. **NVMe FDP** groups writes by expected lifetime in reclaim units; it does not
    alter read-command granularity or token co-access.
26. **NAND read-disturb studies** show repeated reads can disturb neighboring rows
    in an erase block, but host traces cannot infer controller remapping or a
    device-independent model-read limit.
27. **Local Routing Consistency** defines bounded-future expert-cache metrics;
    equal cache hit rates can still transfer different page-byte volumes.
28. **MoE-SpeQ** forecasts future-token experts and prefetches quantized experts;
    it does not jointly optimize physical page placement.

## Gap And Pre-Registered Hypothesis

No reviewed work jointly specifies all of: (1) parameter groups constructed from
token co-activation, (2) groups serialized on explicit storage-page boundaries,
(3) bounded lookahead routing of those pages, and (4) measurement of useful
parameter bytes against all fetched container bytes. DiskLM will test whether
that combination improves the frozen metrics. A null or negative result is valid.

## UPT Answer

Search boundary (2026-07-26): arXiv title/abstract and Google Scholar queries for
`"useful parameters per token"`, `"useful bytes" LLM page`, `LLM page locality
metric`, `dense model storage page routing`, and `UPT LLM inference`, followed by
backward references from the 28 included primary sources. Included works had to
define LLM parameter selection, offload, model containers, or storage semantics;
unrelated uses of UPT were retained only to disambiguate the acronym.

That bounded search found no primary LLM-inference publication defining “UPT” as useful
parameters per token/page, nor an equivalent metric reported for a dense 1B
model. Published uses include unrelated “Universal Physics Transformers” and
“Unsupervised Post-Training.” The closest vocabulary is activated parameters per
token, storage bytes per token, I/O amplification, and expert-cache hit rate.
Therefore this project uses the explicit `useful_parameter_byte_ratio` definition
in `EVAL_CONTRACT.md` and does not present UPT as established terminology.

## Reproduction

Run `npm run research:verify`. The verifier requires at least 25 gap rows, unique
keys, six columns, matching parsed bibliography entries, HTTPS sources, frozen
contract fields, three seeds, explicit UPT/search and amendment language, and no
benchmark constants outside the contract import. Semantic claims still require
the mandated two-person read-through; CI cannot prove literature correctness.

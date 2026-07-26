# MiniCPM5-1B Architecture Audit

## Provenance

- Checkpoint: `openbmb/MiniCPM5-1B@4e9de7a0778dc1c362e983e6858f0e77542cbdca`
- Method: pinned config/tokenizer files plus the safetensors header; model tensors
  were not loaded or executed.
- Architecture declaration: `LlamaForCausalLM` (`llama`)

## Measured Structure

| Field | Value |
| --- | ---: |
| Parameters from 219 tensor shapes | 1,080,632,832 |
| Brief parameter claim | 1,080,632,832 |
| Delta from brief | +0 |
| Tensor payload bytes | 2,161,265,664 |
| Layers | 24 |
| Hidden / intermediate size | 1536 / 4608 |
| Query / KV heads | 16 / 2 |
| GQA ratio | 8:1 |
| Head dimension | 128 |
| Max positions | 131,072 |
| RoPE theta / scaling | 5,000,000 / `None` |
| Vocabulary | 130,560 |
| Tied embeddings | `False` |
| Activation / norm | `silu` / RMSNorm epsilon `1e-06` |

The tensor-derived total exactly matches the brief.
The checkpoint confirms 24 layers, 8:1 grouped-query attention, and a
131,072-token configured context.

## Parameter Breakdown

Each transformer layer has `28,314,624` parameters. Global tensors have
`401,081,856` parameters. Module totals across all layers are recorded below.

| Module | Parameters |
| --- | ---: |
| `input_layernorm` | 36,864 |
| `lm_head` | 200,540,160 |
| `mlp.down_proj` | 169,869,312 |
| `mlp.gate_proj` | 169,869,312 |
| `mlp.up_proj` | 169,869,312 |
| `model.embed_tokens` | 200,540,160 |
| `model.norm` | 1,536 |
| `post_attention_layernorm` | 36,864 |
| `self_attn.k_proj` | 9,437,184 |
| `self_attn.o_proj` | 75,497,472 |
| `self_attn.q_proj` | 75,497,472 |
| `self_attn.v_proj` | 9,437,184 |

## Tokenizer And Template

The tokenizer is `PreTrainedTokenizerFast`, with the special-token map in
`tokenizer_report.json`. The exact pinned template is copied to `chat_template.jinja`.
`template_render.txt` records a deterministic tool definition and assistant tool
call; the generator verifies the function name and `city=Nairobi` argument survive
serialization.

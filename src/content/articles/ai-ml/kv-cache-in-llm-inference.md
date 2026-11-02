---
summary: Why LLMs store the keys and values of every past token, how that turns generation from quadratic to linear work, and why the cache, not the model weights, is often what limits context length and batch size.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A transformer generates one token at a time, and each new token attends to every earlier one. The earlier tokens' **keys (K) and values (V)** don't change, so we compute them once and keep them in GPU memory: the **KV cache**. Each step then does work for just one new token instead of re-processing the whole sequence. The price is memory: the cache grows linearly with context length × batch size × layers. At long contexts it can be bigger than the model itself. Most of modern inference engineering (**GQA/MQA, PagedAttention, prefix caching, KV quantization, sliding windows, MLA**) is about making that cache smaller or using it better.

## Background: what attention needs

In each attention layer, every token's hidden state `x` is projected into three vectors:

- a **query** `q = x·W_q` ("what am I looking for?"),
- a **key** `k = x·W_k` ("what do I contain?"),
- a **value** `v = x·W_v` ("what do I pass on if selected?").

Token *t*'s output is a weighted average of the values of all tokens it may see, weighted by how well its query matches their keys:

```text
attn(q_t) = softmax( q_t · [k_1 … k_t]ᵀ / √d ) · [v_1 … v_t]
```

Decoder-only LLMs (GPT, Llama, Claude, Gemini, Mistral …) use a **causal mask**: token *t* sees only tokens `1…t`. That one constraint makes the KV cache possible. Because a token never attends to the future, **its key and value are final as soon as it has been processed.** Nothing generated later can change them.

## The problem: generation is a loop

LLMs generate **autoregressively**. They produce one token, append it to the input, and run the model again. Without any caching, step *t* would run the full forward pass over all *t* tokens, recomputing keys and values for tokens that haven't changed since the last step.

![Two triangular grids of six steps. On the left every cell is computed at every step, 21 in total. On the right only the diagonal is computed, 6 in total, and the rest is read from cache.](/figures/kv-cache/recompute-vs-cache.svg "Without a cache, step t recomputes K/V for the whole prefix. With one, each step adds one row.")

For `n` generated tokens, that's `1 + 2 + … + n = n(n+1)/2` key/value projections per layer, so **quadratic** work for what should be linear. At 2,000 tokens, it's ~1,000× more projection work than needed.

## How the KV cache works

Keep, for every layer and every attention head, a growing tensor of past keys and values:

```text
K_cache[layer]: [batch, kv_heads, seq_len, head_dim]
V_cache[layer]: [batch, kv_heads, seq_len, head_dim]
```

Then each decoding step, for each layer:

1. Run the **one new token** through the projections to get `q_t, k_t, v_t`.
2. **Append** `k_t, v_t` to the cache.
3. Compute attention of `q_t` against **all** cached keys and values.
4. Continue through the rest of the layer (MLP etc.) for the one token only.

![The new token is projected to q, k and v. k and v are appended to the cached K and V. The query is scored against all keys, the softmax weights mix the values.](/figures/kv-cache/decode-step.svg "One decoding step for one head. Only q_t, k_t and v_t are computed. Everything else is read from memory.")

Here it is in about 20 lines of NumPy, for a single head:

```python
import numpy as np

def softmax(x):
    e = np.exp(x - x.max())
    return e / e.sum()

class CachedAttentionHead:
    def __init__(self, Wq, Wk, Wv):
        self.Wq, self.Wk, self.Wv = Wq, Wk, Wv
        self.K = np.empty((0, Wk.shape[1]))   # [seq, d]
        self.V = np.empty((0, Wv.shape[1]))

    def step(self, x_t):                      # x_t: [d_model] for the newest token
        q = x_t @ self.Wq
        self.K = np.vstack([self.K, x_t @ self.Wk])   # append, never recompute
        self.V = np.vstack([self.V, x_t @ self.Wv])
        scores = self.K @ q / np.sqrt(q.shape[0])     # [seq]
        return softmax(scores) @ self.V               # [d]
```

Real implementations preallocate the cache instead of `vstack`-ing (Hugging Face's `StaticCache` exists for exactly this reason), and fuse the attention into a single kernel (FlashAttention, FlashInfer). But the logic is the same.

> [!NOTE]
> Only **K and V** are cached, never **Q**. A past token's query was only needed to compute *that* token's output, which has already been produced. Future tokens use their own queries.

## Prefill and decode: two very different phases

An inference request has two phases:

![A large prefill block followed by a row of small decode steps, labelled time to first token and time per output token.](/figures/kv-cache/prefill-decode.svg "Prefill builds the cache for the prompt in one parallel pass. Decode then extends it one token at a time.")

| | **Prefill** | **Decode** |
| --- | --- | --- |
| Input per step | the whole prompt (thousands of tokens) | 1 token per sequence |
| Math | matrix × matrix | matrix × vector |
| Bottleneck | **compute** (FLOPs) | **memory bandwidth** |
| KV cache | written in bulk | read in full, appended to by one row |
| User-facing metric | time to first token (TTFT) | time per output token (TPOT), tokens/s |

Decode is memory-bound because each step must stream **all model weights plus the sequence's entire KV cache** from GPU memory (HBM) to compute just one token. A rough lower bound on decode step time is:

```text
step_time ≳ (weight_bytes + kv_cache_bytes) / memory_bandwidth
```

This is why **batching** matters so much. One weight read can serve many sequences at once. But every sequence brings its **own** KV cache, so the cache, not the weights, ends up limiting how big the batch can get.

## How big is the cache?

Per token, the cache stores one key and one value vector per KV head, per layer:

```text
bytes_per_token = 2 (K and V) × n_layers × n_kv_heads × head_dim × bytes_per_element
total           = bytes_per_token × seq_len × batch_size
```

Real numbers at FP16 (2 bytes):

| Model | Layers | KV heads × dim | Per token | 4K context | 128K context |
| --- | ---: | ---: | ---: | ---: | ---: |
| Llama 2 7B (MHA) | 32 | 32 × 128 | **512 KiB** | 2.1 GB | 69 GB* |
| Llama 3.1 8B (GQA) | 32 | 8 × 128 | **128 KiB** | 0.5 GB | 17 GB |
| Llama 3.1 70B (GQA) | 80 | 8 × 128 | **320 KiB** | 1.3 GB | 43 GB |

<small>* Llama 2 supports 4K natively. 128K is shown only for comparison.</small>

![Line chart of KV cache size against context length for three models, reaching 69, 43 and 17 GB at 128K tokens, with a dashed line at 80 GB.](/figures/kv-cache/memory-growth.svg "KV cache size grows linearly with context. A single 128K-token conversation on Llama 3.1 70B needs 43 GB for the cache alone, on top of 140 GB of FP16 weights.")

Now multiply by batch size. Thirty-two concurrent 8K-token chats on Llama 3.1 8B need `32 × 8,192 × 128 KiB ≈ 34 GB` of cache. That's twice the model's ~16 GB of weights. **For long contexts and high concurrency, the KV cache is the dominant consumer of GPU memory.**

## Making the cache smaller

### 1. Share K/V heads: MQA and GQA

Standard **multi-head attention (MHA)** gives each query head its own key and value head. Shazeer (2019) showed you can have *all* query heads share **one** K/V head (**multi-query attention, MQA**) with only a small quality loss. That shrinks the cache by the number of heads (e.g. 32×). **Grouped-query attention (GQA)** (Ainslie et al., 2023) is the middle ground: groups of query heads share a K/V head. Llama 3 uses 8 KV heads for 32 (8B) or 64 (70B) query heads, which is a 4–8× reduction compared with MHA with almost no quality loss. GQA is now the default in most open models.

![Three diagrams: eight query heads each with their own KV head (MHA), four query heads per KV head (GQA), and all eight sharing one (MQA).](/figures/kv-cache/mha-gqa-mqa.svg "The number of cached K/V heads, not query heads, is what sets the cache size.")

### 2. Compress K/V into a latent: MLA

DeepSeek-V2 (2024) introduced **multi-head latent attention (MLA)**. Instead of caching full K and V, it caches a small shared **latent vector** per token and up-projects it to keys and values when needed. The up-projection can be folded into other matrices, so it costs almost nothing at inference time. DeepSeek reports a **93.3% smaller KV cache** than their earlier 67B dense model, with better quality. DeepSeek-V3 and R1 use it too.

### 3. Quantize the cache

Store K and V in **FP8, INT8, or even 2–4 bits** instead of FP16. FP8 KV cache halves memory and is widely supported (vLLM, TensorRT-LLM, SGLang). Research methods like **KIVI** (2024) go down to 2 bits by quantizing keys per-channel and values per-token, because keys have outlier channels and values don't.

### 4. Don't keep everything: windows, sinks and eviction

- **Sliding-window attention** (Mistral 7B, and alternating local/global layers in Gemma 2/3) attends only to the last `W` tokens in some or all layers. The cache becomes a fixed-size **rolling buffer**. Mistral reports 8× less cache memory at 32K tokens with a 4K window.
- **Attention sinks / StreamingLLM** (Xiao et al., 2023) found that models put huge attention on the first few tokens. If you keep those "sink" tokens plus a recent window, you can stream effectively unbounded input without the model collapsing.
- **Heavy-hitter eviction (H2O)**, SnapKV, and similar methods drop cached tokens that have received little attention so far. These are lossy, so test them on your own tasks.

## Using the cache better

### PagedAttention (vLLM)

Early serving systems reserved one **contiguous** chunk of memory per request, sized for the *maximum* possible length. Most requests stop far short of that, so the memory sat unused. The vLLM paper (Kwon et al., SOSP 2023) measured that existing systems used only **20–38%** of KV cache memory for actual token states. The rest was lost to reservation and fragmentation.

**PagedAttention** borrows the operating-system idea of **virtual memory paging**. The cache is split into fixed-size **blocks** (e.g. 16 tokens). Each request has a **block table** mapping its logical blocks to physical blocks, which can sit anywhere in GPU memory and are allocated only when needed.

![Two requests' logical KV blocks mapped through block tables to scattered physical blocks in GPU memory.](/figures/kv-cache/paged-attention.svg "Logical blocks map to non-contiguous physical blocks. Only the last block of each request can be partly empty.")

Waste drops to under 4% (just the unfilled tail of each request's last block), so many more requests fit in a batch. vLLM reported **2–4× higher throughput** than the previous state of the art at the same latency. Paging also makes **sharing** cheap. Parallel samples or beam-search branches can point at the same physical prefix blocks, with copy-on-write when they diverge.

### Prefix caching

Many requests start with the **same tokens**: a long system prompt, few-shot examples, a document being asked about repeatedly, or the earlier turns of a chat. Their K/V for that prefix is **identical**, so compute it once and reuse it:

- **Automatic prefix caching** in vLLM hashes each full block of tokens (together with its prefix) and reuses matching blocks across requests.
- **RadixAttention** in SGLang keeps cached prefixes in a **radix tree** and evicts them least-recently-used, which suits multi-turn chat and agent workloads.
- **API-level prompt caching** (offered by Anthropic, OpenAI, Google and others) is this idea sold as a product. Mark or reuse a stable prompt prefix, and later requests skip its prefill. You get lower latency and pay a discounted price for cached input tokens.

> [!TIP]
> **Design prompts for cache hits.** Put stable content (system prompt, tool definitions, reference documents) **first**, and variable content (the user's question, timestamps, request IDs) **last**. A single changed token early in the prompt invalidates the cache for everything after it.

### Offloading and disaggregation

- **Offload** cold cache blocks to CPU RAM or SSD and bring them back on reuse (vLLM, LMCache, NVIDIA Dynamo).
- **Disaggregated prefill/decode** runs the compute-heavy prefill and the memory-heavy decode on different GPU pools (DistServe, Mooncake, NVIDIA Dynamo) and ships the KV cache between them over a fast interconnect. The cache becomes a first-class object that moves around the cluster.

## Real-world use cases

| Scenario | Why the KV cache matters |
| --- | --- |
| **Chat assistants** | Each new turn reuses the K/V of the conversation so far (prefix caching), so a 50-turn chat doesn't re-prefill 50 turns every time. |
| **Coding agents / tool use** | Agents loop dozens of times over a growing context full of files and tool output. Prefix caching often decides whether the agent feels fast and is affordable. |
| **RAG over a fixed corpus** | The same retrieved documents show up in many queries. Caching their K/V, or precomputing it (e.g. CacheBlend), cuts TTFT. |
| **Long-context analysis** | Reading a 500-page contract in a 200K-token window is mostly a KV-memory problem. GQA/MLA and FP8 cache make it fit on one node. |
| **High-throughput serving** | Paged allocation + continuous batching keeps hundreds of sequences in flight per GPU. Batch size is bounded by free KV blocks. |
| **On-device LLMs** | Phones have a few GB of RAM. Small models with GQA, sliding windows and quantized caches are how a 3B model handles a few thousand tokens of context locally. |

## Pitfalls and gotchas

> [!WARNING]
> **The cache is part of the model's state.** Bugs here are silent. If positions are off by one, cache entries are mixed between sequences in a batch, or a stale prefix is reused after the system prompt changed, you get subtly wrong outputs, not crashes.

- **Positional encodings interact with caching.** With RoPE, keys are rotated by their absolute position *before* being cached. Evicting or shifting tokens (sliding windows, StreamingLLM) means tracking positions carefully. StreamingLLM assigns positions within the cache rather than in the original text.
- **Out-of-memory under load.** A server that admits requests based on prompt length alone can OOM as generations grow. Engines reserve blocks, preempt requests and swap their cache out, or recompute it later.
- **Prefix caching and privacy.** Cache hits are faster, and that timing difference can reveal whether another user sent the same prefix. Multi-tenant systems isolate caches per tenant or organisation.
- **Batch-invariance and determinism.** Different batch compositions and cache layouts can change floating-point reduction order, so the same prompt may not produce bit-identical output across runs. That matters for evals and debugging.
- **Benchmarks lie at short context.** A model and server that look fast at 1K tokens can fall over at 64K. Always measure TTFT and TPOT at your real context lengths and concurrency.

## Discussion questions

1. Why can encoder-only models like BERT not benefit from a KV cache in the same way? What property of causal attention makes caching valid?
2. Compute the KV cache for Llama 3.1 70B serving 16 users at 32K tokens each in FP8. Does it fit on 8×80 GB GPUs alongside FP8 weights?
3. MQA cuts the cache 32× but GQA became the default. What do you lose with MQA, and why does GQA recover most of it?
4. Prefix caching only helps if the prefix is byte-identical. How would you restructure a chat app's prompt (date, user name, tools, history) to maximise hits?
5. Why is decode memory-bound even on a GPU with enormous compute? What does batching change, and what stops you batching forever?
6. PagedAttention is "virtual memory for the KV cache". Which other OS ideas (copy-on-write, swapping, LRU) show up in LLM serving, and where?

## FAQ

### Does the KV cache change the model's output?

No. It's an exact optimisation. Past keys and values can't change under causal attention, so reusing them gives the same result as recomputing them, up to tiny floating-point differences. Lossy techniques built on top of it, such as KV quantization, eviction and sliding windows, **can** change outputs, so evaluate those separately.

### Is this the same as "prompt caching" in LLM APIs?

Prompt caching is the KV cache **kept across requests**. Normally a request's cache is thrown away when it finishes. With prompt or prefix caching, the provider keeps the K/V for a prompt prefix for a while. When your next request starts with exactly the same tokens, it skips prefill for that part. That's why cached input tokens are cheaper and the first token comes back faster.

### If the cache removes recomputation, why do long contexts still get slower?

Each new token still has to **read** the whole cache to attend over it. At 100K tokens of context, every decoding step streams 100K keys and values per layer from GPU memory. Per-token time and memory both grow linearly with context. The cache removes the *quadratic recompute*, not the *linear read*.

### How do I estimate how much memory I need?

Use `2 × layers × kv_heads × head_dim × bytes_per_value` per token, from the model's `config.json` (`num_hidden_layers`, `num_key_value_heads`, `head_dim` or `hidden_size / num_attention_heads`). Multiply by the longest context you'll serve and the number of concurrent sequences. Add the weights and ~10–20% headroom for activations and fragmentation.

### Does FlashAttention shrink the KV cache?

No. FlashAttention computes attention in tiles, so it never materialises the full attention-score matrix, which saves memory traffic and time. The K and V tensors it reads are still the full cache. To shrink the cache itself, use GQA/MQA, MLA, quantization or windows. FlashAttention-style kernels and a paged KV cache are complementary, and engines use both.

### Can different users share a KV cache?

Only for **byte-identical prefixes**, such as a common system prompt, and only if it's safe. Cache-hit timing can leak whether someone else recently sent the same prefix, so multi-tenant services usually scope caches per organisation or account.

### Is the KV cache the model's "memory" of earlier conversations?

No. It's per-request working state that disappears when the request ends, or when a prompt cache entry expires. A model "remembers" an earlier chat only because the app sends that chat again as part of the next prompt. The KV cache just makes re-reading it cheaper.

## Key takeaways

- Causal attention makes past keys and values **immutable**, so caching them is exact, not an approximation.
- The cache turns generation from **quadratic** to **linear** work, but it makes decode **memory-bandwidth-bound**.
- Cache size = `2 × layers × kv_heads × head_dim × bytes × tokens × batch`. At long context it rivals or beats the weights.
- **Shrink it** with GQA/MQA, MLA, quantization and windows. **Manage it** with paging, prefix caching, offloading and disaggregation.
- Prompt structure is a performance feature: **stable prefix first, variable suffix last.**

## References

1. A. Vaswani et al. [Attention Is All You Need](https://arxiv.org/abs/1706.03762). *NeurIPS 2017*.
2. N. Shazeer. [Fast Transformer Decoding: One Write-Head is All You Need](https://arxiv.org/abs/1911.02150). 2019 (multi-query attention).
3. J. Ainslie et al. [GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints](https://arxiv.org/abs/2305.13245). *EMNLP 2023*.
4. W. Kwon et al. [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180). *SOSP 2023* (vLLM).
5. R. Pope et al. [Efficiently Scaling Transformer Inference](https://arxiv.org/abs/2211.05102). *MLSys 2023*.
6. L. Zheng et al. [SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104) (RadixAttention). *NeurIPS 2024*.
7. DeepSeek-AI. [DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model](https://arxiv.org/abs/2405.04434) (multi-head latent attention). 2024.
8. A. Q. Jiang et al. [Mistral 7B](https://arxiv.org/abs/2310.06825) (sliding-window attention, rolling buffer cache). 2023.
9. G. Xiao et al. [Efficient Streaming Language Models with Attention Sinks](https://arxiv.org/abs/2309.17453). *ICLR 2024*.
10. Z. Zhang et al. [H₂O: Heavy-Hitter Oracle for Efficient Generative Inference of Large Language Models](https://arxiv.org/abs/2306.14048). *NeurIPS 2023*.
11. Z. Liu et al. [KIVI: A Tuning-Free Asymmetric 2bit Quantization for KV Cache](https://arxiv.org/abs/2402.02750). *ICML 2024*.
12. T. Dao et al. [FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness](https://arxiv.org/abs/2205.14135). *NeurIPS 2022*.
13. vLLM docs. [Automatic Prefix Caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html).
14. Anthropic docs. [Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching).

---
summary: How Bloom filters, Count-Min sketches and HyperLogLog answer membership, frequency and cardinality questions about billions of items in kilobytes of memory, by accepting small, bounded errors.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Probabilistic data structures trade **exactness for enormous memory savings**, with errors you can bound in advance. A **Bloom filter** answers "have I seen this key?" with **no false negatives** and a tunable false-positive rate: about **10 bits per key for 1%**, regardless of key size. A **Count-Min sketch** estimates **how often** each item appears, always over-estimating by a bounded amount. **HyperLogLog** estimates **how many distinct** items you've seen, with about **0.8% error in 12 KB** whether there are a thousand or a billion. They're used everywhere a cheap "probably" saves an expensive lookup: databases skipping disk reads, CDNs, network monitoring, analytics.

## The problem: exact answers are expensive

Some questions are easy with unlimited memory:

- **Membership:** is this URL in the set of 2 billion known-malicious URLs? Has this user already seen this article?
- **Frequency:** how many times has each IP hit us in the last minute? Which search terms are trending?
- **Cardinality:** how many unique visitors did this page get today?

Exact answers need to store every item: a hash set of 2 billion URLs at ~50 bytes each is ~100 GB. Per-IP counters for the whole IPv4 space, or exact unique-visitor sets for every page and every day, add up fast. And often the answer is used as a **filter** in front of something more expensive, where a small error is harmless as long as it's in the safe direction.

## Bloom filters

Burton Bloom described the idea in 1970.

![A 16-bit array; adding "cat" sets bits 1, 6, 11; adding "dog" sets bits 3, 6, 14; querying "fox" checks bits 1, 3, 14, which are all set, giving a false positive.](/figures/bloom-filters/bloom-filter.svg "Bits are shared between keys. That's where the memory savings come from, and also the false positives.")

A Bloom filter is a **bit array of m bits** and **k hash functions**:

- **Add(x):** compute the k hashes of x, and set those k bits to 1.
- **Query(x):** compute the k hashes. If **any** bit is 0, x was **definitely never added**. If all are 1, x is **probably** present: the bits might have been set by other keys.

So there are **no false negatives** and a **controllable false-positive rate**. A Bloom filter **can't list its keys** and **can't delete** (clearing a bit might remove other keys).

### Sizing

![False-positive rate on a log scale falling from about 9% at 5 bits per element to 0.82% at 10 bits, 0.074% at 15 and 0.0067% at 20.](/figures/bloom-filters/fp-rate.svg "Memory grows linearly while the error falls exponentially.")

With n keys, m bits and the optimal number of hash functions `k = (m/n) · ln 2`, the false-positive rate is approximately:

`p ≈ (1/2)^k ≈ 0.6185^(m/n)`

Rules of thumb:

| Bits per key | Optimal k | False positives |
| --- | --- | --- |
| 5 | 3 | ~9% |
| 10 | 7 | ~1% |
| 15 | 10 | ~0.07% |
| 20 | 14 | ~0.007% |

About **4.8 extra bits per key** cut the error tenfold. Crucially, the size doesn't depend on **how big the keys are**: a filter for 1 billion URLs at 1% takes about **1.2 GB**, whether the URLs are 20 or 2,000 bytes long.

In practice you don't need k independent hash functions: two hashes h₁ and h₂ combined as `h₁ + i·h₂` work just as well (Kirsch and Mitzenmacher, 2006).

### Variants

- **Counting Bloom filter:** small counters instead of bits, so you can delete (decrement). Uses 3–4× more memory.
- **Scalable Bloom filter:** a series of filters that grow as more items are added, keeping the error bounded without knowing n in advance.
- **Blocked Bloom filter:** all k bits for a key fall within one CPU cache line, so a query costs one cache miss instead of k. RocksDB and others use this.
- **Cuckoo filter** (Fan et al., 2014): stores short fingerprints in a cuckoo hash table. Supports **deletion**, and uses less space than a Bloom filter for false-positive rates below about 3%.
- **Xor and binary fuse filters** (2020–2022): static (built once from a known set), about 20–25% smaller than Bloom filters and very fast to query.
- **Quotient filters**: cache-friendly, support deletion and merging, used in some storage engines.

### What Bloom filters are used for

The classic pattern: **put a Bloom filter in front of an expensive lookup** so most negative lookups skip it.

- **LSM-tree databases** (RocksDB, LevelDB, Cassandra, HBase, ScyllaDB): each SSTable has a Bloom filter. A read for a key that isn't in a file skips reading that file from disk. With dozens of files per read, this is the difference between one disk read and many.
- **CDNs and caches:** Akamai found that about 75% of URLs were requested only once ("one-hit wonders"), so it caches an object only on its **second** request, using a Bloom filter to remember first requests. That saved a large share of disk writes and cache space.
- **Databases:** PostgreSQL's `bloom` index extension; Bloom filters in hash joins and in distributed joins to avoid shipping rows that can't match (Spark runtime filters, ClickHouse skip indexes).
- **Web browsers:** Chrome used to check URLs against a local Bloom filter of malicious sites before asking Safe Browsing servers (it later switched to prefix sets).
- **Bitcoin:** BIP 37 lite clients sent Bloom filters to full nodes to receive only relevant transactions (later found to leak privacy).
- **Spell checkers, "username taken" checks, deduplicating crawl frontiers** in web crawlers.

## Count-Min sketch

A Bloom filter says *whether* you've seen something. A **Count-Min sketch** (Cormode and Muthukrishnan, 2005) estimates *how many times*.

![A grid of 3 rows by 8 counters; the key "tea" hashes to one counter per row with values 7, 6 and 9; the estimate is the minimum, 6.](/figures/bloom-filters/count-min.svg "Each row over-estimates because of collisions. The least-collided row is the best guess.")

- A grid of **d rows × w counters**, with one hash function per row.
- **Increment(x):** add 1 to one counter in each row (the one x hashes to).
- **Estimate(x):** the **minimum** of x's d counters.

Collisions only ever **add**, so every counter is ≥ the true count, and the minimum is the tightest bound. With `w = ⌈e/ε⌉` and `d = ⌈ln(1/δ)⌉`, the estimate exceeds the true count by at most **εN** (N = total of all counts) with probability at least **1 − δ**. Memory is fixed regardless of how many distinct items there are.

Uses:

- **Heavy hitters / top-k:** combined with a small heap, find the most frequent items in a stream (trending hashtags, top IPs, hot keys).
- **Rate limiting and abuse detection** across millions of keys with fixed memory.
- **Network monitoring:** per-flow traffic estimates in routers and switches.
- **Database query planning:** frequency estimates for skewed values.

Small counts are relatively inaccurate (the error is absolute, εN), so sketches are best for finding **large** counts. Conservative update (only increment counters equal to the current minimum) noticeably reduces over-estimation.

## HyperLogLog

**HyperLogLog** (Flajolet, Fusy, Gandouet and Meunier, 2007) estimates the number of **distinct** items in a stream.

![Four hashes with 3, 0, 6 and 1 leading zeros; seeing 6 leading zeros suggests about 64 distinct values; splitting into many registers and averaging gives about 0.8% error in 12 KB.](/figures/bloom-filters/hyperloglog.svg "One register is a noisy estimate. Thousands of them, averaged, are a precise one.")

The intuition: hash every item to a uniformly random bit string. A hash starting with k zeros happens with probability 1/2^k. So if the **longest run of leading zeros** you've seen is 6, you've probably seen around 2^6 = 64 distinct items. Duplicates hash to the same value, so they don't change anything.

One such estimate is very noisy. HyperLogLog:

1. Uses the first p bits of the hash to pick one of **2^p registers**.
2. Stores in each register the **maximum** leading-zero count (plus one) seen among the remaining bits.
3. Combines the registers with a **harmonic mean**, which limits the influence of outliers, plus bias corrections for small and large ranges.

Standard error is about **1.04 / √(2^p)**. Redis uses 2^14 = 16,384 registers of 6 bits, so **12 KB** gives **0.81%** error for any cardinality up to 2^64.

Two HyperLogLogs **merge** by taking the register-wise maximum, which gives the cardinality of the **union**. So you can keep one HLL per hour and combine them into days or weeks, or per shard and combine across a cluster. (Intersections are possible via inclusion-exclusion, but with much worse error.)

Google's **HyperLogLog++** (2013) improved accuracy for small cardinalities with a sparse representation and empirical bias correction. It's what BigQuery's `APPROX_COUNT_DISTINCT` and many other systems use.

## Others in the family

- **MinHash:** estimates Jaccard similarity between sets. Used for near-duplicate detection (web pages, documents).
- **Locality-sensitive hashing:** finds similar items without comparing all pairs.
- **t-digest, KLL, DDSketch:** approximate **quantiles** (p50, p99) over streams in bounded memory. Used for latency percentiles.
- **Reservoir sampling:** a uniform random sample of a stream of unknown length.
- **Skip lists, treaps:** randomized, but exact, data structures.

## Where it's used

| System | Structure | Purpose |
| --- | --- | --- |
| **RocksDB, Cassandra, HBase, LevelDB** | Bloom filters (blocked / ribbon in RocksDB) | Skip SSTables that don't contain a key |
| **Redis** | HyperLogLog built in. Bloom, cuckoo, Count-Min, top-k and t-digest via Redis Stack / modules | Unique counts, membership, frequencies |
| **BigQuery, Snowflake, Presto/Trino, Spark** | HyperLogLog(++) | `APPROX_COUNT_DISTINCT` |
| **Akamai** | Bloom filter | Don't cache one-hit wonders |
| **Elasticsearch** | HyperLogLog++ | `cardinality` aggregation |
| **Apache DataSketches** (Yahoo) | Theta, HLL, KLL, frequent items | Mergeable sketches for analytics |
| **Network switches / routers** | Count-Min and variants | Heavy-hitter flow detection |

### Use case walk-through: "don't show articles a user has already seen"

A news feed must not show an article to a user who has already seen it. There are 50 million users, each having seen up to 2,000 articles.

1. **Exact:** a set of (user, article) pairs is 100 billion entries in the worst case. Too big to check on every feed render.
2. **Bloom filter per user:** 2,000 items × 10 bits = 2.5 KB per user for 1% false positives, or about 125 GB total in a key-value store, fetched once per feed render.
3. A **false positive** means a new article is wrongly hidden: 1% of candidates are skipped. With hundreds of candidates per feed, that's harmless.
4. A **false negative** (showing a seen article) is impossible.
5. Filters are rebuilt monthly (articles older than a month aren't recommended anyway), which also handles the "can't delete" limitation.

## Pitfalls

- **Using a Bloom filter where false positives are harmful.** "Is this username taken?" can say "taken" for a free name. Fine as a fast pre-check, not as the final answer.
- **Undersizing.** Add more than the planned n and the false-positive rate climbs fast. Size for the maximum, or use a scalable filter.
- **Bad hash functions.** Correlated hashes destroy the error guarantees. Use well-mixed non-cryptographic hashes (xxHash, MurmurHash3).
- **Count-Min for rare items.** The error is relative to the total count, so small counts can be wildly over-estimated.
- **Averaging HLL estimates** instead of merging registers.

> [!WARNING]
> These structures are often exposed to user input. An attacker who knows your hash functions can craft inputs that collide, inflating false positives or counts. Use seeded hashes when inputs are adversarial.

## Discussion questions

1. Why can't a standard Bloom filter support deletion? How do counting Bloom filters and cuckoo filters fix that?
2. How much memory does a Bloom filter for 500 million keys at 0.1% false positives need?
3. Why does a Count-Min sketch take the minimum across rows rather than the average?
4. How would you count unique visitors per page per day for a million pages, and then compute weekly uniques?
5. Where in your systems would a "probably" answer save an expensive lookup?
6. What happens to HyperLogLog's estimate if you add the same item a million times?

## FAQ

### Can a Bloom filter have false negatives?

Not if it's used correctly: a key that was added always has all its bits set. False negatives can appear only through bugs, such as using different hash seeds on add and query, or "deleting" from a standard filter.

### Bloom filter or cuckoo filter?

Use a **cuckoo filter** if you need deletion, or if you want very low false-positive rates (below ~3%) with less memory. Use a **Bloom filter** for simplicity, very high insert rates, or when filters must be merged with bitwise OR. For static sets, **xor or binary fuse** filters are smaller and faster than both.

### How accurate is HyperLogLog in practice?

With Redis's default (16,384 registers), the standard error is 0.81%, so about 95% of estimates are within ±1.6% of the true count. For small cardinalities, sparse representations make it nearly exact.

### Are these structures mergeable across machines?

Bloom filters (same size and hashes) merge by bitwise **OR**. Count-Min sketches merge by **adding** counters. HyperLogLogs merge by register-wise **max**. That makes them ideal for distributed systems: compute per shard or per time window, then merge.

### When should I not use them?

When you need exact answers (billing, money, permissions), when the data is small enough to store exactly, or when the cost of an error is high and not one-sided.

## Key takeaways

- Probabilistic structures give **bounded-error** answers in a **tiny, fixed** amount of memory.
- **Bloom filters:** membership with no false negatives. ~10 bits per key for 1% false positives, independent of key size.
- **Count-Min sketch:** frequency estimates that only over-estimate. Good for heavy hitters.
- **HyperLogLog:** distinct counts with ~0.8% error in 12 KB, mergeable across shards and time.
- Use them as **filters in front of expensive operations**, where the error is one-sided and cheap to absorb.

## References

1. B. H. Bloom. [Space/Time Trade-offs in Hash Coding with Allowable Errors](https://dl.acm.org/doi/10.1145/362686.362692). *Communications of the ACM*, 1970.
2. A. Broder, M. Mitzenmacher. [Network Applications of Bloom Filters: A Survey](https://www.eecs.harvard.edu/~michaelm/postscripts/im2005b.pdf). *Internet Mathematics*, 2004.
3. A. Kirsch, M. Mitzenmacher. [Less Hashing, Same Performance: Building a Better Bloom Filter](https://www.eecs.harvard.edu/~michaelm/postscripts/rsa2008.pdf). 2006.
4. B. Fan, D. Andersen, M. Kaminsky, M. Mitzenmacher. [Cuckoo Filter: Practically Better Than Bloom](https://www.cs.cmu.edu/~dga/papers/cuckoo-conext2014.pdf). *CoNEXT 2014*.
5. G. Cormode, S. Muthukrishnan. [An Improved Data Stream Summary: The Count-Min Sketch and its Applications](http://dimacs.rutgers.edu/~graham/pubs/papers/cm-full.pdf). *Journal of Algorithms*, 2005.
6. P. Flajolet, É. Fusy, O. Gandouet, F. Meunier. [HyperLogLog: the analysis of a near-optimal cardinality estimation algorithm](https://algo.inria.fr/flajolet/Publications/FlFuGaMe07.pdf). 2007.
7. S. Heule, M. Nunkesser, A. Hall. [HyperLogLog in Practice: Algorithmic Engineering of a State of The Art Cardinality Estimation Algorithm](https://research.google/pubs/hyperloglog-in-practice-algorithmic-engineering-of-a-state-of-the-art-cardinality-estimation-algorithm/). *EDBT 2013*.
8. B. Maggs, R. Sitaraman. [Algorithmic Nuggets in Content Delivery](https://www.sigcomm.org/sites/default/files/ccr/papers/2015/July/0000000-0000009.pdf). *ACM SIGCOMM CCR*, 2015.
9. Redis docs. [HyperLogLog](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/) and [Bloom filter](https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/).
10. T. M. Graf, D. Lemire. [Xor Filters: Faster and Smaller Than Bloom and Cuckoo Filters](https://arxiv.org/abs/1912.08258). *ACM JEA*, 2020.

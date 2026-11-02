---
summary: Why sharding spreads keys but not load, how a single viral post or celebrity account can overload one node in an otherwise idle cluster, and the techniques for detecting and spreading hot keys.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Sharding by hash spreads **keys** evenly, but real traffic is **skewed**: a few keys (a viral post, a celebrity, a flash-sale product, a popular cache entry) get a huge share of requests. All requests for one key go to the shard that owns it, so that shard saturates while the rest of the cluster idles, and **adding nodes doesn't help**. Fixes depend on the access pattern. For **read-hot** keys: cache locally in each app server, replicate the key to several nodes, or push it to a CDN. For **write-hot** keys: **split** the key into sub-keys (salting) and combine on read, batch or buffer writes, or use commutative counters. For **hot ranges** (sequential keys): hash or prefix the key, or let the store **split** ranges by load. Detect hotness continuously, because it changes by the minute.

## The problem: skew

Most workloads follow a **power law** (Zipf distribution): the most popular item gets far more traffic than the 100th, which gets far more than the 10,000th. Sharding assigns keys to nodes, usually by hash, so each node gets a similar **number** of keys. But load depends on **which** keys a node owns.

![Load per shard across 16 shards: 15 shards are low, while shard 11 is far above capacity.](/figures/hot-keys/skew.svg "The average looks healthy. The one shard everyone is waiting on doesn't.")

Real examples:

- A celebrity's tweet or post read by millions in minutes.
- A like or view **counter** on a viral video, incremented tens of thousands of times per second.
- A product during a flash sale. Ticket inventory for a big concert.
- A **configuration or feature-flag key** that every request reads.
- A cache key for the home page.
- **Time-ordered keys** (timestamps, auto-increment IDs) in a range-partitioned store: all new writes go to the last range.

Why it's hard: a single key lives on a single shard (and its replicas). That node's CPU, network and lock throughput is a hard ceiling for that key. Adding more shards spreads other keys thinner but doesn't touch the hot one.

Hot keys also cause secondary problems: a saturated shard slows **every** key it owns (not just the hot one), cache nodes drop connections, and clients retry, adding more load.

## Read-hot keys

When a key is read far more than it's written, **make more copies** and spread reads across them.

![App servers with local caches in front of a cache node that owns the hot key and replicas holding copies, with the database rarely touched.](/figures/hot-keys/read-hot.svg "Most reads are answered without leaving the app server.")

- **Local (in-process) caching.** Each app server keeps a hot key in memory for a short TTL (1–5 s). With 200 app servers, the cache cluster sees at most 200 reads per TTL period for that key, instead of 200,000 per second. This is the most effective single technique, at the price of a few seconds of staleness.
- **Replicate hot keys** across several cache nodes: store `home_page#1 … #N` copies and pick one at random on read. Writes update all copies.
- **Read from replicas.** In databases, route reads for hot partitions to read replicas.
- **CDN / edge caching** for public content.
- **Request coalescing**, so concurrent misses for the hot key cause one fetch, not thousands.

Facebook's memcache paper describes both regional replication and leases for hot keys.

## Write-hot keys

Writes are harder, because copies must be kept consistent. The main trick is to **split the key**.

![Writes to likes:post42 are spread across eight sub-keys likes:post42#0 to #7 on different shards; a read sums all eight.](/figures/hot-keys/key-splitting.svg "Spread the writes, pay for it on reads. Worth it only for keys that are actually hot.")

- **Key splitting / salting.** Append a suffix (`#0 … #N−1`) to the key on write, chosen at random or by writer. Each sub-key lands on a different shard. Reads fetch all N sub-keys and combine them (sum for counters, merge for sets). DynamoDB's documentation calls this **write sharding**. Google's App Engine called it **sharded counters**.
- **Buffer and batch.** Accumulate increments in memory for 100 ms or 1 s per app server, then write one aggregated update. Fewer writes, slightly delayed counts.
- **Commutative updates.** Increment operations (`INCR`, `+= 1`) don't conflict the way read-modify-write does, so they avoid lock contention on the hot row. CRDT counters take this further.
- **Queue and serialize.** Send writes for the hot key to a queue (partitioned by key) processed by one consumer that applies them in batches. Flash-sale inventory systems often do this.
- **Rethink the data model.** Store per-user rows (`likes(post_id, user_id)`) and count asynchronously, rather than updating one counter row.

Only split keys that are **actually** hot. Splitting everything multiplies read costs everywhere.

## Hot ranges and monotonic keys

Range-partitioned stores (Bigtable, HBase, Spanner, CockroachDB, TiKV) keep keys in sorted order. **Monotonically increasing keys** (timestamps, sequential IDs) send every new write to the **last range**, one node.

- **Hash or prefix the key:** `hash(user_id) + timestamp` instead of `timestamp`. You lose global time ordering in exchange for spread writes.
- **Bucketing:** prefix with `timestamp % N` or a shard number, and query all N buckets for time ranges.
- **Load-based splitting:** CockroachDB, Spanner and DynamoDB **split** a range automatically when it gets hot, and move halves to different nodes. DynamoDB's **adaptive capacity** shifts throughput to hot partitions and isolates frequently accessed items. But a single key can't be split this way, so it still has a ceiling.

## Detecting hot keys

![A pipeline: sample 1 in 100 requests per node, count with a Count-Min sketch or top-k per window, merge top-k lists centrally, and act by splitting, replicating, caching or throttling.](/figures/hot-keys/detection.svg "Hotness is dynamic. A key can go from cold to hottest in the cluster in a minute.")

You can't plan for a post going viral, so detect hotness at runtime:

- **Per-node metrics:** requests per second per shard, CPU, and latency outliers show **that** a shard is hot.
- **Key-level sampling:** sample a fraction of requests and count keys with a **Count-Min sketch** or a top-k structure (Space-Saving) per time window. Merge per-node top-k lists to get a cluster-wide view.
- **Built-in tools:** `redis-cli --hotkeys` (with LFU eviction), DynamoDB CloudWatch Contributor Insights, Cassandra `nodetool toppartitions`.
- **Act automatically:** promote the key to local caches, replicate it, or start splitting writes. Notify the owner of the access pattern.

## Where it's used

| System | Hot-key handling |
| --- | --- |
| **DynamoDB** | Adaptive capacity, split-for-heat on partitions. Docs recommend write sharding with random or calculated suffixes. Contributor Insights shows top keys. |
| **Facebook memcache / TAO** | Regional replication, leases, and read-through caches for hot objects |
| **CockroachDB, Spanner, TiKV** | Load-based range splitting and rebalancing |
| **Redis Cluster** | `--hotkeys` with LFU. Client-side caching (`CLIENT TRACKING`) with invalidation messages. |
| **Google App Engine / Firestore** | Sharded counters. Firestore documents ~1 sustained write per second per document as a guideline. |
| **Kafka** | Hot partition keys cause consumer lag on one partition. Mitigated by re-keying or splitting. |

### Use case walk-through: a live-stream view counter

A streaming platform shows a live view count. A popular stream gets 100,000 increments per second.

1. **Naive:** one `INCR stream:123:views` key in Redis. A single Redis shard handles it, but it's the hottest key in the cluster, and its shard's latency affects thousands of other keys.
2. **Buffering:** each of 300 API servers aggregates increments locally and flushes every second: 300 writes/s instead of 100,000.
3. **Splitting:** for the very largest streams, flushes go to `stream:123:views#{0..15}`, chosen by server ID.
4. **Reads:** viewers poll the count every 5 s. A background job sums the 16 sub-keys every second and writes `stream:123:views:total`, which is cached in every API server for 2 seconds.
5. **Accuracy:** the count lags by a couple of seconds, which nobody watching notices.

## Pitfalls

- **Assuming more shards fix it.** They don't for a single key.
- **Splitting every key.** Fan-out reads everywhere for a problem a handful of keys have.
- **Local caches without TTLs** or invalidation, serving stale data indefinitely.
- **Retry storms** against a hot shard, which make it hotter. Use backoff with jitter and circuit breakers.
- **Monotonic keys in range-partitioned stores**, such as timestamps or UUIDv7 as the leading key component in Bigtable or HBase.
- **Hidden hot keys:** a global config key, a "current exchange rate" key, or a lock that every request touches.

> [!TIP]
> When latency rises on one shard but not others, check the **top keys** on that shard before scaling the cluster. It's often one key, and the fix is a cache or a split, not more machines.

## Discussion questions

1. Why doesn't adding more nodes help with a single hot key?
2. A key gets 500k reads/s and 1 write/minute. What would you do? What if it got 50k writes/s and few reads?
3. How do you choose N when splitting a write-hot counter? What does it cost on reads?
4. Why do timestamps make bad leading keys in Bigtable or HBase but fine keys in a B-tree?
5. How would you detect hot keys in a cache cluster without logging every request?
6. What staleness is acceptable for a like counter? For flash-sale inventory?

## FAQ

### What's the difference between a hot key and a hot shard?

A **hot key** is a single key with disproportionate traffic. A **hot shard** is a shard with disproportionate load, which can be caused by one hot key, by several warm keys landing together, or by a hot **range** of keys. The fixes differ: shards can be split and moved, single keys can't.

### Does consistent hashing solve hot keys?

No. Consistent hashing helps spread **keys** evenly and minimizes movement when nodes change. A hot key still maps to one node. Variants like consistent hashing with bounded loads help with **load balancing requests** (e.g. to caches), but not with stateful ownership of a key.

### How does DynamoDB handle hot partitions?

It splits partitions based on traffic and uses adaptive capacity to give hot partitions more throughput. But a single item is limited to roughly 3,000 reads and 1,000 writes per second (per partition). For higher rates on one logical item, you need write sharding or caching (DAX).

### Is local caching safe for data that changes?

With short TTLs, yes, for data where a few seconds of staleness is fine. For data that must be fresh, use invalidation (Redis client-side caching with tracking, or pub/sub invalidation messages) or don't cache locally.

### What causes hot partitions in Kafka?

Producers keying messages by a skewed attribute (customer ID where one customer dominates, or a null key mapping to one partition in some clients). The partition's consumer falls behind. Fixes: better keys, splitting the dominant key across partitions (if ordering allows), or more consumer capacity for that partition.

## Key takeaways

- Hashing spreads **keys**, not **load**. Skewed traffic creates hot keys and hot shards.
- **Read-hot:** local short-TTL caches, replicated copies, CDNs, request coalescing.
- **Write-hot:** split into sub-keys, buffer and batch, commutative increments, or redesign the data model.
- **Hot ranges:** avoid monotonic leading keys, and use stores that split by load.
- **Detect continuously** with sampling and sketches, and act automatically where you can.

## References

1. R. Nishtala et al. [Scaling Memcache at Facebook](https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf). *NSDI 2013*.
2. AWS docs. [Using write sharding to distribute workloads evenly](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-sharding.html) and [Burst and adaptive capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html).
3. Google Cloud. [Bigtable schema design: row keys to avoid](https://cloud.google.com/bigtable/docs/schema-design#row-keys-avoid).
4. CockroachDB docs. [Load-based splitting](https://www.cockroachlabs.com/docs/stable/load-based-splitting).
5. Firebase docs. [Distributed counters](https://firebase.google.com/docs/firestore/solutions/counters).
6. Redis docs. [Client-side caching](https://redis.io/docs/latest/develop/reference/client-side-caching/).
7. A. Metwally, D. Agrawal, A. El Abbadi. [Efficient Computation of Frequent and Top-k Elements in Data Streams](https://www.cs.ucsb.edu/sites/default/files/documents/2005-23.pdf) (Space-Saving). *ICDT 2005*.
8. M. Kleppmann. *Designing Data-Intensive Applications*, chapter 6: Partitioning ("Skewed Workloads and Relieving Hot Spots"). O'Reilly, 2017.

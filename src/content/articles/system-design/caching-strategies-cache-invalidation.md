---
summary: Cache-aside, read-through, write-through, write-back and write-around, how to keep caches from serving stale data, which eviction policy to pick, and the races that make invalidation famously hard.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A cache keeps a copy of expensive-to-get data closer to where it's needed. The **read strategy** (usually **cache-aside**) decides how data gets in. The **write strategy** (**write-through**, **write-back** or **write-around**) decides how updates reach the cache and the database. **Invalidation** decides how stale data gets out: **TTLs**, **delete-on-write**, or **event-driven** purges. The hard parts are **races** between concurrent reads and writes, **stampedes** when hot keys expire, and choosing what staleness your users can tolerate. Measure **hit rate**: the last few percent matter most.

## Why cache?

- **Latency.** A Redis lookup takes well under a millisecond in the same data centre. A database query with joins can take 10–100 ms, and a cross-region call 100 ms or more.
- **Load.** Every hit is a query the database doesn't run. Caches let a modest database serve a huge read volume.
- **Cost and resilience.** Fewer expensive calls (to databases, third-party APIs or ML models). Some caches can serve stale data when the backend is down.

![Bar charts: average latency and database queries per second at hit rates of 0, 80, 90, 95 and 99%.](/figures/caching/hit-rate-latency.svg "With a 1 ms cache and a 50 ms database at 10k req/s, going from 90% to 99% hits cuts average latency about 4× and database load 10×.")

### Caches are everywhere

| Layer | Example | Typical content |
| --- | --- | --- |
| Browser / app | HTTP cache, Service Worker, in-app memory | static assets, API responses |
| CDN / edge | Cloudflare, CloudFront, Fastly | images, JS/CSS, cacheable HTML and API responses |
| Reverse proxy | NGINX, Varnish | whole responses |
| Application, in-process | Caffeine, Guava, an LRU map | hot config, small lookup tables |
| Distributed cache | Redis, Memcached | sessions, objects, query results, computed views |
| Database | buffer pool, query cache | pages, plans |

Each layer has its own invalidation story, and stale data can hide in any of them.

## Read strategies

### Cache-aside (lazy loading)

The application talks to both the cache and the database:

![App asks the cache, misses, queries the database, then writes the result into the cache with a TTL; on write it updates the database and deletes the key.](/figures/caching/cache-aside.svg "Cache-aside is the most common pattern: simple, resilient to cache failure, and it only caches what's actually read.")

```text
read(key):
    v = cache.get(key)
    if v is miss:
        v = db.query(key)
        cache.set(key, v, ttl)
    return v

write(key, v):
    db.update(key, v)
    cache.delete(key)
```

- ✅ Only data that's actually read gets cached. If the cache dies, the app still works (slower).
- ❌ The first read of every key is a miss (a cold start after deploys or cache restarts). There's a race window, covered below.

### Read-through

The **cache library or service** loads from the database on a miss, using a loader function you register. Application code just calls `cache.get(key)`. It's the same behaviour as cache-aside, with the logic centralised (e.g. Caffeine's `LoadingCache`, or DAX in front of DynamoDB).

## Write strategies

![Three panels: write-through writes cache and DB synchronously, write-back writes cache and flushes later, write-around writes only the DB.](/figures/caching/write-strategies.svg "The write strategy trades write latency, durability and freshness against each other.")

| Strategy | How | Pros | Cons |
| --- | --- | --- | --- |
| **Write-through** | Write cache and DB together, synchronously | Cache always fresh for written keys | Slower writes. Caches data that may never be read. |
| **Write-back** (write-behind) | Write the cache, flush to the DB asynchronously | Very fast writes. Batches and absorbs repeated updates. | **Data loss** if the cache dies before flushing. Harder to reason about. |
| **Write-around** | Write the DB only, let reads populate the cache | No cache pollution from write-heavy data | First read after a write misses. Needs invalidation. |
| **Delete-on-write** (with cache-aside) | Update the DB, then delete the cache key | Simple. Avoids writing values that may race. | Next read pays the miss. |

> [!TIP]
> **Prefer delete over update.** If two writers update the DB and then `SET` the cache, the cache can end up holding the *older* value when their cache writes arrive in a different order from their DB writes. Deleting is idempotent and order-insensitive. The next reader loads whatever is current.

Write-back is common **inside** systems (CPU caches, database buffer pools, page caches). It's rarer for application caches unless losing recent writes is acceptable, as with view counters or analytics.

## Invalidation: the hard part

> "There are only two hard things in Computer Science: cache invalidation and naming things." (Phil Karlton)

### Option 1: TTL (expire after time)

Every entry expires after N seconds. It's simple, needs no coordination, and puts a hard bound on staleness. Pick TTLs per data type from **how stale is acceptable**:

| Data | Reasonable TTL |
| --- | --- |
| Product catalogue, blog posts | minutes to hours |
| User profile shown to others | 30–300 seconds |
| Feature flags, config | seconds (or push-based) |
| Prices at checkout, balances, permissions | don't cache, or validate before use |

TTLs alone mean users can see stale data for up to the TTL. Even with explicit invalidation, **always set a TTL as a safety net**, so an invalidation bug can't keep a value stale forever.

### Option 2: Explicit invalidation on write

Delete the affected keys whenever the data changes. The trouble is knowing **all** the keys that depend on a row: `user:42`, `user:42:profile_card`, `team:7:members`, `search:"ana"`… Strategies:

- **Key naming conventions** and a small set of well-defined cache entries per entity.
- **Tags / surrogate keys** (Fastly, Varnish): label responses with `user-42` and purge by tag.
- **Versioned keys**: include a version in the key (`user:42:v17`). Bumping the version makes old entries unreachable, and they expire naturally.

### Option 3: Event-driven invalidation

Subscribe to the database's change stream (Postgres logical replication, MySQL binlog, via Debezium or similar) and invalidate caches from there. Writers can't forget to invalidate, and it covers writes that bypass the app (migrations, admin tools). Facebook's memcache does this at scale: a daemon tails MySQL's commit log and broadcasts deletes to every cache cluster.

### The race that bites everyone

![Timeline: reader A misses and reads v1; writer B updates to v2 and deletes the key; reader A then sets the cache to v1.](/figures/caching/stale-race.svg "A slow reader can put an old value back into the cache after the writer has deleted it. The cache then stays stale until the TTL expires.")

Fixes, from simplest to most robust:

- **Short TTLs** limit the damage.
- **Delayed double delete:** delete on write, then delete again a short time later, after any in-flight reads have finished.
- **Version or compare-and-set:** store a version with the value, and only `SET` if the version is newer than what's cached.
- **Leases** (Facebook's memcache, NSDI 2013): on a miss, the cache hands the reader a lease token. A delete invalidates outstanding leases, so the slow reader's `SET` is rejected. Leases also limit **thundering herds**: only one lease per key is issued every few seconds, and other readers wait or get slightly stale data.

## Eviction: what to drop when full

| Policy | Idea | Good for |
| --- | --- | --- |
| **LRU** (least recently used) | Evict what hasn't been touched longest | General purpose. The default for most caches. |
| **LFU** (least frequently used) | Evict what's used least often | Stable popularity (catalogues). Resists scans. |
| **FIFO / random** | Simple order or random choice | Very cheap. Random works surprisingly well. |
| **ARC, W-TinyLFU** | Adaptive mix of recency and frequency | Mixed workloads. Caffeine uses W-TinyLFU. |
| **TTL-based** | Evict expired entries first | Data with natural freshness limits |

A one-off **scan** (a batch job reading every key once) can flush an LRU cache full of hot data. Frequency-aware policies like LFU and TinyLFU resist this. Redis lets you choose with `maxmemory-policy`, including approximated `allkeys-lru` and `allkeys-lfu`.

## Where it's used

| System | Strategy |
| --- | --- |
| **Facebook memcache** | Cache-aside, delete-on-write, commit-log-driven invalidation, leases, regional pools |
| **CDNs** | TTLs via `Cache-Control: max-age / s-maxage`, `stale-while-revalidate`, purge-by-tag |
| **E-commerce product pages** | Long TTLs plus event-driven purges when prices or stock change |
| **Session stores** | Redis as primary store with TTLs (a "cache" that is really the source of truth) |
| **ML feature and model serving** | Precomputed features cached per entity, refreshed on schedule or on change |
| **DNS** | TTLs at every resolver level. The textbook example of eventual consistency through caching. |

## Pitfalls

> [!WARNING]
> **Caching a value that controls security or money.** Permissions, balances, prices at checkout and feature entitlements need either no cache or validation at the moment of use. A stale "isAdmin = true" is a vulnerability, not a performance quirk.

- **Cache stampede.** A hot key expires, and thousands of requests miss at once and hammer the database. Use request coalescing, leases, early probabilistic refresh, or `stale-while-revalidate`.
- **Cold start.** After a deploy or cache restart, hit rate is zero. Warm critical keys first, or roll out gradually.
- **Caching nulls (or not).** If "not found" isn't cached, a flood of lookups for missing keys (or an attacker) always reaches the DB. Cache negative results briefly.
- **Unbounded keys.** Caching per-query results with user input in the key can blow up memory and hit rates. Normalise keys and cap cardinality.
- **The cache becomes the database.** If the DB can no longer handle traffic without the cache, a cache outage becomes a full outage. Capacity-plan for degraded hit rates.
- **Inconsistent layers.** You purged Redis but not the CDN or the in-process cache. Map every layer that holds a given piece of data.

## Discussion questions

1. Your product page shows a price that is cached for 10 minutes, and the price changes. What can go wrong, and how would you fix it without dropping the cache?
2. Walk through the stale-set race. Which of the mitigations would you choose for a user profile service?
3. When is write-back caching acceptable? What data would you never write-back cache?
4. How would you invalidate a cached "team members" list when any user's name changes?
5. You add a cache and p50 latency improves, but p99 gets worse. What could explain it?
6. How would you size a cache? What metrics tell you it's too small?

## FAQ

### Should I update the cache or delete the key on writes?

Delete, in most cases. Updates from concurrent writers can arrive out of order and leave an old value behind. A delete is idempotent, and the next read loads the current value. Updating can make sense for very hot keys where a miss is too expensive, but then use versioning or compare-and-set.

### What TTL should I use?

Start from the business question "how stale can this be before it's a bug?", not from performance. Then add jitter (±10–20%) so keys written at the same time don't all expire together. Keep a TTL even when you invalidate explicitly.

### Is Redis a cache or a database?

Both, depending on how you use it. As a cache, it holds copies of data whose source of truth is elsewhere, and losing it only costs performance. As a database (sessions, rate-limit counters, leaderboards), losing it loses data, so you need persistence (AOF/RDB), replication and backups.

### What's the difference between cache-aside and read-through?

Behaviourally they're the same. Who does the loading differs. With cache-aside, application code checks the cache and queries the DB. With read-through, the cache layer calls a loader you provided. Read-through centralises the logic and makes stampede protection (one load per key) easier.

### How do I cache personalised responses at a CDN?

Mostly you don't. Cache the shared parts (static assets, public data) at the edge, and fetch personalised parts separately (client-side, or with edge compute that combines a cached shell with per-user data). Never let a response containing one user's data be cached under a shared key. Check `Cache-Control: private` and the `Vary` headers.

### How do I know my cache is working?

Track **hit rate** (overall and per key prefix), **eviction rate**, **memory usage**, **latency** of hits and misses, and backend load. A falling hit rate with high evictions means the cache is too small or the keys too varied. A good hit rate with stale-data complaints means the invalidation needs work.

## Key takeaways

- **Cache-aside + delete-on-write + TTL** is the robust default.
- Choose a write strategy deliberately: **write-through** for freshness, **write-back** for speed when you can tolerate loss, **write-around** for write-heavy data.
- Invalidation needs **TTLs as a safety net**, plus **explicit** or **event-driven** purges, and protection from **races** (versions, leases).
- Choose **eviction** for your access pattern: LRU by default, frequency-aware for scan-heavy mixes.
- Never let a cache be the only thing standing between users and a database that can't cope without it.

## References

1. R. Nishtala et al. [Scaling Memcache at Facebook](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala). *NSDI 2013*.
2. AWS Whitepaper. [Database Caching Strategies Using Redis](https://docs.aws.amazon.com/whitepapers/latest/database-caching-strategies-using-redis/welcome.html).
3. Microsoft Azure Architecture Center. [Cache-Aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside).
4. Redis docs. [Key eviction](https://redis.io/docs/latest/develop/reference/eviction/).
5. G. Einziger, R. Friedman, B. Manes. [TinyLFU: A Highly Efficient Cache Admission Policy](https://arxiv.org/abs/1512.00727). *ACM TOS*, 2017.
6. N. Megiddo, D. Modha. [ARC: A Self-Tuning, Low Overhead Replacement Cache](https://www.usenix.org/conference/fast-03/arc-self-tuning-low-overhead-replacement-cache). *FAST 2003*.
7. M. Nottingham. [RFC 5861: HTTP Cache-Control Extensions for Stale Content](https://www.rfc-editor.org/rfc/rfc5861). 2010.
8. R. Fielding, M. Nottingham, J. Reschke. [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111). 2022.
9. Fastly docs. [Purging with surrogate keys](https://www.fastly.com/documentation/guides/full-site-delivery/purging/working-with-surrogate-keys/).
10. M. Fowler. [Two Hard Things](https://martinfowler.com/bliki/TwoHardThings.html).

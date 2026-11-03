---
summary: In-process, distributed and edge caches sit at different distances from the user — each layer trades freshness and invalidation effort for speed.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — A backend usually has several caches stacked between the user and the database: a **CDN or reverse proxy** at the edge, an **in-process (L1)** cache inside each server, and a **distributed (L2)** cache such as Redis or Memcached shared by all servers. The closer a cache is to the user, the faster it is and the harder it is to keep consistent. Pick a loading strategy (usually **cache-aside**), give every entry a **TTL**, invalidate on write, and protect hot keys from **stampedes**. Caching is easy to add and hard to get right; most production bugs come from stale data and synchronized expiry, not from the cache being slow.

## The problem: the database can't serve every read

A typical web backend reads far more than it writes — often 10:1 or 100:1. The same product page, user profile or configuration row is fetched thousands of times a second, and every fetch costs a network hop, a query plan, buffer-pool lookups and serialization.

As traffic grows, you hit one of these walls:

- **Latency.** A 15 ms query on the hot path of every request adds up, especially when one page triggers several of them.
- **Throughput.** The primary database runs out of CPU or connections long before the application servers do.
- **Cost.** Scaling the database vertically, or adding read replicas, is expensive compared with a few gigabytes of RAM.
- **Expensive computations.** Some answers — a rendered recommendation list, an aggregated dashboard — take hundreds of milliseconds to compute and change rarely.

Caching keeps a copy of a result somewhere cheaper to reach. The questions are *where* to keep it, *who* fills it, and *how* you stop it from serving wrong answers.

## How it works

### The layers

![Caching layers from CDN at the top through reverse proxy, in-process L1, distributed L2 to the database, with approximate latencies](/figures/server-caching/layers.svg "Each step up is faster and serves more traffic — and holds copies that are harder to invalidate.")

| Layer | Typical latency | Scope | Good for |
|---|---|---|---|
| **CDN / edge** | ~5–30 ms from the user | Per URL, shared by everyone in a region | Public, cacheable HTTP responses, static assets |
| **Reverse proxy** (Varnish, NGINX) | ~1 ms | Per URL, per data center | Whole responses for anonymous traffic |
| **In-process (L1)** (Caffeine, Guava, `lru-cache`) | ~100 ns | Per server instance | Tiny, very hot, rarely changing data: config, feature flags, reference tables |
| **Distributed (L2)** (Redis, Memcached) | ~0.5–1 ms | Shared by all instances | Sessions, computed objects, query results, rate-limit counters |
| **Database** | ~1–50 ms | Source of truth | Everything else; its own buffer pool is also a cache |

**In-process caches** are the fastest — a hash-map lookup with no serialization — but each server has its own copy. With 50 instances you have 50 copies that can disagree, and the memory is multiplied by 50. Use them for small, hot data with short TTLs, or broadcast invalidations to every instance (for example, over Redis pub/sub). Redis 6 added **client-side caching** with server-assisted invalidation for exactly this "near cache" pattern.

**Distributed caches** are a network hop away but shared: one write or delete is seen by every instance. Redis offers rich data structures (hashes, sorted sets, streams), persistence and replication; Memcached is a simpler, multithreaded key–value store that is excellent for plain object caching. Both are usually deployed as clusters with keys sharded by hash.

**Edge caches** are covered in depth by HTTP caching: they're controlled by `Cache-Control`, `ETag` and surrogate keys, and they can absorb most traffic for public content. They can't help with personalized responses unless you split pages into cacheable and per-user parts.

A common combination is **L1 + L2**: check a small in-process cache, then Redis, then the database. The L1 removes network hops for the hottest keys; the L2 keeps instances roughly consistent and protects the database when instances restart cold.

### Who fills the cache

![Cache-aside, read-through, write-through and write-behind strategies shown as flows between app, cache and database](/figures/server-caching/patterns.svg "Cache-aside is the default; the others move responsibility into the cache layer.")

- **Cache-aside (lazy loading).** The application checks the cache; on a miss it reads the database and writes the result into the cache. On writes it updates the database and *deletes* the cache entry. Simple, resilient (if the cache is down, you just read the database), and only caches what's actually requested. Most Redis and Memcached usage looks like this.
- **Read-through.** The cache library itself knows how to load a missing key (you give it a loader function). Application code just calls `cache.get(key)`. Caffeine's `LoadingCache` and many ORMs' second-level caches work this way.
- **Write-through.** Writes go to the cache, which synchronously writes to the database. The cache is always warm and fresh for written keys, at the cost of slower writes and caching data that may never be read.
- **Write-behind (write-back).** Writes go to the cache and are flushed to the database asynchronously, often batched. Writes are very fast, but a cache crash can lose acknowledged data, so it's reserved for things like counters and metrics where that's acceptable.

### Expiry and invalidation

Phil Karlton's joke that cache invalidation is one of the two hard things in computer science is popular because it's true. The tools:

- **TTL on everything.** Even if you invalidate explicitly, a TTL bounds how long a missed invalidation can live. Choose it by asking "how stale can this be before a user notices or money is wrong?"
- **Delete on write, don't update.** After writing the database, delete the key and let the next read repopulate it. Updating the cache from the writer races with concurrent writers and can leave the older value behind.
- **Versioned keys.** Put a version in the key (`product:42:v17`, or a global `catalog_version`). Bumping the version makes old entries unreachable at once; they age out by TTL.
- **Event-driven invalidation.** Subscribe to change-data-capture (Debezium on the database log) or domain events and delete affected keys. This catches writes made by other services, scripts and admin tools that would otherwise bypass your invalidation code.
- **Tag-based purges** at the CDN (surrogate keys) let one product update purge every page that shows the product.

There is a classic race even with delete-on-write: a reader misses, reads the old value from the database, a writer updates the database and deletes the key, and *then* the reader writes its stale value into the cache. Facebook's memcache paper solves this with **leases**: a miss hands out a token, and a set is rejected if the key was deleted after the token was issued. Simpler mitigations are short TTLs and a delayed second delete.

### Eviction

Caches are smaller than the data, so something must be evicted when they fill:

- **LRU** (least recently used) is the common default; Redis uses an approximated LRU when `maxmemory-policy` is `allkeys-lru`.
- **LFU** (least frequently used) keeps popular keys even if they weren't touched in the last second; Redis supports `allkeys-lfu`.
- **W-TinyLFU**, used by Caffeine, combines a small recency window with a frequency sketch and achieves near-optimal hit rates across many workloads.
- **`volatile-*`** policies in Redis evict only keys with a TTL — useful if the same instance also stores data that must not be evicted (better: don't mix them).

Watch the **hit ratio** and **eviction rate** together. A falling hit ratio with high evictions means the cache is too small or keys are too large.

### Stampedes and hot keys

![Without protection, six concurrent misses send six identical database queries; with request coalescing, one query runs and the others wait](/figures/server-caching/stampede.svg "A stampede turns one expired key into a load spike on the database at exactly the wrong moment.")

When a popular key expires, every request that arrives before it's repopulated misses and hits the database at the same moment — a **cache stampede** (or dog-pile). With thousands of requests per second on one key, this can take the database down, and a cold restart of the whole cache does the same for every key at once.

Defences, often combined:

- **Request coalescing / single-flight.** Only one request per key recomputes; others wait for its result. In-process this is a per-key future (Go's `singleflight`, Caffeine's loading cache); across instances it's a short-lived lock in Redis (`SET key NX PX 5000`).
- **Serve stale while revalidating.** Keep the stale value and return it while one request refreshes in the background — the same idea as HTTP's `stale-while-revalidate`.
- **Probabilistic early refresh.** Each read refreshes early with a probability that grows as expiry approaches (the "XFetch" algorithm of Vattani et al.), so one request usually refreshes before the key actually expires.
- **Jittered TTLs.** Add randomness (say ±10%) so keys written together don't expire together.
- **Warm-up** after deploys or cache failures, and rate-limited fallbacks to the database.

**Hot keys** are a related problem: a single key (a celebrity's profile, a flash-sale item) receives so much traffic that the one cache shard holding it saturates. Fixes include an L1 in front of the L2 for that key, replicating it under several suffixed keys (`item:7#0..#7`) and reading one at random, or using read replicas of the cache.

### Other details that matter

- **Negative caching.** Cache "not found" results (with a short TTL) so repeated lookups for missing IDs — including malicious ones — don't each reach the database.
- **Serialization.** Large JSON blobs cost CPU to encode and decode and network bandwidth to move. Cache only the fields you need, consider compact formats, and avoid multi-megabyte values that block Redis's single thread.
- **Key design.** Namespaced, predictable keys (`svc:entity:id:variant`) make invalidation and debugging possible. Include everything the value depends on — locale, currency, user tier — or users will see each other's variants.
- **Failure mode.** Decide what happens when the cache is down. Cache-aside degrades to the database, which may not survive the full load; a circuit breaker and load shedding may be needed.

## Where it's used

| System | Caching approach |
|---|---|
| Facebook | Memcache clusters with leases and McSqueal-driven invalidation from the MySQL log, serving billions of requests per second |
| Twitter/X | Large Redis and Memcached (Twemcache) deployments for timelines and object caches |
| Shopify, GitHub | Rails low-level caching backed by Memcached/Redis plus CDN caching for storefronts and assets |
| Java services | Caffeine as an L1, often in front of Redis via Spring Cache |
| E-commerce | CDN caching for catalog pages, Redis for carts and sessions, in-process caches for pricing rules |
| AWS ElastiCache, Google Memorystore | Managed Redis/Memcached for cache-aside workloads |

## Use case walk-through: a product catalog under load

An online store's product API serves 8,000 reads/s at peak; each product read joins four tables and takes ~20 ms. The primary database sits at 85% CPU and spikes past 100% during sales.

1. **Measure first.** Request logs show that 2% of products receive 70% of reads, and product data changes a few times a day.
2. **Add cache-aside with Redis.** Product reads check `product:{id}:{locale}`; on miss they query the database and store the JSON with a 10-minute TTL plus ±10% jitter.
3. **Invalidate on change.** The admin service deletes the key after each update. A CDC consumer on the products table also deletes keys, catching bulk imports and scripts that bypassed the admin service.
4. **Protect against stampedes.** Misses take a per-key Redis lock; requests that fail to get the lock wait 50 ms and retry the cache, and an expired value is served stale for up to 30 seconds while one request refreshes.
5. **Add an L1 for the hottest keys.** Each instance keeps a 5,000-entry Caffeine cache with a 10-second TTL, so flash-sale products rarely even hit Redis.
6. **Cache misses too.** Lookups for nonexistent IDs from a scraper are cached as "not found" for 60 seconds.
7. **Watch the numbers.** Dashboards show hit ratio, Redis latency, evictions and database QPS.

**Result:** the hit ratio settles at 97%, product API p99 drops from 60 ms to 4 ms, database CPU falls to 30%, and the next flash sale passes without a spike.

## Pitfalls

- **No TTL.** One missed invalidation and the wrong price lives forever.
- **Updating instead of deleting** on writes, which races with concurrent writers.
- **Synchronized expiry** from bulk-loaded keys with identical TTLs.
- **Caching per-user data under a shared key** — a privacy incident waiting to happen.
- **Unbounded in-process caches** that grow until the JVM or Node process runs out of memory.
- **Treating the cache as a database.** If losing Redis loses data you can't rebuild, it isn't a cache any more — give it persistence, replication and backups, or move that data.
- **Caching too early.** A cache hides slow queries that an index would fix, and adds a consistency problem you didn't need.

> [!WARNING]
> Make sure the system survives a completely cold cache. Restart Redis in a staging environment under realistic load: if the database falls over, you need warm-up, request coalescing or load shedding before you rely on the cache in production.

## Discussion questions

1. For a piece of data in your system, how stale can it be before it causes a real problem? How does that shape the TTL?
2. When would you put an in-process cache in front of Redis, and how would you keep the instances consistent?
3. Which writes to your database bypass your application's invalidation code?
4. How would you detect a hot key before it saturates a cache shard?
5. When is write-behind acceptable, and what data should never use it?
6. What would happen to your database if the cache's hit ratio dropped from 95% to 80% during peak?

## FAQ

### Redis or Memcached?

Memcached is a simple, multithreaded, memory-only key–value cache — great for plain object caching at high throughput. Redis adds data structures, persistence, replication, pub/sub, Lua scripting and client-side caching, which makes it the default choice for most new systems. Choose Memcached when you only need a cache and want its simplicity and multicore scaling.

### Should I cache database query results or domain objects?

Usually domain objects or computed views keyed by ID. Query-result caching is hard to invalidate because any write might change many queries' results. Caching objects by ID makes "delete key on update" straightforward.

### How do I pick a TTL?

Start from the business tolerance for staleness, then shorten it if invalidation is unreliable or lengthen it if the data rarely changes and is expensive to compute. Add jitter. Measure the hit ratio — if a longer TTL barely improves it, keep the shorter one.

### Is the database's own buffer pool not enough?

The buffer pool avoids disk reads but not query parsing, planning, joins, serialization or connection limits. A cache in front of the database saves all of that, and it can store results that are expensive to compute rather than just pages of rows.

### How do I keep the cache consistent with the database?

You generally can't make it strictly consistent without giving up most of the benefit. Aim for **bounded staleness**: delete on write, event-driven invalidation for out-of-band writes, leases or a delayed second delete for races, and a TTL as the backstop. For data that must be exact (balances, inventory decrements), read from the source of truth.

## Key takeaways

- Caches stack in **layers**; closer to the user means faster and harder to invalidate.
- **Cache-aside** with **delete-on-write** and a **TTL on every key** is the safe default.
- Use event-driven invalidation to catch writes that bypass your code.
- Defend against **stampedes** with single-flight, stale-while-revalidate, early refresh and jittered TTLs.
- Monitor hit ratio and evictions, and make sure the system survives a cold cache.

## References

- [Redis documentation — Client-side caching](https://redis.io/docs/latest/develop/reference/client-side-caching/)
- [Redis documentation — Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- [Caffeine wiki — Efficiency](https://github.com/ben-manes/caffeine/wiki/Efficiency)
- [AWS — Caching best practices](https://aws.amazon.com/caching/best-practices/)
- Rajesh Nishtala et al., "Scaling Memcache at Facebook," NSDI 2013.
- Andrea Vattani, Flavio Chierichetti and Keegan Lowenstein, "Optimal Probabilistic Cache Stampede Prevention," VLDB 2015.
- Gil Einziger, Roy Friedman and Ben Manes, "TinyLFU: A Highly Efficient Cache Admission Policy," ACM Transactions on Storage, 2017.

---
summary: Why one expired hot key, a cache restart or synchronized retries can send a wall of identical requests to your database, and the techniques that keep a herd from forming.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **thundering herd** is many clients waking up and hitting the same resource at the same moment. In caching, it's called a **cache stampede** (or dog-piling): a hot key expires, every request misses at once, and all of them run the same expensive query against the database, which slows down, which lets even more requests pile up. Defences: **coalesce** concurrent misses so only one request recomputes (single flight or a lock), **refresh early** before expiry (probabilistically, or in the background), **serve stale** data while revalidating, **add jitter** to TTLs and retries so things don't expire or retry in sync, and **warm** caches before sending them traffic.

## The problem: synchronized demand

Caches are what let a small database serve a large site. A page might be served from cache 99.9% of the time, so the database only sees 0.1% of traffic. That ratio is the danger: the database is **sized for the misses**, not for the full load.

![A graph of database queries per second: flat while the cache serves hits, then a sharp spike when a hot key expires, then back down once the cache is refilled.](/figures/stampede/stampede.svg "The spike is the same query, repeated by every request that arrived before the cache was refilled.")

What happens when a hot key expires:

1. The key for the home page, popular with thousands of requests per second, expires at 12:00:00.000.
2. In the time it takes to recompute it (say 500 ms), **every** request misses. At 2,000 req/s, that's 1,000 identical queries.
3. The database, sized for a few queries per second for this data, slows down. The recompute now takes 5 seconds instead of 500 ms, so 10,000 requests miss.
4. Connection pools fill, timeouts fire, clients retry. The database may fall over, and then **nothing** can refill the cache.

The same shape shows up elsewhere:

- **Cold cache after a restart or deploy:** every key misses at once.
- **Synchronized expiry:** thousands of keys loaded at the same moment (by a batch job or at startup) with the same TTL expire together.
- **Retries after an outage:** every client retries on the same schedule when a service comes back.
- **Cron jobs at :00:** every server's hourly job hits the same API at the top of the hour.
- **Lock release / wake-ups:** the original OS "thundering herd", where many processes blocked on one event (like `accept()` on a socket) are all woken, but only one can proceed.

## Defence 1: coalesce concurrent misses

![Five requests miss at the same time; the first acquires a lock or registers in an in-flight map and queries the database; the others wait for its result.](/figures/stampede/coalescing.svg "One query instead of a thousand, and the database never sees the herd.")

**Request coalescing** (also "single flight", "request collapsing", "dog-pile lock") ensures that for each key, **only one** recompute is in flight at a time:

- **In-process:** keep a map from key → in-flight future/promise. The first miss starts the computation and stores the future. Later misses wait on the same future. Go's `golang.org/x/sync/singleflight` is exactly this, and many caching libraries (Caffeine's `AsyncLoadingCache`, Guava's `LoadingCache`) do it automatically.
- **Across servers:** a short-lived lock in the shared cache, e.g. Redis `SET lock:key token NX PX 5000`. The holder recomputes and writes the value. Others either **wait** briefly and re-read, or **serve stale** data if they have it.
- **At the edge:** CDNs and reverse proxies do it too: NGINX `proxy_cache_lock`, Varnish request coalescing, Fastly and Cloudflare collapse concurrent misses for the same object into one origin fetch.

In-process coalescing reduces the herd from "number of requests" to "number of servers". Adding a distributed lock reduces it to one.

> [!WARNING]
> A lock-based scheme needs a **timeout**. If the lock holder crashes, the others must eventually try themselves instead of waiting forever. And waiting requests need their own deadline, or the herd just becomes a queue of blocked requests.

## Defence 2: refresh before expiry

If a hot key never actually expires under load, there's no moment when everyone misses.

### Probabilistic early expiration (XFetch)

![A curve showing the probability that a request refreshes the key rising from near zero ten seconds before expiry to one at expiry, steeper for beta 1 than beta 2.](/figures/stampede/xfetch.svg "Some request almost always refreshes shortly before expiry, and usually only one.")

Vattani, Chierichetti and Lowenstein (VLDB 2015) proposed an elegant scheme. Store with each value how long it took to compute (δ). On every read, refresh early if:

`now − δ · β · ln(random()) ≥ expiry`

Since `ln(random())` is negative, the left side is "now plus a random amount". The probability of refreshing grows exponentially as expiry approaches, and is higher when recomputation is slow (larger δ), so slow values refresh earlier. With heavy traffic, one request refreshes the key just before it expires. With light traffic, the key may expire normally, which is fine because there's no herd. β > 1 refreshes earlier. The authors show this is optimal in a precise sense, and it needs no locks or coordination.

### Background refresh

- **Refresh-ahead:** a cache library refreshes entries that are accessed close to expiry asynchronously (Caffeine's `refreshAfterWrite`), while continuing to serve the current value.
- **Proactive refresh:** a background job recomputes known hot keys on a schedule, so user requests never trigger recomputation.

## Defence 3: serve stale while revalidating

Often a slightly old value is far better than a slow or failed request.

- **Soft and hard TTLs:** store the value with a "fresh until" time and a longer "usable until" time. After the soft TTL, one request refreshes (with a lock), and everyone else keeps getting the stale value.
- **HTTP `stale-while-revalidate`** (RFC 5861): `Cache-Control: max-age=60, stale-while-revalidate=300` lets caches serve a stale response for up to 5 minutes while refetching in the background.
- **`stale-if-error`:** serve stale content if the origin is failing. This turns an outage into stale data instead of errors.
- **Facebook's memcache leases** (NSDI 2013): on a miss, memcached hands out a **lease token** to one client and tells others to wait briefly or accept a slightly stale value. Facebook reported that leases cut peak database query rates for hot keys from about 17,000/s to 1,300/s.

## Defence 4: break synchronization with jitter

![Histograms of key expirations: with a fixed TTL, all 10,000 keys expire at 60:00; with a TTL of plus or minus 10%, they spread over 12 minutes.](/figures/stampede/jitter.svg "Same number of misses, but spread thin enough for the database to absorb.")

Herds are often caused by **synchronization**: things that started together end together.

- **TTL jitter:** use `ttl × (1 + random(−0.1, 0.1))` instead of a fixed TTL, so keys written together expire at different times.
- **Retry jitter:** use exponential backoff **with jitter**, so clients don't retry in lockstep after an outage.
- **Scheduled jobs:** add a random delay (`sleep $((RANDOM % 300))` before a cron job, or a per-host offset) instead of every host firing at :00.
- **Client reconnects:** randomize reconnect delays for WebSockets and long-poll clients after a server restart.

## Defence 5: warm up and protect the backend

- **Cache warming:** before sending traffic to a new cache node or region, pre-load hot keys (from a log of recent popular keys or by replaying traffic).
- **Gradual traffic shift:** move traffic to a cold cache slowly, so misses ramp up instead of arriving all at once.
- **Consistent hashing** for cache clusters, so adding or removing a node only invalidates a small fraction of keys.
- **Backend protection:** rate limits, concurrency limits and circuit breakers in front of the database, so a herd that does get through is shed rather than taking the database down.

## Where it's used

| System | Mechanism |
| --- | --- |
| **Facebook memcache** | Leases for coalescing and stale reads, gutter pools, cold-cluster warmup |
| **NGINX** | `proxy_cache_lock`, `proxy_cache_use_stale updating`, `proxy_cache_background_update` |
| **Varnish** | Request coalescing, grace mode (serve stale while fetching) |
| **CDNs (Fastly, Cloudflare, CloudFront)** | Request collapsing, `stale-while-revalidate`, `stale-if-error`, tiered caching/origin shield |
| **Go** | `singleflight` package |
| **Caffeine / Guava (JVM)** | Loading caches that coalesce loads, `refreshAfterWrite` |
| **Linux** | `EPOLLEXCLUSIVE` and `SO_REUSEPORT` to avoid waking every process for one incoming connection |

### Use case walk-through: a product page on launch day

A product launch page is expected to get 50,000 req/s. The product data comes from a database query that takes 200 ms.

1. **Warm** the cache with the product before the launch announcement.
2. Store values with a **soft TTL** of 30 s and a **hard TTL** of 10 minutes.
3. After the soft TTL, the first request to notice acquires a Redis lock (`SET NX PX 2000`) and refreshes in the background. Everyone else gets the stale value.
4. Inside each app server, `singleflight` collapses concurrent cache misses into one cache read, protecting Redis itself from a herd on the hot key.
5. The CDN caches the rendered page with `max-age=5, stale-while-revalidate=30` and request collapsing, so most traffic never reaches the app.
6. TTLs on the thousands of related keys (reviews, recommendations) are jittered by ±15%.

On launch, the database sees roughly one query every 30 seconds for the product, instead of thousands per second.

## Pitfalls

- **Coalescing only in-process.** With 500 app servers, you still get 500 concurrent queries. Add a shared lock or rely on stale-while-revalidate.
- **Locks without timeouts**, or waiters without deadlines, which turn a herd into a pile of blocked threads.
- **Caching errors or empty results** without care: a failed recompute that caches "null" for an hour is its own outage. Cache negative results with short TTLs.
- **Restarting all cache nodes at once** during a deploy. Roll them gradually.
- **Same TTL everywhere.** Jitter is a one-line change and removes a whole class of synchronized expiry.

## Discussion questions

1. Why does a cache stampede tend to make itself worse over time?
2. Compare request coalescing, early probabilistic refresh, and stale-while-revalidate. When is each the best choice?
3. How would you warm a new cache region before shifting traffic to it?
4. Your app runs on 300 servers, each with in-process single-flight. How many database queries happen when a hot key expires? How would you reduce it to one?
5. What should a cache store when the database query fails?
6. Where else in your systems do things happen "all at once"? Cron jobs, reconnects, retries?

## FAQ

### What's the difference between a thundering herd and a cache stampede?

A **thundering herd** is the general pattern of many waiters waking at once for one resource. A **cache stampede** is the specific case where a cache miss on a hot key sends many concurrent requests to the backing store.

### Isn't serving stale data dangerous?

Depends on the data. For product descriptions, feeds and recommendations, seconds or minutes of staleness are usually invisible. For balances, inventory counts at checkout or permissions, read from the source of truth (or use short TTLs with explicit invalidation).

### How do I pick β for XFetch?

β = 1 is the paper's recommended default. Use β > 1 to refresh earlier, if recomputation is very expensive or the cost of a stampede is high. The algorithm already scales with the recompute time δ, so slow queries refresh earlier automatically.

### Does a distributed lock create a single point of failure?

It adds a dependency on the cache (usually Redis) being available, which you already depend on. Make sure lock timeouts are short and that clients fall back to recomputing (or serving stale) if the lock can't be acquired, rather than failing.

### What about hot keys that never expire?

A key that's both hot and never expires can still overload a **single cache node**. That's a different problem (hot keys) with different fixes: local in-process caching, replicating the key across nodes, or key splitting.

### How does `SO_REUSEPORT` relate to the thundering herd?

In the classic OS version, many processes block in `accept()` on the same socket, and a new connection wakes all of them even though only one can accept it. `SO_REUSEPORT` gives each process its own socket and lets the kernel distribute connections, and `EPOLLEXCLUSIVE` wakes only one waiter.

## Key takeaways

- A cache stampede happens when **many requests miss on the same key at once** and all recompute it.
- **Coalesce** misses (single flight in-process, locks or leases across servers, collapsing at the CDN).
- **Refresh before expiry**: probabilistically (XFetch) or in the background.
- **Serve stale while revalidating**, and serve stale on errors.
- **Add jitter** to TTLs, retries and schedules, and **warm** caches before they take traffic.

## References

1. A. Vattani, F. Chierichetti, K. Lowenstein. [Optimal Probabilistic Cache Stampede Prevention](https://www.vldb.org/pvldb/vol8/p886-vattani.pdf). *VLDB 2015*.
2. R. Nishtala et al. [Scaling Memcache at Facebook](https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf). *NSDI 2013*.
3. M. Nottingham. [RFC 5861: HTTP Cache-Control Extensions for Stale Content](https://www.rfc-editor.org/rfc/rfc5861). IETF, 2010.
4. Go. [Package singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight).
5. NGINX docs. [proxy_cache_lock](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_lock) and [proxy_cache_use_stale](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_use_stale).
6. Wikipedia. [Cache stampede](https://en.wikipedia.org/wiki/Cache_stampede).
7. M. Brooker. [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/). AWS Architecture Blog, 2015.
8. Caffeine wiki. [Refresh](https://github.com/ben-manes/caffeine/wiki/Refresh).
9. Varnish docs. [Grace mode and keep](https://varnish-cache.org/docs/trunk/users-guide/vcl-grace.html).

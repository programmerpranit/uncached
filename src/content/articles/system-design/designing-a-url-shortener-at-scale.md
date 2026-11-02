---
summary: The classic interview problem, worked through properly. Estimate the load, choose how to generate short codes, design a read path that serves 100k+ redirects per second, and handle hot links, analytics and abuse.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A URL shortener maps a short **code** to a long URL and redirects. Writes are modest (~1k/s). Reads are **~100× higher** and very skewed toward a few popular links, so the design is mostly about a **fast, cached read path**. Generate codes with a **counter + base62** (with range leasing so it scales), **random codes** with a collision check, or a **hash** of the URL. Store `code → URL` in a sharded **key-value store**, put a **cache** (and possibly a CDN) in front, choose **301 vs 302** deliberately, and send click analytics through an **async pipeline**. The traps are hot keys, guessable codes, and links to malware.

## Requirements

**Functional**

- `POST /links {url, customAlias?, expiresAt?}` → returns `https://sho.rt/aZ3kQ9x`.
- `GET /aZ3kQ9x` → redirects to the long URL.
- Optional: custom aliases, expiry, per-link click analytics, link management for logged-in users.

**Non-functional**

- Redirects must be **fast** (a few ms server-side) and **highly available**. A dead short link breaks every place it was shared.
- Codes should be **short** and, ideally, **not guessable**.
- Created links must never point at the wrong URL. Correctness beats availability on the write path.

## Back-of-the-envelope

![Six cards: 1.2k writes/s, 116k redirects/s, 182.5B links in 5 years, about 91 TB of storage, 7-character base62 codes, and an 80/20 click skew.](/figures/url-shortener/estimates.svg "Assumptions: 100M new links per day, 100 redirects per link created, 5 years of retention, ~500 bytes per record.")

- **Writes:** 100M/day ÷ 86,400 s ≈ **1,200/s** on average. Plan for 3–5× peaks.
- **Reads:** at 100:1, about **116,000 redirects/s** on average, several times that at peak.
- **Storage:** 182.5 billion links × ~500 bytes ≈ **90 TB** over 5 years, before replication. That's a sharded store, not one Postgres box.
- **Code length:** base62 (`0-9a-zA-Z`) gives `62⁶ ≈ 57 billion` codes at 6 characters, which isn't enough. 7 characters gives `62⁷ ≈ 3.5 trillion`, about 19× headroom.
- **Cache:** link popularity is heavily skewed. If roughly 20% of links get 80% of clicks, caching the hot set (a few TB at most, usually much less) serves the vast majority of reads.

## High-level design

![Clients → load balancer → create API (with ID allocator and links DB) and redirect service (with cache, falling back to the DB, emitting click events to Kafka).](/figures/url-shortener/architecture.svg "Separate the create path from the redirect path. They have very different load, latency and consistency needs.")

- **Create API:** validates the URL, checks for abuse, obtains a code, and writes `code → {url, owner, createdAt, expiresAt}` to the links DB.
- **Redirect service:** a tiny, stateless service. Look up the code in the cache, fall back to the DB, return the redirect, and emit a click event. This is the path to optimise.
- **Links DB:** a key-value lookup by code, which is a perfect fit for **DynamoDB, Cassandra, ScyllaDB, Bigtable** or sharded MySQL/Postgres. Partition by code, and replicate across zones.
- **Cache:** Redis/Memcached cluster, plus in-process LRU caches on redirect servers for the hottest few thousand codes.
- **Analytics:** click events go to **Kafka** and are aggregated by a stream processor into per-link counts, referrers and geography. Never write analytics synchronously on the redirect path.

## Generating short codes

![Three cards comparing hash+truncate, random codes, and counter+base62 with their pros and cons.](/figures/url-shortener/id-options.svg "All three work. The trade-offs are about coordination, collisions and guessability.")

### Option 1: Counter + base62

Keep a global counter, and encode each new ID in base62: `125 → "21"`, `1,000,000,000 → "15FTGg"`.

- ✅ No collisions, shortest possible codes, trivial to implement.
- ❌ A global counter is a bottleneck and a single point of failure, and sequential codes are **guessable**: anyone can walk `…Gg`, `…Gh`, `…Gi` and enumerate links.

**Range leasing** fixes the bottleneck. Each create server leases a block of IDs (say 1,000) from a central allocator (a DB row with `UPDATE … SET next = next + 1000 RETURNING`, or etcd/ZooKeeper) and hands them out from memory. The allocator is touched once per thousand links. A server crash wastes at most one block, which is fine.

To defeat enumeration, **scramble** the ID before encoding with a reversible permutation (a format-preserving cipher, a Feistel network, or Hashids/Sqids-style encoding with a secret salt). Codes stay unique but stop looking sequential.

### Option 2: Random codes

Generate 7 random base62 characters and insert with a **conditional write** (`PutItem` with `attribute_not_exists`, `INSERT … ON CONFLICT DO NOTHING`). Retry on collision.

- ✅ No coordination at all, and unguessable.
- ❌ Collisions grow as the space fills. With 10 billion links among 3.5 trillion codes, about 0.3% of attempts collide, which is harmless with a retry. Use 8 characters if you expect to fill a large fraction of the space.

### Option 3: Hash of the URL

`base62(sha256(url))[:7]`. The same long URL always gets the same code, which deduplicates for free.

- ❌ Truncated hashes collide, so you still need check-and-retry (e.g. rehash with a salt). Deduplication is often *not* wanted: two users shortening the same URL usually want separate links with separate analytics and owners.

**In practice:** random codes, or scrambled counters with range leasing, are the most common choices. Custom aliases (`/summer-sale`) go into the same table, with a uniqueness check and reserved-word filtering.

## The redirect path

```text
GET /aZ3kQ9x
  → in-process LRU hit?       → redirect      (~µs)
  → Redis hit?                → redirect      (~1 ms)
  → DB lookup                 → cache it, redirect (~5–10 ms)
  → not found / expired       → 404 page
  → emit click event to Kafka (async, fire-and-forget with a local buffer)
```

### 301 or 302?

| | `301 Moved Permanently` | `302 Found` / `307 Temporary Redirect` |
| --- | --- | --- |
| Browser caching | Browsers may cache it and skip your server on later clicks | Every click hits your server |
| Analytics | Undercounts repeat clicks | Accurate counts |
| Load | Lower | Higher |
| Changing the destination later | Cached clients keep the old one | Takes effect immediately |

Services that sell click analytics or allow editing links usually use **302** (or 301 with `Cache-Control: private, max-age=…` to limit caching). If you only care about load and links never change, 301 is fine.

### Hot links

A link in a viral tweet or a Super Bowl ad can get millions of clicks a minute, all hitting **one key** on **one cache shard**.

- Cache hot codes **in process** on every redirect server, so they never leave the box.
- Put the redirect behind a **CDN**: a cacheable 301/302 response at the edge absorbs the spike entirely, at the cost of analytics accuracy, which you can partly recover from CDN logs.
- Coalesce concurrent misses for the same code into one DB read.

## Analytics

Each redirect emits `{code, ts, ip-derived geo, user-agent, referrer}` to Kafka. A stream processor (Flink, Spark, ksqlDB) aggregates per-link counters into an OLAP store (ClickHouse, Druid, BigQuery) for dashboards. Keep the redirect independent of this pipeline. If Kafka is down, buffer locally or drop events, but **always redirect**.

## Abuse and safety

Shorteners are a favourite tool for hiding phishing and malware links.

- **Scan URLs on creation** against threat lists (e.g. Google Safe Browsing, internal reputation data), and **rescan** popular links later, because a domain can turn malicious after the link was created.
- **Rate limit** link creation per account and IP, and require auth for high volumes.
- Show **interstitial warnings** for flagged links. Support takedown reports.
- Don't make private documents reachable by guessing. Georgiev and Shmatikov (2016) scanned short codes and found large numbers of links to private cloud documents and map directions. That's an argument for longer, random codes and for services not to rely on short links as access control.

## Where it's used

Public shorteners (Bitly, TinyURL), platform-internal ones (t.co for X/Twitter links, lnkd.in), marketing tools with branded domains, QR-code campaigns, and internal "go links" (`go/wiki`) in many companies. The same design underlies **any ID → resource lookup service** that needs huge read throughput: invite links, share links, paste bins, file-sharing URLs.

## Pitfalls

> [!WARNING]
> **Treating it as a write problem.** Most of the effort goes into ID generation, but at ~100:1 read-to-write, the **redirect path's cache hit rate and tail latency** decide whether the service survives a viral link.

- **One global auto-increment** in a single DB: a bottleneck, and a single point of failure for every create.
- **Sequential, unsalted codes** let anyone enumerate every link.
- **Synchronous analytics writes** on redirect: one slow ClickHouse insert slows every click.
- **No expiry or cleanup policy:** storage grows forever. Decide retention up front.
- **Ignoring abuse:** your domain gets blocklisted by email providers and browsers, breaking every legitimate link too.

## Discussion questions

1. Redo the estimates for 1 billion new links per day. What changes in the design?
2. Counter vs random codes: which would you choose, and how would you prevent enumeration?
3. A link gets 2 million clicks per minute for an hour. Walk through what happens in your design.
4. How would you support editing a link's destination without stale redirects?
5. How would you design per-link analytics that are accurate to the minute, without slowing redirects?
6. What would you change for an internal "go links" service with 10,000 users?

## FAQ

### Why base62 and not base64?

Base64 includes `+` and `/` (or `-` and `_` in the URL-safe variant), which are awkward in URLs and easy to mangle when copied. Base62 (`0-9a-zA-Z`) is URL-safe and readable. Some services also remove look-alike characters (`0/O`, `1/l/I`) for links people type by hand.

### SQL or NoSQL for the links table?

The access pattern is a single-key lookup with no joins, so any key-value store works. Managed NoSQL (DynamoDB, Bigtable, Cassandra) scales horizontally with little effort. Sharded Postgres/MySQL works too, and makes user-facing link management queries (list my links) easier. Often both: a KV store for redirects, and a relational store for the management UI.

### How do I make codes unguessable but still short?

Use random codes with enough entropy (7–8 base62 characters is about 42–48 bits), or permute sequential IDs with a secret key before encoding. Never rely on obscurity for access control. Private content should still require authentication.

### How do expiring links work?

Store `expiresAt`, check it on redirect (return 410 Gone or a custom page), and set a matching TTL in the cache. A background job or the database's native TTL (DynamoDB TTL, Cassandra TTL) cleans up records later. Decide whether expired codes can ever be **reused**. Usually they shouldn't be, since old shares would suddenly point somewhere new.

### How does the redirect stay fast across the world?

Deploy redirect servers in several regions with replicated (read-mostly) data, serve popular codes from caches or a CDN close to users, and use anycast or GeoDNS to route to the nearest region. Creates can go to a home region, since a few hundred milliseconds of replication delay for a brand-new link is usually acceptable.

## Key takeaways

- Do the **estimates**: ~1k writes/s, ~100k+ reads/s, tens of TB, 7-character base62 codes.
- Choose code generation deliberately: **scrambled counter + range leasing** or **random + conditional insert**.
- The **redirect path** is the product: KV lookup, multi-level caching, CDN for viral links, async analytics.
- **301 vs 302** is a trade-off between load and analytics or editability.
- Plan for **abuse** from day one: scanning, rate limits and takedowns.

## References

1. A. Xu. *System Design Interview*, chapter 8: Design a URL Shortener. 2020.
2. M. Georgiev, V. Shmatikov. [Gone in Six Characters: Short URLs Considered Harmful for Cloud Services](https://arxiv.org/abs/1604.02734). arXiv:1604.02734, 2016.
3. R. Fielding, M. Nottingham, J. Reschke. [RFC 9110: HTTP Semantics, §15.4 Redirection 3xx](https://www.rfc-editor.org/rfc/rfc9110#name-redirection-3xx). 2022.
4. Google. [Safe Browsing APIs](https://developers.google.com/safe-browsing).
5. AWS. [Amazon DynamoDB: conditional writes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html#WorkingWithItems.ConditionalUpdate).
6. [Sqids](https://sqids.org/): generate short unique IDs from numbers (successor to Hashids).
7. Instagram Engineering. [Sharding & IDs at Instagram](https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c). 2012.

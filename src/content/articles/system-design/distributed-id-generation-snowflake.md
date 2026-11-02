---
summary: How to mint billions of unique IDs per second across many machines without a central counter, why putting time in the high bits matters, and how Snowflake, UUIDv7 and ULID compare.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A single auto-increment column stops working once you have many databases, shards or regions. **Snowflake** IDs, introduced by Twitter in 2010, pack a **41-bit millisecond timestamp**, a **10-bit machine ID** and a **12-bit per-millisecond sequence** into one 64-bit integer. Every machine generates IDs locally with no network calls. The IDs are **unique** because no two machines share a machine ID, and **roughly time-sortable** because time sits in the high bits. The hard parts are **assigning machine IDs** and surviving a **clock that moves backwards**. If you can afford 128 bits, **UUIDv7** gives you the same time-ordering with no coordination at all.

## The problem: unique IDs without a bottleneck

Almost every record needs an ID: tweets, orders, messages, payments, log events. On one database, `BIGSERIAL` / `AUTO_INCREMENT` is perfect: short, unique, ordered. It stops being perfect when:

- Data is **sharded** across many databases, and each one's counter starts at 1.
- You want to know the ID **before** the insert (to build a URL, to put it in an event, to do client-side idempotency).
- You run in **several regions** and don't want every insert to cross an ocean to reach one counter.
- The central counter becomes a **throughput bottleneck** or a single point of failure.

What you usually want from an ID:

1. **Unique**, globally and forever.
2. **Generated without coordination** on the hot path.
3. **Roughly ordered by time**, so newer items sort later. That's useful for pagination, feeds, and index performance.
4. **Compact.** 64 bits fits in a `BIGINT` and takes half the index space of a 128-bit UUID.
5. **Not too revealing.** Sequential IDs leak business volume and are easy to enumerate.

## How Snowflake works

![A 64-bit integer split into 1 sign bit, a 41-bit timestamp, a 10-bit machine ID and a 12-bit sequence.](/figures/snowflake/bit-layout.svg "Each field has a job: time for ordering, machine for uniqueness across nodes, sequence for uniqueness within a millisecond.")

A Snowflake ID is a 64-bit integer built from three fields:

- **Timestamp (41 bits):** milliseconds since a **custom epoch**. Twitter's epoch is 2010-11-04, so the clock starts near zero instead of wasting 40 years of range on 1970–2010. 2⁴¹ ms is about **69.7 years** before the field overflows.
- **Machine ID (10 bits):** 1,024 distinct generators. Twitter split this into 5 bits of datacenter and 5 bits of worker.
- **Sequence (12 bits):** a counter that resets every millisecond. 4,096 IDs per millisecond per machine.

The top bit stays 0 so the number is positive in languages with signed 64-bit integers.

`id = (now_ms − epoch) << 22 | machine_id << 12 | sequence`

Capacity: 1,024 machines × 4,096 IDs × 1,000 ms ≈ **4.2 billion IDs per second**, with no shared state between machines.

### The generator loop

![Read the clock; if it moved back, wait or refuse; if it's the same millisecond, bump the sequence; if it's a new millisecond, reset the sequence.](/figures/snowflake/generator.svg "All the logic lives in one process. The only shared state is the machine ID, assigned once at startup.")

Each generator keeps two variables: the last timestamp it used and the current sequence.

- **New millisecond:** reset the sequence to 0 and emit.
- **Same millisecond:** increment the sequence. If it overflows past 4,095, **spin until the next millisecond**.
- **Clock went backwards:** the dangerous case. Emitting now could repeat an ID already issued. The generator either **waits** until the clock catches up to `last` (fine for small jumps) or **refuses** to issue IDs and raises an alert (for large jumps).

### Ordering: "roughly" sortable

Because the timestamp occupies the high bits, sorting Snowflake IDs numerically sorts them by creation time. Two caveats:

- **Within a millisecond**, IDs from different machines interleave arbitrarily.
- **Across machines**, ordering is only as good as clock synchronization. With NTP, clocks typically agree within a few milliseconds, so an ID created 2 ms "later" on another machine can sort earlier.

This is **k-sorted** (each ID is close to its true position), not strictly ordered. It's good enough for feeds, pagination and time-range queries. It is *not* a substitute for a sequence number when you need a strict total order, such as in a log.

## Assigning machine IDs

The only coordination Snowflake needs is that **no two live generators share a machine ID**. That's easy to get wrong:

- **Static config:** each host gets an ID in its deployment config. Simple, but breaks with autoscaling and copy-pasted configs.
- **Coordination service:** a generator claims an ID at startup as an ephemeral node in **ZooKeeper** (what Twitter did) or a lease in **etcd**, and gives it up on shutdown.
- **Derived from the environment:** Kubernetes StatefulSet ordinal (`pod-17` → 17), or the low bits of an IP address. Watch out for collisions when the address space is larger than 10 bits.
- **Database lease table:** `worker_id` rows with an expiry, renewed by heartbeat.

> [!WARNING]
> A duplicated machine ID silently produces **duplicate IDs**, which usually surfaces much later as a primary-key violation or, worse, two records merged into one. If machine IDs come from leases, a generator whose lease expires must **stop issuing IDs** until it re-acquires one. This is the same zombie problem as in leader election.

## The alternatives

![A table comparing auto-increment, DB ranges, UUIDv4, UUIDv7, ULID and Snowflake on size, sortability, uniqueness and coordination.](/figures/snowflake/compare.svg "Snowflake is the compact 64-bit option. UUIDv7 and ULID trade 64 extra bits for not needing machine IDs at all.")

### Database ranges (Hi-Lo)

Each app server **leases a block** of IDs (e.g. 1,000) from a central counter, then hands them out locally. Flickr's "ticket servers" were a variant: two MySQL servers, one issuing odd IDs and one even, using `REPLACE INTO` to bump an auto-increment. IDs are compact and nearly sequential, but ordering across servers is loose and the allocator is a dependency, though only once per block.

### UUIDv4

122 random bits. Unique with overwhelming probability (you'd need about 2.7 × 10¹⁸ IDs for a 50% chance of a single collision) and needs no coordination at all. But it's 128 bits, and **completely random**, which hurts databases (see below) and gives you no ordering.

### UUIDv7

Standardized in **RFC 9562 (2024)**: a **48-bit Unix millisecond timestamp** in the high bits, followed by version bits and **74 random bits** (optionally with a counter). It's time-ordered like Snowflake, needs **no machine IDs** because the random part makes collisions negligible, and fits existing `uuid` columns. PostgreSQL 18 added a built-in `uuidv7()` function. For most new systems, this is the default to beat.

### ULID

A 2016 community spec with the same idea as UUIDv7: 48-bit ms timestamp + 80 random bits, encoded as a **26-character Crockford base32** string (`01ARZ3NDEKTSV4RRFFQ69G5FAV`) that sorts lexicographically. It predates UUIDv7, and UUIDv7 now covers most of the same ground in a standard format.

### Other Snowflake variants

- **Sonyflake** (Sony): 39-bit time in **10 ms units** (~174 years), 8-bit sequence, 16-bit machine ID. Fewer IDs per second per machine, many more machines.
- **Instagram:** generated IDs **inside PostgreSQL** with a PL/pgSQL function: 41 bits of time, 13 bits of **logical shard ID**, 10 bits from a per-shard sequence. The shard is encoded in the ID, so you can route a lookup without a directory.
- **Discord** uses Snowflake with its own epoch (2015-01-01). **Mastodon** uses 48 bits of time + 16 bits of sequence.
- **TSID**, **KSUID** (Segment, 160 bits with second precision) and **XID** are further variations.

## Why sortable IDs help databases

![Two B-trees: random UUIDs hit every leaf page; time-ordered IDs only hit the rightmost leaf.](/figures/snowflake/index-locality.svg "Time-ordered keys turn random index writes into appends.")

Most primary-key indexes are B-trees (InnoDB clusters the whole table by primary key).

- **Random keys** (UUIDv4) insert into a random leaf page every time. The whole index becomes the working set, page splits happen everywhere and leave pages half-empty, and once the index doesn't fit in memory, inserts start causing random disk reads. Benchmarks routinely show insert throughput dropping several-fold as tables grow.
- **Time-ordered keys** (auto-increment, Snowflake, UUIDv7) always insert near the **right edge**. Only the newest pages are hot, pages fill completely, and the cache works well.

Time-ordering also makes **"newest first" pagination** cheap: `WHERE id < :cursor ORDER BY id DESC LIMIT 20`, with no separate `created_at` index.

> [!TIP]
> The flip side of right-edge inserts: in range-partitioned stores (HBase, Bigtable, Spanner, CockroachDB), monotonically increasing keys send **all writes to the last range**, creating a hot spot. Those systems recommend hashing or prefixing keys, or using UUIDv4, for exactly the reason B-trees prefer sorted ones.

## Where it's used

| System | Scheme | Notes |
| --- | --- | --- |
| **Twitter / X** | Snowflake | Tweet IDs since 2010. Generators were a Thrift service; machine IDs came from ZooKeeper. |
| **Discord** | Snowflake | Message, user and channel IDs. Epoch 2015-01-01. You can read creation time straight from any ID. |
| **Instagram** | Snowflake-like, in PostgreSQL | 13-bit logical shard ID embedded in the ID |
| **Mastodon** | 48-bit ms + 16-bit sequence | Generated in PostgreSQL |
| **Sony** | Sonyflake | 10 ms resolution, 16-bit machine ID |
| **Flickr** | Ticket servers | Two MySQL auto-increment servers, odd/even |
| **New systems on Postgres / MySQL** | UUIDv7 | Native `uuid` type, no machine IDs to manage |

### Use case walk-through: IDs for a chat app

You're building messages for a chat app on 64 shards, with tens of thousands of messages per second at peak.

1. Message IDs must sort by time within a channel (to page backwards through history) and be known before the write (so the client can retry idempotently).
2. You choose Snowflake: 64-bit IDs halve index size compared with UUIDs across billions of rows.
3. Each API pod gets a worker ID from its StatefulSet ordinal plus a 2-bit region code.
4. Pagination is `WHERE channel_id = ? AND id < :before ORDER BY id DESC LIMIT 50`, using the primary key `(channel_id, id)`.
5. The API returns IDs to clients **as strings**, because JavaScript numbers lose precision above 2⁵³.

## Pitfalls

- **JavaScript precision.** `Number` is a 64-bit float with 53 bits of integer precision. Snowflake IDs exceed it, so `JSON.parse` silently rounds them. Twitter added an `id_str` field for exactly this reason. Send IDs as strings in JSON.
- **Clock jumps.** NTP step corrections, VM restores, leap-second smearing done differently on different hosts. Use `CLOCK_MONOTONIC` between reads, prefer NTP slewing over stepping, and alarm on backwards jumps.
- **Persisting `last` on restart.** A process that restarts within the same millisecond, or after the clock moved back, can repeat IDs. Wait out the gap at startup, or persist the last timestamp.
- **Information leaks.** Snowflake IDs reveal creation time and roughly how many IDs a machine issues. Don't use them where that's sensitive, and never rely on them for unguessability. Use a random token for that.
- **Epoch overflow.** 41 bits from 2010 runs out around 2079. Fine for most, but choose your epoch deliberately.
- **Sequence starting at 0 every millisecond.** In low-traffic systems almost every ID ends in sequence 0, which skews sharding if you shard by `id % N`. Some implementations start the sequence at a random value.

## Discussion questions

1. Why does Snowflake reserve 41 bits for time and only 12 for sequence? What would you change for a system with 50,000 generators but low throughput each?
2. How would you assign machine IDs in a Kubernetes deployment that autoscales from 3 to 300 pods?
3. A host's clock jumps back by 5 seconds. What should its ID generator do, and what are the trade-offs?
4. When would you choose UUIDv7 over Snowflake, and vice versa?
5. Why do B-trees prefer time-ordered keys while range-partitioned stores like Bigtable prefer random ones?
6. What can an outsider learn from a Snowflake ID? How would you hide that if it mattered?

## FAQ

### Are Snowflake IDs guaranteed unique?

Yes, as long as **every live generator has a distinct machine ID** and **no generator issues IDs while its clock is behind its last-used timestamp**. Break either rule and duplicates are possible. Random-based schemes (UUIDv4/v7) are unique with overwhelming probability instead of by construction.

### Should I use UUIDv7 instead of Snowflake?

For most new applications, probably yes. It's standardized, needs no machine-ID management, and is supported by databases and libraries. Pick Snowflake when the **64-bit size** matters (huge tables, many secondary indexes, IDs embedded in other keys) or when you want shard or machine info encoded in the ID.

### How do I get the creation time from an ID?

Shift right by 22 bits and add the epoch: `(id >> 22) + 1288834974657` gives Unix milliseconds for Twitter IDs. Discord's epoch is `1420070400000`. For UUIDv7, the first 48 bits are Unix milliseconds directly.

### Can I generate IDs on the client?

UUIDv4/v7 and ULID can be generated anywhere, including browsers and mobile apps, because they don't need machine IDs. Snowflake needs a unique machine ID per generator, so it usually stays on the server. Client-generated IDs are handy for offline-first apps and idempotent retries.

### What happens if I need more than 4,096 IDs per millisecond on one machine?

The generator spins until the next millisecond, capping it at ~4.1 million IDs per second. If that's a real limit, run more generators (more machine IDs) or shift bits from machine ID to sequence.

### Is a central ID service a bad idea?

Not necessarily. Leasing ranges from a central service (Hi-Lo, ticket servers) touches it only once per block, so it's rarely a bottleneck. The bigger cost is the operational dependency: if it's down when a server runs out of IDs, writes stop.

## Key takeaways

- Snowflake = **time (41) + machine (10) + sequence (12)** in a 64-bit integer, generated locally with no coordination per ID.
- Time in the high bits gives **k-sorted** IDs: great for pagination and B-tree indexes, not a strict global order.
- Correctness depends on **unique machine IDs** and on **never going backwards in time**.
- **UUIDv7** offers the same time-ordering in 128 bits without machine IDs, and is the sensible default today.
- Send 64-bit IDs to JavaScript **as strings**, and remember sortable IDs leak creation time.

## References

1. Twitter Engineering. [Announcing Snowflake](https://blog.x.com/engineering/en_us/a/2010/announcing-snowflake). 2010.
2. Twitter. [twitter-archive/snowflake](https://github.com/twitter-archive/snowflake) (original Scala implementation).
3. K. Davis, B. Peabody, P. Leach. [RFC 9562: Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562). IETF, 2024.
4. Instagram Engineering. [Sharding & IDs at Instagram](https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c). 2012.
5. Flickr. [Ticket Servers: Distributed Unique Primary Keys on the Cheap](https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/). 2010.
6. Discord Developer Docs. [API Reference: Snowflakes](https://discord.com/developers/docs/reference#snowflakes).
7. Sony. [sonyflake](https://github.com/sony/sonyflake).
8. ULID spec. [ulid/spec](https://github.com/ulid/spec).
9. Google Cloud. [Bigtable schema design: row keys to avoid](https://cloud.google.com/bigtable/docs/schema-design#row-keys-avoid).

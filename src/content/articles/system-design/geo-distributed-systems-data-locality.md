---
summary: Why the speed of light makes cross-region round trips unavoidable, and how replica placement, geo-partitioning, multi-leader replication and edge caching decide who pays that latency and what consistency they get for it.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Light in fibre covers about 200 km per millisecond, so a round trip between continents costs **70–200 ms** no matter how good your code is. A geo-distributed system decides **where data lives** and **which operations wait for distant replicas**. The main patterns: **single primary with read replicas** (simple, remote writes are slow), **active-active / multi-leader** (fast local writes, conflicts to resolve), **geo-partitioning** (each row has a home region near its users, fast and consistent for local access), and **global consensus** (strongly consistent everywhere, at least one cross-region round trip per write). Use **edge caching** and **read-local** strategies for everything that can tolerate staleness, and be explicit about which operations need global agreement.

## The problem: distance is latency

![Bars comparing typical round-trip times between cloud regions with the theoretical fibre minimum: 62 ms us-east to us-west up to 200 ms us-east to Sydney.](/figures/geo/rtt.svg "Engineering can close the gap to the floor. It can't lower the floor.")

Light in optical fibre travels at about two-thirds of its speed in vacuum, roughly **200,000 km/s**, or **1 ms per 100 km of round trip**. Real network paths are longer than great circles and pass through routers, so measured round-trip times are typically 1.5–2× the theoretical minimum.

That matters because:

- **Sequential round trips add up.** A page that makes 5 dependent calls to a database 80 ms away takes at least 400 ms.
- **Consensus needs a majority.** If replicas are spread across continents, every strongly consistent write waits for at least one long round trip.
- **Users notice.** Studies by Amazon, Google and others have long shown that added latency reduces engagement and conversion.

Other reasons to go multi-region besides latency:

- **Availability:** survive the loss of an entire region.
- **Data residency:** laws and contracts may require some data to stay in a jurisdiction (GDPR transfers, India's and China's localization rules, sector regulations).
- **Capacity:** spread load across regions.

## Patterns

![Three cards: primary with read replicas, active-active multi-leader, and geo-partitioned.](/figures/geo/patterns.svg "Each moves the latency somewhere different.")

### 1. Single primary + read replicas

All writes go to a primary in one region. Other regions have asynchronous **read replicas**.

- ✅ Simple. No write conflicts. Local reads are fast.
- ❌ Writes from far-away users pay a cross-region round trip. Reads from replicas can be **stale**, which breaks read-your-writes (a user updates their profile and then sees the old one). Failover to another region is a big event and may lose recent writes.
- Mitigations: route a user's reads to the primary for a few seconds after they write, or track replication position (a session token with the log position) and wait until the local replica catches up.

### 2. Active-active (multi-leader)

Every region accepts writes and replicates them asynchronously to the others.

- ✅ Fast local writes everywhere. Each region keeps working during a partition.
- ❌ **Conflicts**: the same record can be changed in two regions at once. Resolution needs last-write-wins (lossy), CRDTs, or application merge logic. Constraints like uniqueness can't be enforced globally without coordination.
- Used by DynamoDB global tables (LWW), Cassandra multi-DC, CouchDB, and Redis Enterprise active-active (CRDTs).

### 3. Geo-partitioning (data homing)

![Three regions each holding the users whose region column matches; global reference tables are replicated everywhere.](/figures/geo/geo-partitioning.svg "Most data has a natural home. Put it there.")

Each row has a **home region**, usually where its owner lives. Its replicas (and its consensus group, if any) stay in that region.

- ✅ Local users get local latency for **both reads and writes**, with **strong consistency**. Data residency is easier.
- ❌ Accessing another region's data (a user travelling, a cross-region report, a global uniqueness check) pays the round trip. Moving a user's home region is a migration.
- Supported directly by CockroachDB (`REGIONAL BY ROW`), Spanner (placement / geo-partitioning), YugabyteDB (tablespaces), and by application-level sharding on a region key.
- **Global tables** (catalogs, configuration) that are read everywhere and rarely written are replicated to all regions and read locally.

### 4. Global consensus

One Paxos or Raft group with replicas in several regions. Every write is strongly consistent and survives the loss of a region.

![A table: three replicas in one region ~2 ms; three regions ~65 ms; five replicas 2+2+1 across regions ~20–30 ms; three continents ~150 ms.](/figures/geo/consensus-placement.svg "Where the majority lives decides how long every write waits.")

- A commit needs a **majority**, so write latency is the round trip from the leader to the nearest replicas that complete a majority.
- **Replica placement** is the main tuning knob: place the leader near most writers, and put enough replicas in nearby regions to form a majority quickly.
- **Spanner** uses TrueTime (GPS and atomic clocks with bounded uncertainty) to give externally consistent transactions and lock-free consistent reads at a timestamp from any replica. Writes still pay the consensus round trip, plus a short "commit wait".
- **Reads** can be served locally with **follower reads** at a slightly old timestamp (bounded staleness), or by **leaseholder** reads that must go to the leader's region.

## Making reads local

Most traffic is reads. Ways to serve them nearby:

- **CDN and edge caching** for anything public or cacheable per user.
- **Read replicas** with bounded staleness (`AS OF SYSTEM TIME '-10s'` in CockroachDB, Spanner stale reads, Aurora Global Database replicas with typically sub-second lag).
- **Session consistency:** guarantee read-your-writes for the user who wrote, while others may see slightly stale data. Azure Cosmos DB offers this as a consistency level.
- **Edge compute** (Cloudflare Workers, Lambda@Edge) with replicated key-value stores for configuration, sessions and feature flags.

## Designing for locality

- **Count round trips, not just latency.** Batch queries, avoid N+1 patterns across regions, and co-locate services that talk to each other in the same region.
- **Classify data** by access pattern: user-owned (geo-partition), global reference (replicate everywhere), globally contended (needs consensus, keep small), and analytics (replicate asynchronously to a central warehouse).
- **Pin requests to the data's region** at the edge: route users to their home region via DNS or anycast plus a routing layer.
- **Plan region failure explicitly:** which data is unavailable, which becomes read-only, which fails over (with what data loss, or RPO), and how long it takes (RTO).

## Where it's used

| System | Approach |
| --- | --- |
| **Google Spanner** | Paxos groups with configurable placement, TrueTime, stale and bounded-staleness reads |
| **CockroachDB** | Multi-region databases: `REGIONAL BY ROW`, `REGIONAL BY TABLE`, `GLOBAL` tables, survival goals (zone or region), follower reads |
| **Amazon DynamoDB global tables** | Multi-active replication, last-writer-wins. Multi-region strong consistency option added in 2024–2025. |
| **Amazon Aurora Global Database** | One primary region, storage-level replication to secondary regions, managed failover |
| **Azure Cosmos DB** | Multi-region writes, five consistency levels (strong, bounded staleness, session, consistent prefix, eventual) |
| **Cassandra** | Multi-DC replication with `LOCAL_QUORUM` per region |
| **Figma, Slack, Shopify** | Pods or cells per region or per customer group, homing data near users |

### Use case walk-through: a SaaS app expanding to Europe and India

A US-hosted SaaS product signs European and Indian customers, with data residency requirements and users complaining about 300 ms page loads.

1. **Classify data:** tenant data (documents, users) must stay in the tenant's region. The product catalog and feature flags are global. Billing is centralized.
2. **Geo-partition tenants:** each tenant has a `home_region`. Its rows live on clusters in that region. A routing layer maps `tenant → region` and sends requests there.
3. **Global tables:** catalog and flags replicate to all regions and are read locally.
4. **Cross-region operations** (a US admin viewing an EU tenant) go to the EU region and pay the round trip, which is acceptable for rare admin actions.
5. **Static assets** move to a CDN, and API servers sit in each region.
6. **Result:** EU and India users see ~40 ms API latency instead of ~250 ms, and tenant data stays in-region.

## Pitfalls

- **Chatty cross-region calls.** A design that's fine within a region (10 sequential 1 ms calls) becomes 10 × 80 ms across regions.
- **Assuming async replication is instant.** Lag spikes during load or failures. Read-your-writes breaks unless you design for it.
- **Global uniqueness with multi-leader writes.** Two regions can create the same username. Use a single home for uniqueness checks, or consensus.
- **Untested region failover.** Region evacuations that have never been rehearsed rarely go smoothly.
- **Hidden global dependencies:** a single-region auth service, configuration store or DNS provider that every region calls.

> [!WARNING]
> "Multi-region" doesn't mean "survives a region failure" unless every dependency on the request path is also multi-region. A single-region identity provider or queue makes every other region fail with it.

## Discussion questions

1. A user in Sydney edits a document stored in us-east. What's the minimum latency for a strongly consistent save? How would you reduce it?
2. Which of your tables are user-owned, global reference data, or globally contended?
3. How would you implement read-your-writes with asynchronous read replicas in another region?
4. When is active-active with last-writer-wins acceptable, and when is it dangerous?
5. How does replica placement change write latency for a 5-replica Raft group across 3 regions?
6. What is your plan if your primary region is unavailable for 6 hours?

## FAQ

### Can I have strong consistency and low latency globally?

Not for writes that must be agreed upon by replicas in distant regions: that's the PACELC trade-off, enforced by physics. You can have both **for data that's local to its users** (geo-partitioning), and low-latency reads everywhere with bounded staleness.

### What's the difference between multi-region and multi-AZ?

Availability zones are separate datacenters within one region, typically a few milliseconds apart, so synchronous replication across them is cheap. Regions are hundreds or thousands of kilometres apart, so synchronous replication across them costs tens to hundreds of milliseconds.

### What's RPO and RTO?

**Recovery point objective:** how much recent data you can afford to lose in a failover (e.g. 5 seconds of asynchronously replicated writes). **Recovery time objective:** how long recovery may take. Synchronous cross-region replication gives RPO ≈ 0 at a latency cost.

### How does Spanner achieve consistency across regions?

Each data split is a Paxos group. TrueTime gives every server a bounded-uncertainty clock, and transactions wait out that uncertainty before committing, so commit timestamps reflect real time order. This lets Spanner serve consistent snapshot reads from any replica at a past timestamp without locking.

### Should every app be multi-region?

No. It adds real complexity and cost. Many apps are well served by one region with multiple AZs, a CDN, and a tested backup-and-restore plan for regional disasters. Go multi-region for latency to distant users, residency requirements, or availability targets that a single region can't meet.

## Key takeaways

- The speed of light sets a hard floor: **~1 ms per 100 km** of round trip in fibre.
- Decide **where each kind of data lives** and **which operations must wait for distant replicas**.
- Patterns: **primary + read replicas**, **active-active**, **geo-partitioning**, **global consensus**. Each moves latency and consistency costs around.
- Serve reads locally (CDN, replicas, bounded staleness, session consistency) wherever staleness is acceptable.
- Count **cross-region round trips**, classify data, and rehearse **region failure**.

## References

1. J. Corbett et al. [Spanner: Google's Globally-Distributed Database](https://research.google/pubs/spanner-googles-globally-distributed-database-2/). *OSDI 2012*.
2. CockroachDB docs. [Multi-region capabilities overview](https://www.cockroachlabs.com/docs/stable/multiregion-overview).
3. D. Abadi. [Consistency Tradeoffs in Modern Distributed Database System Design](https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf) (PACELC). *IEEE Computer*, 2012.
4. AWS docs. [DynamoDB global tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html) and [Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html).
5. Microsoft docs. [Consistency levels in Azure Cosmos DB](https://learn.microsoft.com/en-us/azure/cosmos-db/consistency-levels).
6. M. Kleppmann. *Designing Data-Intensive Applications*, chapter 5: Replication ("Multi-Leader Replication", "Reading Your Own Writes"). O'Reilly, 2017.
7. AWS Builders' Library. [Static stability using Availability Zones](https://aws.amazon.com/builders-library/static-stability-using-availability-zones/).
8. I. Grigorik. *High Performance Browser Networking*, chapter 1: [Primer on Latency and Bandwidth](https://hpbn.co/primer-on-latency-and-bandwidth/). O'Reilly, 2013.

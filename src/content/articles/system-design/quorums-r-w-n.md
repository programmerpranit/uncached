---
summary: How leaderless databases use read and write quorums to trade latency, availability and consistency, why R + W > N makes reads see the latest write (mostly), and the edge cases where it doesn't.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** In a leaderless store, each key is replicated to **N** nodes. A write succeeds once **W** replicas acknowledge it, and a read asks **R** replicas and takes the newest version. If **R + W > N**, every read set **overlaps** every write set, so a read normally sees the latest acknowledged write. Tuning R and W trades **read latency against write latency** and decides **how many failures** each operation tolerates: with N=3, `W=2, R=2` survives one replica down for both. But quorums aren't a full consistency guarantee: **sloppy quorums**, concurrent writes, failed writes, clock-based conflict resolution and in-flight writes can all produce stale or inconsistent reads. When you need linearizability, use **consensus**.

## The problem: replicas without a leader

Single-leader replication sends all writes through one node, which makes ordering easy but makes that node a bottleneck and a failover risk. **Leaderless** replication, popularized by Amazon's Dynamo (2007) and used by Cassandra, Riak, ScyllaDB and Voldemort, lets **any replica** accept reads and writes for a key.

Without a leader, replicas will sometimes disagree: one was down during a write, another received writes in a different order. The questions are:

- How many replicas must take a write before we call it successful?
- How many must we ask on a read to be confident we see the latest value?
- What happens when some replicas are slow or down?

## The quorum condition

![Three replicas; the write set {1, 2} wrote v2; the read set {2, 3} overlaps it at replica 2, so the read sees v2.](/figures/quorums/overlap.svg "With R + W > N, a read can't pick only replicas that missed the write.")

- **N:** replicas per key (the replication factor). Commonly 3, or 3 per region.
- **W:** acknowledgements needed for a write to succeed.
- **R:** replicas consulted for a read.

If **R + W > N**, any set of R replicas and any set of W replicas share at least one replica (by the pigeonhole principle). So at least one of the replicas a reader contacts has the latest successfully written value. The reader compares versions (timestamps or version vectors) and returns the newest.

The writer still sends the write to **all N** replicas. W is just how many acknowledgements it waits for. The rest catch up asynchronously.

## Tuning R and W

![A table for N=3: W=3/R=1 fast reads; W=2/R=2 balanced; W=1/R=3 fast writes; W=1/R=1 fastest with no overlap.](/figures/quorums/configs.svg "Each configuration moves cost and fragility between reads and writes.")

| Config (N=3) | Overlap? | Reads tolerate | Writes tolerate | Good for |
| --- | --- | --- | --- | --- |
| W=2, R=2 | Yes | 1 replica down | 1 replica down | General purpose |
| W=3, R=1 | Yes | 2 down | 0 down | Read-heavy, rarely written |
| W=1, R=3 | Yes | 0 down | 2 down | Write-heavy, rarely read |
| W=1, R=1 | **No** | 2 down | 2 down | Caches, metrics, data where stale is fine |

General rules:

- A write tolerates `N − W` unavailable replicas, and a read tolerates `N − R`.
- **Latency is set by the slowest replica you wait for.** Waiting for 2 of 3 lets you ignore the slowest replica, which also helps tail latency.
- Majority quorums (`R = W = ⌊N/2⌋ + 1`) are the usual default. With N=5, `R = W = 3` tolerates two failures for both.

### Multi-region quorums

With replicas in several regions, a global quorum means cross-region round trips on every operation. Cassandra offers:

- `LOCAL_QUORUM`: a majority within the local datacenter. Fast, and consistent within a region.
- `EACH_QUORUM`: a majority in every datacenter (writes only). Strong, slow.
- `QUORUM`: a majority of all replicas across datacenters.

`LOCAL_QUORUM` for both reads and writes gives read-your-writes within a region, while other regions see the write after asynchronous replication.

## Keeping replicas in sync

Quorums tolerate stale replicas, but something must eventually fix them:

- **Read repair:** when a read sees an older version on some replica, it writes the newest version back to it. Cheap for frequently read keys, and does nothing for keys nobody reads.
- **Hinted handoff:** when a replica is down, another node stores the write with a **hint** and delivers it when the replica recovers.
- **Anti-entropy:** background processes compare replicas and copy missing data, typically using **Merkle trees** to find differences without comparing every key (Cassandra's `nodetool repair`, Riak's active anti-entropy).

## Sloppy quorums

![The coordinator writes to A (acks), B and C (down), and fallback node D (acks with a hint for B); when B recovers, D hands the write back.](/figures/quorums/sloppy.svg "The write succeeds, but it may be on nodes a later read won't ask.")

What if fewer than W of a key's **home** replicas are reachable, say during a network partition? A **strict** quorum fails the write. A **sloppy** quorum (from Dynamo) accepts the write on **other** nodes outside the key's home set, which hold it with a hint and hand it back later.

- ✅ Much higher write availability: as long as any W nodes are reachable, writes succeed.
- ❌ The overlap guarantee is gone. A read from the home replicas might not include any node that has the write, even with R + W > N.

Riak enables sloppy quorums by default. Cassandra uses hinted handoff but counts only home replicas toward the consistency level (except for the special `ANY` level, which accepts a hint as a write).

## When R + W > N isn't enough

Quorums make stale reads **unlikely**, not impossible. Edge cases:

![A write has reached replica 1 only; reader A asks replicas 1 and 2 and sees v2; reader B, later, asks replicas 2 and 3 and sees v1.](/figures/quorums/not-linearizable.svg "The two reads overlap the eventual write set, but not the partial state in between.")

- **In-flight writes.** While a write is still propagating, one reader may see it and a later reader may not, as in the figure. That violates **linearizability**, which requires that once any read sees a value, every later read sees it too. Fix: **blocking read repair** (the reader writes the newest value back to a quorum before returning), as Cassandra does.
- **Failed writes aren't rolled back.** If a write reaches only 1 of the required 2 replicas, the client gets an error, but the value stays on that replica and may later be read or spread by repair.
- **Concurrent writes** to the same key need conflict resolution. With **last-write-wins** by timestamp, a write can be silently lost, and clock skew can make an older write "win".
- **A replica restored from an old backup**, or a node that lost data, can reduce the number of replicas holding the latest value below W.
- **Sloppy quorums**, as above.
- **Membership changes:** while nodes join or leave, the set of "home replicas" can be inconsistent between coordinators.

For atomic compare-and-set or linearizable reads, leaderless stores provide a consensus path: Cassandra's **lightweight transactions** use Paxos (`IF NOT EXISTS`, `IF version = ?`), and newer Cassandra versions add Accord-based transactions.

## Quorums elsewhere

The same intersection idea underpins many other systems:

- **Raft and Paxos** commit an entry once a **majority** has it, and elect leaders by majority vote. Any two majorities intersect, which is why a new leader always has every committed entry.
- **Flexible Paxos** (Howard et al., 2016) showed that only the leader-election quorum and the replication quorum need to intersect, not every pair of quorums. So you can use small replication quorums with large election quorums.
- **ZooKeeper, etcd, Consul:** majority quorums of 3 or 5 servers.
- **Distributed locks** (like Redlock) use majority acquisition across independent nodes, with the caveats discussed for fencing.
- **Byzantine fault tolerance** needs larger quorums: 2f + 1 out of 3f + 1 nodes.

## Where it's used

| System | Quorum model |
| --- | --- |
| **Amazon Dynamo** (2007 paper) | Configurable N, R, W; sloppy quorums; hinted handoff; Merkle-tree anti-entropy |
| **Apache Cassandra / ScyllaDB** | Per-query consistency levels: ONE, TWO, QUORUM, LOCAL_QUORUM, EACH_QUORUM, ALL, ANY. Paxos for lightweight transactions. |
| **Riak** | N, R, W, plus PR/PW (primary replicas only) and DW (durable writes). Sloppy quorums by default. |
| **Voldemort** | Configurable N, R, W |
| **Amazon Aurora** | Storage quorum: 6 copies across 3 AZs, write quorum 4, read quorum 3 (4 + 3 > 6) |
| **etcd, ZooKeeper, Consul** | Majority quorums through Raft / Zab |

### Use case walk-through: a user-profile store in Cassandra

Profiles are read on every page view, written occasionally, and replicated 3× in each of two regions.

1. Writes use `LOCAL_QUORUM`: 2 of 3 local replicas must acknowledge. One local replica can be down.
2. Reads use `LOCAL_QUORUM`, so with 2 + 2 > 3 a user always sees their own latest update in their region.
3. The other region receives the write asynchronously, typically within milliseconds to seconds. A user who switches region might briefly see older data.
4. Username changes need uniqueness, so they use a lightweight transaction (`INSERT … IF NOT EXISTS` on a `usernames` table), paying for Paxos only on that path.
5. Weekly incremental repair keeps rarely read profiles consistent.

## Pitfalls

- **Assuming quorums mean "strongly consistent".** They mean "usually reads the latest". Know the edge cases above.
- **`ONE`/`ONE` by default** for data that users expect to read back immediately.
- **Skipping repair.** Without read repair and anti-entropy, rarely read data drifts, and deleted data can come back from a replica that missed the delete (Cassandra's tombstone `gc_grace_seconds` exists for this reason).
- **Global QUORUM across regions** on latency-sensitive paths. Every operation pays cross-region round trips.
- **Even N.** With N=4, a majority is 3, so you tolerate only 1 failure, the same as N=3, at higher cost.

> [!WARNING]
> Last-write-wins plus quorums means **concurrent writes to the same key lose data silently**. If two clients may update the same key at once, design for it: separate keys or columns per writer, CRDT-style merging, or compare-and-set.

## Discussion questions

1. With N=5, which (R, W) pairs give overlap? Which tolerates the most failed nodes for writes?
2. Why does waiting for 2 of 3 replicas often have better tail latency than waiting for 1 specific replica?
3. Explain how a read can return stale data even with R + W > N.
4. Why does Aurora use 6 copies with W=4 and R=3 rather than 3 copies with W=2 and R=2?
5. When are sloppy quorums worth the loss of the overlap guarantee?
6. How does a Raft majority quorum differ from a Dynamo-style read/write quorum?

## FAQ

### Does R + W > N give strong consistency?

It gives a **high likelihood** of reading the latest acknowledged write, but not linearizability in all cases: in-flight writes, failed partial writes, sloppy quorums and LWW conflict resolution can all break it. Blocking read repair plus strict quorums gets closer. Consensus is needed for full guarantees.

### What is a "consistency level" in Cassandra?

The per-query choice of how many replicas must respond: `ONE`, `QUORUM`, `ALL`, `LOCAL_QUORUM` and so on. It's the R or W for that single operation, so different queries on the same table can choose differently.

### Why not always use W = N?

Then a single unavailable replica blocks every write, and write latency is the slowest replica's. It also doesn't fix concurrent-write conflicts.

### What's the difference between read repair and anti-entropy?

**Read repair** fixes stale replicas for keys that are being read, as a side effect of the read. **Anti-entropy** is a background process that compares whole replicas (usually with Merkle trees) and fixes everything, including keys nobody reads.

### How does Aurora's quorum work?

Aurora stores 6 copies of each 10 GB segment across 3 availability zones. Writes need 4 of 6 and reads 3 of 6. It can lose an entire AZ (2 copies) and keep writing, and lose an AZ plus one more node and still read and repair. In practice, Aurora avoids quorum reads in the normal path by tracking which segments are up to date.

## Key takeaways

- N replicas, W acknowledgements to write, R replicas to read. **R + W > N** makes read and write sets overlap.
- R and W trade **read vs write latency** and **failure tolerance**. Majority quorums are the usual balance.
- **Read repair, hinted handoff and anti-entropy** bring stale replicas back into line.
- **Sloppy quorums** improve availability but drop the overlap guarantee.
- Quorums aren't linearizable by themselves. Use **consensus** (Paxos/Raft, lightweight transactions) when you need it.

## References

1. G. DeCandia et al. [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf). *SOSP 2007*.
2. M. Kleppmann. *Designing Data-Intensive Applications*, chapter 5: Replication ("Leaderless Replication", "Limitations of Quorum Consistency"). O'Reilly, 2017.
3. Apache Cassandra docs. [Dynamo: tunable consistency](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html).
4. D. K. Gifford. [Weighted Voting for Replicated Data](https://dl.acm.org/doi/10.1145/800215.806583). *SOSP 1979*.
5. H. Howard, D. Malkhi, A. Spiegelman. [Flexible Paxos: Quorum intersection revisited](https://arxiv.org/abs/1608.06696). 2016.
6. A. Verbitski et al. [Amazon Aurora: Design Considerations for High Throughput Cloud-Native Relational Databases](https://www.amazon.science/publications/amazon-aurora-design-considerations-for-high-throughput-cloud-native-relational-databases). *SIGMOD 2017*.
7. P. Bailis et al. [Probabilistically Bounded Staleness for Practical Partial Quorums](https://arxiv.org/abs/1204.6082). *VLDB 2012*.
8. Riak docs. [Replication properties](https://docs.riak.com/riak/kv/latest/developing/app-guide/replication-properties/index.html).

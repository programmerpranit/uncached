---
summary: What CAP actually proves, why "pick two of three" is misleading, and how PACELC adds the trade-off you face every day, latency versus consistency, even when the network is healthy.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** CAP says that **during a network partition**, a replicated system must either stay **consistent** (refuse some requests) or stay **available** (answer with possibly stale data). It can't do both. Partitions aren't optional in a distributed system, so the real choice is **CP vs AP while partitioned**. **PACELC** adds the part CAP leaves out: **E**lse, when there is no partition, you still trade **L**atency against **C**onsistency on every request.

## The problem: replicas disagree when they can't talk

We replicate data across machines to survive failures and serve users nearby. Replicas stay in sync by exchanging messages over a network, and networks fail. Switches die, cables get cut, GC pauses look like crashes, cloud regions lose connectivity. When the replicas can't reach each other, a request arrives at one of them, and that replica has to decide what to do with what it knows.

![Two nodes separated by a partition. N1 has the new value, N2 the old one. Choosing C means N2 refuses; choosing A means N2 returns the stale value.](/figures/cap-theorem/partition.svg "A client wrote x=2 to N1, but replication to N2 failed. A read now arrives at N2.")

N2 has two options:

- **Refuse or wait** until it can confirm the latest value. The system stays correct but is **unavailable** on N2's side of the partition.
- **Answer with what it has** (`x = 1`). The system stays **available** but returns **stale** data. If N2 also accepts writes, the two sides diverge and have to be reconciled later.

No protocol avoids this. N2 has no way of knowing about a write it never received. That's the whole theorem.

## What CAP actually says

Eric Brewer conjectured CAP in a 2000 keynote. Gilbert and Lynch proved it in 2002 with precise definitions:

| Letter | Formal meaning | What people often think it means |
| --- | --- | --- |
| **C**onsistency | **Linearizability**: every operation appears to happen atomically at one point in time, and every read sees the latest completed write. | "The data is valid" (that's ACID's C, which is different) |
| **A**vailability | **Every** request received by a **non-failing** node gets a (non-error) response, eventually. | "High uptime" |
| **P**artition tolerance | The system keeps working even if the network drops arbitrary messages between nodes. | "We have multiple data centres" |

**Theorem:** no system can provide C and A at the same time if the network can partition.

### Why "pick two out of three" is misleading

The slogan suggests three equal options: CA, CP or AP. But you don't get to choose whether partitions happen. Any system that runs on more than one machine over a network will see them. A "CA" system is really a single-node system, or one that behaves unpredictably when a partition happens.

So the honest framing is:

> When a partition happens, will you give up **consistency** or **availability**?

And even that is coarse. Brewer himself wrote in 2012 that the choice can be made **per operation** and **per subsystem**, and that systems can be partially available and partially consistent in useful ways.

> [!WARNING]
> CAP's "availability" is very strict. It requires **every** non-failing node to answer, including nodes in a minority partition. A majority-quorum system like Raft or ZooKeeper isn't "available" in the CAP sense, because the minority side refuses writes. In practice it's still highly available, since the majority side keeps serving. "CP" and "highly available" aren't contradictory.

## PACELC: the trade-off you pay every day

Partitions are rare. If CAP were the only trade-off, most systems would rarely face it. Daniel Abadi pointed out in 2012 that the bigger everyday trade-off happens when the network is **fine**:

> **If P**artition → choose **A** or **C**; **E**lse → choose **L**atency or **C**onsistency.

To make a write strongly consistent, a replica has to coordinate with others before acknowledging. That means at least one network round trip, which may cross regions. To make reads strongly consistent, you have to read from the leader or a quorum, not the nearest replica. Every request pays that coordination cost, partition or not.

![Two timelines. Synchronous replication waits for a far replica before acknowledging; asynchronous acknowledges immediately and replicates later.](/figures/cap-theorem/latency-vs-consistency.svg "With no partition at all, consistency still costs latency: the ack has to wait for other replicas.")

Classifying real systems on both axes:

![Four quadrants: PA/EL (Dynamo, Cassandra, Riak), PC/EC (Spanner, VoltDB, HBase, BigTable), PA/EC (MongoDB), PC/EL (PNUTS).](/figures/cap-theorem/pacelc.svg "Abadi's PACELC classification. Many systems are tunable, so these are their defaults.")

- **PA/EL** systems (Dynamo-style stores like Cassandra and Riak) favour speed and availability. Writes go to whatever replicas are reachable, and conflicts get resolved later.
- **PC/EC** systems (Spanner, HBase, VoltDB) always coordinate. You get linearizable behaviour and pay for it in latency, both during and outside partitions.
- The mixed quadrants exist too. Yahoo's PNUTS gave up consistency for latency in normal operation but chose consistency during partitions.

## Consistency is a spectrum

"Consistent vs not" is a false binary. There's a whole range of guarantees between linearizable and eventual, and the weaker ones are cheaper and stay more available:

![Five bars from linearizable, sequential, causal, session guarantees, to eventual consistency.](/figures/cap-theorem/consistency-spectrum.svg "Stronger models need more coordination. Causal consistency is the strongest model that can stay available during a partition.")

- **Linearizable:** behaves like a single copy. Needed for locks, leader election, uniqueness constraints, and account balances that must not go negative.
- **Causal:** if A could have influenced B, everyone sees A before B. A comment never appears before the post it replies to. Causal consistency (and its variants) can be provided **with** availability during partitions (Mahajan et al., 2011). Often it's exactly what applications need.
- **Session guarantees:** *read-your-writes* and *monotonic reads* mean a user never sees their own update vanish, and never sees time go backwards. Many "eventual consistency bugs" are really missing session guarantees.
- **Eventual:** if writes stop, replicas converge. It promises nothing about *when*, or about what you read in the meantime.

## Where it shows up

| System | Default stance | Knobs |
| --- | --- | --- |
| **Cassandra** | AP / EL | Per-query consistency level: `ONE`, `QUORUM`, `LOCAL_QUORUM`, `ALL`. `QUORUM` reads + writes give strong consistency for single keys (without linearizable compare-and-set unless you use LWT/Paxos). |
| **DynamoDB** | Eventually consistent reads by default | `ConsistentRead=true` for strong reads within a region. Global tables replicate asynchronously across regions (last-writer-wins). |
| **Spanner** | CP / EC | Paxos groups + TrueTime give externally consistent (linearizable) transactions. Google argues it's "effectively CA" because partitions within its network are rare enough to meet five-nines availability. |
| **etcd / ZooKeeper / Consul** | CP | Majority quorum. The minority side refuses writes. Reads can be linearizable or "stale-allowed". |
| **MongoDB** | Configurable | `writeConcern: majority` + `readConcern: majority/linearizable` for stronger guarantees. Weaker settings are faster. |
| **DNS, CDNs** | AP / EL | Caches with TTLs. Staleness is accepted by design. |

### Use case walk-through: a shopping cart vs a payment ledger

- **Cart:** losing availability means lost sales. If two devices add items during a partition, merging the two carts (union) is a fine outcome. That's exactly the reasoning behind Amazon's Dynamo, so choose **AP/EL**.
- **Ledger:** a double-spend is far worse than a 500 error. Debits need linearizable checks against the balance. Choose **CP**, and accept that a minority partition can't take payments. You might still serve the **read** side (balances, history) from AP caches marked "as of 10:02".

Most real products are like this. **Different operations within the same product need different points in the trade-off.**

## Pitfalls

- **Calling a system "CA".** If it's distributed, it will meet partitions. Ask what it actually does when one happens.
- **Assuming the label tells you the behaviour.** "CP" databases have had bugs that lost acknowledged writes during partitions. Jepsen's test reports are the best reality check.
- **Ignoring latency.** Teams pick a strongly consistent multi-region database and then discover that every write costs 100+ ms. PACELC's "E" half is usually the one that hurts.
- **Treating eventual consistency as "consistent within a second or so".** Under failures, the lag can be minutes. Design for unbounded staleness or measure it explicitly.
- **Forgetting about clients.** A client that fails over to another replica can lose read-your-writes, even if every server behaves correctly.

## Discussion questions

1. Why can't a system "choose CA"? What would a CA system do when the network partitions?
2. A Raft cluster of 5 nodes splits 3/2. Which side serves writes? Is the cluster "available" in CAP terms? In practical terms?
3. Pick a feature from your own product. Which operations need linearizability, and which could tolerate staleness?
4. Spanner claims to be "effectively CA". What has to be true about the network for that to be a reasonable claim?
5. How would you show a user that data might be stale, without confusing them?
6. Why might causal consistency be a better default than eventual consistency for a social app?

## FAQ

### Is the "C" in CAP the same as the "C" in ACID?

No. ACID's consistency means a transaction keeps your **application invariants** (constraints, foreign keys). CAP's consistency means **linearizability**: all replicas behave like a single copy. A database can be ACID on one node and say nothing about CAP-consistency across replicas.

### Does CAP apply to a single-node database?

Not really. CAP is about replicated data over an unreliable network. A single node is trivially consistent. If it's unreachable, it's unavailable, but that's a plain failure, not a CAP trade-off.

### Is MongoDB CP or AP?

It depends on settings and version. With a majority write concern and majority/linearizable read concern, it behaves like a CP system. With `w: 1` and reads from secondaries, it can return stale data or roll back acknowledged writes after a failover. Labels describe configurations, not products.

### Is a quorum system CP?

A majority quorum (`R + W > N`, with a single leader or consensus protocol) gives strong consistency and stays available as long as a majority is reachable. A minority partition loses availability, so in CAP terms it's CP. Leaderless quorums with sloppy quorums and hinted handoff (as in Dynamo) lean AP.

### Why do people say CAP is "too simplistic"?

It only models one kind of failure (partitions), one consistency model (linearizability) and one strict kind of availability. It says nothing about latency, which is what you trade constantly. Kleppmann's critique suggests talking about specific consistency models and their latency costs instead. PACELC is a step in that direction.

### What does Spanner do during a partition?

Spanner chooses consistency. A Paxos group that loses its majority stops accepting writes for the data it owns. Google relies on a private, heavily redundant network to make such partitions extremely rare, which is why it can claim very high availability anyway.

## Key takeaways

- CAP is a statement about **partitions**: during one, choose consistency or availability.
- Partitions aren't optional, so "CA" isn't a real option for distributed systems.
- **PACELC** captures the everyday trade-off: without partitions, **latency vs consistency**.
- Consistency is a **spectrum**. Causal and session guarantees often give users what they need, cheaply.
- Decide **per operation**, not per company or per database.

## References

1. E. Brewer. [Towards Robust Distributed Systems](https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf). PODC keynote, 2000.
2. S. Gilbert, N. Lynch. [Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services](https://dl.acm.org/doi/10.1145/564585.564601). *ACM SIGACT News*, 2002.
3. E. Brewer. [CAP Twelve Years Later: How the "Rules" Have Changed](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/). *IEEE Computer*, 2012.
4. D. Abadi. [Consistency Tradeoffs in Modern Distributed Database System Design](https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf). *IEEE Computer*, 2012.
5. M. Kleppmann. [A Critique of the CAP Theorem](https://arxiv.org/abs/1509.05393). arXiv:1509.05393, 2015.
6. E. Brewer. [Spanner, TrueTime and the CAP Theorem](https://research.google/pubs/spanner-truetime-and-the-cap-theorem/). Google, 2017.
7. P. Mahajan, L. Alvisi, M. Dahlin. [Consistency, Availability, and Convergence](https://www.cs.utexas.edu/~lorenzo/papers/TR-11-22.pdf). UTCS TR-11-22, 2011.
8. P. Bailis et al. [Highly Available Transactions: Virtues and Limitations](https://arxiv.org/abs/1302.0309). *VLDB 2014*.
9. K. Kingsbury. [Jepsen analyses](https://jepsen.io/analyses).
10. M. Kleppmann. *Designing Data-Intensive Applications*, chapter 9: Consistency and Consensus. O'Reilly, 2017.

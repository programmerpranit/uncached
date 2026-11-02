---
summary: Why "only one leader at a time" is a promise no lock service can keep on its own, and how monotonically increasing fencing tokens let the protected resource reject a leader that doesn't know it's been replaced.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Many systems need exactly one node doing something: running a scheduler, owning a shard, writing to a file. **Leader election** usually works through a **lease** (a lock with an expiry) in a consensus-backed store like etcd, ZooKeeper or Consul. But a leader can **pause**: a GC pause, a VM stall, a slow disk, a network delay. While it's paused its lease expires, someone else takes over, and the old leader wakes up still believing it's in charge. Leases can't prevent this. **Fencing tokens** can. Each new lease comes with a **strictly increasing number**, every write carries that number, and the **resource rejects any write with a lower token than one it has already seen**.

## The problem: "exactly one" is hard

Situations that need a single active node:

- One **scheduler** triggering cron jobs, so each job runs once, not N times.
- One **primary** accepting writes for a database shard.
- One **consumer** processing a partition in order.
- One process **owning a file** or object in shared storage.

The obvious approach: take a lock (or lease) from a coordination service, and do the work only while holding it. Leases expire automatically, so a crashed leader doesn't block everyone forever.

The flaw: **a process can't reliably know whether it still holds a lease.** It checks the lease, then does the work, and between those two moments it can stop for an arbitrary length of time.

![Timeline: client 1 holds the lease, pauses for a long GC, the lease expires, client 2 acquires it and writes, then client 1 wakes and also writes.](/figures/fencing/zombie-leader.svg "Client 1 checked its lease before the pause. From its point of view nothing happened, but in the meantime it lost leadership.")

Ways a process can be paused without noticing:

- **Stop-the-world garbage collection.** Pauses of seconds to minutes have been seen in production JVMs and other GC'd runtimes.
- **VM suspension or live migration**, or an overloaded hypervisor stealing CPU.
- **Swapping**, or a page fault that waits on a slow disk.
- **`SIGSTOP`**, a debugger, or a laptop lid closing.
- **Network delay.** The write was sent on time but sits in a queue or is retransmitted, and arrives after the lease ended.
- **Clock problems.** A lease measured with a local clock that jumped, or that runs at a different rate than the lock server's clock.

No amount of "check the lease again right before writing" fixes this. The pause can happen *after* the check.

## Leader election with leases

The standard building block: a key in a linearizable store, held with a **lease** that the holder renews by heartbeat.

![Three nodes race to create a key in etcd; node A wins and keeps its lease alive while B and C watch the key.](/figures/fencing/lease-election.svg "Create-if-absent + lease + watch is all a basic election needs. The store's revision number is a free fencing token.")

1. Each candidate tries to **create the key if absent** (etcd transaction on `create_revision == 0`, ZooKeeper ephemeral node, Consul session lock).
2. The winner is leader. It **renews its lease** with heartbeats (`KeepAlive`) well within the lease TTL.
3. Losers **watch** the key. If the leader crashes or is cut off, its lease expires, the key is deleted, and the watchers race again.
4. The leader should **step down by itself** when it can't renew in time, *before* the lease would expire from the store's point of view (Kubernetes uses a renew deadline shorter than the lease duration).

ZooKeeper's classic recipe uses **ephemeral sequential** nodes: everyone creates one, the lowest sequence number is leader, and each node watches only the node just before it. That avoids a thundering herd of watchers on every change.

> [!WARNING]
> The election must use a **linearizable, consensus-backed** store. A lock in a single Redis instance, or in an asynchronously replicated cluster, can be lost on failover, and then two clients hold the "same" lock at once even without any pauses.

## Fencing tokens

The fix moves the check to where it can't be outrun: **the resource being protected**.

![Same timeline, but client 1 gets token 33 and client 2 gets token 34; storage accepts 34 and rejects the later write tagged 33.](/figures/fencing/fencing-tokens.svg "The lock service can't stop a paused client. The storage can, because it remembers the highest token it has seen.")

1. Every time the lock service grants the lease, it returns a **fencing token**: a number that **strictly increases** with each grant (33, then 34…).
2. The client sends the token with **every** request to the protected resource.
3. The resource keeps the **highest token it has accepted** and **rejects** any request with a lower one.

Now the zombie leader's write, tagged 33, is refused because the storage has already accepted 34. Nothing depends on timing, clocks or the client noticing its pause.

### Where to get the numbers

- **etcd:** the key's `mod_revision` or `create_revision` (global, monotonic).
- **ZooKeeper:** the znode's `czxid`/`mzxid` (transaction ID) or the sequence number of an ephemeral sequential node.
- **Raft and Paxos themselves:** the **term** or **ballot number** is a fencing token. A follower rejects `AppendEntries` from a lower term.
- **Chubby:** "sequencers", which are lock generation numbers clients pass to servers, which check them.
- **Database row:** an `epoch` column incremented with each leadership change, using conditional writes (`UPDATE … WHERE epoch <= :myEpoch`).

### The resource must cooperate

Fencing only works if the protected thing **checks** tokens. Options:

- **Conditional writes:** `If-Match` / ETags, DynamoDB condition expressions, `UPDATE … WHERE version = ?`, S3 conditional writes.
- **A gatekeeper service** in front of a dumb resource, which checks tokens on its behalf.
- **Epoch-aware protocols:** HDFS's Quorum Journal Manager makes each new NameNode obtain a higher **epoch** from a majority of journal nodes, and journal nodes reject writes from lower epochs. Kafka uses **controller epochs** and **leader epochs** the same way.

If the resource can't check tokens (say, it sends emails or calls a third-party API), fencing can't fully protect it. Then you rely on **idempotency**, or on physically isolating the old leader: **STONITH**, "shoot the other node in the head" (power it off via IPMI, revoke its storage access).

## Where it's used

| System | Election mechanism | Fencing |
| --- | --- | --- |
| **Kubernetes controllers** | `Lease` objects in the API server (backed by etcd). Default lease 15 s, renew deadline 10 s. | Mostly relies on stepping down plus optimistic concurrency (`resourceVersion`) on API writes |
| **HDFS NameNode HA** | ZooKeeper Failover Controller | QJM epochs, plus optional `sshfence` / shell fencing |
| **Kafka** | Controller via ZooKeeper, then the KRaft quorum | Controller epoch, partition leader epoch |
| **Raft-based DBs** (CockroachDB, TiKV, etcd) | Raft elections | Terms reject stale leaders. Lease-based reads add care around clocks. |
| **Pacemaker / Corosync clusters** | Quorum + resource manager | STONITH devices |
| **Google Chubby / Borg** | Chubby locks | Sequencers checked by servers. Lock-delay on expiry. |

### Use case walk-through: a single cron scheduler

You run three replicas of a scheduler and want each job to fire once.

1. Each replica campaigns for `/scheduler/leader` in etcd with a 10-second lease. One wins and gets revision `r`.
2. The leader writes job runs to Postgres as `INSERT INTO runs(job, slot, leader_rev) … ON CONFLICT (job, slot) DO NOTHING`. Duplicate slots are ignored (idempotency).
3. Job **side effects** also carry `leader_rev`, and workers refuse instructions older than the highest revision they've seen (fencing).
4. If the leader pauses for 30 seconds, another replica takes over with revision `r' > r`. When the old one wakes, its writes are deduplicated or rejected. It notices it lost the lease and steps down.

## Pitfalls

- **"We use Redis SETNX with a TTL."** That's fine as an *efficiency* lock (avoid duplicate work most of the time). It's not a *correctness* lock: no fencing, and the lock can be lost on Redis failover. Kleppmann's critique of Redlock makes the same distinction.
- **Assuming bounded pauses.** "GC never takes more than 1 s" holds until it doesn't. Design for pauses longer than your lease.
- **Lease TTL too short.** Slow networks or busy disks cause spurious failovers ("flapping"). Too long, and failover is slow. Typical values are 10–30 s, with heartbeats at a third of the TTL.
- **Not stepping down.** A leader that can't reach the store should stop acting as leader proactively, not wait to be told.
- **Fencing only some paths.** A single unfenced write path (a background job, an admin script) brings the whole problem back.

## Discussion questions

1. Why can't the client simply check "do I still hold the lease?" immediately before each write?
2. Which of your systems rely on "only one instance runs this"? What happens if two run at once for 30 seconds?
3. How would you fence writes to S3 or to a third-party API that can't check tokens?
4. Why is a Raft term a fencing token? Where does Raft check it?
5. What's the trade-off in choosing a lease TTL?
6. When is an unfenced, best-effort lock (like Redis `SETNX`) good enough?

## FAQ

### What's the difference between a lock and a lease?

A **lock** is held until released. If the holder dies, it may be held forever. A **lease** is a lock with a **time limit** that the holder must keep renewing. Leases are what make automatic failover possible, and also what create the "expired without knowing" problem.

### Do I need fencing if I already use etcd or ZooKeeper?

Yes, if correctness matters. Those systems make sure only one client **holds the lease** at any moment, according to the store. They can't stop a client that *used to* hold it from sending requests late. Fencing protects the resource. A correct election protects the lease.

### Can't I just use synchronized clocks?

Clock-based schemes (leases checked against local time) assume bounded clock drift and bounded pauses. Both assumptions fail occasionally in practice. Google Spanner's TrueTime bounds clock *uncertainty* with GPS and atomic clocks, but even Spanner's leader leases rely on that special hardware. Fencing tokens need no clock assumptions at all.

### What is STONITH?

"Shoot The Other Node In The Head": forcibly powering off or isolating a suspected-dead node before failing over, so it can't keep writing. It's common in traditional HA clusters with shared storage, where the storage can't check tokens itself.

### Is Redlock safe?

Redlock (locking across several independent Redis instances) is debated. Its safety depends on timing assumptions (bounded pauses, network delays and clock drift), and it provides no fencing tokens. For efficiency locks it's fine. For correctness, use a consensus store and fencing.

### How does Kubernetes handle leader election for controllers?

Controllers use a `Lease` object. The holder updates `renewTime` periodically and gives up leadership if it can't renew within the renew deadline. Writes to the API server use optimistic concurrency (`resourceVersion`), which limits the damage from overlapping leaders, but controllers should still be idempotent.

## Key takeaways

- Leader election = **lease** in a **linearizable** store + heartbeats + watches.
- A lease guarantees one holder **in the store's view**, not one actor in reality. Pauses create **zombie leaders**.
- **Fencing tokens** (monotonic numbers checked by the resource) make zombies harmless.
- Good token sources: etcd revisions, ZooKeeper zxids, Raft terms, database epochs.
- If the resource can't check tokens, use **idempotency** or **STONITH**.

## References

1. M. Kleppmann. [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html). 2016.
2. M. Kleppmann. *Designing Data-Intensive Applications*, chapter 8: The Trouble with Distributed Systems ("The leader and the lock", "Fencing tokens"). O'Reilly, 2017.
3. M. Burrows. [The Chubby lock service for loosely-coupled distributed systems](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/). *OSDI 2006*.
4. Apache ZooKeeper. [ZooKeeper Recipes and Solutions: Leader Election](https://zookeeper.apache.org/doc/current/recipes.html#sc_leaderElection).
5. etcd docs. [Concurrency API: election](https://etcd.io/docs/latest/dev-guide/api_concurrency_reference_v3/).
6. Kubernetes docs. [Leases](https://kubernetes.io/docs/concepts/architecture/leases/).
7. Apache Hadoop. [HDFS High Availability Using the Quorum Journal Manager](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HDFSHighAvailabilityWithQJM.html).
8. C. Gray, D. Cheriton. [Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency](https://dl.acm.org/doi/10.1145/74850.74870). *SOSP 1989*.
9. Redis docs. [Distributed Locks with Redis (Redlock)](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/).

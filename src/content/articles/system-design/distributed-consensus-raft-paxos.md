---
summary: How a group of machines agrees on one sequence of decisions even when some of them crash, and why that single capability sits underneath etcd, ZooKeeper, Kafka, CockroachDB and Spanner.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Consensus gets a group of servers to agree on values, usually the **next entry in a shared log**, in a way that survives crashes and lost messages. With **2f + 1** servers it tolerates **f** failures, because any two majorities overlap in at least one server. **Paxos** (Lamport) is the classic, proven protocol, but it's famously hard to follow and to turn into a full system. **Raft** (Ongaro & Ousterhout, 2014) splits the problem into **leader election**, **log replication** and **safety**, and is now what most new systems implement. Both give you a **replicated state machine**: every server applies the same commands in the same order and ends up in the same state.

## The problem

You want a service that keeps working when a machine dies. That service could be a lock service, a metadata store or a database's leader. So you run several copies. Now the copies must **agree**: which write came first, who holds the lock, who's the leader. If they disagree, you get split-brain: two leaders, double-granted locks, diverged data.

Agreement sounds easy until you list what can go wrong:

- Servers **crash** and restart, possibly losing anything not yet written to disk.
- Messages get **lost, delayed, duplicated or reordered**.
- There's no reliable way to tell a **crashed** server from a **slow** one.

That last point is fundamental. The **FLP impossibility result** (Fischer, Lynch and Paterson, 1985) proves that in a fully asynchronous system, no deterministic algorithm can guarantee consensus terminates if even one process may crash. Real protocols get around this by using **timeouts**. They're always **safe**, meaning they never decide two different things, and they make **progress** whenever the network behaves reasonably for long enough.

## The goal: a replicated state machine

![Three servers each with a consensus module, an identical log and a state machine reaching the same state.](/figures/consensus/replicated-state-machine.svg "If every server applies the same commands in the same order, they all end up in the same state. Consensus is what keeps the logs identical.")

Clients send commands to the cluster. The consensus module puts each command in a **log**. Once the command is **committed**, which means stored durably on a majority, every server applies it to its local state machine (a key-value map, a lock table, anything deterministic). Almost every "strongly consistent, fault-tolerant" system is built this way.

### Why majorities?

With `N = 2f + 1` servers, any two majorities of size `f + 1` share **at least one server**. That shared server carries knowledge forward. A new leader elected by one majority is guaranteed to hear about anything a previous majority committed.

| Cluster size | Majority | Failures tolerated |
| ---: | ---: | ---: |
| 3 | 2 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

Even sizes don't help: 4 servers tolerate only 1 failure, the same as 3, and add another machine every write has to wait on. That's why consensus clusters are almost always 3 or 5 nodes.

## Raft

Raft was designed for **understandability**. It makes one server the **leader**, which handles all client requests and replicates log entries to the others. Time is divided into **terms**, numbered consecutively, and each term has at most one leader.

### Leader election

![State diagram: Follower to Candidate on election timeout, Candidate to Leader on majority, back to Follower on seeing a higher term.](/figures/consensus/raft-states.svg "Every server starts as a follower. A follower that stops hearing from a leader times out, becomes a candidate and asks for votes.")

1. The leader sends periodic **heartbeats** (empty `AppendEntries`).
2. A follower that hears nothing for its **election timeout**, randomized between e.g. 150 and 300 ms, increments the term, votes for itself and sends `RequestVote` to everyone.
3. Each server grants **at most one vote per term**, and only to a candidate whose log is **at least as up-to-date** as its own (compare the last entry's term, then its index).
4. A candidate with votes from a majority becomes leader and starts sending heartbeats. If the vote splits, the timeouts expire again and a new term starts. Because timeouts are random, the next election usually has a clear winner.

The "up-to-date" rule in step 3 is what makes Raft safe. A server missing committed entries can't collect a majority of votes, because at least one voter in any majority has those entries and will refuse.

### Log replication

![Five server logs with entries labelled by term; a dashed line marks the commit index at entry 5.](/figures/consensus/log-replication.svg "An entry is committed once it is stored on a majority. The leader tells followers the commit index, and they apply entries up to it.")

1. The client sends a command to the leader. The leader appends it to its own log.
2. The leader sends `AppendEntries(term, prevLogIndex, prevLogTerm, entries, leaderCommit)` to all followers.
3. A follower accepts only if its log **contains an entry at `prevLogIndex` with `prevLogTerm`**. This consistency check means that if two logs agree on an entry, they agree on everything before it (the *Log Matching* property).
4. If a follower rejects, the leader steps back and retries with earlier entries until the logs match, then overwrites the follower's conflicting tail.
5. Once a majority has stored the entry, the leader marks it **committed**, applies it and replies to the client. Followers learn the new commit index on the next message.

> [!WARNING]
> **A subtle rule:** a new leader can't consider an entry from a *previous* term committed just because it's now on a majority. It only commits entries from its **own** term by counting replicas. Older entries get committed indirectly, along with them. Skipping this rule allows a committed entry to be overwritten. Figure 8 of the Raft paper walks through the counterexample.

### Everything else a real system needs

- **Snapshots and log compaction:** periodically snapshot the state machine and discard the log prefix. Lagging followers get an `InstallSnapshot`.
- **Membership changes:** adding or removing servers safely, using *joint consensus* or one-server-at-a-time changes.
- **Linearizable reads:** a leader might have been deposed without knowing it. Use **ReadIndex** (confirm leadership with a heartbeat round before serving the read) or **leader leases** (rely on bounded clock drift).
- **PreVote and CheckQuorum:** stop a partitioned server from disrupting the cluster with ever-increasing terms when it rejoins.

## Paxos

Leslie Lamport's Paxos (written up in 1989, published in 1998, re-explained in *Paxos Made Simple*, 2001) solves **single-decree consensus**: agreeing on **one** value. There are three roles: **proposers**, **acceptors** and **learners**. One machine usually plays all three.

![Sequence diagram: proposer sends Prepare(5), acceptors return Promise, proposer sends Accept(5, v), acceptors reply Accepted.](/figures/consensus/paxos-phases.svg "Phase 1 reserves a ballot number and discovers any value that may already have been chosen. Phase 2 gets a majority to accept a value.")

1. **Prepare(n):** a proposer picks a unique ballot number `n` higher than any it has used and sends it to the acceptors.
2. **Promise:** an acceptor that hasn't promised a higher ballot promises to ignore lower ones, and reports the highest-numbered proposal it has already **accepted**, if any.
3. **Accept(n, v):** with promises from a majority, the proposer sends a value. It **must** use the value from the highest-numbered accepted proposal it heard about. Only if there was none may it use its own.
4. **Accepted:** acceptors accept unless they've promised a higher ballot. Once a majority accepts `(n, v)`, `v` is **chosen** and can never change.

The rule in step 3 is the core of Paxos. Any later proposer will run into that chosen value in its phase 1 and is forced to re-propose it.

### Multi-Paxos

A log needs a decision per slot. Running both phases for every entry would be slow, so **Multi-Paxos** elects a stable leader that runs phase 1 once for all future slots and then does only phase 2 (one round trip) per entry. At that point it looks a lot like Raft. The difference is that Paxos variants allow more flexibility, such as holes in the log and out-of-order commits, and leave many engineering details unspecified. Google's *Paxos Made Live* paper documents how much work it took to turn Paxos into Chubby.

## Raft vs Paxos

| | Raft | (Multi-)Paxos |
| --- | --- | --- |
| Design goal | Understandability, a complete spec | Minimal, provably correct core |
| Leader | Required. Only nodes with up-to-date logs can win. | Optional for safety. Any node can propose. |
| Log | No holes. Entries committed in order. | Slots decided independently. Holes possible. |
| Spec completeness | Election, replication, membership, compaction | Core algorithm. The rest is left to implementers. |
| Common in | etcd, Consul, CockroachDB, TiKV, Kafka KRaft | Chubby, Spanner, Megastore, Cassandra LWT (Paxos per operation) |

They have the same fault tolerance (`2f + 1`) and the same message cost in steady state: one round trip from leader to majority. In 2020, Howard and Mortier showed that Raft and Paxos are far more alike than different, and that Raft's leader election is in effect a particular way of running Paxos phase 1.

## Where it's used

| System | Consensus | What it agrees on |
| --- | --- | --- |
| **etcd** (Kubernetes' brain) | Raft | All cluster state: pods, services, leases |
| **ZooKeeper** | ZAB (a Paxos-like atomic broadcast) | Coordination: locks, leader election, config |
| **Kafka (KRaft)** | Raft variant | Cluster metadata. Replaces ZooKeeper; ZooKeeper mode was removed in Kafka 4.0. |
| **CockroachDB, TiKV, YugabyteDB** | Raft per data range | Each range is its own Raft group. Thousands per cluster. |
| **Google Spanner** | Paxos per split | Replicated, externally consistent data across zones |
| **Consul, Nomad, Vault** | Raft | Service catalog, scheduling state, secrets |
| **MongoDB replica sets** | Raft-inspired protocol | Primary election and oplog replication |

### Use case walk-through: Kubernetes losing a node

Your cluster's control plane runs etcd on 3 machines. One dies.

- 2 of 3 is still a majority. Writes keep committing, the API server keeps working, nothing visible happens.
- A second dies. 1 of 3 can't form a majority. etcd **stops accepting writes**, so you can't create pods or change deployments. Existing pods keep running, because the kubelets already have their instructions.
- That's the CAP choice in action. etcd chose **consistency** over availability rather than risk two halves of the control plane disagreeing.

## Pitfalls

- **Consensus isn't free.** Every write waits for a majority round trip plus an fsync. Across regions, that's tens to hundreds of milliseconds. Keep consensus for **metadata and coordination**, and shard bulk data into many small groups.
- **Disk latency matters more than CPU.** etcd's most common production problem is slow fsync, which leads to missed heartbeats, spurious elections and an unstable cluster.
- **Don't build your own.** Consensus bugs are subtle and show up only under rare interleavings. Use a mature library (etcd/raft, hashicorp/raft, Apache Ratis) or a service, and test with fault injection (Jepsen).
- **Leader leases depend on clocks.** Lease-based reads assume bounded clock drift. A VM paused for 30 seconds can wake up still believing it's the leader. That's why fencing tokens exist.
- **More nodes is not more throughput.** Every write still goes through one leader to a majority. Scale by **partitioning** into many groups, not by growing one.

## Discussion questions

1. Why does a 4-node cluster tolerate no more failures than a 3-node one? When might you still run 4?
2. In Raft, why must a voter refuse candidates with less up-to-date logs? Construct a scenario where skipping that rule loses a committed write.
3. What happens to client requests during a Raft leader election? How long is the cluster unavailable?
4. Why does Paxos phase 2 force the proposer to reuse a previously accepted value?
5. How do CockroachDB and Spanner get high throughput when each consensus group has a single leader?
6. FLP says consensus can't always terminate. Why don't we see etcd clusters stuck forever in practice?

## FAQ

### Is consensus the same as two-phase commit?

No. Two-phase commit (2PC) gets several participants to agree to **commit or abort a transaction**, and it **blocks** if the coordinator crashes at the wrong moment. Consensus tolerates the failure of any minority, leader included. Systems like Spanner run 2PC **on top of** Paxos groups, so each 2PC participant is itself fault-tolerant.

### What about Byzantine (malicious) failures?

Raft and Paxos assume servers are **crash-faulty but honest**. If nodes may lie or be compromised, you need Byzantine fault-tolerant protocols (PBFT, Tendermint, HotStuff), which require **3f + 1** nodes to tolerate f bad ones and cost more messages. They're mostly used in blockchains and some high-assurance systems.

### Does Raft guarantee linearizable reads?

Not automatically. A leader that has been partitioned away may still believe it's the leader and serve stale reads. etcd and others use **ReadIndex** (confirm leadership with a majority before answering) or **leases** (time-bounded leadership) to make reads linearizable. Follower reads are cheaper but may be stale unless they also use ReadIndex.

### Why not just use a database with a primary and a replica?

Primary/replica failover needs *something* to decide who the new primary is, and to make sure the old one has stopped. Without consensus, a network blip can leave two primaries accepting writes. Many databases rely on an external consensus service (etcd, ZooKeeper, Consul) or a built-in Raft protocol exactly for this.

### How long does a Raft election take?

Roughly one election timeout plus a round trip: typically a few hundred milliseconds with default settings in a LAN. The timeouts have to be much larger than the heartbeat interval and network round trip, or the cluster will churn through needless elections.

### Is ZooKeeper's ZAB just Paxos?

ZAB (ZooKeeper Atomic Broadcast) is a different protocol designed for primary-backup ordering. It shares Paxos' majority-quorum foundations and resembles Multi-Paxos with a stable leader, but it was designed around ZooKeeper's specific needs, like ordered broadcast and fast recovery.

## Key takeaways

- Consensus gives you a **replicated log**, and with it a fault-tolerant **replicated state machine**.
- **2f + 1** servers tolerate **f** crashes. Overlapping majorities are what carry committed decisions forward.
- **Raft** = randomized leader election + log replication with a consistency check + an election restriction that keeps committed entries safe.
- **Paxos** = prepare/promise then accept/accepted. Multi-Paxos with a stable leader looks very much like Raft.
- Use consensus for **coordination and metadata**, partition for scale, and never hand-roll it.

## References

1. D. Ongaro, J. Ousterhout. [In Search of an Understandable Consensus Algorithm](https://raft.github.io/raft.pdf). *USENIX ATC 2014*.
2. L. Lamport. [The Part-Time Parliament](https://lamport.azurewebsites.net/pubs/lamport-paxos.pdf). *ACM TOCS*, 1998.
3. L. Lamport. [Paxos Made Simple](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf). 2001.
4. M. Fischer, N. Lynch, M. Paterson. [Impossibility of Distributed Consensus with One Faulty Process](https://groups.csail.mit.edu/tds/papers/Lynch/jacm85.pdf). *JACM*, 1985.
5. T. Chandra, R. Griesemer, J. Redstone. [Paxos Made Live: An Engineering Perspective](https://research.google/pubs/paxos-made-live-an-engineering-perspective/). *PODC 2007*.
6. H. Howard, R. Mortier. [Paxos vs Raft: Have we reached consensus on distributed consensus?](https://arxiv.org/abs/2004.05074) *PaPoC 2020*.
7. [The Raft Consensus Algorithm](https://raft.github.io/): visualizations, papers and implementations.
8. F. Junqueira, B. Reed, M. Serafini. [Zab: High-performance broadcast for primary-backup systems](https://marcoserafini.github.io/papers/zab.pdf). *DSN 2011*.
9. M. Castro, B. Liskov. [Practical Byzantine Fault Tolerance](https://pmg.csail.mit.edu/papers/osdi99.pdf). *OSDI 1999*.
10. etcd docs. [etcd versus other key-value stores](https://etcd.io/docs/latest/learning/why/) and [Tuning](https://etcd.io/docs/latest/tuning/).

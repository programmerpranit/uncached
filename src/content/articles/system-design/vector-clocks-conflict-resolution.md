---
summary: When replicas accept writes independently, timestamps can't tell an overwrite from a conflict. Vector clocks track causality so a store knows when two versions really are concurrent, and then something has to merge them.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** In multi-leader and leaderless databases, two replicas can accept writes to the same key at the same time. Resolving that with **wall-clock timestamps** (last-write-wins) silently **drops** one write, and clock skew can drop the newer one. A **vector clock** keeps **one counter per node**. Comparing two vectors tells you whether one version **happened before** the other (safe to overwrite) or whether they're **concurrent** (a real conflict). Detecting concurrency is half the job. Resolving it means keeping both versions as **siblings** for the application to merge, using a type-specific **merge function**, or using **CRDTs** that merge automatically.

## The problem: concurrent writes

With a single leader, all writes to a key go through one node, which orders them. Conflicts can't happen. But many systems accept writes on several nodes:

- **Leaderless replication** (Dynamo, Cassandra, Riak): any replica can take a write.
- **Multi-leader / multi-region** setups: each region accepts local writes and replicates asynchronously.
- **Offline-first clients**: a phone edits data without a connection and syncs later.

Two clients can then update the same key on different replicas at about the same time. When the replicas exchange updates, each has to decide: is the incoming version **newer** than mine, **older**, or **neither**?

![Replica A adds eggs, replica B adds bread to the same cart concurrently; last-write-wins keeps only eggs.](/figures/vector-clocks/lww.svg "Both replicas agree on the result, and they agree on the wrong one.")

The tempting answer is **last-write-wins (LWW)**: attach a timestamp and keep the higher one. Replicas converge, but:

- Of two **concurrent** writes, one is **silently discarded**. The user who added bread never finds out.
- **Clock skew**: if B's clock runs 50 ms fast, B's older write "wins" over A's newer one.
- Even sequential writes from one client can be reordered if they land on nodes with different clocks.

LWW is fine when losing concurrent writes is acceptable (caches, sensor readings where any recent value will do, immutable keys written once). For a shopping cart or a document, it isn't.

## Causality, not time

Leslie Lamport's 1978 paper defined **happened-before** (→): event a → b if a came before b on the same node, or a is the sending of a message and b its receipt, or by transitivity. If neither a → b nor b → a, the events are **concurrent**: neither could have known about the other.

What we actually want to know about two versions isn't "which was written later in wall-clock time" but "**did the writer of one version see the other?**" If the second writer had seen the first version, the second is a deliberate update and should replace it. If not, they're concurrent edits and both contain information.

**Lamport clocks** (a single counter) give an order consistent with causality, but can't detect concurrency: if L(a) < L(b), a might have happened before b, or they might be concurrent. **Vector clocks** (Fidge and Mattern, 1988) fix that.

## How vector clocks work

Each node keeps a vector with **one counter per node**.

- **Local event** (e.g. a write): increment your own entry.
- **Send**: attach your current vector.
- **Receive**: take the **element-wise maximum** of your vector and the received one, then increment your own entry.

![Three timelines A, B and C with events labelled by vector clocks; A at [3,0,0] and B at [2,2,1] are concurrent.](/figures/vector-clocks/spacetime.svg "Each vector summarizes everything its event could have known about.")

Entry `i` in an event's vector counts how many events on node `i` are in that event's causal past. So comparing vectors compares knowledge.

### Comparing two vectors

![Three cases: [2,1,0] vs [3,1,0] happened-before; equal vectors are the same version; [3,0,0] vs [2,2,1] are concurrent.](/figures/vector-clocks/compare.svg "Two vectors are ordered only if one is ≥ the other in every position.")

For versions with vectors V and W:

- **V ≤ W in every entry** (and different): V happened before W. W **supersedes** V, so V can be discarded.
- **Equal**: the same version.
- **Some entries greater, some smaller**: **concurrent**. Neither saw the other. This is a real conflict, and both must be kept.

### Version vectors in databases

Databases use a close cousin, the **version vector**: one counter per **replica** (not per client), attached to each stored value.

1. A client **reads** a key and gets the value plus its version vector (Riak calls this the "causal context").
2. The client **writes back** a new value along with the vector it read.
3. The replica compares: if the client's vector covers what's stored, it's an overwrite. If the store has versions the client didn't see, the new value is **concurrent** with them, and the store keeps **siblings**.
4. A later read returns **all siblings**. The client merges them and writes back with a vector covering all of them, collapsing the siblings into one.

Always **read before you write** so you pass the right context. A blind write with no context is concurrent with everything.

## Resolving conflicts

![Four options: last-write-wins, siblings with application merge, merge functions, and CRDTs.](/figures/vector-clocks/resolution.svg "Detection tells you there's a conflict. Something still has to decide the merged value.")

1. **Last-write-wins.** Pick one sibling by timestamp or node ID. Simple, convergent, loses data. Cassandra uses LWW per **column** (cell), which reduces, but doesn't remove, loss.
2. **Siblings + application merge.** Return all concurrent versions and let the application merge them with domain knowledge. Dynamo's shopping cart merged siblings by **set union**, which never lost an added item, but sometimes **resurrected removed items**, because a union can't tell "never added" from "added then removed".
3. **Built-in merge functions.** For specific types: take the max of counters, the union of sets, concatenate lists. CouchDB picks a deterministic winner but keeps losing revisions available to the application.
4. **CRDTs.** Conflict-free replicated data types (counters, sets with tombstones, maps, registers, text sequences) are designed so concurrent updates **always merge** into the same result, without application code. Riak's data types, Redis Enterprise active-active and Automerge use them.
5. **Ask the user.** Git merge conflicts, or a "this note was edited on two devices" dialog. Fine for documents, impossible for high-volume data.

## The size problem

A vector clock has one entry per node or client that has ever written. With many clients, vectors grow without bound.

- **Use replica IDs, not client IDs** (version vectors): the size is bounded by the replica count.
- **Pruning**: Dynamo stored a timestamp with each entry and dropped the oldest when the vector exceeded about 10 entries. That can make a descendant look concurrent with its ancestor, producing spurious siblings, but never silently loses data.
- **Dotted version vectors** (Preguiça, Baquero et al.) fix a subtle problem where siblings multiply when many clients write through the same replica. Riak 2.0 adopted them.
- **Interval tree clocks** support dynamic numbers of participants that join and leave.

## Where it's used

| System | Mechanism |
| --- | --- |
| **Amazon Dynamo** (2007 paper) | Vector clocks per object, siblings returned to the application, clock truncation |
| **Riak** | Version vectors, then dotted version vectors. Siblings or CRDT data types. |
| **Voldemort** (LinkedIn) | Vector clocks, application-level resolution |
| **Cassandra / ScyllaDB** | LWW per cell with timestamps. No vector clocks. Lightweight transactions (Paxos) when you need compare-and-set. |
| **DynamoDB** (the service) | Single-leader per item within a region. Global tables use LWW across regions. |
| **CouchDB / PouchDB** | Revision trees. A deterministic winner plus retained conflicting revisions for the app. |
| **Git** | Commit DAG. Merge-base tells whether one branch contains another (fast-forward) or they diverged (merge). |
| **Automerge, Yjs** | CRDTs with causal metadata for offline-first collaboration |

### Use case walk-through: a multi-device notes app

Notes are stored per device and synced through a server, and users often edit offline.

1. Each note stores a version vector with one entry per **device**: `{phone: 4, laptop: 2}`.
2. The phone edits offline: `{phone: 5, laptop: 2}`. The laptop also edits: `{phone: 4, laptop: 3}`.
3. On sync, the server compares: neither covers the other, so they're **concurrent**. It stores both as siblings.
4. The app merges: for note titles (a register), it shows both and asks the user. For the checklist (a set), it uses an add-wins set CRDT so items added on either device are kept and items removed on one device are removed.
5. The merged version gets `{phone: 5, laptop: 3}` plus one increment for the device that performed the merge, and supersedes both siblings.

## Pitfalls

- **Assuming LWW is harmless.** It's the default in many stores. Know which of your data can tolerate silently lost writes.
- **Writing without the causal context.** A write that doesn't carry the vector it read creates a sibling every time.
- **Unbounded siblings.** If clients never merge, sibling lists grow forever. Riak calls this "sibling explosion".
- **Naive union merges** resurrect deleted items. Deletions need **tombstones** or a CRDT that tracks removes.
- **Vectors keyed by client** grow without bound. Key them by replica or use dotted version vectors.

> [!WARNING]
> Vector clocks **detect** conflicts. They don't resolve them. If the merge step isn't designed, you've only moved the data loss from the database into your application.

## Discussion questions

1. Give an example of data where last-write-wins is acceptable, and one where it isn't.
2. Why can't a Lamport clock tell you that two events are concurrent?
3. Two siblings exist: `{A:2, B:1}` and `{A:1, B:2}`. A client merges them on replica A. What vector should the merged version get?
4. How would you merge a shopping cart so removed items don't reappear?
5. Why do databases key version vectors by replica instead of by client?
6. How does Git decide between a fast-forward and a merge, and how is that related to vector clocks?

## FAQ

### What's the difference between a vector clock and a version vector?

They use the same comparison rules. **Vector clocks** track causality between **events** in a distributed computation (every send and receive). **Version vectors** track versions of **replicated data**, with one entry per replica, updated on writes. In databases, "vector clock" is often used loosely to mean a version vector.

### Why not just use synchronized clocks?

Even well-synchronized clocks differ by milliseconds, and two writes within that window can't be ordered reliably. More fundamentally, timestamps order writes but can't say whether one writer **saw** the other's write. That's what decides overwrite versus conflict.

### What about hybrid logical clocks?

**Hybrid logical clocks (HLC)** combine a physical timestamp with a logical counter. They stay close to wall-clock time and respect causality for single values (CockroachDB and YugabyteDB use them). Like Lamport clocks, they produce a **total order**, so they can't detect concurrency by themselves. They're used for ordering and snapshots, not for detecting conflicts.

### Do CRDTs replace vector clocks?

Many CRDTs use vector clocks or similar causal metadata internally: to know which updates a replica has seen, to implement remove operations, or to deliver operations in causal order. CRDTs answer "how do I merge?". Causal metadata answers "what has been seen?".

### How big do vector clocks get in practice?

With version vectors per replica, typically 3–5 entries (the replication factor), plus a few for hinted handoff. Problems come from per-client vectors or from many replicas over a key's lifetime, which is why pruning and dotted version vectors exist.

### Is Cassandra's conflict resolution safe?

It's **convergent** (all replicas agree) but **lossy** for concurrent writes to the same cell, since it uses LWW timestamps. Design schemas so concurrent writers touch different cells (e.g. append rows rather than overwrite one value), or use lightweight transactions for compare-and-set.

## Key takeaways

- Concurrent writes are unavoidable when multiple replicas accept writes.
- **Last-write-wins** converges but silently drops concurrent writes and depends on clocks.
- **Vector (version) clocks** capture **causality**: they tell overwrite (happened-before) apart from conflict (concurrent).
- Conflicts must still be **resolved**: siblings + application merge, type-specific merges, or **CRDTs**.
- Watch the operational details: pass causal context on writes, bound vector size, and handle deletes with tombstones.

## References

1. L. Lamport. [Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf). *Communications of the ACM*, 1978.
2. C. Fidge. [Timestamps in Message-Passing Systems That Preserve the Partial Ordering](https://zoo.cs.yale.edu/classes/cs426/2012/lab/bib/fidge88timestamps.pdf). 1988.
3. F. Mattern. Virtual Time and Global States of Distributed Systems. *Parallel and Distributed Algorithms*, 1989.
4. G. DeCandia et al. [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf). *SOSP 2007*.
5. Riak docs. [Causal Context](https://docs.riak.com/riak/kv/latest/learn/concepts/causal-context/index.html) and [Conflict Resolution](https://docs.riak.com/riak/kv/latest/developing/usage/conflict-resolution/index.html).
6. N. Preguiça, C. Baquero, P. S. Almeida, V. Fonte, R. Gonçalves. [Dotted Version Vectors: Logical Clocks for Optimistic Replication](https://arxiv.org/abs/1011.5808). 2010.
7. M. Kleppmann. *Designing Data-Intensive Applications*, chapter 5: Replication ("Detecting Concurrent Writes"). O'Reilly, 2017.
8. S. Kulkarni et al. [Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases](https://cse.buffalo.edu/tech-reports/2014-04.pdf) (hybrid logical clocks). 2014.
9. Basho. [Why Vector Clocks Are Hard](https://riak.com/posts/technical/why-vector-clocks-are-hard/). 2010.

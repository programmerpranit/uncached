---
summary: Conflict-free replicated data types let every replica accept writes without coordination and still converge to the same state. How counters, sets, registers and collaborative text are built to merge automatically, and what that costs.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **CRDT** (conflict-free replicated data type) is a data structure designed so replicas can be updated **independently and concurrently**, without locks or consensus, and are **guaranteed to converge** to the same state once they've seen the same updates. The trick is to make merging **commutative, associative and idempotent** (state-based CRDTs) or to make concurrent operations **commute** (operation-based CRDTs). There are CRDTs for counters, sets, registers, maps, lists and text. They power **offline-first** and **real-time collaborative** apps (Figma-style multiplayer, Automerge, Yjs) and **active-active** databases (Riak, Redis Enterprise). The price is **metadata** (IDs, tombstones, version vectors) and semantics that don't fit every invariant: a CRDT can't enforce "balance never goes below zero".

## The problem: writes everywhere, no coordination

You want every replica, whether a phone, a browser tab or a database in another region, to accept writes **immediately**, even offline, and sync later. The usual options all disappoint:

- **Consensus** (Raft, Paxos) needs a majority to be reachable for each write. Offline devices can't write, and cross-region writes pay round trips.
- **Last-write-wins** converges but silently drops concurrent writes.
- **Siblings + application merge** keeps all versions, but every application must write correct merge logic for every type, and it's easy to get wrong.

CRDTs move the merge logic **into the data type**, designed once and proven correct, so any two replicas that have received the same set of updates are in the **same state**, regardless of order or duplication. This property is called **strong eventual consistency**.

## The core idea: merges that can't disagree

The simplest example: a counter of likes, replicated on several nodes.

![Replica A has {A:3, B:0, C:0}, replica B has {A:1, B:2, C:0}; merging takes the max per slot, giving {A:3, B:2, C:0} with value 5.](/figures/crdts/g-counter.svg "Each replica only ever increments its own slot. Merging can't lose an increment or count one twice.")

A single integer doesn't work: if A and B both go from 5 to 6 and then sync, is the answer 6 or 7? Instead, a **G-Counter** (grow-only counter) keeps **one slot per replica**:

- **Increment:** a replica adds 1 to **its own** slot.
- **Value:** the sum of all slots.
- **Merge:** the **element-wise maximum** of the two vectors.

`max` is **commutative** (order doesn't matter), **associative** (grouping doesn't matter) and **idempotent** (merging the same state twice changes nothing). So replicas can gossip states in any order, over an unreliable network that duplicates and reorders messages, and still agree.

A **PN-Counter** supports decrements with two G-Counters, P for increments and N for decrements: value = P − N.

Mathematically, the states form a **join-semilattice** and the merge is the **least upper bound**. Every update moves the state "up", and merging finds the smallest state that includes both.

## Two families

![State-based CRDTs ship state and merge with a join; operation-based CRDTs ship operations that must commute and need causal, exactly-once delivery.](/figures/crdts/state-vs-op.svg "Same convergence guarantee, different demands on the network.")

- **State-based (CvRDT, convergent):** replicas periodically send their **whole state**, and receivers merge with the join function. Robust to any delivery order, loss and duplication. The cost is bandwidth when states are large.
- **Operation-based (CmRDT, commutative):** replicas broadcast each **operation** ("increment by 1", "insert 'x' after ID 7@A"). Concurrent operations must commute. Messages are small, but delivery must be **exactly once** and usually in **causal order**, which requires a reliable broadcast layer.
- **Delta-state CRDTs** send only the **change** (a small piece of state) but merge it with the same join, so they keep state-based robustness with op-based message sizes. Most production systems use something in this family.

## A tour of common CRDTs

### Registers

A register holds a single value.

- **LWW-Register:** keep the value with the highest (timestamp, replica ID). It converges but drops concurrent writes, which is often fine for things like "user's display name".
- **Multi-Value Register (MV-Register):** keep **all** concurrent values (using version vectors) and let the reader pick or merge. It's what Dynamo's siblings are.

### Sets

Sets are where the semantics get interesting, because **add and remove don't commute**. If one replica adds "milk" while another concurrently removes it, what should the result be?

- **G-Set:** add only. Merge = union. Trivial.
- **2P-Set:** a G-Set of adds plus a G-Set of removes (tombstones). Once removed, an element can **never be added again**.
- **LWW-Element-Set:** each add and remove carries a timestamp, and the latest wins per element.
- **OR-Set (observed-remove), add-wins:** the usual choice.

![Replica A adds milk with tag a1; B sees it; A removes milk covering tag a1 while B concurrently adds milk with tag b7; after merging, milk with tag b7 remains on both.](/figures/crdts/or-set.svg "A remove can only delete the adds it has observed. A concurrent add wasn't observed, so it survives.")

In an OR-Set, every **add** creates a unique tag. A **remove** deletes only the tags the remover has **observed**. A concurrent add has a tag the remover never saw, so it survives. The intuitive result: if one person removes an item while another adds it, the item stays. This is exactly the fix for Dynamo's "deleted items reappear" shopping-cart bug, which came from a naive union.

Remove-wins variants also exist. Which one is right depends on the application.

### Maps and JSON

Maps nest CRDTs: each key maps to a CRDT value (a counter, a register, another map), and the map merges key by key. Automerge and Yjs offer a full **JSON-like document** CRDT this way. Riak's data types include maps, sets, counters, flags and registers.

### Sequences and collaborative text

Text editing is the hardest case. Positions shift with every insert and delete, so "insert 'x' at index 5" means different things on replicas that have seen different edits.

![Characters H and i have IDs 1@A and 2@A; A inserts ! after 2@A and B inserts ? after 2@A; both replicas end up with H i ? !.](/figures/crdts/sequence.svg "Referencing stable IDs instead of indexes makes concurrent inserts well defined.")

Sequence CRDTs give every character a **unique, stable ID** and express edits relative to IDs:

- **Insert** "after ID 2@A". Concurrent inserts at the same spot are ordered by a deterministic tiebreak (e.g. higher counter or replica ID first).
- **Delete** marks a character as a **tombstone** rather than removing it, because other replicas' inserts might reference it.

Well-known algorithms: **RGA** (Replicated Growable Array), **Logoot** and **LSEQ** (dense position identifiers), **YATA** (used by Yjs), **Fugue** (2023, which avoids interleaving of concurrent insertions), and the algorithms behind Automerge.

**Operational transformation (OT)**, used by Google Docs, solves the same problem differently: a central server transforms concurrent operations against each other. OT is simpler with a server in the middle. CRDTs work peer-to-peer and offline.

## The costs

- **Metadata overhead.** Unique IDs per element, version vectors, and **tombstones** for deletions. A text CRDT may store far more than the visible text. Modern implementations (Yjs, Automerge 2, diamond-types) compress this heavily with run-length encoding, getting overhead to a small multiple of the text size.
- **Tombstone garbage collection.** Tombstones can be removed only when every replica has seen the deletion, which requires knowing who all the replicas are, which is hard in open peer-to-peer systems.
- **Limited invariants.** CRDTs guarantee convergence, not business rules. "Stock never negative", "username unique" and "at most 10 seats" need coordination. Escrow and reservation techniques (pre-allocating a share of the budget to each replica) can help in some cases.
- **Surprising semantics.** Merged results are deterministic but not always what a human would choose: interleaved text from concurrent typing, a renamed and a deleted field both "winning" in odd ways. Pick types whose merge semantics match your domain.
- **Schema evolution** of CRDT documents is hard, since old replicas may still be sending operations in old formats.

## Where it's used

| System | How it uses CRDTs |
| --- | --- |
| **Riak** | Built-in data types: counters, sets, maps, registers, flags, HyperLogLog |
| **Redis Enterprise Active-Active** | CRDT-based multi-region replication for strings, counters, sets, sorted sets, lists |
| **Automerge** | JSON document CRDT library for local-first apps (Rust core with JS bindings) |
| **Yjs** | Fast CRDT for collaborative editing. Bindings for ProseMirror, CodeMirror, Monaco, Quill. |
| **Figma** | Multiplayer inspired by CRDTs, but with a central server as the authority (properties use last-writer-wins per object) |
| **Apple Notes, Zed** | CRDT-based sync for notes and for collaborative code editing |
| **SoundCloud Roshi, League of Legends chat** | LWW-element sets for timelines and presence at scale |

### Use case walk-through: an offline-first task app

Users edit task lists on phones and laptops, often without connectivity.

1. Each list is an **Automerge document**: a map with `title` (LWW register), `tasks` (list of maps), and per-task `done` (LWW register) and `labels` (add-wins set).
2. Edits apply locally immediately, so the UI never waits for the network.
3. When online, devices exchange **changes** (deltas) with a sync server, which simply relays and stores them. The server doesn't need merge logic.
4. Concurrent edits merge automatically: two people adding tasks get both tasks. One marking done while another edits the title keeps both. Concurrent title edits use LWW.
5. Invariants that need coordination ("only the owner can delete a list") are enforced by the server **validating** incoming changes, not by the CRDT.

## Pitfalls

- **Choosing LWW everywhere** and calling it a CRDT. It converges, but it's the lossy option.
- **Ignoring tombstone growth** in long-lived documents. Plan for compaction or snapshotting.
- **Assuming CRDTs enforce invariants.** They don't. Uniqueness and non-negative balances need coordination.
- **Rolling your own.** Correct CRDTs are subtle (interleaving anomalies in text, resurrection in sets). Use a well-tested library.
- **Wall-clock timestamps in LWW parts** without considering skew. Use hybrid logical clocks or Lamport timestamps.

> [!TIP]
> Start from the user's expectation of a merge ("if two people add items, keep both"; "if one deletes and one edits, keep the edit"), then pick the CRDT whose semantics match. The data type is a product decision as much as a technical one.

## Discussion questions

1. Why do a G-Counter's merge properties (commutative, associative, idempotent) matter for unreliable networks?
2. In a shopping cart, should a concurrent add and remove of the same item result in the item being present or absent? Why?
3. Why can't a CRDT enforce "account balance never goes below zero"? What could you do instead?
4. Compare operational transformation and CRDTs for a collaborative editor with and without a central server.
5. How would you garbage-collect tombstones in a system where devices may stay offline for months?
6. When would plain last-write-wins be the right choice?

## FAQ

### Are CRDTs eventually consistent?

They provide **strong eventual consistency**: replicas that have received the same set of updates are in the same state **immediately**, without further coordination or conflict resolution rounds. Plain eventual consistency only promises that replicas converge "eventually", possibly after resolving conflicts.

### Do CRDTs need a server?

No. They work peer-to-peer, since any replica can sync with any other. Many apps still use a server for relay, storage, authentication and validation, but the server doesn't need to resolve conflicts.

### What's the difference between CRDTs and OT?

Both enable concurrent editing. **Operational transformation** rewrites operations against concurrent ones, typically through a central server that defines the order. **CRDTs** make operations commute by design, using unique IDs, so no central ordering is needed. CRDTs historically had higher memory overhead, but modern implementations have closed most of that gap.

### How much overhead do CRDTs add?

It depends on the type and the implementation. Counters cost one integer per replica. Sets need tags and tombstones. Text CRDTs used to cost tens of bytes per character, but Yjs and Automerge 2 compress runs of consecutive inserts by the same author, reducing overhead to a small multiple of the document size for typical editing histories.

### Can I use CRDTs in my database?

Yes, through databases that support them (Riak, Redis Enterprise Active-Active, AntidoteDB, ElectricSQL-style sync layers) or by storing CRDT documents (Automerge/Yjs binary format) as values and merging in the application.

### What does "local-first" mean?

A design philosophy (from Ink & Switch's 2019 essay) where the primary copy of data lives on the user's device, apps work fully offline, and sync and collaboration happen in the background. CRDTs are the main enabling technology.

## Key takeaways

- CRDTs let replicas **update independently** and **converge automatically**: strong eventual consistency without coordination.
- State-based CRDTs merge with a **join** (commutative, associative, idempotent). Op-based CRDTs need **commuting operations** and reliable causal delivery. Delta CRDTs combine both.
- Common types: **counters** (G/PN), **registers** (LWW, MV), **sets** (OR-Set, add-wins), **maps**, **sequences** for text.
- Costs: **metadata and tombstones**, and no support for invariants that need coordination.
- They power **local-first**, **collaborative** and **active-active multi-region** systems.

## References

1. M. Shapiro, N. Preguiça, C. Baquero, M. Zawirski. [Conflict-free Replicated Data Types](https://inria.hal.science/hal-00932836/document). *SSS 2011*.
2. M. Shapiro et al. [A comprehensive study of Convergent and Commutative Replicated Data Types](https://inria.hal.science/inria-00555588/document). INRIA tech report, 2011.
3. P. S. Almeida, A. Shoker, C. Baquero. [Delta State Replicated Data Types](https://arxiv.org/abs/1603.01529). 2016.
4. M. Kleppmann, A. Wiggins, P. van Hardenberg, M. McGranaghan. [Local-first software: You own your data, in spite of the cloud](https://www.inkandswitch.com/local-first/). Ink & Switch, 2019.
5. M. Weidner, M. Kleppmann. [The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing](https://arxiv.org/abs/2305.00583). 2023.
6. P. Nicolaescu, K. Jahns, M. Derntl, R. Klamma. [Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types) (YATA / Yjs). *GROUP 2016*.
7. Figma Engineering. [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/). 2019.
8. crdt.tech. [Resources and papers on CRDTs](https://crdt.tech/).
9. Redis docs. [Active-Active geo-distributed Redis](https://redis.io/docs/latest/operate/rs/databases/active-active/).

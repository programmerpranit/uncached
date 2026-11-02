---
summary: How hashing data into a tree lets two replicas find exactly where they differ by exchanging a handful of hashes, and why the same structure underpins Git, blockchains, certificate transparency and database repair.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **Merkle tree** hashes data in blocks or key ranges (the leaves), then hashes pairs of hashes up to a single **root**. Any change to any data changes the root, so **equal roots mean identical data**. To find what differs between two replicas, compare roots, then compare children only where hashes differ, and descend. The cost is proportional to **the number of differences × tree depth**, not the size of the data. This makes Merkle trees the standard tool for **anti-entropy**: background repair that brings diverged replicas back in sync (Dynamo, Cassandra, Riak). The same structure gives cheap **inclusion proofs** (prove one item is in a set of a billion with ~30 hashes), which is why **Git**, **Bitcoin**, **Certificate Transparency**, **IPFS** and **ZFS** all use it.

## The problem: are these replicas the same?

Replicated databases drift. A replica misses writes while it's down, hinted handoff loses hints, a bug or disk error corrupts data, or a delete doesn't reach every replica. Read repair fixes keys that get read, but rarely read keys can stay inconsistent forever. **Anti-entropy** is the background process that periodically compares replicas and fixes all differences.

How do you compare two replicas holding 100 million keys?

- **Send everything:** transfer all keys and values. Tens or hundreds of gigabytes for a few differing keys.
- **Send a hash per key:** smaller, but still gigabytes, and it grows with the data.
- **Send one hash of everything:** tells you *whether* they differ, not *where*.

A Merkle tree gives you both: a single hash to check equality, and a structure to find the differences cheaply.

## How a Merkle tree works

![A tree with four leaves H0 to H3 hashing key ranges, two parents H(01) and H(23), and a root.](/figures/merkle/tree.svg "Each hash summarizes everything below it.")

Ralph Merkle patented the idea in 1979.

1. Split the data into blocks or **key ranges** and hash each one. These are the **leaves**.
2. Hash each pair of leaves together to get their parent: `H(01) = hash(H0 ‖ H1)`.
3. Repeat up the tree until there's one **root hash**.

Properties:

- **Tamper-evident:** changing any data changes its leaf, every ancestor, and the root. With a cryptographic hash, it's infeasible to produce different data with the same root.
- **Cheap updates:** changing one leaf means recomputing only the log₂ n hashes on its path to the root.
- **Compact summary:** the root is a fixed-size fingerprint of arbitrarily large data.

## Finding differences

![Two trees compared top-down: root differs; left child equal (skipped); right child differs; descend until one differing leaf is found.](/figures/merkle/diff.svg "Equal subtrees are skipped entirely, no matter how much data they cover.")

Two replicas build trees over the **same key ranges** and compare:

1. Exchange root hashes. If equal, done: the replicas are identical.
2. Otherwise, exchange the root's children. For each child whose hash matches, **skip** the whole subtree.
3. Descend into each mismatching child, and repeat.
4. At the leaves, exchange the actual keys (or per-key hashes) in each differing range, and copy the newer versions across.

If d leaves differ in a tree of depth h, this costs roughly **d × h** hash comparisons plus the keys in d ranges, independent of the total data size.

![Bars: sending every key and value ~100 GB; every key and hash ~2.4 GB; Merkle tree and differing ranges ~0.2 MB.](/figures/merkle/cost.svg "The cost follows the differences. The catch is building the tree, which reads all the data once.")

### The catch: building the tree

To compute leaf hashes, you must **read all the data**. That's the main cost of Merkle-based repair:

- **Cassandra** builds Merkle trees during repair through a "validation compaction" that reads every SSTable for the range, which is I/O-heavy, so repair is scheduled and throttled. Since Cassandra 4.0, **incremental repair** marks already-repaired data so later repairs only need to process new data.
- **Riak's active anti-entropy** keeps **persistent, incrementally updated** hash trees on disk, so trees are always ready to compare.
- **Dynamo** maintained a Merkle tree per key range (virtual node), recalculated when ranges change ownership.

Tree shape is a tuning choice: more leaves mean smaller ranges to transfer per difference but more hashes to store and compare. Cassandra limits tree depth (2¹⁵ to 2²⁰ leaves per range), so with a lot of data each leaf covers many keys, and a single difference causes a whole leaf range to be streamed ("overstreaming").

## Inclusion proofs

![The path from leaf H2 to the root: given H3 and H(01), a verifier computes H(23) and then the root, and compares it with the trusted root.](/figures/merkle/proof.svg "With n items, a proof is log₂ n hashes.")

If someone gives you a trusted root hash, you can verify that a particular item is in the tree **without the rest of the data**: the prover supplies the item plus the **sibling hashes** along its path. You recompute the path up to the root and compare. For a billion items, that's about 30 hashes, under 1 KB.

This is what makes Merkle trees central to verifiable systems:

- **Certificate Transparency** (RFC 6962 / 9162): public append-only logs of TLS certificates. Browsers and monitors verify **inclusion proofs** (a certificate is in the log) and **consistency proofs** (the log only appended, never rewrote history).
- **Bitcoin**: each block header contains the Merkle root of its transactions. **SPV** light clients verify that a transaction is in a block with a Merkle path, without downloading the block.
- **Ethereum**: Merkle Patricia tries for state, so clients can prove account balances and storage values.
- **Transparency logs** for software supply chains (Sigstore's Rekor, Go's checksum database `sum.golang.org`).

## Merkle structures everywhere

- **Git:** every blob, tree (directory) and commit is addressed by the hash of its content, and trees and commits reference child hashes. A commit hash therefore covers the entire repository history, which is a Merkle DAG. Comparing two trees skips identical subdirectories instantly.
- **IPFS and content-addressed storage:** files are split into blocks and linked in a Merkle DAG, so identical blocks are deduplicated and content can be verified from any untrusted peer.
- **ZFS and Btrfs:** block checksums are stored in parent blocks up to the root (the uberblock in ZFS), detecting silent data corruption and enabling self-healing from a good copy.
- **BitTorrent v2:** per-file Merkle trees let peers verify each piece as it arrives.
- **Apache Cassandra, Riak and ScyllaDB** use them for replica repair.
- **Rsync-like sync tools and backup systems** (restic, borg) use content-defined chunks and hash trees for deduplication and incremental transfer.

## Where it's used

| System | Use of Merkle trees |
| --- | --- |
| **Amazon Dynamo** (2007 paper) | One tree per key range for anti-entropy between replicas |
| **Apache Cassandra** | `nodetool repair` builds trees per token range and streams mismatching ranges |
| **Riak** | Active anti-entropy with persistent hash trees |
| **Git** | Merkle DAG of blobs, trees and commits |
| **Bitcoin / Ethereum** | Transaction and state roots in block headers. SPV proofs. |
| **Certificate Transparency** | Append-only Merkle logs with inclusion and consistency proofs |
| **ZFS** | Checksum tree for end-to-end data integrity |
| **IPFS** | Content-addressed Merkle DAG |

### Use case walk-through: repairing a replica after an outage

A Cassandra replica was down for 6 hours. Hinted handoff covered 3 hours (the default `max_hint_window`), so it has missed writes from the rest.

1. An operator runs `nodetool repair -pr` on the affected nodes (or a scheduler like Reaper does it automatically).
2. For each token range, every replica builds a Merkle tree of its data with a validation compaction.
3. The coordinator compares the trees. Most subtrees match. A few thousand leaf ranges differ.
4. Replicas **stream** the mismatching ranges to each other, and conflicts are resolved by timestamp.
5. With incremental repair, the repaired SSTables are marked, so next week's repair only builds trees over new data.
6. Repair must complete within `gc_grace_seconds` (10 days by default), or deletes that a replica missed can **resurrect** after tombstones are purged elsewhere.

## Pitfalls

- **Repairing too rarely.** In Cassandra, failing to repair within `gc_grace_seconds` risks deleted data reappearing.
- **Full rebuilds on every comparison.** Building trees reads all data. Use incremental or persistent trees for large datasets.
- **Coarse leaves.** If each leaf covers millions of keys, one difference streams millions of keys. Tune depth, or use smaller ranges.
- **Comparing trees over different ranges or snapshots.** Replicas must agree on range boundaries and, ideally, on a point in time, or in-flight writes cause false mismatches.
- **Non-cryptographic hashes where integrity matters.** For anti-entropy, a fast hash is fine. For tamper-evidence, use a cryptographic hash (SHA-256).

> [!TIP]
> Merkle trees answer "where do we differ?" efficiently. They don't answer "which version is right?". That still needs timestamps, version vectors or CRDT merges.

## Discussion questions

1. Why does comparing two Merkle trees cost O(differences × depth) rather than O(data size)?
2. What's the trade-off in choosing how many keys each leaf covers?
3. How does Git use Merkle structures to make `git diff` between two commits fast?
4. Why can a Bitcoin light client trust that a transaction is in a block without downloading the block?
5. What could go wrong if a Cassandra cluster isn't repaired for a month?
6. How would you keep Merkle trees up to date for a store that receives 100k writes per second?

## FAQ

### What hash function should a Merkle tree use?

For **anti-entropy** inside a trusted system, a fast hash is usually enough, since no one is trying to forge data. For **verifiable** structures where an adversary might try to forge data (Git, blockchains, CT logs), use a cryptographic hash like SHA-256. Git is migrating from SHA-1 to SHA-256 for this reason.

### Do Merkle trees have to be binary?

No. Trees can have any branching factor. Wider trees are shallower (fewer levels to descend) but each comparison exchanges more hashes. Patricia/radix-style Merkle tries (Ethereum) and Merkle DAGs (Git, IPFS) are common variants.

### How is anti-entropy different from read repair?

**Read repair** fixes a key when a read notices replicas disagree, so it only covers keys that are read. **Anti-entropy** proactively compares all data in the background, covering cold keys and missed deletes. Systems use both.

### What's a consistency proof?

In an append-only Merkle log (like Certificate Transparency), a consistency proof shows that a newer tree with root R₂ contains everything the older tree with root R₁ contained, unchanged. It proves the log only appended entries and never rewrote history, again with O(log n) hashes.

### Can I use Merkle trees to sync files between devices?

Yes. Many sync and backup tools split files into content-defined chunks, hash them into a tree, and compare trees to find which chunks to transfer. That avoids sending unchanged parts of large files.

## Key takeaways

- A **Merkle tree** hashes leaves and then pairs of hashes up to a **root**: equal roots mean identical data.
- Comparing trees top-down finds differences in **O(differences × depth)** hash comparisons.
- That makes Merkle trees the core of **anti-entropy** repair in Dynamo-style databases. The cost is **building** the trees, which incremental and persistent trees reduce.
- **Inclusion and consistency proofs** need only log₂ n hashes, enabling Git, blockchains, Certificate Transparency and content-addressed storage.
- Merkle trees find **where** replicas differ. Resolving **which** version wins is a separate problem.

## References

1. R. Merkle. [A Digital Signature Based on a Conventional Encryption Function](https://link.springer.com/chapter/10.1007/3-540-48184-2_32). *CRYPTO 1987* (the tree construction dates to his 1979 patent).
2. G. DeCandia et al. [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf). *SOSP 2007*.
3. Apache Cassandra docs. [Repair](https://cassandra.apache.org/doc/latest/cassandra/managing/operating/repair.html).
4. B. Laurie, A. Langley, E. Kasper. [RFC 6962: Certificate Transparency](https://www.rfc-editor.org/rfc/rfc6962). IETF, 2013.
5. S. Nakamoto. [Bitcoin: A Peer-to-Peer Electronic Cash System](https://bitcoin.org/bitcoin.pdf), section 7–8 (Merkle trees and simplified payment verification). 2008.
6. S. Chacon, B. Straub. *Pro Git*, chapter 10: [Git Internals: Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects).
7. Riak docs. [Active Anti-Entropy](https://docs.riak.com/riak/kv/latest/learn/concepts/active-anti-entropy/index.html).
8. J. Benet. [IPFS: Content Addressed, Versioned, P2P File System](https://arxiv.org/abs/1407.3561). 2014.

---
summary: How to spread keys across a changing set of servers so that adding or removing one moves only a small slice of the data instead of reshuffling almost all of it.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Hash both servers and keys onto the same circle. A key belongs to the first server clockwise from it. When a server joins or leaves, only the keys in its arc move, about **1/N** of them, instead of the **~N/(N+1)** that `hash(key) % N` moves. Add **virtual nodes** so the load is even, and consider **rendezvous**, **jump** or **Maglev** hashing when their trade-offs fit better.

## The problem: `hash % N` breaks when N changes

Say you run a cache cluster with 4 servers and route each key with:

```ts
const server = servers[hash(key) % servers.length]
```

This is fast, stateless and spreads keys evenly, until the number of servers changes. Add a fifth server and `% 4` becomes `% 5`. A key stays on its server only if `hash % 4 === hash % 5`. Over many keys that happens for only about 1 in 5 of them, so **about 80% of keys now map to a different server.**

![Two rows of 24 keys coloured by server. With N=4 and then N=5, 20 of the 24 keys change colour.](/figures/consistent-hashing/modulo-remap.svg "Adding one server under `hash % N`. Highlighted keys changed owner. In general, going from N to N+1 moves about N/(N+1) of all keys.")

For a cache, that means a near-total **cold start**. Most lookups miss at the same moment and fall through to the database, which is exactly when you can least afford it (you were probably adding capacity *because* load was high). For a sharded datastore it's worse: you physically move most of your data to grow by one node.

What we want:

1. **Balance:** each server gets roughly `1/N` of the keys.
2. **Monotonicity / minimal disruption:** when a server is added, keys only move *to* the new server. When one is removed, only *its* keys move.
3. **Decentralisation:** any client can compute a key's owner from the server list alone, with no lookup service.

Consistent hashing, introduced by Karger et al. in 1997 to spread load across web caches (the work that led to Akamai), gives you all three.

## How the ring works

Take a hash function with a large output space, say 32 bits (`0 … 2³²−1`), and bend that range into a circle so the largest value wraps back to 0.

1. **Place servers.** Hash each server's identifier (`"cache-07"`, an IP:port, …) to get its position on the ring.
2. **Place keys.** Hash each key with the same function.
3. **Assign.** Walk **clockwise** from the key's position. The first server you meet owns the key.

![A circle with servers A, B and C and ten keys. Each key is coloured by the first server clockwise from it.](/figures/consistent-hashing/ring.svg "Servers and keys share one hash space. Each server owns the arc between its predecessor and itself.")

Each server owns the **arc** between the previous server and itself. Lookup is a binary search over the sorted server positions, so it costs `O(log S)` for `S` points on the ring.

### Adding and removing servers

When server **D** joins, it lands somewhere on the ring and takes over only the keys between its predecessor and itself. Those keys used to belong to D's clockwise successor. **No other key moves.**

![The same ring with a new server D between A and B. Only key k2 moves, from B to D.](/figures/consistent-hashing/ring-add-node.svg "Adding D moves only the keys in the arc (A, D], all of them taken from D's clockwise neighbour B.")

Removal is the mirror image: a departing server's keys slide clockwise to its successor. On average a membership change moves **K/N keys** (K keys, N servers). That is the minimum possible: a newcomer has to receive its fair share from somewhere.

> [!NOTE]
> "Consistent" here means *consistent across membership changes*: a key's owner stays the same unless that owner changes. It has nothing to do with the "C" in CAP or ACID.

## Virtual nodes: fixing the balance

With one point per server, arc lengths are random, and random arcs are very uneven. With `N` points placed uniformly at random, the largest arc is expected to be about `ln N` times the average. And when a server dies, **all** of its load lands on a single neighbour, which may then fall over too.

The fix is to hash each physical server onto the ring **many times**, as `A#0, A#1, … A#v`. These are **virtual nodes** (vnodes). Each physical server now owns many small arcs scattered around the ring, so:

- its total share converges to `1/N` (the spread shrinks roughly as `1/√v`);
- when it leaves, its arcs go to *many different* successors, so the load spreads across the cluster instead of hitting one neighbour;
- you can give a bigger machine **more vnodes** to get proportionally more keys (weighting).

![A ring where servers A, B and C each appear four times, interleaved.](/figures/consistent-hashing/virtual-nodes.svg "Each physical server appears several times. With only 4 vnodes each the shares are still lumpy (45% / 25% / 30%). Real systems use 100–256.")

How much does it help? Here is a simulation of 100,000 keys over 10 servers:

![Two bar charts. With one vnode per server the loads range from 324 to 27,795 keys. With 100 vnodes they range from 9,140 to 10,824.](/figures/consistent-hashing/load-balance.svg "Simulated load per server. One point each: the busiest server holds 2.8× its fair share. 100 vnodes each: within ±9%.")

| vnodes per server | busiest / ideal | std. dev. of load | keys moved when an 11th server joins |
| ---: | ---: | ---: | ---: |
| 1 | 2.78× | 92% | 11.2% |
| 10 | 1.63× | 27% | 9.4% |
| 100 | 1.08× | 5.1% | 7.8% |
| 200 | 1.09× | 4.2% | 8.6% |

*(The ideal movement for 10→11 servers is 1/11 ≈ 9.1%. Individual runs land around it.)*

The cost of vnodes is memory and lookup time for the ring (`N × v` entries), plus more complex rebalancing bookkeeping in databases, where every vnode is a token range to stream. Cassandra used 256 vnodes per node by default for years. Since 4.0 it defaults to **16 tokens** with a smarter allocation algorithm, because 256 made repairs and streaming expensive.

## A minimal implementation

```ts
import { createHash } from 'node:crypto'

const hash32 = (s: string) => createHash('md5').update(s).digest().readUInt32BE(0)

class HashRing {
  private points: { pos: number; node: string }[] = []

  constructor(nodes: string[] = [], private vnodes = 100) {
    nodes.forEach((n) => this.add(n))
  }

  add(node: string) {
    for (let i = 0; i < this.vnodes; i++) {
      this.points.push({ pos: hash32(`${node}#${i}`), node })
    }
    this.points.sort((a, b) => a.pos - b.pos)
  }

  remove(node: string) {
    this.points = this.points.filter((p) => p.node !== node)
  }

  /** First point clockwise from hash(key), wrapping past the top of the ring. */
  get(key: string): string {
    if (!this.points.length) throw new Error('empty ring')
    const h = hash32(key)
    let lo = 0, hi = this.points.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.points[mid].pos < h) lo = mid + 1
      else hi = mid
    }
    return this.points[lo % this.points.length].node
  }

  /** N distinct physical nodes clockwise from the key: the replica set. */
  getN(key: string, n: number): string[] {
    const out = new Set<string>()
    let i = this.points.findIndex((p) => p.pos >= hash32(key))
    if (i < 0) i = 0
    for (let step = 0; out.size < n && step < this.points.length; step++) {
      out.add(this.points[(i + step) % this.points.length].node)
    }
    return [...out]
  }
}
```

Things to note:

- **The hash function only has to spread values evenly. It doesn't need to be cryptographic.** MD5 is common for historical reasons (ketama). MurmurHash3 or xxHash are faster. Every client **must** use the same function and the same vnode naming scheme, or they'll disagree about owners.
- **`getN` skips duplicate physical nodes.** With vnodes, the next few points clockwise may belong to the same machine, and two replicas on one machine aren't really two replicas. Production systems also skip nodes in the same rack or availability zone.

## Where it's used

| System | How consistent hashing shows up |
| --- | --- |
| **Amazon Dynamo / DynamoDB** | The 2007 Dynamo paper partitions keys on a ring with virtual nodes and replicates each key to the next N distinct nodes clockwise (its "preference list"). |
| **Apache Cassandra / ScyllaDB** | Each node owns token ranges on a ring (Murmur3 partitioner, −2⁶³…2⁶³−1). Vnodes (`num_tokens`) control how many ranges a node owns. |
| **Riak** | Fixed number of partitions on a ring (a power of 2), each claimed by a node. Rebalancing moves whole partitions. |
| **Memcached clients (ketama)** | Last.fm's *ketama* library (2007) made client-side consistent hashing the standard way to shard memcached without a proxy. |
| **Load balancers** | Envoy's `RING_HASH` and `MAGLEV` policies, NGINX `hash … consistent`, and HAProxy `hash-type consistent` keep a client or session on the same backend, which helps with cache locality and sticky sessions. |
| **Discord** | Routes each guild (server) to the Elixir process that owns it using a hash ring, so every message for a guild hits the same process. |
| **CDNs & P2P (Chord, BitTorrent DHT)** | Distributed hash tables are consistent hashing without a global server list: each node knows only some neighbours and routes lookups in `O(log N)` hops. |

### Use case walk-through: scaling a cache tier

You have 8 Redis cache nodes at 70% memory and want to add 2.

- With `hash % N`: going 8 → 10 remaps about **80%** of keys. Hit rate drops from ~95% to ~20% for the duration of the warm-up, and the database takes ~16× its normal read load. You'd have to do it at 3 a.m., or pre-warm.
- With a ring and vnodes: about **20%** of keys move (2/10), spread evenly across the 8 old nodes, so each old node loses about 20% of its keys. The hit rate dips briefly to ~75% and recovers as the new nodes fill. You can do it in the middle of the day.

## Pitfalls and trade-offs

> [!WARNING]
> **Hot keys aren't solved by consistent hashing.** It balances the *number* of keys, not the *traffic* per key. If one celebrity's timeline gets 10% of all reads, the server that owns it is overloaded no matter how even the arcs are. Fix that with key-level replication, request coalescing, local caching, or by splitting the key (`timeline:123#shard-3`).

- **Membership must be agreed on.** If two clients have different server lists, they route the same key to different servers, which can mean split-brain writes in a datastore. Membership usually comes from a coordination service (ZooKeeper/etcd), gossip (Cassandra, Dynamo), or a config push.
- **Data still has to move.** Consistent hashing *minimises* movement but doesn't do it for you. Datastores need streaming, handoff, and reads that check both the old and new owner during the transition.
- **Cascading failure from uneven load.** Without enough vnodes, a dead node's whole load lands on one neighbour, which pushes it over, which dumps everything on *its* neighbour… Vnodes, plus bounded loads (below), stop this.
- **Range scans are lost.** Hashing scatters adjacent keys, so `user:100` through `user:200` live on many nodes. If you need ordered scans, use range partitioning (as Bigtable, HBase, Spanner and CockroachDB do) instead.
- **Ring metadata cost.** 1,000 nodes × 256 vnodes = 256K ring entries per client. Usually fine, but not free on memory-constrained clients.

## Beyond the ring: alternatives worth knowing

### Rendezvous (highest random weight) hashing

For each key, compute `score = hash(key, server)` for **every** server and pick the highest. When a server leaves, only its keys move, each to its own second choice, which spreads them evenly. There are no vnodes and no ring state, and you get a replica set for free (the top-k scores). The cost is that lookup is **O(N)** per key, which is fine for tens to hundreds of servers. Thaler & Ravishankar described it in 1996–98. It's used in GitHub's load balancer and in Apache Ignite, among others.

### Jump consistent hash

Lamping & Veach (Google, 2014) give a ~5-line function that maps a 64-bit key to a bucket in `[0, N)`. It needs **no memory** and has a near-perfect balance, and changing N to N+1 moves exactly 1/(N+1) of the keys. The catch is that buckets are numbered, so you can only add or remove at the **end**. That suits sharded storage where shards are numbered and replicated. It doesn't suit a cache fleet where arbitrary hosts die.

```c
int32_t JumpConsistentHash(uint64_t key, int32_t num_buckets) {
  int64_t b = -1, j = 0;
  while (j < num_buckets) {
    b = j;
    key = key * 2862933555777941757ULL + 1;
    j = (b + 1) * ((double)(1LL << 31) / (double)((key >> 33) + 1));
  }
  return b;
}
```

### Maglev hashing

Google's Maglev network load balancer (NSDI 2016) fills a fixed-size lookup table (e.g. 65,537 entries) using per-backend permutations. Lookups are **O(1)** and balance is near-perfect. Disruption on a change is slightly above the minimum, which is a good trade for a packet-processing fast path. Envoy implements it as the `MAGLEV` policy.

### Consistent hashing with bounded loads

Mirrokni, Thorup & Zadimoghaddam (2016/2018) cap every server at `⌈(1+ε) × average load⌉`. If a key's owner is full, the key keeps walking clockwise to the next server with room. This bounds the worst case even with hot spots, at the cost of a little extra movement. Vimeo added it to HAProxy, and it cut their cache bandwidth by a factor of almost 8. Google uses it in Cloud Pub/Sub.

| Scheme | Lookup | Memory | Balance | Arbitrary removal? |
| --- | --- | --- | --- | --- |
| `hash % N` | O(1) | O(1) | great | moves almost everything |
| Ring + vnodes | O(log Nv) | O(Nv) | good with many vnodes | ✓ |
| Rendezvous | O(N) | O(N) | great | ✓ |
| Jump hash | O(log N) | O(1) | near-perfect | ✗ (end only) |
| Maglev | O(1) | O(M) table | near-perfect | ✓ (small extra churn) |
| Bounded-load ring | O(log Nv) amortised | O(Nv) | capped at (1+ε)× | ✓ |

## Discussion questions

Use these to drive the conversation once someone has explained the basics:

1. Why does `hash % N` move ~N/(N+1) of keys, and not something smaller? Can you prove it for N=4 → 5?
2. If you have 3 servers with 1 vnode each, what's the probability that one server owns more than half the ring?
3. Dynamo's preference list skips vnodes owned by the same physical node. What goes wrong if you don't?
4. When would you pick jump hash over a ring? When would you pick rendezvous?
5. Your cache cluster uses consistent hashing, but one node is at 95% CPU and the rest are at 30%. List three possible causes and how you'd tell them apart.
6. How would you change a *datastore's* membership without serving stale reads during the data movement?

## Key takeaways

- `hash % N` is fine for a **fixed** set of buckets and terrible for a changing one.
- The ring keeps disruption to ~**1/N** per change, and a key only moves to or from the server that changed.
- **Virtual nodes** turn the ring from "theoretically nice" into "actually balanced", and they let you weight servers.
- Consistent hashing balances **keys**, not **traffic**. Hot keys need separate handling.
- Know the family: **rendezvous** (simple, O(N)), **jump** (no memory, append-only), **Maglev** (O(1) table for load balancers), **bounded loads** (caps hot spots).

## References

1. D. Karger, E. Lehman, T. Leighton, R. Panigrahy, M. Levine, D. Lewin. [Consistent Hashing and Random Trees: Distributed Caching Protocols for Relieving Hot Spots on the World Wide Web](https://dl.acm.org/doi/10.1145/258533.258660). *STOC 1997*.
2. G. DeCandia et al. [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf). *SOSP 2007*.
3. A. Lakshman, P. Malik. [Cassandra: A Decentralized Structured Storage System](https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf). *LADIS 2009*.
4. J. Lamping, E. Veach. [A Fast, Minimal Memory, Consistent Hash Algorithm](https://arxiv.org/abs/1406.2294). *arXiv:1406.2294*, 2014.
5. D. Thaler, C. Ravishankar. [Using Name-Based Mappings to Increase Hit Rates](https://doi.org/10.1109/90.663936). *IEEE/ACM Transactions on Networking*, 1998.
6. D. Eisenbud et al. [Maglev: A Fast and Reliable Software Network Load Balancer](https://www.usenix.org/conference/nsdi16/technical-sessions/presentation/eisenbud). *NSDI 2016*.
7. V. Mirrokni, M. Thorup, M. Zadimoghaddam. [Consistent Hashing with Bounded Loads](https://arxiv.org/abs/1608.01350). *SODA 2018*.
8. A. Rodland. [Improving load balancing with a new consistent-hashing algorithm](https://medium.com/vimeo-engineering-blog/improving-load-balancing-with-a-new-consistent-hashing-algorithm-9f1bd75709ed). Vimeo Engineering, 2016.
9. I. Stoica et al. [Chord: A Scalable Peer-to-peer Lookup Service for Internet Applications](https://pdos.csail.mit.edu/papers/chord:sigcomm01/chord_sigcomm.pdf). *SIGCOMM 2001*.
10. Apache Cassandra docs. [Dynamo: Dataset Partitioning via Consistent Hashing](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html).
11. Envoy docs. [Load balancer types: Ring hash and Maglev](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers).

---
summary: Why the slowest 1% of requests decides what users feel in a large system, where those slow requests come from, and the techniques (hedging, tied requests, micro-partitioning, load-aware routing) that make a fast service out of less predictable parts.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Latency distributions have **long tails**: most requests are fast, a few are much slower. At small scale you can ignore the tail. At large scale you can't, because a user request often **fans out** to many servers and must wait for the **slowest** one. If each of 100 servers is slow 1% of the time, **63%** of user requests will be slow. You can't eliminate every source of slowness (GC pauses, queueing, noisy neighbours, background compaction), so large systems are designed to be **tail-tolerant**: measure **percentiles**, not averages; send **hedged** or **tied** requests to replicas; split work into many small **micro-partitions**; route away from slow machines; and return **good-enough** partial results.

## The problem: averages lie, fan-out multiplies

Two facts make tail latency matter:

**1. Latency isn't normally distributed.** It has a long right tail.

![A latency density curve with p50 at 40 ms, mean at 46 ms, p99 at 145 ms and p99.9 at 220 ms.](/figures/tail-latency/distribution.svg "The mean barely moves when the tail gets worse. Percentiles show it.")

A service with a 40 ms median can easily have a p99 three or four times higher, and a p99.9 five times higher or more. The **mean** hides this. A handful of 2-second requests barely shift the average, but they're the requests users remember.

**2. Fan-out turns rare slowness into common slowness.** A web search, a social feed or a product page may call dozens to thousands of backend servers in parallel and wait for all of them.

![A curve showing the probability that a request is slow rising from 1% with one server to 63% with 100 servers and 87% with 200.](/figures/tail-latency/fan-out.svg "P(slow) = 1 − 0.99ⁿ. With enough leaves, the leaf p99 becomes the user-facing median.")

If each server independently responds slowly 1% of the time, a request that touches n servers is slow with probability `1 − 0.99ⁿ`. For n = 100, that's **63%**. Jeffrey Dean and Luiz André Barroso's "The Tail at Scale" (2013) gives a real example: in a Google service where the root waits for many leaves, the p99 latency of a single leaf was 10 ms, but the p99 for waiting on all leaves was 140 ms, and **waiting for the slowest 5% of leaves accounted for half of that**.

Heavy users feel it too. Someone who makes 100 requests during a session will very likely hit the p99 at least once, and those are often the most engaged (and most valuable) users.

## Where the tail comes from

![Six sources of tail latency: queueing, shared resources, background work, power and hardware, retries and timeouts, fan-out.](/figures/tail-latency/causes.svg "Most of these can be reduced. None can be eliminated.")

- **Queueing.** Bursts arrive faster than they're served, and requests wait. Queueing delay grows sharply as utilization approaches 100% (in an M/M/1 queue, waiting time ∝ ρ/(1−ρ)). Running servers at 90% busy makes the tail much worse than at 60%.
- **Shared resources.** Other processes on the machine (or other VMs on the host) compete for CPU, memory bandwidth, caches, disk and network.
- **Background activity.** Garbage collection pauses, LSM-tree compactions, log rotation, cron jobs, page cache flushes.
- **Hardware and power management.** CPU frequency scaling and thermal throttling, SSDs pausing for internal garbage collection, a NIC dropping packets.
- **Retries and timeouts.** A single lost TCP packet costs a retransmission timeout, often 200 ms or more. A retried request takes at least two round trips.
- **Head-of-line blocking.** A slow request in front of a queue (one large query, one slow HTTP/1.1 response on a shared connection) delays everything behind it.
- **Uneven work.** Some keys, users or queries are simply much more expensive than others.

## Measure it properly

- Track **p50, p99, p99.9** (and max), per endpoint and per dependency. Averages are close to useless for latency.
- **Don't average percentiles** across servers or time windows. Merge **histograms** instead: HdrHistogram, t-digest, DDSketch, or Prometheus histograms with sensible buckets.
- Beware **coordinated omission** (Gil Tene): load generators that wait for each response before sending the next hide the very stalls you want to measure, because they stop sending during the stall. Use open-loop load generation (e.g. wrk2) or correct for it.
- Set **SLOs on percentiles**: "99% of requests under 300 ms over 28 days".

## Reducing the tail on each server

Before building tail-tolerant systems, remove what you can:

- **Keep utilization moderate.** Headroom is the cheapest tail-latency fix. Autoscale before queues build.
- **Prioritize interactive work** over batch work on shared machines, using separate queues, cgroups or dedicated pools.
- **Keep queues short** and bounded, and prefer many small requests over few huge ones, so one expensive request can't block a queue for long.
- **Reduce pause times**: low-pause GCs (ZGC, Shenandoah), off-heap data, careful allocation, or languages without GC for the hottest paths.
- **Synchronize disruptions**: do background work (compactions, GC) on all servers at the same time during a brief window, or stagger it so only a few replicas are affected at once, then route around them.

## Tail-tolerant techniques

Dean and Barroso's key insight: just as fault-tolerant systems build reliable services from unreliable parts, **tail-tolerant** systems build predictably fast services from less predictable parts.

### Hedged requests

![Replica 1 is stuck for 400 ms; after the p95 delay of 20 ms, a backup request goes to replica 2, which answers in 12 ms; replica 1's request is cancelled.](/figures/tail-latency/hedged.svg "Pay a few percent extra load to cut the tail dramatically.")

Send the request to one replica. If no response arrives within the **p95 latency** for that request type, send a **second copy** to another replica and use whichever answers first, cancelling the other. Only about 5% of requests trigger the hedge, so extra load is small. In Google's measurements on a BigTable benchmark reading 1,000 keys, hedging after 10 ms reduced the p99.9 for retrieving all keys from **1,800 ms to 74 ms**, while sending only **2%** more requests.

Hedging requires **idempotent** (or read-only) requests, and the delay should adapt to observed latency rather than be fixed.

### Tied requests

A refinement: send the request to **two** servers at once, each tagged with the identity of the other. When one server **starts** executing it, it tells the other to cancel. This avoids duplicated work while still letting the request run on whichever server's queue clears first. A small random delay between the two sends reduces the chance that both start at the same moment.

### Micro-partitioning and selective replication

- Split data into **many more partitions than machines** (e.g. 20 per machine), so load can be rebalanced in small increments and a slow machine's work can be moved quickly.
- **Replicate hot partitions** more, so their load spreads over more machines.

### Route away from slow servers

- **Latency-aware load balancing** (EWMA, power of two choices) naturally sends less traffic to slow replicas.
- **Probation:** temporarily exclude a server that's consistently slow, keep probing it with shadow requests, and re-admit it when it recovers.
- **Outlier detection** in proxies (Envoy) ejects hosts with elevated error rates or latency.

### Good-enough results

For search, recommendations and feeds, a response built from **98% of shards** is often indistinguishable from one built from 100%. Return what you have by a deadline and skip the stragglers. Also use **canary requests**: for very high fan-out, send a query to one or two leaves first, so a query that crashes or stalls servers is caught before it reaches all of them.

## Where it's used

| System | Technique |
| --- | --- |
| **Google search, BigTable** | Hedged and tied requests, micro-partitions, canary requests, partial results |
| **Apache Cassandra** | Speculative retry: send a read to another replica if the first is slower than its p99 (`speculative_retry = 99p`) |
| **Amazon DynamoDB / S3 clients** | Request hedging in some SDKs and services; AWS writes about avoiding tail latency in the Builders' Library |
| **gRPC** | Hedging policy in service config (`hedgingPolicy` with `hedgingDelay`) |
| **Envoy** | Request hedging on per-try timeout, outlier detection |
| **Finagle / Linkerd** | Backup requests, latency-aware balancing |
| **Elasticsearch** | Adaptive replica selection: route searches to the fastest-responding shard copies |

### Use case walk-through: a search API with 50 shards

Each query fans out to 50 shards. Each shard's p99 is 80 ms, but the API's p99 is 400 ms.

1. **Measure:** histograms per shard show a few nodes with periodic 300 ms GC pauses and compaction spikes.
2. **Hedge:** if a shard hasn't answered within its p95 (35 ms), send the same query to that shard's second replica. Extra traffic: about 4%.
3. **Adaptive replica selection:** prefer the replica with the lowest recent latency and shortest queue.
4. **Deadline + partial results:** at 150 ms, return results from whichever shards have answered, flagging the response as partial. Over 99.5% of responses are complete.
5. **Server fixes:** switch to a low-pause GC and throttle compaction.
6. **Result:** API p99 drops from 400 ms to about 110 ms. p50 is unchanged.

## Pitfalls

- **Hedging non-idempotent writes.** A duplicated payment is worse than a slow one.
- **Fixed hedge delays.** Too low and you double load. Too high and it never helps. Base it on a measured percentile.
- **Hedging under overload.** When the system is saturated, every request looks slow, hedges multiply load, and things get worse. Cap hedging to a percentage of traffic (a **hedge budget**) and disable it under overload.
- **Optimizing the mean.** A change that improves average latency can make p99 worse (e.g. bigger batches).
- **Averaging percentiles** in dashboards, which produces numbers that aren't any real percentile.

> [!TIP]
> When a user-facing p99 is bad, check the **fan-out** first. Reducing the number of servers a request must wait for (or not waiting for all of them) is often more effective than making each server faster.

## Discussion questions

1. A request fans out to 500 leaves, each slow 0.1% of the time. What fraction of requests are slow?
2. Why does running servers at high utilization disproportionately hurt the tail?
3. When are hedged requests unsafe, and how would you make them safe?
4. How would you decide whether returning partial results is acceptable for your product?
5. Why can't you average p99 values from 10 servers to get the overall p99?
6. What is coordinated omission, and how might it make your load tests lie?

## FAQ

### Which percentile should I care about?

It depends on fan-out and traffic. For a user-facing API, p99 is a common target. For backend services called many times per user request, you need p99.9 or beyond, because their tail becomes the caller's median. Pick percentiles based on how many calls a typical user action makes.

### Doesn't hedging double the load?

No, if the hedge delay is set at a high percentile: with a p95 delay, only ~5% of requests send a second copy. Cancelling the losing request reduces wasted work further, and tied requests avoid most duplicated execution.

### What's the difference between hedging and retrying?

A **retry** is sent after a **failure** or timeout, and replaces the original attempt. A **hedge** is sent while the original is **still in flight**, and both race. Hedges target slowness. Retries target errors.

### How do I find what's causing tail latency?

Compare traces of slow requests with fast ones. Look for correlation with GC logs, compaction events, specific hosts, specific keys, CPU throttling, and request size. Distributed tracing with tail-based sampling (keeping slow traces) makes this much easier.

### Is tail latency only a problem at Google scale?

No. A page that makes 20 backend calls, or a microservice architecture with a deep call chain, already amplifies the tail. A deep chain adds latency in series, and parallel calls make you wait for the slowest.

## Key takeaways

- Latency is **long-tailed**. Measure and set targets on **percentiles**, with histograms.
- **Fan-out amplifies** the tail: with 100 leaves, a 1% leaf tail becomes a 63% user tail.
- Reduce sources of variability on each server: headroom, short queues, prioritization, low-pause GC.
- Build **tail-tolerant** systems: hedged/tied requests, micro-partitioning, latency-aware routing, and good-enough partial results.
- Hedge only **idempotent** requests, with adaptive delays and a budget.

## References

1. J. Dean, L. A. Barroso. [The Tail at Scale](https://cacm.acm.org/research/the-tail-at-scale/). *Communications of the ACM*, 2013.
2. J. Dean. [Achieving Rapid Response Times in Large Online Services](https://research.google/pubs/achieving-rapid-response-times-in-large-online-services/). Talk, 2012.
3. G. Tene. [How NOT to Measure Latency](https://www.youtube.com/watch?v=lJ8ydIuPFeU). Strange Loop, 2015.
4. gRPC. [Request Hedging](https://grpc.io/docs/guides/request-hedging/).
5. Apache Cassandra docs. [Speculative retry](https://cassandra.apache.org/doc/latest/cassandra/reference/cql-commands/create-table.html#speculative-retry-options).
6. Elastic. [Improving Response Latency in Elasticsearch with Adaptive Replica Selection](https://www.elastic.co/blog/improving-response-latency-in-elasticsearch-with-adaptive-replica-selection). 2017.
7. P. Lu, T. Ji, et al. [Treadmill: Attributing the Source of Tail Latency through Precise Load Testing and Statistical Inference](https://research.facebook.com/publications/treadmill-attributing-the-source-of-tail-latency-through-precise-load-testing-and-statistical-inference/). *ISCA 2016*.
8. Google SRE Book. [Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) (on percentiles and "worrying about your tail").

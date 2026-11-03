---
summary: When demand exceeds capacity, rejecting some requests quickly is what keeps the rest fast — and keeps the system from collapsing entirely.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — Every server has a throughput ceiling. Past it, accepting more work doesn't produce more answers: requests queue, latency climbs past client timeouts, and the server spends its time on work nobody is waiting for — **goodput collapses**. **Load shedding** deliberately rejects excess requests *early and cheaply* (a fast 503 or 429) so the requests you do accept finish within their deadlines. **Admission control** is the decision of what to accept: concurrency limits, bounded queues with timeouts, priority tiers, and deadline checks — ideally applied at several layers, with clients that back off instead of retrying harder.

## The problem: overload turns into collapse

Imagine a service that can handle 1,000 requests per second. At 1,200 rps, you might hope it simply serves 1,000 and the extra 200 wait a bit. What actually happens without protection:

- **Queues grow without bound.** Thread pools, accept backlogs and in-process queues fill. Each new request waits behind all earlier ones.
- **Latency passes the client timeout.** Once queueing delay exceeds, say, 2 seconds, clients give up — but the server still processes the abandoned requests. It is now doing 1,000 rps of *useless* work.
- **Retries multiply the load.** Timed-out clients retry, turning 1,200 rps of demand into 2,400 rps of offered load.
- **Resources thrash.** More concurrent work means more memory, more GC, more lock contention and more context switching, so real capacity *drops* below 1,000.

This is **congestion collapse**: throughput of *useful* responses (goodput) falls toward zero even though the servers are 100% busy. And it is sticky — even when the original spike passes, the backlog and the retries keep the system pinned.

## How it works

### Goodput vs offered load

![Goodput versus offered load: with load shedding goodput plateaus at capacity; without it goodput collapses as load increases](/figures/load-shedding/curve.svg "The goal of load shedding is to keep the flat green line — serve at capacity and reject the rest fast — instead of sliding down the red one.")

The idea behind every technique below is the same: **keep the amount of in-flight work at or just below what the server can complete in time**, and say "no" to everything else as cheaply as possible. A rejected request costs microseconds and gives the client a clear signal; an accepted request that times out costs full processing *and* produces an error.

Two concepts are often confused:

- **Rate limiting** enforces a *policy*: tenant A may make 100 requests per second, regardless of how loaded the server is. It protects fairness and cost.
- **Load shedding / admission control** responds to *actual capacity*: accept work while the server can handle it, reject when it can't. It protects the server itself.

You usually need both. A rate limit set below capacity doesn't help when capacity drops (a slow dependency, a bad deploy, half the fleet down), and a load shedder doesn't stop one noisy tenant from consuming everyone's share.

### Where to reject

![Layers of admission control from edge to handler: gateway rate limits, load balancer, server admission with concurrency limits and queue timeouts, priority-based shedding, and deadline checks in the handler](/figures/load-shedding/layers.svg "The earlier a request is rejected, the cheaper the rejection — but inner layers know more about actual capacity.")

- **Edge / API gateway.** Per-client and global rate limits returning **429 Too Many Requests** with `Retry-After`. Cheapest place to drop traffic; knows little about backend health.
- **Load balancer.** Least-outstanding-requests routing, per-backend connection limits, and outlier ejection steer traffic away from struggling instances.
- **Server admission.** The most important layer. A **concurrency limit** caps in-flight requests; anything beyond goes to a **small bounded queue** with a **queue timeout**, and anything that doesn't fit is rejected immediately with **503**.
- **Priority.** When shedding, drop the least important traffic first: batch jobs and prefetches before user-facing reads, reads before checkout.
- **Handler and downstream calls.** Check the remaining **deadline** before starting expensive work, and don't call a dependency with a request that has already expired.

### Concurrency limits and Little's law

Requests-per-second limits are hard to set correctly because capacity in rps depends on request mix and latency. **Concurrency** — requests in flight — is a better control variable. Little's law ties them together:

> in-flight requests = throughput × latency

If an instance completes 500 rps at 20 ms, it naturally has about 10 requests in flight. When it holds 200 in flight, they are waiting, not working. Capping concurrency near the natural level keeps latency low and makes excess load visible as rejections instead of as queueing.

Static limits drift as code and hardware change, so many systems use **adaptive concurrency limits**, borrowed from TCP congestion control: increase the limit while latency stays near its minimum, cut it when latency rises or errors appear. Netflix's `concurrency-limits` library (AIMD, Vegas and Gradient algorithms) and Envoy's adaptive concurrency filter work this way.

### Queues: bounded, timed and sometimes LIFO

![An unbounded FIFO queue where every request goes stale compared with a bounded queue plus timeout where excess is rejected immediately](/figures/load-shedding/queue.svg "A queue is a buffer for short bursts, not a place to store sustained overload.")

A queue absorbs bursts — that's its only job. Under sustained overload, a FIFO queue guarantees that *every* request waits the maximum time, so every response is late. Better designs:

- **Bounded size.** Pick a queue length that corresponds to an acceptable wait (e.g. 100 ms of work), not "as much as memory allows".
- **Queue timeout.** Drop a request that has waited longer than it can usefully wait; it's probably already been abandoned by the client.
- **CoDel (Controlled Delay).** From Nichols and Jacobson's work on network bufferbloat: watch the *minimum* queueing delay over an interval. If even the best-case wait stays above a target (say 5 ms) for a whole interval, the queue is standing, not bursting — start dropping aggressively, using a much shorter timeout.
- **Adaptive LIFO.** Facebook's servers switch the queue to last-in-first-out when it's backed up. The newest requests, whose clients are still waiting, get served; the oldest ones time out. Under normal load the queue stays FIFO for fairness.

### Priority and criticality

Not all requests are equal. Google's SRE practice tags each request with a **criticality** — e.g. `CRITICAL_PLUS`, `CRITICAL`, `SHEDDABLE_PLUS`, `SHEDDABLE` — that propagates with the call. Under overload, servers drop the lowest tiers first, so a capacity crunch degrades batch analytics long before it affects login.

Practical rules:

- **Classify at the edge** (by endpoint, client, or header) and **propagate** the class through internal calls.
- **Reserve capacity** for critical traffic, or shed by tier as utilization crosses thresholds (e.g. drop batch above 80%, default above 95%).
- **Keep the cheap paths cheap.** Health checks and control-plane calls shouldn't be stuck behind user traffic.

### Deadlines and client cooperation

Shedding on the server only works if clients don't fight it:

- **Deadline propagation.** Pass the remaining time budget (gRPC deadlines, a `timeout` header) downstream. Each hop subtracts its own time and refuses work whose deadline has passed.
- **Retry budgets.** Cap retries to a fraction of normal traffic (e.g. retries ≤ 10% of requests) and retry with exponential backoff and jitter. Retry at one layer, not at every layer.
- **Client-side throttling.** Google's adaptive throttling has clients track how many requests the backend accepted vs how many they sent, and reject locally with increasing probability when the ratio worsens — the overload stops before it reaches the network.
- **Clear signals.** Return 503 (server overloaded) or 429 (client over quota) with `Retry-After`, and make sure clients treat them as "back off", not "try again immediately".

## Where it's used

| Setting | How it shows up |
|---|---|
| Google services | Per-request criticality, client-side adaptive throttling, deadline propagation over Stubby/gRPC |
| Netflix | `concurrency-limits` library in servers and clients; priority-based shedding at the Zuul gateway |
| AWS services | Per-instance concurrency limits and fast rejection, as described in the Amazon Builders' Library |
| Envoy / service meshes | Circuit-breaker thresholds (max requests, max pending), adaptive concurrency filter, local rate limits |
| Facebook / Meta | Adaptive LIFO queues and CoDel-style queue timeouts in RPC servers |
| Databases & proxies | Connection limits, PgBouncer pool limits, statement timeouts, admission control in CockroachDB |
| Web servers | Nginx `limit_req` / `limit_conn`, accept backlogs, worker connection caps |

## Use case walk-through: surviving a flash sale

An e-commerce API runs 20 instances that each comfortably serve 400 rps at p99 120 ms. A flash-sale email goes out and traffic jumps from 6,000 to 15,000 rps in a minute. Last year, the same event caused a 25-minute outage: thread pools saturated, latencies hit 30 s, and client retries kept the site down after the spike ended.

1. **Measure natural concurrency.** At 400 rps × 0.12 s, each instance holds about 50 requests in flight when healthy. Above ~80 in flight, latency climbs sharply.
2. **Add an adaptive concurrency limit** per instance, starting at 60 and allowed to range from 20 to 100 based on observed latency.
3. **Bound the queue.** Up to 40 waiting requests with a 200 ms queue timeout; beyond that, an immediate `503` with `Retry-After: 2`.
4. **Classify traffic.** Checkout and payment are `critical`, product pages and search `default`, recommendations and analytics beacons `sheddable`. Sheddable traffic is dropped first when the limiter is above 80% full.
5. **Propagate deadlines.** The gateway sets a 3 s budget; the inventory and pricing services refuse work with less than 50 ms left.
6. **Fix the clients.** The web and mobile apps honor `Retry-After`, use exponential backoff with jitter, and cap retries at 2. Recommendations simply hide on error.
7. **Load test it.** A replay at 3× peak confirms goodput stays at ~8,000 rps with p99 under 300 ms for accepted requests, while the excess gets fast 503s.

**Result:** during the next sale, recommendations disappeared for four minutes and some product-page loads got a "busy, retrying" message, but checkout success stayed above 99.5% and the site recovered the moment traffic eased — no outage, while autoscaling caught up in the background.

## Pitfalls

- **Unbounded queues anywhere.** Thread pool queues, async executors, message buffers and TCP backlogs all hide overload until it becomes collapse.
- **Expensive rejections.** If rejecting a request requires authenticating, parsing the body and querying a database, shedding doesn't save much. Decide as early as possible.
- **Static limits that go stale.** A limit tuned last year may be too high after a slow dependency appears or too low after an optimization. Prefer adaptive limits or revisit regularly.
- **Retry amplification.** Clients and every intermediate layer retrying independently can multiply load 10× or more. Use retry budgets and retry at one layer.
- **Shedding the wrong work.** Without priorities, a backlog of analytics events can starve checkout.
- **Autoscaling as the only plan.** Scaling takes minutes; overload takes seconds. Shedding buys the time for scaling to catch up — and protects you when it can't.
- **Unready-based shedding.** Marking instances unready under load can leave the load balancer with zero endpoints. Return fast 503s instead.
- **Invisible shedding.** If rejected requests aren't counted and alerted on, you'll learn about capacity problems from users.

> [!TIP]
> Track **goodput** (successful responses within their deadline), **shed rate** by priority, and **queue wait time** as first-class metrics. A rising shed rate is your early warning to add capacity — long before latency or error budgets are hit.

## Discussion questions

1. What is the natural concurrency of your busiest service, and what happens to latency at 2× that number?
2. Where in your stack are there unbounded queues, and what would bound them?
3. How would you assign priorities to your endpoints, and who gets to decide?
4. When should a server return 429 versus 503, and how should a client react to each?
5. How do your retries behave when a dependency is overloaded? Could they cause a retry storm?
6. How would you test load shedding before a real traffic spike, and what would count as a pass?

## FAQ

### Isn't rejecting requests just a self-inflicted outage?

No — it is a *partial* failure chosen deliberately to avoid a total one. Without shedding, overload usually causes every request to time out. With shedding, most requests succeed and the rest fail fast with a clear, retryable signal.

### How is load shedding different from a circuit breaker?

A circuit breaker sits in the **client** and stops calling a dependency that is failing. Load shedding sits in the **server** and refuses work it can't handle. They complement each other: the server sheds, the client's breaker notices the errors and backs off.

### Should I use requests-per-second limits or concurrency limits?

Use rps limits for policy (per-tenant quotas, abuse protection) and concurrency limits for capacity protection. Concurrency automatically adapts to request cost: slow requests occupy slots longer, so fewer are admitted.

### What status code should a shed request get?

503 Service Unavailable when the server is overloaded, 429 Too Many Requests when a specific client exceeded its quota. Include `Retry-After` when you can estimate when to come back. For gRPC, `RESOURCE_EXHAUSTED` or `UNAVAILABLE`.

### Doesn't autoscaling make load shedding unnecessary?

Autoscaling handles sustained growth over minutes; it can't react to a spike in seconds, can't help when the bottleneck is a shared database, and has upper limits. Shedding keeps the system healthy while scaling happens and when it can't.

## Key takeaways

- Past capacity, accepting more work **reduces** useful throughput — that's congestion collapse.
- **Reject early and cheaply**: a fast 503/429 is far better than a slow timeout.
- **Concurrency limits** (ideally adaptive) are the core server-side control; Little's law tells you the natural level.
- Keep queues **small, bounded and timed**; consider CoDel-style timeouts and adaptive LIFO.
- **Prioritize**, so overload degrades nice-to-have traffic first.
- Clients must cooperate: **deadlines, retry budgets, backoff with jitter** and honoring `Retry-After`.

## References

- [Google SRE Book — Handling Overload](https://sre.google/sre-book/handling-overload/)
- [Google SRE Book — Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
- [Amazon Builders' Library — Using load shedding to avoid overload](https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/)
- [Netflix — concurrency-limits (GitHub)](https://github.com/Netflix/concurrency-limits)
- [Kathleen Nichols and Van Jacobson — Controlling Queue Delay (ACM Queue)](https://queue.acm.org/detail.cfm?id=2209336)
- Ben Maurer, "Fail at Scale: Reliability in the face of rapid change," *ACM Queue*, 2015.
- Marc Brooker, "Timeouts, retries, and backoff with jitter," Amazon Builders' Library.

---
summary: How a single slow dependency can exhaust a caller's resources and cascade into an outage, and how circuit breakers (stop calling) and bulkheads (isolate resources) contain the damage.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** In a distributed system, a dependency that's **slow** is more dangerous than one that's **down**: every call to it holds a thread, a connection or memory until it times out, and soon the caller has nothing left for healthy work. A **circuit breaker** watches calls to a dependency and, once failures cross a threshold, **opens**: it fails calls immediately (or returns a fallback) for a while, then lets a few **probe** calls through to check for recovery. A **bulkhead** gives each dependency its **own bounded pool** of threads or connections, so one failure can only use up its own share. Together with **timeouts**, they turn "one feature is broken" back into exactly that, instead of "the whole site is down".

## The problem: cascading failures

A service calls a few others: payments, search, recommendations. All share the same pool of 200 worker threads.

![An API service with 200 threads calls payments, search and a hung recommendations service; 190 threads end up stuck waiting on recommendations.](/figures/circuit-breaker/cascade.svg "The healthy dependencies are fine. The caller fails anyway, because it has run out of threads.")

Recommendations starts hanging. Calls to it now take the full 30-second timeout instead of 50 ms:

- At 100 requests per second that need recommendations, **3,000 threads** would be needed to absorb 30 seconds of waiting. The pool has 200, so it's full within two seconds.
- Requests that only need payments or search now **queue behind them**, and time out too.
- Clients and load balancers **retry**, adding load to an already saturated service.
- Services that call *this* API now hit slow responses, and the same thing happens to them, one level up.

This is a **cascading failure**: a partial failure in one place spreads through shared resources until it becomes a total failure. Michael Nygard's *Release It!* (2007) catalogued the pattern and named the two defences discussed here.

> [!NOTE]
> A dependency that **fails fast** (connection refused, instant 500) is relatively harmless: threads are released immediately. The killers are slowness, hangs, and responses that trickle in byte by byte.

## Circuit breakers

The idea comes from electrical circuit breakers: when something is clearly wrong, stop sending current instead of letting the wiring melt.

![A state diagram: CLOSED goes to OPEN when the failure rate crosses a threshold; OPEN goes to HALF-OPEN after a wait; HALF-OPEN goes back to CLOSED when probes succeed, or to OPEN when a probe fails.](/figures/circuit-breaker/states.svg "Open means 'don't even try'. Half-open means 'try carefully'.")

A circuit breaker wraps calls to one dependency and has three states:

1. **Closed (normal).** Calls pass through. The breaker records outcomes in a **sliding window**, e.g. the last 100 calls or the last 10 seconds.
2. **Open.** When the **failure rate** in the window crosses a threshold (say 50%, with a minimum of 20 calls so a few errors don't trip it), the breaker opens. Calls **fail immediately** without touching the network. Callers get an error or a **fallback**.
3. **Half-open.** After a **wait duration** (e.g. 30 s), the breaker lets a small number of **trial calls** through. If they succeed, it closes. If any fail, it opens again and restarts the timer.

What counts as a failure matters:

- **Count:** timeouts, connection errors, 5xx responses, and **slow calls** (calls above a latency threshold, even if they eventually succeed).
- **Don't count:** client errors like 400 or 404. The dependency is healthy, the request was bad. Counting them can open a breaker because of one misbehaving user.

### What the breaker buys you

- **The caller keeps its resources.** Failing in microseconds instead of 30 seconds frees threads for healthy work.
- **The dependency gets room to recover.** It isn't hammered with traffic while it's struggling, which is often what keeps it down.
- **Users get a fast answer**, ideally a degraded one, instead of a spinner.

### Fallbacks

When the breaker is open, decide what the caller gets:

| Dependency | Fallback |
| --- | --- |
| Recommendations | Show a generic "popular items" list from cache, or hide the section |
| Product reviews | Show the page without reviews |
| Pricing | **No fallback.** Fail the request: showing a wrong price is worse than an error. |
| Feature flags | Last known values, or safe defaults |
| Fraud check | Depends on business risk: block, allow small amounts, or queue for review |

Fallbacks should be **cheap and local**. A fallback that calls another remote service can fail in the same way and needs its own protection.

## Bulkheads

Ships are divided into watertight compartments, called bulkheads, so a hole in one doesn't sink the whole ship. In software, the compartments are **resource pools**.

![An API service with three separate thread pools: payments (40), search (60) and recommendations (20). The recommendations pool is fully used; the others have spare threads.](/figures/circuit-breaker/bulkheads.svg "A hung dependency can only exhaust its own pool.")

Instead of one shared pool, give each dependency (or each class of work) its own **bounded** allocation:

- **Thread pools per dependency.** Netflix's Hystrix ran every dependency call in its own small thread pool. When recommendations' 20 threads are busy, new calls to it are **rejected immediately**, and payments' 40 threads are unaffected.
- **Semaphores.** A cheaper variant: limit the number of **concurrent calls** to a dependency without separate threads. Good for async and non-blocking code.
- **Connection pools per downstream.** A separate HTTP or database connection pool for each dependency.
- **Separate instances or clusters** for different traffic: e.g. a dedicated pool of servers for internal batch jobs, so a heavy batch can't starve user traffic. At the largest scale this becomes **cell-based architecture**.
- **Per-tenant limits**, so one noisy customer can't consume a shared service.

Bulkheads cap the **blast radius** of a failure. Circuit breakers cut off the source. They're often used together: the bulkhead bounds concurrency and the breaker stops calls entirely once it's clear the dependency is unhealthy.

## Timeouts come first

Neither pattern works without **timeouts** on every remote call. A call with no timeout can hold a thread forever, and a breaker that waits for a result never sees the failure.

- Set **connect** and **request** timeouts on every client. Library defaults are often infinite or very long.
- Base the timeout on the dependency's **observed latency**: a little above its p99 is a common starting point, not "30 seconds to be safe".
- Propagate a **deadline** through the call chain (gRPC deadlines do this) so downstream services stop working on requests the user has already given up on.

## Breakers, retries and load shedding

These defences interact:

- **Retries inside a breaker.** Retries count against the breaker, so persistent failures open it quickly and stop the retries too. Retry *outside* the breaker and a retry storm can keep a struggling dependency down.
- **Retry budgets.** Limit retries to a percentage of normal traffic (e.g. 10%), so they can't multiply load during an outage.
- **Load shedding** is the server-side counterpart: the struggling service itself rejects work it can't handle (with a 503 and `Retry-After`) rather than queueing it forever.
- **Adaptive concurrency limits** (Netflix's `concurrency-limits` library, Envoy's adaptive concurrency filter) adjust a bulkhead's size automatically based on observed latency, borrowing from TCP congestion control.

## Where it's used

| Tool | What it provides |
| --- | --- |
| **Netflix Hystrix** (2012, now in maintenance mode) | Popularized both patterns in the JVM world: per-dependency thread pools, breakers, fallbacks, dashboards |
| **Resilience4j** | Hystrix's successor for Java: breaker, bulkhead (semaphore or thread pool), retry, rate limiter, time limiter |
| **Polly** (.NET) | Circuit breaker, bulkhead isolation, retry, timeout, fallback policies |
| **Envoy / Istio** | Breakers at the proxy layer: max connections, pending requests and retries per upstream cluster, plus **outlier detection** to eject bad hosts |
| **Linkerd** | Failure accrual, which stops sending to endpoints that fail repeatedly |
| **AWS** | Cells and shuffle sharding for blast-radius control; SDK retry quotas |
| **gobreaker, opossum, pybreaker** | Breakers for Go, Node.js and Python |

### Use case walk-through: a product page

A product page calls catalog (essential), pricing (essential), reviews and recommendations (optional).

1. Every client has a **timeout** set to a bit above that dependency's p99: 300 ms for catalog, 800 ms for recommendations.
2. Each dependency gets a **bulkhead** sized from Little's law: concurrency ≈ request rate × latency. At 200 req/s and 50 ms, that's 10 calls in flight, so you allow ~30 for headroom.
3. Reviews and recommendations have **breakers** with fallbacks: hide reviews, show cached bestsellers.
4. Catalog and pricing have breakers **without** fallbacks: if they're open, the page returns an error quickly instead of hanging.
5. Dashboards show every breaker's state, and an alert fires when an essential breaker opens.

When recommendations has an outage, the page loads in normal time with bestsellers instead of personalized picks. Most users never notice.

## Pitfalls

- **Thresholds tuned on a laptop.** A breaker that opens on 5 errors out of 6 calls will flap at low traffic. Use a minimum call count and a rate, not a raw count.
- **One breaker for many hosts.** If one of ten replicas is bad, a single breaker for the whole service either never opens or cuts off the nine healthy ones. Use per-host **outlier detection** (Envoy) or the load balancer for that, and the breaker for whole-service failure.
- **Counting the wrong errors.** 4xx responses and validation errors shouldn't open a breaker.
- **Untested fallbacks.** Fallback code runs rarely, so it rots. Test it, and run game days where breakers are forced open.
- **Hiding outages.** A breaker silently returning fallbacks can mask a problem for days. Breaker state changes need metrics and alerts.
- **Thread pools everywhere.** Per-dependency thread pools have real overhead (context switching, memory). Semaphores are often enough, especially in async code.

> [!WARNING]
> A breaker on a **write path** needs care. If "fail fast" means a payment request returns an error but the call actually reached the dependency earlier, the client may retry and charge twice. Pair breakers on writes with **idempotency keys**.

## Discussion questions

1. Why is a slow dependency more dangerous than one that's completely down?
2. Which dependencies in your system have a sensible fallback, and which must fail the request?
3. How would you size a bulkhead for a dependency that handles 500 req/s at 40 ms p99?
4. Where should retries live relative to the breaker, and why?
5. What's the difference between a circuit breaker and outlier detection in a service mesh? When do you need both?
6. How would you test that your breakers and fallbacks actually work in production?

## FAQ

### Is a circuit breaker the same as a rate limiter?

No. A **rate limiter** caps how much traffic you send (or accept) regardless of health. A **circuit breaker** reacts to **failures** and stops traffic entirely while the dependency is unhealthy. They're complementary.

### Should the breaker be in the client library or the service mesh?

Both work. **Client libraries** (Resilience4j, Polly) know about business context: which errors matter and what the fallback is. **Proxies** (Envoy, Istio) apply limits uniformly across languages without code changes, but can only fail, not fall back. Many teams use mesh-level limits as a safety net and library breakers where fallbacks matter.

### How long should the breaker stay open?

Long enough for the dependency to plausibly recover: typically 5 to 60 seconds. Some implementations increase the wait exponentially after repeated failed probes. Too short and you keep poking a dying service. Too long and you stay degraded after it has recovered.

### Why did Netflix retire Hystrix?

Hystrix went into maintenance mode in 2018. Netflix moved toward **adaptive** approaches (concurrency limits that adjust to observed latency) instead of static thresholds that need manual tuning, and Resilience4j became the common choice for Java.

### Do I need breakers if I already have timeouts and retries?

Timeouts bound the cost of each call, but during an outage you still pay that cost on every call. Retries make it worse. Breakers stop paying it at all once failure is clear, and they give the dependency room to recover.

### What's the difference between a bulkhead and a cell?

Same idea at different scales. A bulkhead isolates resources **inside** a process or service (thread pools, connection pools). A **cell** is a complete, independent copy of the whole stack serving a subset of customers, so a failure in one cell doesn't affect others.

## Key takeaways

- Slow dependencies cause **cascading failures** by exhausting shared threads, connections and memory.
- **Timeouts** are the foundation: every remote call needs one.
- **Circuit breakers** (closed → open → half-open) fail fast during outages, protect the caller and give the dependency space to recover.
- **Bulkheads** give each dependency a bounded share of resources so one failure can't consume everything.
- Design **fallbacks** deliberately, test them, and alert when breakers open.

## References

1. M. Nygard. *Release It! Design and Deploy Production-Ready Software*, 2nd ed., chapter 5: Stability Patterns. Pragmatic Bookshelf, 2018.
2. M. Fowler. [CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html). 2014.
3. Netflix. [Hystrix: How it Works](https://github.com/Netflix/Hystrix/wiki/How-it-Works).
4. Resilience4j. [CircuitBreaker](https://resilience4j.readme.io/docs/circuitbreaker) and [Bulkhead](https://resilience4j.readme.io/docs/bulkhead) documentation.
5. Microsoft Azure Architecture Center. [Circuit Breaker pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker) and [Bulkhead pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead).
6. Envoy docs. [Circuit breaking](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking) and [Outlier detection](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier).
7. Google SRE Book. [Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/).
8. Netflix Tech Blog. [Performance Under Load](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581) (adaptive concurrency limits). 2018.
9. AWS Builders' Library. [Using load shedding to avoid overload](https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/).

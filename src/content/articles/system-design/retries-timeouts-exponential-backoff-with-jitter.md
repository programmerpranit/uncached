---
summary: Retries hide transient failures but can turn a brief blip into a self-inflicted outage. How to set timeouts, which errors to retry, why exponential backoff needs jitter, and how retry budgets and idempotency keep retries safe.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Networks drop packets and servers hiccup, so clients retry. Done naively, retries **multiply load exactly when a system is struggling**: every layer retries, every client retries at the same moment, and a brief overload becomes a sustained outage (a **retry storm**). Do it safely: put a **timeout** on every call (based on measured latency, with an overall **deadline**), retry only **transient** errors on **idempotent** operations, use **exponential backoff with jitter** so clients spread out, **cap** attempts and use a **retry budget** so retries can add at most ~10% load, and retry at **one layer** of the stack, not all of them.

## The problem: retries are load

A retry is another request. When failures are rare and random (a dropped packet, one bad host), retrying is nearly free and very effective. When failures are caused by **overload**, every retry adds to the overload.

![A client calls an API gateway, which calls service A, then service B, then the database; with 3 attempts at each layer, one request becomes 81 database calls.](/figures/retries/amplification.svg "Each layer is behaving 'reasonably'. Together they multiply load by 81.")

Two ways retries go wrong:

- **Amplification through layers.** If each of four layers makes up to 3 attempts, one user request can become 3⁴ = **81** calls to the bottom layer during an outage.
- **Synchronization.** When a dependency fails, all clients see the failure at about the same time and retry at the same intervals, hitting it in waves just as it tries to recover.

The result can be a **metastable failure** (Bronson et al., 2021): the trigger (a brief spike, a deploy, a cache flush) goes away, but the system stays down because retry load alone keeps it overloaded.

## Timeouts first

Without a timeout, a call to a hung dependency waits forever, holding a thread or connection, and there's nothing to retry.

- **Set timeouts on every remote call**, including connect, TLS handshake, and request/response. Many client libraries default to very long or infinite timeouts.
- **Base them on measured latency.** A common starting point is a bit above the dependency's p99 or p99.9. If the p99 is 80 ms, a 30-second timeout guarantees that a hung dependency holds resources for 30 seconds per call.
- **Use deadlines, not just per-call timeouts.** A request with a 1-second budget that calls three services in sequence should pass the **remaining** time to each (gRPC deadlines propagate automatically). Downstream services stop working on requests whose caller has already given up.
- **Leave room for retries.** If the overall deadline is 1 s, a per-attempt timeout of 900 ms leaves no time for a second attempt. Something like 300 ms per attempt allows a retry.

> [!TIP]
> A timeout is also a **retry decision**. After a timeout you don't know whether the server did the work. That's why timeouts and idempotency go together.

## What to retry

Retry **transient** failures, where trying again has a reasonable chance of succeeding:

| Retry | Don't retry |
| --- | --- |
| Connection refused / reset, DNS failure | 400 Bad Request, validation errors |
| Timeouts (if the operation is idempotent) | 401/403 auth errors |
| 503 Service Unavailable, 429 Too Many Requests (respect `Retry-After`) | 404 Not Found |
| 502/504 from a proxy | 409 Conflict (usually needs a re-read, not a blind retry) |
| gRPC `UNAVAILABLE`, `RESOURCE_EXHAUSTED` (with backoff) | gRPC `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `FAILED_PRECONDITION` |

**Non-idempotent operations** (charging a card, sending a message, incrementing a counter) can only be retried safely if the server deduplicates them, usually with an **idempotency key** that the client generates once and sends with every attempt. Without one, a timeout followed by a retry can apply the operation twice.

## Backoff: wait longer each time

Retrying immediately is the worst option for an overloaded server. **Exponential backoff** waits `base × 2ⁿ` before attempt n (100 ms, 200 ms, 400 ms, 800 ms…), up to a **cap**.

![Formulas for constant, exponential, full jitter, equal jitter and decorrelated jitter backoff.](/figures/retries/formulas.svg "All the jittered versions work. No jitter is the one to avoid.")

But plain exponential backoff keeps clients **synchronized**: if 100 clients failed at the same moment, they all retry at 100 ms, then all at 300 ms, and so on.

![Two histograms of retry times for 100 clients: without jitter, five tall spikes; with full jitter, a spread-out decay.](/figures/retries/jitter.svg "Same number of retries. The difference is whether they arrive together.")

**Jitter** adds randomness. In Marc Brooker's analysis for AWS ("Exponential Backoff and Jitter", 2015):

- **Full jitter:** `sleep = random(0, min(cap, base × 2ⁿ))`. Spreads load the most and completes the work with the fewest total calls. This is the usual recommendation.
- **Equal jitter:** half fixed, half random. Guarantees a minimum wait.
- **Decorrelated jitter:** `sleep = min(cap, random(base, previous_sleep × 3))`. Grows from the previous sleep rather than the attempt number.

All jittered variants perform far better than no jitter. Which one you pick matters much less than picking one.

Also:

- **Cap the number of attempts** (often 3 in total) and the **maximum delay**.
- **Respect `Retry-After`** headers on 429 and 503 responses: the server knows better than you when to come back.
- **Add jitter to periodic work** too: cache TTLs, cron jobs, reconnects and polling intervals.

## Retry budgets

Backoff spreads retries in time, but during a long outage every request still gets its full quota of retries, so load can still double or triple. A **retry budget** caps retries as a **fraction of normal traffic**.

![A failed request checks a retry token bucket that gains 0.1 tokens per success and loses 1 per retry; with a token it retries, without one it fails fast.](/figures/retries/budget.svg "When most requests are failing, retrying them doesn't help. The budget notices and stops.")

- Keep a token bucket per client (or per client-dependency pair). Each **success** adds a fraction of a token (e.g. 0.1), each **retry** costs one.
- When healthy, the bucket is full and occasional failures are retried.
- During an outage, the bucket drains within seconds, and further failures **fail fast** without retrying. Retries can add at most ~10% load.

gRPC implements this as **retry throttling** in the service config. The AWS SDKs' "standard" retry mode uses a **retry quota** that works the same way. Google's SRE book describes a per-client retry budget of 10% plus a per-request limit of 3 attempts.

## Retry at one layer

The most effective fix for amplification is architectural: **pick one layer to retry**, usually:

- The **outermost** layer that knows the user's deadline (a client or the edge), **or**
- The layer that knows the operation is safe to repeat.

Other layers should fail fast and return a clear error, ideally signalling "don't retry" or "overloaded" upstream (a 503 with `Retry-After`, or a gRPC status that the caller won't retry). Service meshes make it easy to accidentally add retries everywhere, so audit retry policies across the stack.

## Hedging versus retrying

A **hedged request** sends a second copy **before** the first has failed, after a short delay (e.g. the p95 latency), and uses whichever answers first. It cuts tail latency for idempotent reads, but it's still extra load and needs its own budget. Retries respond to **errors**. Hedges respond to **slowness**.

## Where it's used

| System | Retry behaviour |
| --- | --- |
| **AWS SDKs** | Exponential backoff with jitter, retry quota (standard mode), adaptive mode with client-side rate limiting |
| **gRPC** | `retryPolicy` (max attempts, backoff, retryable codes) and `retryThrottling` (token bucket). Deadlines propagate. |
| **Envoy / Istio** | `retry_on` conditions, `num_retries`, per-try timeout, retry budgets (`retry_budget` as a % of active requests) |
| **Google Cloud client libraries** | Exponential backoff with jitter, total timeout |
| **Kubernetes controllers** | Rate-limited work queues with per-item exponential backoff |
| **Stripe API** | Idempotency keys for safe retries of POST requests, with client libraries that retry using backoff |

### Use case walk-through: a checkout service

Checkout calls inventory (read), pricing (read), and payment (write).

1. **Deadline:** the whole checkout has 2 s. The edge sets a gRPC deadline that propagates to all calls.
2. **Timeouts:** each call's per-attempt timeout is about 1.5× its p99: 120 ms for inventory and pricing, 800 ms for payment.
3. **Retries:** inventory and pricing (idempotent reads) retry once on `UNAVAILABLE` with full jitter (base 50 ms). Payment retries only with an **idempotency key** generated once per checkout, and the payment provider deduplicates.
4. **Budget:** gRPC retry throttling with `maxTokens = 100, tokenRatio = 0.1`.
5. **One layer:** the API gateway and service mesh have retries **disabled** for these routes, so the checkout service's policy is the only one.
6. **Outage drill:** when the pricing service is killed, checkout errors rise for the affected requests, but pricing receives at most ~10% extra traffic when it comes back, and recovers in seconds instead of collapsing under a wave of retries.

## Pitfalls

- **No timeout**, or a library default of minutes.
- **Retrying non-idempotent writes** without an idempotency key.
- **Retries at every layer**, multiplying load.
- **No jitter**, so retries arrive in synchronized waves.
- **Retrying on 4xx errors**, which will never succeed.
- **Unbounded attempts or delays**: infinite retry loops in background workers can hold resources forever. Send exhausted items to a dead-letter queue.
- **Ignoring `Retry-After`** and rate-limit headers.

> [!WARNING]
> If your error rate jumps when a dependency recovers rather than when it fails, suspect a **retry storm**: queued and retrying clients all arriving at once. Budgets, jitter and load shedding on the server side are the fixes.

## Discussion questions

1. Why can retries make an outage last longer than the problem that caused it?
2. With 5 layers each retrying 3 times, how many calls can reach the bottom layer?
3. How would you choose the per-attempt timeout given an overall deadline of 1 s and a dependency p99 of 150 ms?
4. Which of your write operations could be applied twice by a retry? How would you make them safe?
5. Why does full jitter outperform plain exponential backoff?
6. How does a retry budget differ from a maximum number of attempts?

## FAQ

### How many times should I retry?

Usually 2–3 attempts in total for user-facing requests, within a deadline. Background jobs can retry more, with longer backoff, ending in a dead-letter queue. Combine attempt limits with a budget so retries can't multiply load during outages.

### What base and cap should I use for backoff?

Base: roughly the dependency's typical latency (tens to hundreds of milliseconds). Cap: a few seconds for interactive work, minutes for background work. The key is to add jitter.

### Is it safe to retry after a timeout?

Only if the operation is idempotent or deduplicated. A timeout means you don't know whether the server processed the request. For reads, retrying is safe. For writes, use an idempotency key or a conditional operation.

### Should the server tell clients when to retry?

Yes. `Retry-After` on 429/503 responses, and gRPC status codes that distinguish "try again" from "don't", let servers steer client behaviour. Servers under overload should **shed load** early with these signals rather than accept work they can't finish.

### What's a metastable failure?

A state where a system stays overloaded after the original trigger is gone, sustained by its own reactions (retries, cache misses, failovers). Retry storms are the classic example. Breaking the loop needs load shedding, retry budgets, or temporarily blocking traffic.

## Key takeaways

- Retries are **extra load**. They help with random transient failures and hurt during overload.
- **Timeouts and deadlines** on every call, based on measured latency.
- Retry only **transient** errors, and only **idempotent** (or deduplicated) operations.
- **Exponential backoff with jitter** (full jitter is a good default), with capped attempts and delays.
- **Retry budgets** and **one retrying layer** prevent amplification and retry storms.

## References

1. M. Brooker. [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/). AWS Architecture Blog, 2015.
2. M. Brooker. [Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/). Amazon Builders' Library.
3. Google SRE Book. [Handling Overload](https://sre.google/sre-book/handling-overload/) and [Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/).
4. N. Bronson, A. Aghayev, A. Charapko, T. Zhu. [Metastable Failures in Distributed Systems](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf). *HotOS 2021*.
5. gRPC. [Retry design (A6)](https://github.com/grpc/proposal/blob/master/A6-client-retries.md) and [Deadlines](https://grpc.io/docs/guides/deadlines/).
6. AWS SDK docs. [Retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).
7. Envoy docs. [Retry policy and retry budgets](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto#config-route-v3-retrypolicy).
8. Stripe docs. [Idempotent requests](https://docs.stripe.com/api/idempotent_requests).

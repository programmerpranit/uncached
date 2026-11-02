---
summary: Token bucket, leaky bucket, fixed and sliding windows. How each one counts, how it behaves under bursts, and how to enforce a limit when requests land on many servers at once.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A rate limiter answers one question per request: *has this client used up its allowance?* **Fixed windows** are simplest but let through **2× the limit** at window edges. **Sliding window logs** are exact but store every timestamp. **Sliding window counters** approximate the log with two integers. **Token buckets** allow controlled bursts and are the most common choice for APIs. **Leaky buckets** smooth traffic into a steady stream. In a distributed system the hard part isn't the algorithm. It's **sharing the count** across servers without adding latency or a single point of failure.

## Why rate limit at all?

- **Protect capacity.** One buggy client in a retry loop shouldn't take the service down for everyone.
- **Fairness.** Divide shared capacity between tenants, so the noisy neighbour gets throttled instead of the quiet one.
- **Cost control.** Cap spend on expensive downstream calls such as LLM APIs, SMS or payment providers.
- **Security.** Slow down credential stuffing, scraping, enumeration and brute-force attacks.
- **Commercial plans.** "Free tier: 60 requests/minute, Pro: 1,000."

A limiter has three parts: a **key** (who is counted: user ID, API key, IP, IP+route), a **limit** (how many per how long), and an **algorithm** (how the counting works). The algorithm decides how the limiter behaves at the edges, and that's where the trade-offs are.

## Fixed window counter

Keep one counter per key per window, e.g. `ratelimit:alice:2026-11-02T12:01`. Increment it on every request and reject once it passes the limit. The counter expires with the window.

It's cheap (one integer and one atomic increment) and easy to explain. The flaw is at the **boundaries**:

![A timeline with two windows. 100 requests arrive just before 12:01 and 100 just after, so 200 pass within about ten seconds.](/figures/rate-limiting/fixed-window-burst.svg "Each window stays under its limit of 100, but around the boundary the backend sees 200 requests in a few seconds.")

A client can send the full limit at the end of one window and again at the start of the next, so up to **2× the limit** passes in a short span. Clients that reset at the top of the minute also cause synchronized spikes across all users.

## Sliding window log

Store the timestamp of every accepted request, e.g. in a Redis sorted set. On each request, drop timestamps older than `now − window`, count what's left, and allow the request if the count is under the limit.

This is **exact**. There is no boundary effect. But memory is `O(limit)` per key. That's fine for "5 login attempts per 15 minutes", and too expensive for "10,000 requests per hour" across millions of keys.

## Sliding window counter

The sliding window counter is a hybrid that keeps only **two counters**, the current and previous fixed windows, and weights the previous one by how much of it still overlaps the sliding window:

![Two adjacent window counters, 84 and 36, with a dashed sliding window that covers 30% of the previous one.](/figures/rate-limiting/sliding-window-counter.svg "estimate = previous × overlap fraction + current. This assumes requests in the previous window were evenly spread.")

```text
estimate = prev_count × (1 − elapsed_in_current / window) + curr_count
```

It smooths out the boundary spike with O(1) memory. The error comes from assuming the previous window's traffic was uniform. Cloudflare analysed this approach on hundreds of millions of real requests and found only a tiny fraction were wrongly allowed or blocked.

## Token bucket

Picture a bucket that holds up to **b** tokens and is refilled at **r** tokens per second. Each request takes one token. If the bucket is empty, the request is rejected (or waits).

![A bucket of tokens refilled at rate r; a request takes a token if one is available, otherwise it gets a 429.](/figures/rate-limiting/token-bucket.svg "Two knobs: r sets the sustained rate, b sets how big a burst can be.")

You don't need a timer to refill. Store `(tokens, last_refill_time)` and top up lazily on each request:

```text
tokens = min(b, tokens + (now − last) × r)
if tokens ≥ 1: tokens -= 1; allow   else: reject
```

Why it's the default for APIs:

- **Bursts are allowed, but bounded.** A client idle for a while can make `b` quick calls, such as loading a page that fans out to ten API calls. Its long-run average still can't exceed `r`.
- **Two numbers per key.** Constant memory, constant time.
- **Easy to explain:** "100 requests/second with bursts up to 200". AWS API Gateway and Stripe's request limiter both describe their throttling this way.
- **Weighted costs:** an expensive endpoint can take 5 tokens instead of 1.

### GCRA: a token bucket in one timestamp

The **Generic Cell Rate Algorithm**, from ATM networks, is mathematically equivalent to a token bucket but stores only a single "theoretical arrival time" (TAT) per key. Each request checks `now ≥ TAT − burst_tolerance` and advances the TAT by `1/r`. Libraries like `redis-cell` and several API gateways use it because it needs one value and one comparison.

## Leaky bucket

There are two versions with the same name:

1. **Leaky bucket as a meter:** effectively the same as a token bucket, seen from the other side (the bucket fills with requests and drains at rate `r`).
2. **Leaky bucket as a queue:** requests enter a FIFO queue of size `b`, and a worker takes them out at a **constant** rate. Overflow is dropped. NGINX's `limit_req` works this way, with an optional `burst` queue.

The queue version **shapes** traffic. Output is perfectly smooth, at the cost of added **latency** for queued requests:

![Simulated bursty input; the token bucket passes the first burst instantly then rejects, while the leaky bucket outputs a steady stream and drops overflow.](/figures/rate-limiting/bucket-shapes.svg "Same input, same rate and capacity. The token bucket passes bursts; the leaky bucket (queue) smooths them into a constant rate.")

Use **shaping** (leaky bucket as a queue) in front of something that genuinely can't handle bursts, such as a legacy system or a third-party API with a strict per-second cap. Use **policing** (token bucket, reject excess) for public APIs, where waiting is worse than a fast 429 and a retry.

## Comparing the algorithms

| Algorithm | Memory per key | Bursts | Accuracy | Typical use |
| --- | --- | --- | --- | --- |
| Fixed window | 1 counter | up to 2× at edges | low at boundaries | coarse quotas (per day/month) |
| Sliding log | O(limit) timestamps | none beyond limit | exact | low-volume, high-stakes (logins, OTP) |
| Sliding counter | 2 counters | small | approximate | high-volume per-key limits |
| Token bucket / GCRA | 2 values / 1 timestamp | up to b, configurable | exact for its model | API rate limits |
| Leaky bucket (queue) | queue of b | absorbed and delayed | exact | traffic shaping, outbound calls |

## Distributed rate limiting

With one server, the counter lives in memory. With 50 gateway instances behind a load balancer, a client's requests are spread across all of them. Each instance only sees a fraction of the traffic, so a local limit is wrong by a factor of ~50.

![Clients hit several gateways, which share counters in a central Redis or limiter service.](/figures/rate-limiting/distributed.svg "Shared state gives correctness. Local state gives speed. Most real systems mix the two.")

### Option 1: Central store

Keep counters in **Redis** (or a dedicated limiter service, like Envoy's global rate limit service). The check-and-update must be **atomic**: use `INCR` + `EXPIRE`, or a Lua script for token buckets so two gateways can't both take the last token.

- ✅ Accurate, and simple to reason about.
- ❌ An extra network round trip on every request (sub-millisecond in the same AZ, but it adds up). The store becomes a critical dependency. Hot keys can overload a single Redis shard.

### Option 2: Local counters with periodic sync

Each instance enforces `limit / N` locally, or keeps local counts and syncs them to a shared store every few hundred milliseconds.

- ✅ No per-request network hop. Keeps working if the store is down.
- ❌ Can overshoot. Uneven load balancing means `limit / N` is unfair. Changes in N (autoscaling) need handling.

### Option 3: Hybrid

Most production systems check **local** limits first (cheap, rejects obvious abuse at the edge) and **global** limits second. Many also **fail open**: if the limiter store is unreachable, they allow traffic rather than turning a Redis outage into a full API outage. Whether to fail open or closed is a deliberate product decision. For a login endpoint, failing closed may be right.

> [!TIP]
> **Stripe's layered approach** is a good model. A *request rate limiter* (token bucket per user), a *concurrent request limiter* (caps in-flight requests, good for expensive endpoints), a *fleet usage load shedder* (reserves capacity for critical traffic), and a *worker utilization load shedder* (drops low-priority traffic when workers are saturated). Rate limits protect from individual clients. Load shedding protects the whole system.

## Telling clients about limits

- Return **`429 Too Many Requests`** (RFC 6585), not 500 or 503, so clients know to back off instead of retrying immediately.
- Include **`Retry-After`** so well-behaved clients know when to come back.
- Advertise the budget with **`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`**-style headers. Many APIs use `X-RateLimit-*`, and the IETF HTTPAPI working group is standardising `RateLimit` / `RateLimit-Policy` fields.
- Document limits **per endpoint** and per plan. Undocumented limits lead to surprise outages for your customers.

## Where it's used

| Context | Typical approach |
| --- | --- |
| Public APIs (Stripe, GitHub, AWS) | Token bucket per key, plus concurrency limits. Quotas per hour or day. |
| API gateways (Envoy, Kong, NGINX) | Local token or leaky buckets, plus an optional global service backed by Redis. |
| Login, OTP and password reset | Sliding log per account **and** per IP, with escalating lockouts. |
| CDNs / WAFs (Cloudflare) | Sliding window counters at the edge, per IP or fingerprint. |
| Outbound calls to third parties | Leaky bucket queue to stay under a vendor's hard limit. |
| LLM platforms | Token buckets on **requests** and on **tokens** per minute, often both at once. |

## Pitfalls

> [!WARNING]
> **Keying by IP alone is fragile.** Thousands of users can share one IP (corporate NAT, mobile carrier CGNAT), while an attacker can rotate through thousands of IPs. Prefer authenticated identity (API key, user ID), and use IP or device signals as a secondary key.

- **Non-atomic read-then-write.** `GET count` → `if < limit` → `SET count+1` lets concurrent requests all pass. Use atomic increments or scripts.
- **Clock skew.** Window keys built from each server's local clock disagree at boundaries. Use the store's time (`TIME` in Redis) or tolerate a little slop.
- **Retry storms.** Clients that retry 429s immediately make things worse. Send `Retry-After`, and make sure SDKs back off with jitter.
- **Limiting too late.** If the limiter sits behind expensive work (auth lookups, DB calls), rejected requests still cost you. Put cheap checks as early as possible.
- **One global number.** A limit that's right for `GET /status` is wrong for `POST /reports/export`. Weight requests by cost, or set per-endpoint limits.

## Discussion questions

1. Show that a fixed window can admit 2× the limit in a short span. What's the worst case for a sliding window counter?
2. Design per-user limits for an API served by 40 gateways with autoscaling. What happens to accuracy when you scale from 40 to 80?
3. When would you choose to queue (leaky bucket) instead of rejecting (token bucket)?
4. Your Redis limiter cluster goes down. Should the API fail open or closed? Does the answer change for login?
5. How would you rate limit an LLM API where requests vary from 10 to 100,000 tokens?
6. How do rate limiting and load shedding differ, and why do you need both?

## FAQ

### What's the difference between rate limiting and throttling?

The terms are used loosely. Usually *rate limiting* means rejecting requests over a limit (with a 429). *Throttling* sometimes means slowing them down instead (queueing or delaying). Some providers, like AWS, call their rejections "throttling". Check what a given API actually does.

### Should the limit be per user, per IP or per API key?

Use the most specific **trustworthy** identity. For authenticated APIs that's the API key or account, often with a separate limit per endpoint. For unauthenticated endpoints (login, signup) combine IP, device fingerprint and target account, so one attacker can't lock out a real user and a NAT'd office isn't blocked as one person.

### How do I choose `r` and `b` for a token bucket?

Set `r` from the sustained load your backend can handle per client (or per plan), with headroom. Set `b` from legitimate burst patterns: how many calls does one page load or one batch job make in a second? Then watch real traffic. If 429s cluster on normal user actions, `b` is too small.

### Does rate limiting stop DDoS attacks?

It helps against application-level abuse from identifiable clients. Volumetric DDoS saturates your network before requests reach the limiter, so it needs upstream protection: CDN/anycast scrubbing, SYN cookies and provider-level filtering.

### Where should the rate limiter live?

As early as possible: CDN or edge for IP-based limits, then the API gateway for per-key limits, then the service itself for limits that need business context ("5 exports per day per workspace"). Cheap, coarse checks go early. Precise, context-aware checks go deeper.

### Is the token bucket the same as the leaky bucket?

As **meters** they're equivalent: one counts tokens available, the other counts how full the bucket is. The difference people usually mean is **policing vs shaping**. Token bucket implementations typically reject excess immediately. Leaky bucket *queue* implementations delay excess to produce a smooth output rate.

## Key takeaways

- The algorithm sets **edge behaviour**: boundary bursts (fixed window), memory cost (sliding log), approximation (sliding counter), allowed bursts (token bucket) or smoothing (leaky queue).
- **Token bucket / GCRA** is the go-to for APIs: two parameters, O(1) state, bounded bursts.
- In distributed setups, **atomic shared state** is the hard part. Choose central, local or hybrid, and decide on fail-open vs fail-closed.
- Talk to clients with **429 + Retry-After + remaining-budget headers**.
- Rate limiting protects you from **clients**. **Load shedding** protects you from **overload**. You want both.

## References

1. P. Tarjan. [Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters). Stripe Engineering, 2017.
2. J. Desgats. [Counting things, a lot of different things](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/). Cloudflare Blog, 2017.
3. B. Leach. [Rate Limiting, Cells, and GCRA](https://brandur.org/rate-limiting). 2015.
4. AWS. [Throttle requests to your REST APIs for better throughput in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html).
5. NGINX. [Module ngx_http_limit_req_module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html).
6. Envoy. [Global rate limiting](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting).
7. M. Nottingham, R. Fielding. [RFC 6585: Additional HTTP Status Codes](https://www.rfc-editor.org/rfc/rfc6585) (429 Too Many Requests). 2012.
8. IETF HTTPAPI WG. [RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) (Internet-Draft).
9. ITU-T I.371 / ATM Forum. Generic Cell Rate Algorithm (GCRA), traffic control for ATM networks.
10. A. Xu. *System Design Interview*, chapter 4: Design a Rate Limiter. 2020.

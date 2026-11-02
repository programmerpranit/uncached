---
summary: Round robin, least connections, latency-aware and hashing strategies, and why picking the better of two random servers beats trying to pick the best one.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A load balancer spreads requests across backends so none is overloaded while others sit idle. **Round robin** is simple and fine when requests and servers are uniform. **Least connections** and **latency-aware** algorithms adapt to uneven work, but need up-to-date load information, and with **stale** information many balancers all pick the same "best" server and overload it. **Power of two choices** (sample two random backends, send to the less loaded one) avoids that herd and gets almost the same balance as a perfect global view. **Hashing** trades balance for **affinity**, sending the same key to the same server. Which works best depends on where the balancing happens and how much each balancer knows.

## The problem: uneven work, partial information

Spreading requests evenly would be trivial if every request cost the same and every server were identical. In reality:

- **Requests vary**: a search for "a" can cost 100× more than a lookup by ID.
- **Servers vary**: different instance types, noisy neighbours, a JIT still warming up, a GC pause.
- **Connections vary**: HTTP/2 and gRPC multiplex many requests over **one long-lived connection**, so balancing per connection can pin heavy traffic to one backend.
- **Information is partial.** There are usually many balancers (proxies, or every client), each seeing only its own traffic, with load data that's already slightly out of date.

## Where balancing happens

![A request passes through DNS or GSLB, then an L4 load balancer, then an L7 proxy or a client-side balancer before reaching a backend.](/figures/load-balancing/layers.svg "Each layer picks among the next, using different information.")

- **DNS / global server load balancing** picks a region or point of presence, using geography, health and capacity. Coarse, and slowed by DNS caching.
- **L4 (transport) balancers** pick a backend per **TCP connection or UDP flow**, based on IPs and ports. Very fast, often in kernels or hardware: AWS NLB, Google Maglev, Facebook Katran, Linux IPVS. They usually use **consistent hashing** of the connection 5-tuple, so packets for one connection keep going to the same backend even when the balancer fleet changes.
- **L7 (application) proxies** pick a backend per **HTTP or gRPC request** and can use paths, headers and cookies: NGINX, HAProxy, Envoy, AWS ALB.
- **Client-side balancing:** the caller gets the list of backends (from service discovery) and picks one itself, as gRPC clients, Finagle and many service meshes do. It saves a network hop but means **thousands of independent balancers**, each with a partial view.

## The algorithms

![Six cards: round robin, weighted round robin, least connections, least latency/EWMA, power of two choices, and hashing.](/figures/load-balancing/algorithms.svg "From no state at all to full load awareness, with power of two choices in the sweet spot.")

### Round robin and random

Send each request to the next backend in turn (or a random one). No state about load is needed.

- Works well when requests are **small and uniform** and servers are identical.
- Ignores reality: a slow server keeps getting its full share, and its queue grows.
- **Weighted round robin** gives bigger servers proportionally more turns. Weights are static, so they don't react to a server that's temporarily slow. NGINX uses a "smooth" weighted variant that interleaves picks rather than sending bursts.

### Least connections / least outstanding requests

Send each request to the backend with the **fewest requests in flight**. Slow servers accumulate in-flight requests, so they naturally get fewer new ones.

- Adapts well to **varying request costs** and slow servers.
- Needs to know the in-flight count. A single proxy knows its own count exactly, but not other proxies' traffic.

### Latency-aware (EWMA)

Track each backend's recent response time as an **exponentially weighted moving average**, often multiplied by its outstanding requests, and prefer the lowest. Twitter's Finagle and Linkerd use **peak EWMA**, which reacts quickly to latency spikes and recovers gradually.

- Routes around slow backends even before their queues build up.
- Can be fooled: a backend that **fails fast** (instant errors) looks like the fastest server and attracts all traffic. Count errors as slow, or combine with outlier detection.

### Power of two choices

Pick **two backends at random**, and send the request to the one with **less load** (fewer outstanding requests, or lower EWMA).

![Bar charts of requests per server for 100 servers and 10,000 requests: random assignment ranges from 79 to 129; two choices ranges from 97 to 101.](/figures/load-balancing/power-of-two.svg "A simulation: the second random sample does almost all the work.")

This comes from Michael Mitzenmacher's 1996 thesis and the "balls into bins" literature (Azar, Broder, Karlin and Upfal, 1994). Throw n balls into n bins at random, and the fullest bin has about **log n / log log n** balls. Let each ball pick the less full of **two** random bins, and the fullest has about **log log n / log 2**: an exponential improvement from one extra sample. A third sample helps only a little more.

It's also **cheap** (two lookups, not a scan of all backends) and works with **partial or stale** information, which matters a lot:

![With load information refreshed every 500 requests, always picking the least-loaded server sends 525 requests to one server; two random choices keeps the maximum at 107.](/figures/load-balancing/stale-herd.svg "With stale data, 'pick the best' is the worst strategy. Randomness spreads the decisions.")

When many balancers act on the same snapshot, they all agree on which backend is least loaded and **all send to it**, overloading it until the next update. Then they all switch to the next one. This **herd behaviour** makes "always pick the least loaded" worse than random once information is stale. With two random choices, different balancers sample different pairs, so their decisions spread out. Mitzenmacher analysed exactly this in "How Useful Is Old Information?" (2000).

That's why power of two choices is the default in **Envoy** (`LEAST_REQUEST` samples two hosts), **Finagle**, **Linkerd**, and **NGINX** (`random two least_conn`), and was adopted by **HAProxy** for its `random` algorithm.

### Hashing and affinity

Hash a key (client IP, user ID, session cookie, cache key) to choose the backend. The same key always goes to the same backend.

- Useful for **cache locality** (each server caches its share of keys), **sticky sessions**, and stateful protocols.
- Use **consistent hashing** (ring hash, Maglev, rendezvous hashing) so adding or removing a backend moves only ~1/n of keys.
- Hashing **ignores load**: a hot key overloads its server. **Consistent hashing with bounded loads** (Google, 2016, used by Vimeo and HAProxy) caps each server at, say, 125% of average and spills excess keys to the next server on the ring.

## Health, slow start and connection reuse

Choosing among backends is only part of the job:

- **Health checks:** active (probe `/healthz`) and passive (**outlier detection**: eject a host after N consecutive 5xx, then re-admit it later).
- **Slow start:** a new or restarted backend has cold caches and an unwarmed JIT. Ramp its share up over 30–60 seconds instead of giving it a full share (or with least-connections, a flood, since it has zero connections).
- **Connection draining:** on deploy, stop sending new requests to a backend but let in-flight ones finish.
- **Long-lived connections:** with HTTP/2 and gRPC, an L4 balancer balances **connections**, not requests. A few clients with heavy multiplexed connections can overload one backend. Use L7 or client-side balancing per request, or cap connection lifetime so connections periodically rebalance.
- **Subsetting:** with thousands of clients and thousands of backends, a full mesh means millions of connections. Each client connects to a **subset** of backends instead (Google's SRE book describes deterministic subsetting).

## Where it's used

| System | Default / notable algorithms |
| --- | --- |
| **NGINX** | Round robin (weighted, smooth), `least_conn`, `ip_hash`, `hash`, `random two least_conn` |
| **HAProxy** | `roundrobin`, `leastconn`, `source`, `uri`, consistent hashing with bounded load, `random(2)` |
| **Envoy** | Round robin, least request (power of two choices), ring hash, Maglev, random. Outlier detection, slow start. |
| **gRPC** | `pick_first` by default, `round_robin`, plus xDS-driven policies (least request, ring hash, weighted round robin using server-reported load via ORCA) |
| **Linkerd** | Peak EWMA with power of two choices |
| **Google Maglev** | L4 consistent hashing (Maglev hashing) across a fleet of software balancers |
| **AWS ALB / NLB** | ALB: round robin or least outstanding requests. NLB: flow hash. |

### Use case walk-through: a gRPC service behind Kubernetes

A team runs a gRPC service with 20 pods behind a Kubernetes `ClusterIP` Service and sees one pod at 90% CPU while others idle.

1. **Diagnosis:** `ClusterIP` is L4 (kube-proxy / IPVS). It balances **connections**, and each gRPC client opens one long-lived HTTP/2 connection, so a few heavy clients pin their traffic to a few pods.
2. **Option 1:** headless Service + gRPC client-side `round_robin`. Each client connects to all pods and balances per request.
3. **Option 2:** a service mesh sidecar (Envoy / Linkerd) does per-request balancing with power of two choices over EWMA latency.
4. They choose option 2, enable slow start for new pods, and add outlier detection to eject pods that return repeated errors.
5. Result: CPU across pods within a few percent of each other, and p99 latency down because slow pods receive less traffic.

## Pitfalls

- **Balancing connections when you meant requests.** The classic gRPC and HTTP/2 trap.
- **Least connections + a new server.** A fresh server with zero connections gets flooded. Use slow start, or power of two choices, which bounds how much any one server receives.
- **Fast failures attract traffic.** A broken backend returning instant 500s looks idle and fast. Combine latency-aware balancing with outlier detection.
- **Sticky sessions hide imbalance.** Long sessions pinned to servers skew load over time and make deploys painful. Prefer stateless servers with session state in a shared store.
- **Global "least loaded" from stale metrics.** Herd behaviour. Use randomness.

> [!TIP]
> If you only remember one thing: in a system with many balancers, **"pick 2 at random, use the less loaded"** is the robust default. It needs no coordination, and it degrades gracefully when load information is old.

## Discussion questions

1. Why does a second random choice help so much more than a third?
2. Why can "always pick the least loaded server" perform worse than random?
3. Your gRPC service behind an L4 load balancer has wildly uneven CPU across pods. What's happening and how would you fix it?
4. When would you deliberately sacrifice balance for affinity?
5. How should a balancer treat a new backend that just joined the pool?
6. A backend starts failing every request in 1 ms. What does each algorithm do with it?

## FAQ

### What's the difference between L4 and L7 load balancing?

L4 works on TCP/UDP flows and sees IPs and ports, so it balances **connections**. It's fast and protocol-agnostic. L7 terminates HTTP/gRPC and balances **requests**, and can route on paths, headers and cookies, retry, and do TLS termination. It costs more CPU per request.

### Is round robin good enough?

Often, yes: when requests are cheap and uniform, servers are identical, and there are few balancers. It becomes a problem when request costs vary widely, servers have different speeds, or a backend is degraded but still passing health checks.

### Why not just use least connections everywhere?

With one balancer, it works well. With many balancers, each only knows its own connections, and decisions based on stale or partial counts herd. Power of two choices over least-request keeps most of the benefit and avoids the herd.

### What is "consistent hashing with bounded loads"?

A variant of consistent hashing where each server has a capacity of, for example, 1.25× the average load. If a key's server is full, the key moves to the next server on the ring. It keeps most of the cache affinity while preventing hot keys from overloading one server.

### How does Google's Maglev work?

Maglev is a software L4 load balancer. Each Maglev machine uses a consistent hashing table built to spread connections evenly across backends and to change minimally when backends change. Because all Maglev machines compute the same table, any of them can handle any packet of a connection, so the balancer fleet can scale out with ECMP routing in front.

### Do I need a load balancer with client-side balancing?

You still need **service discovery** (a registry of healthy backends) and usually health information. Client-side balancing removes the proxy hop, but pushes balancing logic into every client library and language.

## Key takeaways

- Balancing happens at several layers (DNS, L4, L7, client-side), each with different information.
- **Round robin** for uniform work. **Least requests** or **EWMA latency** when costs and speeds vary.
- **Power of two choices** gives near-optimal balance cheaply and stays robust with stale information, avoiding herd behaviour.
- **Hashing** buys affinity at the cost of balance. Use consistent hashing, ideally with bounded loads.
- Watch out for **connection-level** balancing of HTTP/2 and gRPC, and use **slow start** and **outlier detection**.

## References

1. M. Mitzenmacher. [The Power of Two Choices in Randomized Load Balancing](https://www.eecs.harvard.edu/~michaelm/postscripts/mythesis.pdf). PhD thesis, UC Berkeley, 1996.
2. M. Mitzenmacher, A. Richa, R. Sitaraman. [The Power of Two Random Choices: A Survey of Techniques and Results](https://www.eecs.harvard.edu/~michaelm/postscripts/handbook2001.pdf). 2001.
3. M. Mitzenmacher. [How Useful Is Old Information?](https://www.eecs.harvard.edu/~michaelm/postscripts/tpds2000.pdf) *IEEE TPDS*, 2000.
4. D. Eisenbud et al. [Maglev: A Fast and Reliable Software Network Load Balancer](https://research.google/pubs/maglev-a-fast-and-reliable-software-network-load-balancer/). *NSDI 2016*.
5. V. Mirrokni, M. Thorup, M. Zadimoghaddam. [Consistent Hashing with Bounded Loads](https://arxiv.org/abs/1608.01350). *SODA 2018*.
6. Google SRE Book. [Load Balancing in the Datacenter](https://sre.google/sre-book/load-balancing-datacenter/).
7. Envoy docs. [Supported load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers).
8. NGINX. [NGINX and the "Power of Two Choices" Load-Balancing Algorithm](https://www.f5.com/company/blog/nginx/nginx-power-of-two-choices-load-balancing-algorithm). 2018.
9. Buoyant. [Beyond Round Robin: Load Balancing for Latency](https://linkerd.io/2016/03/16/beyond-round-robin-load-balancing-for-latency/). 2016.
10. gRPC. [Load Balancing in gRPC](https://github.com/grpc/grpc/blob/master/doc/load-balancing.md).

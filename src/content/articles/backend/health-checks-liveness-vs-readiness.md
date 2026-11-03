---
summary: Liveness asks "should I be restarted?", readiness asks "should I get traffic?" — mixing them up turns small blips into outages.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — A **liveness** check answers *"is this process stuck beyond repair?"* — failing it gets the container **killed and restarted**. A **readiness** check answers *"should this instance receive traffic right now?"* — failing it only **removes the instance from the load balancer**. A **startup** check holds off the other two while a slow app boots. Keep liveness cheap and local (never call the database), let readiness reflect warm-up, capacity and draining, and remember that the orchestrator will act on whatever you return, at fleet scale.

## The problem: the orchestrator believes your health endpoint

Kubernetes, ECS, Nomad and every cloud load balancer poll your service and act on the answer automatically. That is enormously useful: a deadlocked process gets restarted at 3 a.m. without paging anyone, and a node that hasn't finished loading its model doesn't receive requests.

But the automation is only as good as the question you let it ask. Common failures:

- A single `/health` endpoint used for **both** liveness and readiness, which checks the database. The database has a 30-second blip; **every pod** fails liveness and restarts at once, then hammers the recovering database with fresh connections.
- A JVM service takes 90 seconds to start, but the liveness probe gives up after 30 — the pod is **killed in a loop** and never comes up (`CrashLoopBackOff`).
- No readiness probe: new pods receive traffic **before** caches and connection pools are warm, so every deploy causes a latency spike and a burst of 502s.
- On shutdown, the pod exits immediately while the load balancer still routes to it — **dropped requests on every rollout**.

All four come from conflating distinct questions. The fix is to ask each one separately and to be deliberate about what each answer triggers.

## How it works

### Three probes, three consequences

![Startup, liveness and readiness probes, and the action taken when each fails](/figures/health-checks/probes.svg "Liveness failure is destructive (restart); readiness failure is reversible (no traffic until it passes again).")

- **Startup probe.** Runs first and disables the others until it succeeds. It gives slow-booting apps a generous budget (`failureThreshold × periodSeconds`, e.g. 30 × 10 s = 5 minutes) without making liveness sluggish for the rest of the pod's life. If it never succeeds, the container is restarted.
- **Liveness probe.** Detects a process that is running but **cannot recover on its own** — a deadlock, an exhausted event loop, a wedged thread pool. The only remedy the platform has is a restart, so the check should be one that a restart would actually fix.
- **Readiness probe.** Decides whether the instance appears in the Service's endpoints (or the load balancer's target group). It can fail and recover many times during a pod's life without any restart.

Probes can be an HTTP GET (2xx/3xx = success), a TCP connect, a gRPC health check, or a command run in the container. Each has `periodSeconds`, `timeoutSeconds`, `failureThreshold` and `successThreshold` — together they set how fast you react and how tolerant you are of jitter.

Outside Kubernetes the same split exists under other names: AWS ALB/NLB target health checks are readiness-style (unhealthy targets stop getting traffic), while ECS container health checks and auto-scaling group health checks replace the task or instance — liveness-style.

### A pod's life through its probes

![Timeline of a pod: booting under the startup probe, warming, serving, briefly unready under overload, serving again, then draining after SIGTERM](/figures/health-checks/timeline.svg "Readiness is a dial the app turns on and off; liveness stays green the whole time unless the process genuinely wedges.")

What each phase should look like:

1. **Booting.** Startup probe fails until the server is listening and initialization is done.
2. **Warming.** The process is alive but not ready: loading config, priming caches, opening a minimum number of DB connections, running JIT warm-up. Readiness returns 503.
3. **Serving.** Readiness passes; the instance is added to endpoints.
4. **Temporarily unready.** Some teams flip readiness off when local queues are saturated, to shed load to healthier peers. Do this carefully (see Pitfalls) — if every instance does it at once, nothing is ready.
5. **Draining.** On `SIGTERM`, the app immediately fails readiness, keeps serving in-flight and newly arriving requests for a few seconds while endpoint removal propagates to load balancers and kube-proxy, then closes listeners and exits before `terminationGracePeriodSeconds`. A `preStop` sleep of 5–10 s is a common way to cover propagation delay.

### What each check should (and shouldn't) look at

The most important design rule: **liveness checks only the process itself**.

![Comparison: liveness that calls the database causes all pods to restart during a DB outage; liveness that checks only the process keeps pods up and degraded](/figures/health-checks/storm.svg "A restart can't fix a database outage — it can only make your recovery slower.")

| Check | Should look at | Should *not* look at |
|---|---|---|
| Liveness | Event loop responsive, main worker threads not deadlocked, a heartbeat updated recently | Database, cache, downstream APIs, disk quota |
| Readiness | Initialization finished, local resources warm, not draining, maybe local saturation | Shared dependencies whose failure would mark **every** instance unready |
| Startup | Process listening, migrations/config loaded | Anything slow and external you can do lazily |

Shared dependencies are the tricky case for readiness. If the database is down for everyone, marking all pods unready doesn't route traffic anywhere better — it just converts graceful errors into connection-refused at the load balancer. It can make sense to include a dependency that is **instance-specific** (a local sidecar, a per-pod connection pool) but not one shared by the whole fleet. Report shared dependency health through metrics, dashboards and circuit breakers instead.

For humans and dashboards, a richer **diagnostic endpoint** (e.g. `/health/details`, Spring Boot Actuator's component breakdown) listing each dependency's status is valuable — just don't wire it to the orchestrator.

## Where it's used

| Setting | How health checks appear |
|---|---|
| Kubernetes | `startupProbe`, `livenessProbe`, `readinessProbe` per container; readiness gates Service endpoints |
| AWS ELB / target groups | HTTP health checks decide whether targets receive traffic; thresholds and intervals configurable |
| AWS ECS / auto-scaling groups | Container or instance health checks replace unhealthy tasks or instances |
| Google Cloud load balancers & managed instance groups | Separate LB health checks (traffic) and autohealing checks (recreate VM) |
| gRPC services | Standard `grpc.health.v1.Health` service, with per-service status |
| Spring Boot, ASP.NET Core, etc. | Built-in liveness/readiness health groups exposed as separate endpoints |
| Docker / Compose | `HEALTHCHECK` instruction; `depends_on: condition: service_healthy` for startup ordering |

## Use case walk-through: fixing restart storms in a payments API

A payments API on Kubernetes has a single `/health` endpoint, used for liveness and readiness, that runs `SELECT 1` against Postgres and pings Redis. During a 40-second Postgres failover, all 24 pods restart; recovery takes 6 minutes because of cold caches and a connection stampede.

1. **Split the endpoints.** `/livez` returns 200 if the HTTP server responds and a background watchdog confirms the worker pool processed a task in the last 30 s. No network calls. `/readyz` reports initialization, warm-up and draining state.
2. **Remove shared dependencies from both probes.** Postgres and Redis health move to metrics and alerts. Requests that need the database during an outage fail fast with 503 via a circuit breaker.
3. **Add a startup probe.** The service loads a large fraud-rules file at boot; `startupProbe` allows up to 3 minutes, so liveness can keep a tight 10 s × 3 setting.
4. **Tune thresholds.** Liveness: `periodSeconds: 10`, `failureThreshold: 3`, `timeoutSeconds: 2`. Readiness: `periodSeconds: 5`, `failureThreshold: 2` — quick to remove, cheap to re-add.
5. **Graceful shutdown.** On `SIGTERM` the app fails `/readyz`, a `preStop` hook sleeps 10 s, then the server stops accepting connections and drains in-flight requests with a 25 s budget inside a 45 s grace period.
6. **Test it.** A game-day exercise kills the Postgres primary and runs a rolling deploy under load, watching restarts, 5xx rate and endpoint counts.

**Result:** the next Postgres failover causes 40 seconds of fast 503s on write paths with **zero pod restarts**, reads served from cache continue, and rolling deploys no longer drop requests.

## Pitfalls

- **Dependencies in liveness.** The classic restart storm: a shared outage makes everything restart, then the cold fleet stampedes the dependency.
- **One endpoint for everything.** Liveness and readiness need different logic; a combined check inherits the worst of both.
- **Timeouts too tight.** A 1 s probe timeout on a service with GC pauses or a busy event loop will fail under exactly the load where a restart hurts most. Probes compete with real requests for the same threads.
- **Liveness without a startup budget.** Slow starters get killed before they finish booting. Use a startup probe rather than a huge `initialDelaySeconds` that also delays detection of real hangs later.
- **Readiness flapping fleet-wide.** If every pod marks itself unready under load at the same moment, the Service has no endpoints and *all* traffic fails. Load shedding with 503s is usually safer than readiness-based shedding.
- **Expensive checks.** A probe that runs queries or renders a page every 5 s on 200 pods is real load. Keep checks O(1) and cached.
- **Ignoring shutdown.** Without failing readiness and waiting for propagation, every deploy drops some requests.
- **Health endpoints exposed publicly.** Detailed dependency reports leak internals; serve them on an internal port or behind auth.

> [!WARNING]
> Ask of every liveness condition: *"Would restarting this container fix it?"* If the answer is no — a database outage, a full disk on a shared volume, a downstream API returning 500s — it does not belong in liveness.

## Discussion questions

1. What signals inside your process genuinely indicate it is wedged and needs a restart?
2. Should readiness fail when a shared database is down? What does the client see in each case?
3. How would you choose `failureThreshold` and `periodSeconds` to balance fast detection against false positives?
4. How does your service behave between `SIGTERM` and exit? How would you test that no requests are dropped?
5. When is it reasonable to use readiness for load shedding, and how would you avoid every instance going unready together?
6. How do health checks interact with autoscaling and rolling-deploy settings like `maxUnavailable`?

## FAQ

### Do I need a liveness probe at all?

Not always. If your process crashes cleanly when something goes wrong, the container runtime already restarts it. Liveness is for the case where the process is running but stuck. A bad liveness probe causes more outages than a missing one, so add it only when you know what "stuck" looks like for your service.

### What's the difference between `initialDelaySeconds` and a startup probe?

`initialDelaySeconds` is a fixed wait before probing begins and applies to the whole lifetime configuration. A startup probe adapts: it succeeds as soon as the app is up (fast boots aren't delayed) and allows a long maximum for slow boots, after which the tight liveness settings take over.

### Should readiness check downstream services?

Only dependencies specific to this instance. If a dependency is shared by all instances, failing readiness everywhere just removes all endpoints. Handle shared dependency failures in the request path with timeouts, circuit breakers and degraded responses.

### What status code should a failing health check return?

For HTTP probes, anything outside 200–399 counts as failure; 503 Service Unavailable is the conventional choice. Keep the body small. For gRPC, use the standard health service's `NOT_SERVING` status.

### How do load balancer health checks relate to Kubernetes probes?

They're separate systems that should agree. A cloud load balancer in front of a cluster runs its own checks against nodes or pods; configure it to use the readiness endpoint, and make its thresholds compatible with your drain timing so it stops sending traffic before the pod exits.

## Key takeaways

- **Liveness → restart; readiness → traffic; startup → patience for slow boots.**
- Liveness checks **only the process itself** — never shared dependencies.
- Readiness covers warm-up, draining and instance-local conditions, and is safe to flip.
- Use a **startup probe** instead of loosening liveness for slow starters.
- Fail readiness on `SIGTERM` and wait for propagation to make deploys lossless.
- Treat probe thresholds as production configuration: test them under load and during dependency outages.

## References

- [Kubernetes — Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Kubernetes — Pod Lifecycle: container probes and termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [AWS — Health checks for Application Load Balancer target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
- [gRPC — Health Checking Protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md)
- Betsy Beyer et al., *Site Reliability Engineering*, O'Reilly, 2016 — chapters on load balancing and handling overload.
- Colm MacCárthaigh, "Implementing health checks," Amazon Builders' Library.
- Spring Boot reference documentation, "Kubernetes Probes" (Actuator health groups).

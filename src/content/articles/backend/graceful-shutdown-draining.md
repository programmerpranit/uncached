---
summary: Why naive shutdowns drop requests during deploys, the correct shutdown sequence (fail readiness, wait for the load balancer, stop accepting, drain, close, exit), the Kubernetes endpoint-removal race and pre-stop hooks, and how to drain keep-alive connections, WebSockets, queue consumers and long jobs safely.
updated: 2026-11-02
---

> [!KEY]
> Every deploy, autoscale-in and node drain **stops processes that are serving traffic**. A graceful shutdown makes that invisible to users. On **SIGTERM**, the process:
> 1. fails its readiness check;
> 2. keeps serving for a few seconds while load balancers notice;
> 3. stops accepting new connections;
> 4. **drains** in-flight requests and jobs;
> 5. flushes and closes resources;
> 6. exits before the orchestrator's **grace period** ends in SIGKILL.
>
> The classic bug is exiting immediately while the load balancer is still sending traffic, which shows up as a burst of 502s on every deploy. Work that can outlive the grace period must be **resumable**: acknowledge only after completion, and make handlers idempotent.

## The problem: deploys that cause errors

A team deploys ten times a day. Their dashboards show a small spike of 502s and "connection reset" errors at each rollout. A few background jobs also end up half-done: an email sent but the database never updated, or an export file left truncated.

Nothing is broken in the code itself. The problem is **how processes die**:

- The process exits the instant it receives SIGTERM, abandoning requests mid-flight.
- The load balancer hasn't yet learned the pod is going away and keeps routing new requests to it.
- Clients holding keep-alive connections send their next request into a socket that's about to close.
- A queue worker is killed halfway through a job that already had side effects.

In a world of rolling deploys, autoscaling and spot instances, process termination is **routine**, not exceptional. It has to be designed.

## How it works

### The shutdown sequence

![The shutdown sequence from SIGTERM through readiness failure, LB wait, stop accepting, drain, close and exit](/figures/graceful-shutdown/sequence.svg "Leave the load balancer first, then drain, then exit, all inside the grace period.")

When an orchestrator stops a container, it sends **SIGTERM**, waits a **grace period**, then sends **SIGKILL**, which can't be caught. Kubernetes defaults to 30 s (`terminationGracePeriodSeconds`), ECS to 30 s (`stopTimeout`), and systemd to 90 s (`TimeoutStopSec`). Inside that window, a well-behaved service:

1. **Catches SIGTERM.** Register a signal handler. Make sure your process actually *receives* the signal. A shell-form Dockerfile `CMD` runs your app under `/bin/sh`, which may not forward signals. Use exec form, or a tiny init like `tini` or `dumb-init`.
2. **Fails readiness.** Return 503 from the readiness endpoint so the orchestrator and load balancers mark the instance as not ready for new traffic.
3. **Waits for the load balancer to catch up.** Keep serving normally for a few seconds. This is the step most people skip.
4. **Stops accepting new connections.** Close the listening socket. Most frameworks have a `server.shutdown()` / `close()` that does this and then waits for active requests.
5. **Drains in-flight work.** Let active requests finish, up to a drain timeout. Tell keep-alive clients to go elsewhere, and stop pulling new jobs from queues.
6. **Closes resources.** Flush buffered logs, metrics and traces. Commit consumer offsets, close DB pools, and release distributed locks or leases.
7. **Exits with status 0**, comfortably before the grace period expires.

Set the timeouts so they nest: the pre-stop delay plus the drain timeout plus cleanup must be less than the grace period. For example: 5 s LB wait + 20 s drain + 3 s cleanup < 30 s grace.

### The endpoint-removal race

![Timeline showing a pod exiting before the load balancer stops routing, versus a pre-stop sleep that avoids the gap](/figures/graceful-shutdown/race.svg "SIGTERM and endpoint removal happen in parallel. A short delay before closing the listener avoids routing to a dead process.")

In Kubernetes, deleting a pod triggers two things **at the same time**:

- The kubelet runs the `preStop` hook, if there is one, then sends SIGTERM to the container.
- The control plane removes the pod from Service **EndpointSlices**. That change then propagates to kube-proxy on every node, to ingress controllers, to service-mesh sidecars and to cloud load balancers. Each picks it up on its own schedule, sometimes taking several seconds.

If the app closes its listener the moment SIGTERM arrives, there's a window where traffic is still routed to a pod that refuses connections. The standard fix is a short delay before shutdown starts:

- a `preStop` hook that sleeps for 5–10 s (`lifecycle.preStop.sleep`, native since Kubernetes 1.30, or `exec: sleep 5` in older versions);
- or, in the app's SIGTERM handler, flip readiness to failing and wait N seconds before closing the listener.

Cloud load balancers add their own **deregistration delay** (AWS ALB target groups default to 300 s), during which existing connections drain but new ones aren't sent. Tune it to match your longest normal request rather than leaving the default.

### Draining different kinds of work

![How to drain HTTP requests, keep-alive connections, WebSockets, queue consumers and batch jobs](/figures/graceful-shutdown/workers.svg "Each kind of work drains differently, but the rule is the same: finish it, or hand it back so someone else can.")

- **Short HTTP requests.** Framework shutdown waits for them. Set a drain timeout slightly above your p99.9 request time.
- **Keep-alive HTTP/1.1.** Clients reuse idle connections. While draining, respond with `Connection: close` so clients open new connections, which will land on other instances, and close idle connections promptly.
- **HTTP/2 and gRPC.** Send a **GOAWAY** frame. It tells the client which streams will complete, and that new streams should go to a new connection. gRPC servers' `GracefulStop()` does this.
- **WebSockets and SSE.** These connections can last hours, so you can't wait for them to finish. Send an application-level "reconnect" message or close code. **Stagger and jitter** reconnects so 10,000 clients don't all reconnect to the remaining pods at once. Clients must reconnect with resume tokens or `Last-Event-ID`.
- **Queue consumers.** Stop polling for new messages immediately. Finish the current message and ack it. If it can't finish in time, **nack** it or let its visibility timeout expire so another worker picks it up. Never ack before the side effects are durable.
- **Long batch jobs.** Checkpoint progress periodically and make each step idempotent, so a replacement worker can resume from the last checkpoint. Kubernetes Jobs with backoff, or workflow engines like Temporal, help here.
- **Leaders and lock holders.** Release leases explicitly so a successor can take over immediately instead of waiting for the lease to expire.

### The hard limit: SIGKILL and crashes

Graceful shutdown is an optimisation. **Hard failures still happen**: OOM kills, node crashes, power loss, a SIGKILL after a stuck drain. A robust system treats graceful shutdown as the common path and still relies on these for correctness:

- at-least-once delivery with idempotent handlers;
- transactional outboxes, rather than in-memory buffers of events;
- client retries with idempotency keys;
- a write-ahead log or database for anything that must not be lost.

## Where it's used

| Platform / component | Shutdown mechanism |
|---|---|
| Kubernetes | `preStop` hook → SIGTERM → `terminationGracePeriodSeconds` → SIGKILL. Endpoint removal runs in parallel. |
| AWS ECS / ALB | SIGTERM + `stopTimeout`. Target group **deregistration delay** drains connections. |
| systemd | `ExecStop`, `KillSignal`, `TimeoutStopSec`. Socket activation can hand listeners to a new process. |
| nginx, Envoy, HAProxy | Graceful reload: old workers finish connections while new workers accept. Envoy has a `drain_time`. |
| Go `net/http`, Node `server.close()`, Spring Boot `server.shutdown=graceful` | Built-in stop-accept-and-wait for in-flight requests. |
| gRPC servers | `GracefulStop()` sends GOAWAY and waits for active RPCs. |
| Sidekiq, Celery, Kafka consumers | Stop fetching, finish or requeue current jobs, commit offsets on rebalance or close. |

## Use case walk-through: eliminating 502s on deploy

A Node.js API runs as 12 pods behind an NGINX ingress. Every rolling deploy produces 200–400 502 errors.

1. **Check signal delivery.** The Dockerfile uses `CMD npm start`. `npm` doesn't reliably forward SIGTERM, so the app never sees it and is SIGKILLed after 30 s. They switch to `CMD ["node", "server.js"]` and add `tini` as the init process.
2. **Add a SIGTERM handler.** On SIGTERM, the app sets `shuttingDown = true`, so `/readyz` now returns 503. Then it waits 8 s, calls `server.close()`, and waits up to 15 s for active requests.
3. **Handle keep-alive.** While shutting down, the app adds `Connection: close` to responses and destroys idle sockets. Otherwise NGINX's upstream keep-alive pool keeps reusing connections to the draining pod.
4. **Clean up.** After the server closes, the app flushes the OpenTelemetry exporter and logs, closes the Postgres pool, and exits 0.
5. **Align timeouts.** 8 s pre-delay + 15 s drain + 2 s cleanup = 25 s, inside the 30 s grace period. Rollout `maxUnavailable: 0` and `maxSurge: 25%` ensure capacity never drops during the deploy.
6. **Fix the job worker too.** The same deployment runs a BullMQ worker. On SIGTERM it calls `worker.close()`, which stops taking new jobs and waits for active ones. Jobs longer than 20 s were already made idempotent with checkpoints.
7. **Verify.** They run a load test with `k6` at 500 req/s while triggering three consecutive rollouts.

**Result:** zero 5xx errors across rollouts. Deploys become boring enough that the team moves to continuous deployment.

## Pitfalls

- **Signals never reach the app.** Shell-form `CMD`, wrapper scripts without `exec`, and PID 1 not handling signals all lead to silent SIGKILLs after the grace period.
- **Closing the listener immediately on SIGTERM.** This causes the endpoint-removal race and 502s. Wait for the load balancer first.
- **Drain timeout longer than the grace period.** The process gets SIGKILLed mid-drain, which defeats the point. Nest the timeouts.
- **Ignoring keep-alive and connection pools.** Upstream proxies keep sending requests over existing connections to the draining instance.
- **Acking queue messages before the work is done.** A shutdown in between loses the message. Ack after the side effects are durable.
- **Thundering herd on reconnect.** Thousands of WebSocket clients reconnecting at once can overload the remaining instances. Add jitter and stagger closes.
- **Health checks that lie.** If readiness doesn't flip during shutdown, or liveness fails during a slow drain, the orchestrator may make things worse.

> [!TIP]
> Test shutdown on purpose. Run a load test and do a rollout, `kubectl delete pod`, or a node drain while watching error rates. If you see any 5xx or lost jobs, one of the steps in the sequence is missing.

## Discussion questions

1. Why does Kubernetes remove endpoints and send SIGTERM in parallel rather than sequentially, and what does that force applications to do?
2. Your longest legitimate request takes 2 minutes, for example a report export. How would you design shutdown for it without a 2-minute grace period on every pod?
3. What's the difference between failing readiness and failing liveness during shutdown, and what goes wrong if you fail liveness?
4. How should a Kafka consumer handle offsets when it's shut down mid-batch?
5. Why isn't graceful shutdown enough for correctness, and which patterns cover the cases where it doesn't happen?
6. How would you drain 50,000 WebSocket connections from one instance without overloading the others?

## FAQ

### How long should the grace period be?

Long enough for: the load balancer delay (typically 5–15 s), plus your drain timeout (above p99.9 request duration), plus cleanup. For typical APIs, 30–60 s is common. Longer grace periods slow down deploys and node drains, so very long work should be made resumable instead.

### Is a `preStop` sleep a hack?

It's a pragmatic fix for a real distributed race. Endpoint removal propagates asynchronously and there's no acknowledgement that every load balancer has stopped routing. Kubernetes added a native `sleep` action to `preStop` hooks because the pattern is so common. Doing the wait inside the app's SIGTERM handler is equivalent.

### What happens to requests that are still running at SIGKILL?

They're cut off. The client sees a connection reset or a 502 from a proxy. Any partial side effects remain. That's why handlers should be idempotent and clients should retry safely with idempotency keys.

### Should I fail liveness during shutdown?

No. Liveness failure tells the orchestrator to **restart** the container, which isn't what you want while it drains. Fail **readiness** to stop new traffic, and keep liveness passing until exit.

### How do serverless platforms handle this?

Platforms like AWS Lambda manage instance lifecycle for you. Requests aren't cut off mid-invocation by scale-in, though there's a timeout per invocation. Lambda can send a SHUTDOWN event to extensions for cleanup, with a short time limit. Cloud Run sends SIGTERM with a 10 s grace before SIGKILL. The same principles of short work, idempotency and flushing telemetry still apply.

## Key takeaways

- Process termination is routine: deploys, autoscaling, spot reclaim. Design for it.
- Sequence: SIGTERM → fail readiness → wait for LBs → stop accepting → drain → close → exit, all within the grace period.
- Kubernetes removes endpoints **in parallel** with SIGTERM. A short pre-stop delay avoids 502s.
- Drain each kind of work properly: `Connection: close` and GOAWAY for keep-alive, reconnect hints for WebSockets, stop-polling and nack for queues, checkpoints for long jobs.
- Graceful shutdown is best-effort. Idempotency, at-least-once delivery and outboxes keep you correct when it doesn't happen.

## References

- [Kubernetes documentation: Pod lifecycle — termination of Pods](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
- [Kubernetes documentation: Container lifecycle hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
- [AWS documentation: Target group deregistration delay](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html#deregistration-delay)
- [Go documentation: http.Server.Shutdown](https://pkg.go.dev/net/http#Server.Shutdown)
- [Spring Boot documentation: Graceful shutdown](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html)
- [gRPC documentation: Graceful shutdown](https://grpc.io/docs/guides/server-graceful-stop/)
- [RFC 9113: HTTP/2, Section 6.8 GOAWAY](https://www.rfc-editor.org/rfc/rfc9113#section-6.8)
- [Docker documentation: Dockerfile ENTRYPOINT (exec form and signals)](https://docs.docker.com/reference/dockerfile/#entrypoint)
- [tini: A tiny but valid init for containers](https://github.com/krallin/tini)

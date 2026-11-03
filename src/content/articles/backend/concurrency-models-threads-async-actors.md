---
summary: How thread-per-request, event loops with async/await, virtual threads and actors each handle waiting, what each costs in memory and complexity, how to size pools with Little's law, and how to pick the right model for an I/O-bound or CPU-bound service.
updated: 2026-11-02
---

> [!KEY]
> A backend request spends most of its life **waiting**: on the database, on another service, on the disk. The concurrency model decides what happens to the request while it waits.
> - **Thread per request:** the OS thread blocks. The code is simple, but each thread costs memory and context switches, so a box tops out at thousands of concurrent requests.
> - **Event loop + async:** a few threads multiplex thousands of requests. A waiting request is just a parked callback or future, so it's cheap. But **one blocking or CPU-heavy call stalls everyone**.
> - **Virtual threads / goroutines:** the runtime parks cheap user-space threads on I/O. You write blocking-style code and get event-loop scale.
> - **Actors:** state lives inside isolated entities that process one message at a time from a mailbox. There are no locks, and a supervisor restarts failed actors.
>
> Whichever model you pick, the real limits are usually **downstream**: database connections, rate limits and memory. Use Little's law to size pools, and apply backpressure.

## The problem: most of a request is waiting

Take a typical API request that takes 50 ms. About 2 ms of that is CPU work: parsing JSON, running business logic and serialising the response. The other 48 ms is spent waiting for a Postgres query, a Redis lookup and a call to the payments service.

If the server handled one request at a time, it would sit idle 96% of the time. So every backend runtime overlaps requests somehow. The question is **what represents a waiting request**:

- a whole **OS thread** with its own stack, parked by the kernel;
- a small **heap object** (a callback, promise or future) that an event loop resumes when the socket is ready;
- a **virtual thread** or goroutine that the language runtime unmounts from its carrier thread;
- a **message** sitting in an actor's mailbox.

That choice drives three things: how many concurrent requests a box can hold, how easy the code is to write and debug, and which mistakes take the whole service down.

## How it works

![Three concurrency models side by side: thread per request, event loop with async, and actors](/figures/concurrency-backend/models.svg "Three ways to represent a waiting request. Each trades simplicity, memory per request and failure isolation differently.")

### Thread per request

The classic model is used by servlet containers, Rails/Puma, Django under gunicorn with sync workers, and PHP-FPM. Each request gets a thread from a **pool**. When code calls `db.query()`, the thread makes a blocking syscall and the kernel puts it to sleep until data arrives.

- **Why people like it:** code reads top to bottom, stack traces make sense, and thread-local context such as the current user or the trace ID just works.
- **Memory cost:** each OS thread reserves a stack, typically 512 KB to 8 MB of virtual memory, with tens of KB actually touched. Kernel bookkeeping comes on top of that.
- **Scheduling cost:** a context switch costs a few microseconds plus cache pollution. With 10,000 threads mostly asleep, the scheduler is fine. With 10,000 threads all runnable, throughput collapses.
- **Practical ceiling:** hundreds to low thousands of concurrent requests per process. That's plenty for many services, but not for 50k idle WebSocket connections.

The pool size is the concurrency limit. When every thread is busy, new requests queue in the acceptor or the OS backlog. That's a crude but real form of **backpressure**.

### Event loop and async/await

Node.js, Python asyncio, Rust's Tokio, Netty and nginx use a small number of threads, often one per core. Each thread runs a loop:

1. Ask the kernel which sockets are ready. This uses `epoll` on Linux, `kqueue` on BSD and macOS, IOCP on Windows, or `io_uring`.
2. For each ready socket, resume the code that was waiting on it.
3. Run that code until it hits the next `await`, then go back to step 1.

A waiting request costs only a small state machine on the heap, often a few hundred bytes to a few KB. One process can hold **hundreds of thousands** of idle connections.

![Timeline comparing a blocking thread and an event loop interleaving several requests during I/O waits](/figures/concurrency-backend/timeline.svg "A blocking thread idles through each wait. The event loop fills those gaps with other requests' CPU work, until one handler hogs the CPU and every other request stalls.")

The catch is that this is **cooperative scheduling**. The loop can only switch at an `await`. That has three consequences:

- **Never block the loop.** A synchronous file read, a sync DB driver, `time.sleep()` or a 200 ms bcrypt hash freezes *every* request on that loop. p99 latency spikes for everyone, not just the slow request.
- **Offload CPU work.** Send CPU-heavy work to a worker pool (`worker_threads`, `run_in_executor`, `spawn_blocking`) or a separate service.
- **Async is contagious.** An async function can only be awaited from async code, so the whole call stack and every library in it must be async-aware. This is often called the "function colour" problem.

Stack traces and request context also get harder. Context has to travel with the task, using `AsyncLocalStorage` in Node or `contextvars` in Python, rather than thread-locals.

### Virtual threads and goroutines: the middle ground

Go's goroutines and Java 21's **virtual threads** (Project Loom) give you blocking-style code with event-loop economics:

- A goroutine or virtual thread starts with a small, growable stack of a few KB.
- When it blocks on I/O, the runtime **unmounts** it from the OS "carrier" thread and registers the socket with epoll or kqueue. The carrier immediately picks up another runnable task.
- When data arrives, the runtime schedules the task again, possibly on a different carrier.

You can run a million goroutines, write `resp, err := http.Get(url)` with no `await`, and still get readable stack traces. Erlang's BEAM processes, covered next, work the same way.

Caveats:

- **Pinning.** Older JVMs pinned a virtual thread to its carrier inside `synchronized` blocks or native calls. Blocking there blocks the carrier. JDK 24 removed most `synchronized` pinning, but native frames still pin.
- **Cheap threads don't make downstream resources cheap.** A million virtual threads all wanting one of 20 database connections just means a million waiters. You still need semaphores and bounded pools.
- **Don't pool virtual threads.** Create one per task. Pooling them just recreates the old limits.

### Actors

The actor model, from Hewitt in 1973, was made practical by Erlang/OTP and is used by Akka/Pekko, Microsoft Orleans, Elixir and Ray. It changes *how state is shared* rather than how waiting works:

- An **actor** owns private state. Nobody else can touch it.
- Actors communicate only by **sending asynchronous messages**, which queue in the receiver's **mailbox**.
- An actor processes **one message at a time**, so its state never needs a lock.
- Actors are cheap. Erlang processes start at about 2–3 KB, so you can have one per user, per cart or per device.

![Per-entity actors with mailboxes processing one message at a time, supervised by a parent that restarts them on failure](/figures/concurrency-backend/actors.svg "One actor per entity serialises updates to that entity without locks. Supervisors restart crashed actors from a known-good state.")

**Supervision** is the other half of the model. Actors are arranged in a tree. When a child crashes, its supervisor applies a strategy such as restart it, restart all its siblings, or escalate. Erlang's "**let it crash**" philosophy says you shouldn't write defensive code for every unexpected state. Instead, fail fast and let the supervisor rebuild the actor from clean state. This isolation is why telecom switches and WhatsApp's backend ran on BEAM.

**Virtual actors**, or grains in Orleans, add location transparency. You address `Cart(42)`, and the runtime activates it on some node, persists its state, and deactivates it when idle.

Trade-offs:

- Request/response flows become message choreography, which is harder to follow.
- Mailboxes can grow without bound if producers outpace an actor, so you need bounded mailboxes or backpressure.
- A single hot actor is a serial bottleneck.

### Sizing pools: Little's law

Whatever the model, some resource is finite: threads, DB connections, file descriptors or memory. **Little's law** relates them:

> concurrency (L) = arrival rate (λ) × time in system (W)

Take 2,000 req/s at 50 ms average latency. That gives 2,000 × 0.05 = **100 requests in flight** on average.

- **Thread per request:** you need roughly 100 threads plus headroom for bursts and slow tails. Size for p99 latency, not the mean.
- **DB connections:** if each request holds a connection for 10 ms of its 50 ms, you need about 2,000 × 0.01 = **20 connections**, not 100.
- **Latency doubling** (for example, because the database slows down) doubles the concurrency you need. That's how a slow dependency exhausts pools and cascades.

A common heuristic for CPU-bound pools is `threads ≈ cores`. For blocking-I/O pools it's `cores × (1 + wait time / compute time)`. Then measure. The HikariCP authors note that small DB pools often beat large ones, because the database itself has only so many cores and disks.

### Backpressure

Cheap concurrency makes it *easy* to accept more work than you can finish. Healthy systems push back:

- Use **bounded queues** everywhere: executor queues, actor mailboxes, channel buffers.
- Put **semaphores** around scarce resources so that, say, at most 20 concurrent DB calls are allowed.
- Set **timeouts** on every wait, so stuck requests release their slots.
- **Reject early** with 429 or 503 when you're full, rather than queueing work whose client has already given up.

## Where it's used

| Platform | Model | Notes |
|---|---|---|
| Java servlets (Tomcat), Spring MVC | Thread per request | Default `maxThreads` of 200. Spring Boot 3.2+ can switch to virtual threads with one property. |
| Ruby on Rails (Puma), Django (gunicorn sync) | Threads or processes per request | Python's GIL makes multi-process the usual choice for CPU parallelism. |
| Node.js, Deno, Bun | Single-threaded event loop | `worker_threads` for CPU work. libuv thread pool for file I/O and DNS. |
| Python FastAPI / asyncio, aiohttp | Event loop | One sync call in an `async def` handler blocks the loop. |
| Rust Tokio / axum, Netty, Vert.x | Multi-threaded event loop | Work-stealing across cores. `spawn_blocking` for sync code. |
| Go net/http | Goroutine per request | Netpoller-integrated scheduler. Blocking style, M:N threads. |
| Java 21+ virtual threads | Virtual thread per request | Blocking APIs become cheap. Watch for pinning and resource limits. |
| Erlang/Elixir (Phoenix), WhatsApp, Discord | Actors (BEAM processes) | Process per connection, supervision trees, preemptive scheduling. |
| Akka/Pekko, Microsoft Orleans, Ray | Actors / virtual actors | Stateful per-entity logic: games, IoT, carts, sessions. |

## Use case walk-through: a notification service hitting its ceiling

A team runs a Spring MVC service that sends push notifications. Each send calls an external push provider, which takes 300 ms at p50 and 2 s at p99.

1. **Symptom.** At 400 req/s the service starts returning timeouts, but CPU is at 15%. Thread dumps show all 200 Tomcat threads `WAITING` on socket reads.
2. **Diagnose with Little's law.** 400 req/s × 0.3 s = 120 in flight on average. At p99 latency, bursts need far more than 200 threads. The service is **thread-bound, not CPU-bound**.
3. **Option A: raise `maxThreads` to 2,000.** Memory grows by hundreds of MB, and context-switching rises during bursts. It works but it's fragile.
4. **Option B: rewrite on WebFlux (event loop).** This scales, but the rewrite touches every layer. The team's JDBC repository is blocking, so it would need R2DBC or offloading. That's weeks of work and a new debugging model.
5. **Option C: virtual threads.** They upgrade to Java 21 and set `spring.threads.virtual.enabled=true`. Each request now runs on a virtual thread, and blocking HTTP calls unmount instead of holding an OS thread. They check that the HTTP client doesn't call blocking code inside `synchronized`, using `-Djdk.tracePinnedThreads` on older JDKs.
6. **Add the missing limits.** With unlimited cheap threads, a provider slowdown could now pile up 50,000 in-flight requests. They add a semaphore of 1,000 concurrent provider calls, a 3 s timeout, and a 503 with `Retry-After` when the semaphore is exhausted.
7. **Keep the database bounded.** The HikariCP pool stays at 20. Little's law says 400 × 0.008 s ≈ 3.2 connections are busy on average, so 20 is ample.

**Result:** the same code handles 3,000 req/s at 20% CPU. Memory is flat. When the push provider has an incident, the service sheds load cleanly instead of falling over.

## Pitfalls

- **Blocking inside async code.** One sync DB call, `requests.get()`, or big `JSON.parse` in an async handler stalls the whole loop. Use loop-lag monitoring (`monitorEventLoopDelay` in Node, asyncio debug mode) to catch it.
- **CPU work on the event loop.** Image resizing, compression, crypto and large serialisation belong in a worker pool or a separate service.
- **Unbounded concurrency.** Goroutines, virtual threads and promises are cheap, but `Promise.all(10_000 requests)` can exhaust sockets, memory or a partner's rate limit. Bound fan-out with semaphores or worker pools.
- **Pool size mismatch.** 500 app threads sharing 10 DB connections means 490 threads waiting on the pool. Size pools together and look at pool wait time, not just query time.
- **Thread-local context in async or virtual-thread code.** Trace IDs and auth context silently disappear across `await`s or thread hops. Use the runtime's context propagation, such as `AsyncLocalStorage`, `contextvars` or `ScopedValue`.
- **Actor mailbox overflow.** A slow actor with an unbounded mailbox becomes a memory leak. Bound mailboxes, shard hot entities, or apply backpressure upstream.
- **Shared mutable state.** Async code on a multi-threaded runtime still races. Actors only protect state if you never leak references out of them.

> [!TIP]
> Before changing the concurrency model, find out **what's actually waiting**. Take a thread dump, an async task dump or an event-loop lag graph. If threads are waiting on a DB pool, more threads won't help. If the loop lags with idle sockets, something is blocking it. The fix is usually a limit or an offload, not a rewrite.

## Discussion questions

1. A service does 5,000 req/s with 20 ms p50 and 400 ms p99 latency. How many in-flight requests should you plan for, and which latency figure do you use?
2. Why can a single slow regex in one Node.js handler raise p99 latency for every endpoint on the server?
3. Virtual threads make blocking cheap. Which resources are still expensive, and how would you protect them?
4. When does the actor model's "one message at a time" guarantee become a bottleneck, and how would you shard around it?
5. Your async Python service uses a library with no async version. What are your options, and what does each cost?
6. How does "let it crash" differ from just not handling errors? What must be true about actor state for it to work?

## FAQ

### Is async always faster than threads?

No. Async isn't faster per request. It holds **more concurrent waiting requests per unit of memory**. For CPU-bound work, or for services with a few hundred concurrent requests, a thread pool performs about the same and is simpler. Async pays off when you have thousands of mostly idle connections: chat, streaming, proxies and fan-out gateways.

### Do virtual threads make reactive frameworks obsolete?

For most request/response services, largely yes. Virtual threads give similar scalability with plain blocking code and readable stack traces. Reactive libraries such as Reactor and RxJava still offer rich stream operators: backpressure-aware pipelines, merging, windowing. Those stay useful for genuinely stream-shaped problems.

### Why is Node.js single-threaded but still able to use many cores?

Your JavaScript runs on one thread per process. libuv uses a small thread pool for file I/O, DNS and some crypto, and `worker_threads` can run JS in parallel. To use all cores for request handling, you run several processes with the `cluster` module, PM2, or one container per core behind a load balancer.

### How do actors differ from a message queue like Kafka?

Actors are an **in-process (or in-cluster) programming model**. They're fine-grained (one per entity), keep state in memory, and communicate with low-latency messages. Kafka is a **durable log between services**: messages are persisted, replayable and consumed in partitions. They're complementary. An actor system might consume from Kafka and route each event to the actor for that entity.

### What's the GIL and does it matter for concurrency?

CPython's Global Interpreter Lock lets only one thread run Python bytecode at a time. Threads still help with I/O-bound work, because the GIL is released during blocking syscalls. They don't give CPU parallelism, so Python servers use multiple processes for CPU work. Python 3.13 introduced an optional free-threaded build without the GIL, and its adoption is still maturing.

## Key takeaways

- The concurrency model is about **what a waiting request costs**: an OS thread, a heap-allocated future, a virtual thread, or a message in a mailbox.
- Thread per request is simple but memory-bound. Event loops scale to huge connection counts but must **never block**. Virtual threads and goroutines combine blocking-style code with cheap waiting.
- Actors remove locks by giving each entity one-at-a-time processing, and add fault isolation through supervision.
- **Little's law** (L = λ × W) sizes thread and connection pools. Size for tail latency, because slow dependencies multiply in-flight work.
- Cheap concurrency moves the bottleneck downstream. Bound every queue, pool and fan-out, and shed load when full.

## References

- [Node.js documentation: Don't Block the Event Loop (or the Worker Pool)](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
- [JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491)
- [Python documentation: asyncio — Developing with asyncio](https://docs.python.org/3/library/asyncio-dev.html)
- [Tokio tutorial: Spawning and blocking](https://tokio.rs/tokio/tutorial/spawning)
- [Erlang/OTP Design Principles: Supervision Trees](https://www.erlang.org/doc/system/design_principles.html)
- [Microsoft Orleans documentation: Grains (virtual actors)](https://learn.microsoft.com/en-us/dotnet/orleans/grains/)
- [HikariCP wiki: About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- [Bob Nystrom: What Color is Your Function?](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)
- Carl Hewitt, Peter Bishop, Richard Steiger: *A Universal Modular ACTOR Formalism for Artificial Intelligence* (IJCAI, 1973)
- John D. C. Little: *A Proof for the Queuing Formula: L = λW* (Operations Research, 1961)

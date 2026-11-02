---
summary: The three main ways to run work concurrently (processes, kernel threads, and user-space green threads or async tasks), what each shares and isolates, what they cost, and how real systems such as Chrome, PostgreSQL, Go, Erlang and Java's virtual threads choose between them.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **process** has its own address space, file descriptors and resources. It's isolated (a crash or memory bug stays contained), but communication needs IPC, and each one costs real memory and setup time. **Threads** run inside one process and share its memory: communication is just reading and writing variables, which is fast and also the source of data races. On Linux, both are kernel **tasks** created with `clone()`, scheduled preemptively, costing roughly **1–2 µs per switch** and a stack each. **Green threads** (goroutines, Erlang processes, Java virtual threads) and **async tasks** (Rust, JavaScript, Python, C#) are scheduled by a **runtime in user space**, multiplexing many tasks onto a few kernel threads. They cost kilobytes and switch in ~100 ns, so a million of them is practical. The trade-offs: runtime complexity, the danger of blocking a carrier thread, and for async/await, "colored" functions. Real systems combine them: **processes for isolation**, then threads or green threads for **concurrency inside**.

## The problem: doing many things at once

A server handles thousands of requests, a browser runs dozens of tabs, a build compiles hundreds of files. Each needs a unit of concurrent execution with its own control flow. The choice of unit decides:

- **Isolation:** can one unit corrupt or crash another?
- **Communication:** how do units share data, and how expensive is it?
- **Cost:** memory per unit, creation time, switch time, and therefore how many you can have.
- **Parallelism:** can units run on multiple cores at once?
- **Programming model:** blocking code, callbacks, or async/await?

## Processes and threads

![Two processes each with their own address space, heap, file descriptors, registers and stack; two threads in one process sharing address space, heap, globals, file descriptors and signal handlers, each with its own registers and stack.](/figures/concurrency-models/sharing.svg "A process is a protection boundary. A thread is a unit of execution inside it.")

A **process** is a running program with:

- its own **virtual address space** (code, heap, stacks, mapped files),
- its own **file descriptor table**, current directory, credentials and signal handlers,
- one or more **threads** of execution.

A **thread** has its own **registers**, **stack** and **thread-local storage**, and shares everything else with the other threads in its process.

On Linux, the kernel doesn't strongly distinguish them: both are **tasks** (`task_struct`) created by `clone()`, which takes flags saying what to share. `fork()` shares nothing (memory is copy-on-write). `pthread_create()` calls `clone(CLONE_VM | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD | ...)` to share almost everything. The scheduler treats every task the same way. This **1:1** model (one user thread per kernel task, glibc's NPTL since 2003) is used by C/C++ pthreads, Rust's `std::thread`, Java's platform threads and .NET threads.

**Processes** communicate through **IPC**: pipes, Unix sockets, TCP, message queues, or shared memory (`mmap` of a shared file or `shm_open`), with explicit synchronization. **Threads** just access shared variables, guarded by locks or atomics.

## Green threads and async tasks

![Left: four user threads, each mapped one-to-one to a kernel thread. Right: eight green threads scheduled by a runtime onto three kernel threads. Both sit on the kernel scheduler.](/figures/concurrency-models/mapping.svg "M:N runtimes decide which task runs on which kernel thread, in user space.")

Kernel threads are relatively heavy: each reserves a stack (1 MiB for Java by default, 8 MiB for glibc pthreads, mostly untouched but still committed in page tables as it grows), a kernel stack, and a `task_struct`, and every switch goes through the kernel. With tens of thousands of threads, memory, scheduling latency and switching overhead dominate.

**Green threads** (also called user-space threads, fibers or coroutines) are scheduled by a runtime instead of the kernel:

- **Many tasks on few threads (M:N):** the runtime keeps a thread per core (Go's `GOMAXPROCS`, Java's carrier threads, Tokio's worker threads) and runs tasks on them.
- **Cheap switching:** when a task blocks on I/O, a channel or a lock, the runtime saves a few registers, parks it, and runs another task, without entering the kernel. ~100–200 ns.
- **Small stacks:** goroutines start with a 2 KiB stack that grows (and shrinks) as needed. Java virtual threads store their stack frames on the heap. Erlang processes start at a few hundred words.
- **Non-blocking I/O underneath:** a "blocking" read in a goroutine actually registers the socket with the runtime's epoll/kqueue poller and parks the goroutine.

**Async/await** is the stackless relative: each `async` function compiles into a **state machine**, and an executor polls tasks when the I/O they wait on is ready. Tasks are as small as their state (often a few hundred bytes), but you must mark functions `async` and `await` their calls. This split between async and regular functions is sometimes called **function coloring**.

| | Green threads (stackful) | Async/await (stackless) |
| --- | --- | --- |
| Examples | Go, Erlang/Elixir, Java virtual threads | Rust (Tokio), JavaScript, Python asyncio, C#, Kotlin coroutines |
| Code style | Ordinary blocking code | `async fn` / `await` everywhere on the path |
| Memory per task | KBs (growable stack) | Size of the state machine |
| Preemption | Go and Erlang preempt; Java virtual threads yield at blocking points | Cooperative: yields only at `await` |

## What they cost

![Table: process about 1+ MB, about 100 µs+ to fork, µs to switch plus TLB; OS thread 1–8 MB stack reserved, about 10–20 µs to create, 1–2 µs to switch; goroutine or virtual thread about 2 KB, about 1 µs or less to create, 100–200 ns to switch; async task size of state, about 100 ns, tens of ns.](/figures/concurrency-models/costs.svg "Each row is roughly an order of magnitude cheaper than the one above.")

These differences determine designs. A thread-per-connection server is fine for hundreds of connections, strained at tens of thousands, and impossible at a million. A Go or Erlang server routinely holds a million mostly idle connections, one lightweight task each.

## Choosing

![Four rows: processes for isolation and crash containment (Chrome tabs, PostgreSQL backends); OS threads for CPU-bound parallelism (thread pools, games); green threads for huge numbers of waiting I/O tasks in blocking style (Go, Erlang, Java virtual threads); async/await for huge I/O concurrency with minimal memory (Node.js, Tokio, asyncio).](/figures/concurrency-models/choosing.svg "Pick the isolation boundary first, then the concurrency model inside it.")

- **Processes** when you need **isolation**: untrusted or crash-prone code (browser renderers), different languages or runtimes, separate privilege levels, or a design where one failure must not take down the rest. Chrome runs a renderer process per site (site isolation), so a compromised or crashing page can't reach others.
- **OS threads** for **CPU-bound parallel work** (compression, rendering, numeric code) with about one thread per core, and for moderate concurrency where blocking code is simplest.
- **Green threads** for **massive I/O concurrency in a blocking style**: network servers, proxies, chat systems, crawlers.
- **Async/await** for massive I/O concurrency with **minimal memory and no runtime stack switching**, or where the language offers nothing else (JavaScript).

### Language-specific constraints

- **CPython's GIL** lets only one thread execute Python bytecode at a time, so CPU-bound Python uses `multiprocessing` (processes) or native extensions that release the GIL. Python 3.13 added an experimental free-threaded build without the GIL.
- **Node.js** runs JavaScript on a single thread with an event loop. CPU-heavy work goes to worker threads or separate processes.
- **Go** makes goroutines the only option, and the runtime handles the rest.
- **Java 21+** offers both: platform threads for CPU work, virtual threads for blocking I/O at scale.

## Where it's used

| System | Model |
| --- | --- |
| **Chrome** | Process per site (renderers), plus GPU, network and browser processes, each multithreaded |
| **PostgreSQL** | Process per connection (forked backends), shared memory for buffers |
| **MySQL** | Thread per connection (with an optional thread pool) |
| **nginx** | Process per core, each running an event loop |
| **Go services** | Goroutine per request on `GOMAXPROCS` threads |
| **Erlang / Elixir (WhatsApp, Discord)** | Millions of BEAM processes with isolated heaps and message passing |
| **Redis** | Single-threaded event loop for commands, with helper threads for I/O |

### Use case walk-through: moving a blocking Java service to virtual threads

A Java 17 service with a 400-thread pool handles requests that spend 95% of their time waiting on databases and HTTP calls. Under load it saturates the pool, and latency climbs while CPU sits at 30%.

1. **Diagnose.** Thread dumps show almost every pool thread in `socketRead` or waiting on a connection. The pool size, not the CPU, limits throughput.
2. **Upgrade to Java 21** and switch request handling to `Executors.newVirtualThreadPerTaskExecutor()` (or enable virtual threads in the framework). Code stays blocking-style.
3. **Bound concurrency where it matters.** With virtual threads, nothing limits concurrent requests to the database except the connection pool. Add explicit semaphores for downstream services, since otherwise 50,000 requests can pile onto a pool of 50 connections.
4. **Watch for pinning.** On Java 21–23, a virtual thread blocking inside a `synchronized` block pins its carrier thread. Replace hot `synchronized` sections with `ReentrantLock`, or upgrade to Java 24+, where JEP 491 removed this limitation.
5. **Result.** Throughput is limited by the downstreams instead of the thread pool, and memory use drops compared with hundreds of platform thread stacks.

## Pitfalls

- **Sharing mutable state between threads without synchronization**: data races, which are undefined behavior in C, C++ and Rust (unsafe), and subtle bugs elsewhere.
- **Thread per connection at large scale**: memory and switching overhead.
- **Blocking a green-thread or async runtime's carrier thread** with CPU-heavy work, blocking syscalls the runtime doesn't intercept, or synchronous libraries.
- **Unbounded concurrency with cheap tasks**: a million goroutines can overwhelm a database. Cheap concurrency still needs backpressure.
- **Forking a multithreaded process**: only the calling thread survives in the child, with other threads' locks still held.
- **Assuming processes are always safer**: shared memory between processes reintroduces most thread hazards.

> [!TIP]
> On Linux, `ps -eLf` or `top -H` shows threads as separate tasks, and `/proc/<pid>/task/` lists them. For goroutines, use `runtime.NumGoroutine()` or a goroutine profile, and for virtual threads, `jcmd <pid> Thread.dump_to_file -format=json`.

## Discussion questions

1. Why does Linux implement threads and processes with the same `clone()` system call?
2. When would you choose processes over threads despite the higher cost?
3. How can a goroutine "block" on a socket without blocking an OS thread?
4. What problems does function coloring cause in async/await languages?
5. Why does cheap concurrency make backpressure more important, not less?
6. How does Erlang get isolation between millions of processes without OS processes?

## FAQ

### Are threads faster than processes?

Creating and switching threads is cheaper, and communication through shared memory avoids copying. But processes can be just as fast at steady state for independent work, and they avoid lock contention and memory-allocator contention between unrelated tasks. The bigger differences are isolation and programming model.

### Are goroutines threads?

No. They're user-space tasks scheduled by the Go runtime onto OS threads. Since Go 1.14, the runtime can preempt long-running goroutines asynchronously using signals, so a tight loop no longer starves the others.

### What happened to Java's original green threads?

Early JVMs (around Java 1.1) used green threads on some platforms but couldn't use multiple cores, so Java moved to native 1:1 threads. Virtual threads (JEP 444, Java 21) bring back M:N scheduling, this time on top of native carrier threads, so they use all cores.

### Do async tasks run in parallel?

It depends on the executor. Node.js and Python asyncio run tasks on one thread, so only concurrently, not in parallel. Tokio's multi-threaded runtime and C#'s thread pool run tasks in parallel across cores.

### How many threads should my program have?

For CPU-bound work, about one per core. For blocking I/O, enough to cover the concurrency you need, which is why green threads or async are preferred at high concurrency. Measure scheduling latency and context switches rather than guessing.

## Key takeaways

- **Processes** isolate memory and resources. **Threads** share them. On Linux both are **tasks** created by `clone()`.
- **Kernel threads** cost MBs of reserved stack and microsecond switches. **Green threads** and **async tasks** cost KBs and switch in ~100 ns.
- **M:N runtimes** (Go, Erlang, Java virtual threads, Tokio) make a million concurrent tasks practical, but you must **never block the carrier thread** and still need **backpressure**.
- Choose **processes for isolation**, **threads for CPU parallelism**, **green threads or async for massive I/O concurrency**, and combine them.

## References

1. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapters 4–5 (processes, process API) and 26–27 (concurrency, thread API).
2. Linux man pages. [clone(2)](https://man7.org/linux/man-pages/man2/clone.2.html), [pthreads(7)](https://man7.org/linux/man-pages/man7/pthreads.7.html).
3. OpenJDK. [JEP 444: Virtual Threads](https://openjdk.org/jeps/444) and [JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491).
4. Go docs. [Go 1.14 release notes](https://go.dev/doc/go1.14#runtime) (asynchronous preemption).
5. B. Nystrom. [What Color is Your Function?](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/) 2015.
6. The Chromium Projects. [Site Isolation](https://www.chromium.org/Home/chromium-security/site-isolation/).
7. Erlang docs. [Processes](https://www.erlang.org/doc/system/eff_guide_processes.html) (efficiency guide).
8. Python docs. [Free-threaded CPython](https://docs.python.org/3/howto/free-threading-python.html).

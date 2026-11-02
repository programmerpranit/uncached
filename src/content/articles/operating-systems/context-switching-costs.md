---
summary: What actually happens when the kernel switches from one thread to another, why the direct cost of a few microseconds is the smaller part of the bill, how to measure switching, and the techniques (event loops, user-space threads, thread-per-core, batching) that systems use to avoid it.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **context switch** is the kernel pausing one thread and resuming another on the same core: save registers, run the scheduler, maybe switch page tables, restore the other thread's registers. On modern hardware that **direct cost** is roughly **1–5 µs**. The bigger cost is **indirect**: the new thread starts with caches, TLB and branch predictors full of the old thread's state, and can run slower for tens of microseconds while it warms them back up. Switches come from **blocking** (voluntary) and **preemption** (involuntary). A few thousand per second per core is harmless. Hundreds of thousands, usually from too many threads or too many tiny blocking operations, waste significant CPU and add latency. That's why high-performance systems use **event loops**, **user-space threads** (goroutines, virtual threads, ~100–200 ns switches), **thread-per-core** designs and **batching**.

## The problem: more threads than cores

A machine runs far more threads than it has cores. The kernel creates the illusion that they all run at once by switching between them, typically every few milliseconds, and whenever a thread waits for something (I/O, a lock, a timer).

Each switch takes time away from useful work. The question is how much, and when it starts to matter.

## What happens in a switch

![Six steps: trap into kernel; save A's registers; scheduler picks B; switch address space; restore B's registers; return to user space. A side panel notes direct cost of about 1–3 µs and indirect costs from cold caches, TLB and branch predictors.](/figures/context-switch/steps.svg "The mechanical steps are cheap. The lost CPU state is not.")

1. **Enter the kernel.** Thread A makes a blocking system call (`read` on an empty socket, `futex` wait on a contended lock), or a timer interrupt arrives and the scheduler decides A's time slice is over.
2. **Save A's state.** General-purpose registers, the stack pointer, the instruction pointer and flags go onto A's kernel stack. The FPU/SIMD register state is saved too, which with AVX-512 is a few kilobytes.
3. **Pick the next thread.** The scheduler updates A's accounting and chooses B from the core's run queue.
4. **Switch address space** if B belongs to a different process: load B's page table root into CR3. With PCID tags, the TLB keeps entries for both processes. Without them, the TLB is flushed.
5. **Restore B's state** and switch to B's kernel stack.
6. **Return to user space**, where B continues from where it was paused.

**Voluntary** switches happen when a thread blocks. **Involuntary** switches happen when the scheduler preempts a thread that still wants to run. Linux reports both per thread in `/proc/<pid>/status` (`voluntary_ctxt_switches` and `nonvoluntary_ctxt_switches`).

## What it costs

![Log-scale bars: function call about 1 ns; system call about 100 ns; user-space coroutine switch about 100–200 ns; thread switch in the same process about 1–2 µs; process switch about 2–5 µs; switch plus cold cache refill about 10–100+ µs.](/figures/context-switch/costs.svg "Order-of-magnitude numbers. Exact values depend heavily on CPU, kernel and workload.")

### Direct cost

Microbenchmarks that ping-pong between two threads through a pipe or futex typically measure **1–3 µs per switch** on modern Linux, and a bit more between processes. The numbers shift with:

- **Security mitigations.** KPTI (Meltdown) and Spectre mitigations made kernel entry and exit more expensive in 2018.
- **Cross-core wakeups.** If B wakes on a different core, that core may be idle in a deep sleep state, which adds tens of microseconds of wakeup latency.
- **Virtualization.** In a VM, some operations involve the hypervisor.

### Indirect cost

When B starts running:

- Its data is **not in L1/L2 cache**, because A's data displaced it. Refilling from L3 or DRAM costs 10–100 ns per cache line.
- Its translations may be **missing from the TLB**, adding page walks.
- **Branch predictors** and prefetchers are trained on A's code.

Studies that measured this (for example Li, Ding and Shen, 2007) found the indirect cost can exceed the direct cost by an order of magnitude when the working set is large, reaching hundreds of microseconds in the worst case. A thread that runs for only a few microseconds between switches may spend most of its time warming caches.

## When switching hurts

![Illustrative chart: throughput on 8 cores rises linearly up to 8 threads, then slowly declines to about half at 1,024 threads.](/figures/context-switch/threads.svg "For CPU-bound work, more threads than cores means only more switching.")

Rules of thumb:

- **Under ~10,000 switches per second per core**, overhead is usually negligible: at 5 µs each, that's 5% of a core at most.
- **CPU-bound work** gains nothing from more threads than cores. Extra threads only time-share, and evict each other's cache lines.
- **Thread-per-connection** servers with tens of thousands of connections spend a lot of time switching and keep thousands of stacks in memory. That's the classic **C10K problem**.
- **Fine-grained hand-offs** between threads (a request passing through 5 thread pools) add several switches and wakeup latencies per request.
- **Lock contention** turns into switching: a contended mutex puts waiters to sleep (`futex` wait) and wakes them later, each a switch.

## Avoiding switches

![Five approaches: event loops with epoll or io_uring; user-space threads such as goroutines, Java virtual threads and async/await; thread-per-core; batching; busy polling.](/figures/context-switch/models.svg "Either switch less often, or switch somewhere cheaper than the kernel.")

- **Event loops.** One thread per core multiplexes thousands of non-blocking sockets with `epoll`, `kqueue` or `io_uring`. Nginx, Redis, Node.js and Netty work this way. Work is switched in user space by calling the next callback.
- **User-space (green) threads.** The runtime multiplexes many lightweight threads onto a few kernel threads, and switches between them in user space by saving a handful of registers: ~100–200 ns. Examples: goroutines, Java virtual threads (JDK 21), Erlang processes, and async/await in Rust, C# and Python. You write blocking-style code but pay coroutine switch costs.
- **Thread-per-core.** Pin one thread per core, partition data so threads don't share it, and pass messages instead of locking. ScyllaDB's Seastar framework and Glommio follow this design, nearly eliminating kernel switches and cross-core cache traffic.
- **Batching.** Do more work per kernel entry: `io_uring` submits many I/O operations at once, `recvmmsg`/`sendmmsg` move many packets per call, and bigger buffers reduce the number of reads.
- **Spinning before sleeping.** Adaptive mutexes spin briefly before blocking, since a wait shorter than a switch is cheaper to spin through. Kernel-bypass networking (DPDK) polls constantly and dedicates whole cores to it.
- **Pinning and isolation.** `taskset`, cgroup cpusets and `isolcpus` keep latency-critical threads on dedicated cores, so they're never preempted or migrated.

## Where it's used

| System | Approach to switching |
| --- | --- |
| **Nginx, HAProxy** | Event loop per worker process, one worker per core |
| **Redis** | Single-threaded event loop for commands (I/O threads optional) |
| **Go** | Goroutines scheduled in user space onto `GOMAXPROCS` OS threads |
| **Java 21+** | Virtual threads mounted on a small carrier thread pool |
| **ScyllaDB (Seastar)** | Thread-per-core, shared-nothing, user-space task scheduler |
| **DPDK / SPDK** | Polling on dedicated cores, no interrupts or blocking |
| **PostgreSQL** | Process per connection, so poolers like PgBouncer limit active backends |

### Use case walk-through: a thread pool that's too big

A Java service handles 20k requests per second on 16 cores with a 2,000-thread pool doing mostly blocking database calls. CPU is at 70%, but p99 latency is poor.

1. **Measure switching.** `pidstat -w -t -p <pid> 1` shows ~400k context switches per second, mostly voluntary, plus many involuntary ones.
2. **Estimate the cost.** At a few microseconds each, plus cache warm-up, a significant fraction of that 70% CPU is switching overhead, and threads wait in run queues behind each other, inflating tail latency.
3. **Look for contention.** `perf` shows many `futex` calls from a shared connection-pool lock, and each contended acquire puts a thread to sleep.
4. **Fix.** Move request handling to virtual threads, so blocking JDBC calls park a virtual thread instead of an OS thread. Cap database concurrency with a semaphore at roughly what the database can actually serve (64), and shard the contended pool.
5. **Result.** OS context switches drop by roughly 10×, CPU falls, and p99 improves because runnable work no longer queues behind hundreds of threads.

## Pitfalls

- **One thread per request or connection** at high concurrency: memory for stacks plus constant switching.
- **Sizing thread pools by guesswork.** For CPU-bound pools, use about the number of cores. For blocking pools, size by the concurrency the downstream can handle (Little's law), not by "more is safer".
- **Many hand-offs per request** across queues and pools, each adding a wakeup.
- **Ignoring involuntary switches.** A high `nonvoluntary_ctxt_switches` count means threads are being preempted: more runnable threads than cores, or noisy neighbors.
- **Blocking a carrier thread.** In async or green-thread runtimes, a blocking syscall or a long CPU loop on an event loop thread stalls every task scheduled on it.

> [!TIP]
> `perf stat -e context-switches,cpu-migrations -p <pid> -- sleep 10` gives a quick per-process switch rate, and `perf sched` can show scheduling latency: how long runnable threads waited for a core.

## Discussion questions

1. Why is a switch between threads of the same process cheaper than between processes?
2. Your service shows 200k context switches per second. How do you tell whether that's a problem?
3. Why do goroutine or virtual-thread switches cost ~100 ns while kernel switches cost microseconds?
4. When is spinning better than blocking, and when is it worse?
5. How does lock contention turn into context switches?
6. What are the trade-offs of thread-per-core designs compared with a shared thread pool?

## FAQ

### How many context switches per second is too many?

There's no single number. Compare switches to useful work: if a request causes 10 switches and each costs ~5 µs plus cache effects, that's 50+ µs of overhead per request. Tens of thousands per second per core usually deserve a look, especially if they're involuntary or accompanied by lock contention.

### Are system calls context switches?

No. A system call is a **mode switch**: the same thread moves from user mode to kernel mode and back, without saving and restoring the full thread state or running the scheduler. It costs on the order of 100 ns. It becomes a context switch only if the call blocks and the kernel runs another thread.

### Do interrupts cause context switches?

An interrupt borrows the current thread briefly to run the handler, which is not a full switch. But the handler often wakes a thread (a packet arrived, a disk read finished), and if that thread should preempt the current one, a context switch follows.

### Why does Go use OS threads at all if goroutines are cheaper?

Goroutines need somewhere to run: Go's scheduler multiplexes them onto OS threads (one per `GOMAXPROCS` core, plus extras for blocking syscalls). Switching between goroutines on the same thread is cheap. The kernel only switches the underlying OS threads.

### Does pinning threads to cores reduce switches?

Pinning reduces **migrations** (moving a thread to another core, which loses its warm cache) and, combined with isolating cores from other work, reduces **preemption**. It doesn't stop a thread from blocking.

## Key takeaways

- A context switch saves one thread's state and restores another's: **~1–5 µs direct cost**.
- The **indirect cost** (cold caches, TLB and predictors) is often larger than the direct cost.
- Switches come from **blocking** and **preemption**. Measure both with `pidstat -w`, `perf` or `/proc`.
- More threads than cores doesn't help **CPU-bound** work. For I/O-bound work, prefer **event loops** or **user-space threads** over huge thread pools.
- **Batching**, **thread-per-core** and **pinning** cut switches where latency matters most.

## References

1. C. Li, C. Ding, K. Shen. [Quantifying the Cost of Context Switch](https://www.usenix.org/legacy/events/expcs07/papers/2-li.pdf). *ExpCS 2007*.
2. E. Bendersky. [Measuring context switching and memory overheads for Linux threads](https://eli.thegreenplace.net/2018/measuring-context-switching-and-memory-overheads-for-linux-threads/). 2018.
3. D. Kegel. [The C10K problem](http://www.kegel.com/c10k.html).
4. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapter 6: [Limited Direct Execution](https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-mechanisms.pdf).
5. OpenJDK. [JEP 444: Virtual Threads](https://openjdk.org/jeps/444).
6. Seastar. [Shared-nothing design](https://seastar.io/shared-nothing/).
7. Linux man pages. [pidstat(1)](https://man7.org/linux/man-pages/man1/pidstat.1.html), [proc_pid_status(5)](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html), [perf-sched(1)](https://man7.org/linux/man-pages/man1/perf-sched.1.html).

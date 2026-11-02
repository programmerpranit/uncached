---
summary: What mutexes, semaphores and spinlocks actually do, how futexes make uncontended locking nearly free, when spinning beats sleeping, and how to deal with contention, priority inversion and the other ways locks go wrong.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** All three primitives coordinate threads around shared state, but they differ in **who may enter** and **what a waiting thread does**. A **mutex** lets one owner in at a time, and waiters **sleep**. A **semaphore** is a counter of **N permits**: it limits concurrency (a pool of 10 connections) or signals between threads, and any thread can release a permit. A **spinlock** lets one owner in, and waiters **busy-loop** instead of sleeping, which is only worth it when the lock is held for a very short time and the holder can't be preempted (mostly inside the kernel). Modern mutexes are built on **futexes**: an **uncontended** lock is a single atomic instruction in user space (~20 ns), and only **contended** locks call into the kernel to sleep and wake (microseconds). The real cost of locking is **contention**: threads queuing, cache lines bouncing between cores, and preemption while holding a lock. Shorter critical sections, sharding, read-mostly techniques, and lock-free structures are how systems scale.

## The problem: shared mutable state

When two threads update the same data, interleavings break invariants. `counter++` is a load, add and store, so two threads can both read 41 and both write 42. A balance check and debit can interleave with another debit. You need **mutual exclusion**: only one thread at a time runs a **critical section**.

Atomic instructions (compare-and-swap, fetch-and-add) solve this for single words. For anything bigger, such as a linked list, a map or several fields that must change together, you need a lock.

## The three primitives

![Three cards: mutex (one owner, owner unlocks, waiters sleep; for protecting shared data); semaphore (N permits, any thread can post, waiters sleep; for limiting concurrency and signaling); spinlock (one owner, never sleeps, waiters busy-loop; for tiny sections in the kernel and interrupt handlers).](/figures/locks/kinds.svg "The difference is in who may enter and what waiters do while they wait.")

### Mutex

- `lock()`: if free, take it. Otherwise wait (sleep) until it's free.
- `unlock()`: release it and wake a waiter. Only the **owner** may unlock.
- Ownership enables useful features: **recursive** mutexes (the owner can re-lock), **error checking** (unlocking a mutex you don't hold is a bug), **priority inheritance** (boost the owner when a higher-priority thread waits), and debugging (who holds it?).

Mutexes usually pair with **condition variables** to wait for a state change ("queue not empty"). Always wait in a loop that rechecks the condition, since wakeups can be spurious or the state can change again before you run.

### Semaphore

Dijkstra's original 1965 primitive: an integer counter with two operations.

- `wait()` (P, acquire): if the count is above zero, decrement it. Otherwise sleep until it is.
- `post()` (V, release): increment the count and wake a waiter.

Uses:

- **Limiting concurrency:** a semaphore with 10 permits lets at most 10 threads use a connection pool, or call a fragile downstream service, at once.
- **Signaling:** a semaphore starting at 0 lets one thread wait until another posts that something happened (a producer posts once per item, a consumer waits once per item).

A **binary semaphore** (count 0 or 1) looks like a mutex but has no owner: any thread can post. That's useful for signaling, but it means no priority inheritance and no detection of mistakes, so use a mutex for mutual exclusion.

### Spinlock

- `lock()`: loop on an atomic test-and-set until it succeeds.
- Waiters never sleep, so there's no context switch, but they burn a CPU the whole time.

Spinlocks make sense when the critical section is **tiny** (tens to hundreds of nanoseconds) and the holder is **guaranteed to be running**. Inside the Linux kernel, taking a spinlock disables preemption (and sometimes interrupts), so the holder can't be descheduled, and code that can't sleep (interrupt handlers) has no other option. Kernel spinlocks are **queued** (ticket locks, then MCS-based `qspinlock` since Linux 4.2), so waiters get the lock in order and each spins on its own cache line.

In **user space**, pure spinlocks are risky: the kernel can preempt the holder at any moment, and then every waiter spins for a whole time slice, getting nothing done. That's why a widely discussed 2020 benchmark of user-space spinlocks drew a sharp response from Linus Torvalds: spinlocks in user space are usually the wrong tool unless you control the scheduling.

## How a modern mutex works: futexes

![The lock() call tries a compare-and-swap of the state from 0 to 1. If it succeeds, the thread has the lock in about 20 ns. If not, it spins briefly, then calls futex_wait to sleep in the kernel. unlock() does an atomic store, and calls futex_wake only if there are waiters.](/figures/locks/futex.svg "The kernel is only involved when there's actual contention.")

Before 2002, Linux user-space locks either spun or always made system calls. **Futexes** ("fast user-space mutexes") split the work:

1. The lock state lives in an ordinary integer in user memory: 0 = unlocked, 1 = locked, 2 = locked with waiters.
2. **Fast path:** `lock()` does a compare-and-swap from 0 to 1. If it succeeds, done: no system call, roughly 20 ns.
3. **Slow path:** if the CAS fails, optionally spin briefly (adaptive mutex), then mark the lock as contended and call `futex(FUTEX_WAIT)`, which sleeps only if the word still has the expected value (avoiding lost wakeups).
4. `unlock()` sets the word to 0, and only if there were waiters calls `futex(FUTEX_WAKE)` to wake one.

glibc's `pthread_mutex`, Rust's `std::sync::Mutex`, C++ `std::mutex` on Linux, and Java's `LockSupport.park` all build on futexes. On Windows, `SRWLOCK` and `WaitOnAddress` play the same role, and macOS has `os_unfair_lock`.

The consequence: **uncontended locks are cheap**. Don't avoid locks for performance until profiling shows contention.

## Spin or sleep?

![Illustrative chart: the cost of spinning grows with hold time, while the cost of sleeping is a fixed few microseconds; they cross near the cost of a sleep and wakeup.](/figures/locks/spin-vs-sleep.svg "Spinning wins for very short holds, sleeping wins for anything longer.")

Waiting costs either CPU (spinning) or a sleep-and-wake cycle (a few microseconds of system calls and context switches, plus wakeup latency). The best choice depends on how long the lock will be held:

- **Shorter than a context switch:** spinning is cheaper.
- **Longer:** sleeping frees the CPU for other work.

Most mutexes are **adaptive**: they spin for a short, bounded time (often only while the owner is actually running on another CPU), then sleep. The Linux kernel's sleeping mutex does "optimistic spinning" while the owner is on a CPU, and glibc offers `PTHREAD_MUTEX_ADAPTIVE_NP`.

## Contention: the real cost

![Illustrative chart: throughput with one global lock stays flat or falls as threads increase, while 64 striped locks scale almost linearly.](/figures/locks/contention.svg "A single hot lock serializes everything, and its cache line bounces between cores.")

Under contention, a lock costs much more than its instructions:

- **Serialization:** only one thread makes progress in the critical section, so Amdahl's law caps the speedup.
- **Cache-line bouncing:** every acquisition moves the lock's cache line (and often the protected data) to the acquiring core, ~50–100+ ns per transfer, more across sockets.
- **Sleeping and waking:** each blocked waiter costs a context switch and wakeup latency.
- **Lock convoys:** if the holder is preempted, everyone queues behind a thread that isn't even running.

Ways to reduce contention:

- **Shrink critical sections.** Do work (allocation, I/O, computation) outside the lock, and hold it only to publish results.
- **Shard (stripe) the state.** One lock per bucket or per shard instead of one global lock. Java's `ConcurrentHashMap` and per-CPU counters follow this pattern.
- **Read-mostly techniques.** **Reader-writer locks** allow many readers at once (but writers can starve, and the reader count itself bounces). **RCU** lets readers proceed without any locks or writes, and **seqlocks** let readers retry if a write happened.
- **Lock-free and wait-free structures** built on atomics, for hot spots where they're worth the complexity.
- **Avoid sharing:** give each thread its own data and merge results, or use message passing.

## Priority inversion and fairness

- **Priority inversion:** a high-priority thread waits for a lock held by a low-priority thread, which is preempted by medium-priority threads, so the high-priority thread effectively waits on medium-priority work. **Priority inheritance** (`PTHREAD_PRIO_INHERIT`, the Linux kernel's `rt_mutex`) temporarily boosts the holder.
- **Fairness vs throughput:** strictly FIFO (fair) locks avoid starvation but hurt throughput, because the lock is handed to a sleeping thread that must wake up first, while a running thread could have taken it immediately. Most locks are unfair by default, with protections: Go's `sync.Mutex` switches to a FIFO **starvation mode** when a waiter has waited more than 1 ms.

## Where it's used

| Primitive | Common uses |
| --- | --- |
| **Mutex** | Protecting shared data structures, caches, in-memory state |
| **Reader-writer lock** | Read-heavy configuration, routing tables, caches |
| **Semaphore** | Connection pools, rate-limiting concurrent calls, producer/consumer signaling |
| **Spinlock** | Linux kernel data structures, interrupt handlers, per-CPU data |
| **RCU** | Linux kernel read-mostly data (routing tables, module lists), user-space via liburcu |
| **Condition variable** | Blocking queues, waiting for state changes |

### Use case walk-through: a slow in-memory cache

A Go service with a `map` guarded by a single `sync.Mutex` serves 200k requests per second on 32 cores. Adding cores doesn't help, and p99 latency is high.

1. **Profile contention.** Go's mutex profiler (`runtime.SetMutexProfileFraction`, then `pprof -mutex`) shows most delay in the cache lock. The block profile confirms goroutines waiting on it.
2. **Shrink the critical section.** The code computed the value (a JSON encode) while holding the lock. Move the encoding outside, and lock only to read or insert.
3. **Use a reader-writer lock?** The cache is 98% reads, so `sync.RWMutex` helps, but the shared reader count still bounces between 32 cores.
4. **Shard instead.** Split into 64 shards by key hash, each with its own lock. Contention per lock drops ~64×.
5. **Limit downstream concurrency** with a semaphore (a buffered channel of 50 tokens) around cache misses, so a cold cache doesn't overwhelm the database.
6. **Result:** throughput scales with cores again, and p99 drops because goroutines rarely wait.

## Pitfalls

- **Holding a lock during I/O or calls to unknown code.** Critical sections become long and deadlock-prone.
- **User-space spinlocks** without control over scheduling: a preempted holder makes everyone spin.
- **Using a semaphore as a mutex.** No ownership means no priority inheritance and no misuse detection.
- **Forgetting to unlock on error paths.** Use RAII guards, `defer`, `with` or `try/finally`.
- **Waiting on a condition variable without a loop** that rechecks the predicate.
- **False sharing:** two independent locks or counters on the same cache line contend as if they were one. Pad hot fields to separate cache lines.
- **Reader-writer locks for short read sections:** the bookkeeping can cost more than a plain mutex.

> [!TIP]
> Measure contention before optimizing: `perf lock` on Linux, Go's mutex and block profiles, Java Flight Recorder's "Java Monitor Blocked" events, or `bpftrace` on futex wait times. A lock that is rarely contended isn't worth replacing.

## Discussion questions

1. Why is an uncontended futex-based mutex so much cheaper than a contended one?
2. When is a spinlock better than a mutex, and why is that rarely true in user space?
3. How would you use a semaphore to cap concurrent requests to a downstream service?
4. Why can adding threads to a program with one hot lock make it slower?
5. What is priority inversion, and how does priority inheritance fix it?
6. Why do most mutexes choose throughput over strict fairness?

## FAQ

### Is a binary semaphore the same as a mutex?

Functionally similar for mutual exclusion, but a mutex has an **owner** and a semaphore doesn't. Ownership allows priority inheritance, recursive locking, and error checking. Use mutexes to protect data, and semaphores to count resources or signal events.

### What's the difference between a mutex and a monitor?

A **monitor** is a higher-level construct: an object whose methods run under a single mutex, with condition variables to wait inside. Java's `synchronized` blocks and `wait`/`notify` implement monitors.

### Should I use a reader-writer lock whenever reads dominate?

Not automatically. RW locks pay off when read sections are long enough to amortize their bookkeeping and many readers actually overlap. For very short reads on many cores, sharded mutexes, RCU-style techniques or copy-on-write snapshots often perform better.

### Are atomics always faster than locks?

Uncontended, an atomic increment and an uncontended lock are both cheap. Under heavy contention, both suffer from cache-line bouncing. Atomics avoid sleeping and lock-holder preemption, but complex lock-free algorithms are hard to get right. Use them for simple counters and flags, or through well-tested libraries.

### Why do some languages have a GIL instead of fine-grained locks?

A global interpreter lock (CPython, Ruby MRI) makes the interpreter's internals simple and single-threaded code fast, at the cost of parallelism for CPU-bound threads. CPython 3.13 added an experimental free-threaded build that replaces the GIL with finer-grained locking and other techniques.

## Key takeaways

- **Mutex:** one owner, waiters sleep. **Semaphore:** N permits, any thread can release. **Spinlock:** one owner, waiters busy-wait.
- **Futexes** make uncontended locks a single atomic operation. Only **contention** involves the kernel.
- **Spin** only when holds are shorter than a context switch and the holder can't be preempted. Most mutexes spin briefly, then sleep.
- Contention costs serialization, cache-line bouncing and wakeups. Fix it by **shrinking critical sections, sharding, read-mostly techniques**.
- Watch for **priority inversion**, **false sharing** and **locks held across I/O**.

## References

1. E. W. Dijkstra. [Cooperating Sequential Processes](https://www.cs.utexas.edu/~EWD/transcriptions/EWD01xx/EWD123.html) (EWD 123). 1965.
2. H. Franke, R. Russell, M. Kirkwood. [Fuss, Futexes and Furwocks: Fast Userlevel Locking in Linux](https://www.kernel.org/doc/ols/2002/ols2002-pages-479-495.pdf). *Ottawa Linux Symposium 2002*.
3. U. Drepper. [Futexes Are Tricky](https://www.akkadia.org/drepper/futex.pdf). 2011.
4. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapters 28–31 (locks, condition variables, semaphores).
5. Linux kernel docs. [Lock types and their rules](https://docs.kernel.org/locking/locktypes.html) and [Generic Mutex Subsystem](https://docs.kernel.org/locking/mutex-design.html).
6. M. Herlihy, N. Shavit. *The Art of Multiprocessor Programming*. Morgan Kaufmann, 2nd ed., 2020.
7. P. McKenney. [Is Parallel Programming Hard, And, If So, What Can You Do About It?](https://www.kernel.org/pub/linux/kernel/people/paulmck/perfbook/perfbook.html)
8. Go source. [sync.Mutex fairness and starvation mode](https://cs.opensource.google/go/go/+/refs/tags/go1.22.0:src/sync/mutex.go).

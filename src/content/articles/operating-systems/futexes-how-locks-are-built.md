---
summary: How Linux futexes split locking between user space and the kernel, how a three-state mutex, condition variables and one-time initialization are built on them, why lost wakeups can't happen, and what PI, robust and multi-wait futexes add.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **futex** ("fast user-space mutex") is not a lock. It's a kernel facility for **sleeping and waking threads based on a 32-bit word in user memory**. The two core operations are **`FUTEX_WAIT(addr, expected)`**, which atomically checks that `*addr == expected` and puts the thread to sleep (or returns immediately if the value changed), and **`FUTEX_WAKE(addr, n)`**, which wakes up to `n` threads sleeping on that address. Everything else (the lock protocol, spinning, fairness) lives in **user space**, built from atomic instructions. A classic **three-state mutex** (0 unlocked, 1 locked, 2 locked with possible waiters) locks and unlocks with one atomic instruction each when uncontended (~20 ns, no system call), and only calls the kernel when threads actually need to sleep or be woken. The atomic check-and-sleep makes **lost wakeups impossible**. Nearly all Linux user-space synchronization (glibc's pthread mutexes, condition variables, rwlocks, semaphores, `pthread_once`, thread join, C++ and Rust standard locks, and the Go and Java runtimes' parking) is built on futexes. Variants add **priority inheritance** (PI futexes), recovery when a lock holder dies (**robust futexes**), and waiting on several futexes at once (**`futex_waitv`**).

## The problem: locks need both speed and sleeping

A lock must make waiting threads **sleep** (spinning forever wastes CPU), and sleeping requires the kernel. But most lock operations are **uncontended**: the lock is free, you take it, you release it. Entering the kernel for those, at hundreds of nanoseconds per system call, would make locking far too expensive.

Before futexes (Linux 2.5, 2002), Linux user-space locks either always made system calls (System V semaphores) or spun. Futexes split the work: user space handles the fast path with atomics, and the kernel is involved only when a thread must actually wait.

## The futex API

![FUTEX_WAIT atomically sleeps if the word still equals the expected value; FUTEX_WAKE wakes up to n waiters. Inside the kernel, addresses hash to buckets holding queues of sleeping threads.](/figures/futex/api.svg "The kernel keeps no per-lock state: only a queue of sleepers, created when someone waits.")

```
futex(&word, FUTEX_WAIT, expected, timeout)   // sleep if word == expected
futex(&word, FUTEX_WAKE, n)                   // wake up to n sleepers on &word
```

- The kernel **hashes the address** to a bucket, a queue of waiters protected by a spinlock. There's no kernel object per lock, and when nobody waits there's no kernel state at all.
- `FUTEX_WAIT` takes the bucket lock, **reads the word**, and only if it still equals `expected` enqueues the thread and sleeps. If it changed, it returns `EAGAIN` immediately.
- `FUTEX_WAKE` takes the bucket lock and wakes up to `n` waiters on that address.
- `FUTEX_PRIVATE_FLAG` marks futexes used within one process, so the kernel can key on the virtual address alone (faster). Shared futexes in shared memory are keyed on the underlying page.

### Why there are no lost wakeups

The classic race: thread A sees the lock taken and decides to sleep. Before it sleeps, thread B releases the lock and sends a wakeup, which finds nobody waiting. Then A sleeps forever.

With futexes, A passes the value it saw (`expected`). B changes the word **before** calling `FUTEX_WAKE`. Either A's `FUTEX_WAIT` runs before B's change, so A is already queued when B's wake arrives, or it runs after, so the kernel sees the word no longer equals `expected` and A doesn't sleep. The check and the enqueue are atomic with respect to wakes, under the bucket lock.

## Building a mutex

![States: 0 unlocked, 1 locked, 2 contended. lock fast path is a CAS from 0 to 1; slow path sets 2 and futex_waits; unlock exchanges to 0 and calls futex_wake only if the old value was 2.](/figures/futex/mutex.svg "The third state tells unlock whether anybody might be sleeping.")

Ulrich Drepper's paper *Futexes Are Tricky* walks through mutex designs, the first ones subtly wrong. The standard correct one uses three states:

- **0**: unlocked.
- **1**: locked, no waiters.
- **2**: locked, and there may be waiters.

```
lock():
  if CAS(&w, 0, 1) succeeds: return            // fast path
  c = exchange(&w, 2)                          // mark contended
  while c != 0:
      futex_wait(&w, 2)                        // sleep while it's 2
      c = exchange(&w, 2)
unlock():
  if exchange(&w, 0) == 2: futex_wake(&w, 1)   // wake one waiter if needed
```

- **Uncontended:** one compare-and-swap to lock, one exchange to unlock, and no system calls.
- **Contended:** waiters set the state to 2 and sleep. Unlock sees 2 and wakes one.
- A woken thread sets the state to 2 again (it can't know whether others still wait), so the last unlock may make one unnecessary wake call: a small price for correctness.

Real implementations add **adaptive spinning** (try the CAS a few times before sleeping, since the holder may be about to release), and different **fairness** policies. glibc's `pthread_mutex`, Rust's standard `Mutex` (futex-based on Linux since Rust 1.62), and C++ standard library mutexes all follow this pattern.

## What else gets built on futexes

![Mutexes, condition variables, rwlocks, semaphores and barriers, one-time initialization, thread join, PI futexes, robust futexes and futex_waitv.](/figures/futex/built-on.svg "Nearly all user-space blocking on Linux ends in a futex system call.")

- **Condition variables:** waiters read a sequence counter, release the mutex, and `FUTEX_WAIT` on the counter. `signal`/`broadcast` increment it and wake. `FUTEX_CMP_REQUEUE` lets a broadcast move waiters from the condvar to the mutex's queue instead of waking them all to fight over the mutex (a thundering herd). glibc rewrote its condvar implementation in 2016 to fix ordering bugs, which shows how subtle this is.
- **Reader-writer locks, semaphores, barriers, latches:** counters plus futex waits.
- **One-time initialization** (`pthread_once`, `std::call_once`, Rust's `Once`): a state word, where late arrivals wait on a futex until initialization finishes.
- **Thread join:** when a thread exits, the kernel clears its thread ID word (registered with `CLONE_CHILD_CLEARTID`) and does a futex wake on it, waking `pthread_join` waiters.
- **Language runtimes:** the Go runtime parks OS threads with futexes, and the JVM's park/unpark ends up in futex calls on Linux.

### Special futexes

- **PI futexes** (`FUTEX_LOCK_PI`, `FUTEX_UNLOCK_PI`): the word holds the owner's **thread ID**, so the kernel knows who owns the lock and can apply **priority inheritance** when a higher-priority thread waits. Used by `PTHREAD_PRIO_INHERIT` mutexes.
- **Robust futexes:** each thread registers a list of locks it holds (`set_robust_list`). If it dies while holding one, the kernel sets an **owner-died** bit and wakes a waiter, which gets `EOWNERDEAD` and can repair the shared state. Essential for locks in shared memory between processes.
- **`futex_waitv`** (Linux 5.16): wait on several futexes at once. It was added for Wine and Valve's Proton, to emulate Windows' `WaitForMultipleObjects` efficiently for games.
- Newer **futex2** system calls (Linux 6.7+) add separate `futex_wait`/`futex_wake` calls with sizes other than 32 bits and NUMA awareness.

## Where it's used

| Component | Futex usage |
| --- | --- |
| **glibc NPTL** | Mutexes, condvars, rwlocks, semaphores, barriers, once, join |
| **Rust std** | `Mutex`, `RwLock`, `Condvar`, `Once` built directly on futexes (Linux) |
| **Go runtime** | Sleeping and waking Ms (OS threads) |
| **JVM** | Park/unpark under `LockSupport` and monitors |
| **Wine / Proton** | `futex_waitv` for Windows multi-object waits |
| **Shared-memory databases** | Robust futexes for locks shared between processes |

### Use case walk-through: high system time from a "lock-free" queue

A service's profile shows 20% CPU in the kernel, mostly in `futex` system calls, though the team believes its work queue is lock-free.

1. **Trace.** `perf trace -s` shows millions of `futex` calls per second. `perf record -g` attributes them to a condition variable used by consumers to sleep when the queue is empty.
2. **Cause.** The producer calls `notify_one()` after **every** push, and consumers sleep and wake for almost every item. Each wake is a futex syscall plus a context switch.
3. **Fix.** Track whether any consumer is sleeping (an atomic counter), and only notify when one is. Have consumers spin briefly on the queue before sleeping, and process items in batches.
4. **Result.** Futex calls drop by ~95%, kernel time falls to a few percent, and latency improves because consumers rarely sleep under load.

## Pitfalls

- **Writing your own futex-based locks** for production. The protocols are subtle (Drepper's paper shows two broken attempts before a correct one). Use your standard library.
- **Notifying condition variables on every event** when nobody is waiting.
- **Forgetting to recheck the condition** after a condvar wait (spurious wakeups, stolen wakeups).
- **Locks in shared memory without robust futexes**: if a process dies holding the lock, every other process hangs.
- **Using `FUTEX_PRIVATE` for locks in memory shared between processes**: waiters and wakers key on different values and never meet.
- **Mistaking futex time for lock overhead**: lots of futex calls mean **contention** or sleep/wake churn, not slow uncontended locking.

> [!TIP]
> `strace -f -e trace=futex -p <pid>` shows futex traffic (often a lot). For aggregate views, `perf trace -s -p <pid>` counts futex calls and time, and `perf lock contention` (newer kernels) attributes waits to specific locks.

## Discussion questions

1. Why does `FUTEX_WAIT` take an expected value, and what race does that prevent?
2. In the three-state mutex, why does a woken waiter set the state to 2 rather than 1?
3. How does `FUTEX_CMP_REQUEUE` avoid a thundering herd on `pthread_cond_broadcast`?
4. Why do PI futexes store the owner's thread ID in the futex word?
5. What problem do robust futexes solve for multi-process shared memory?
6. Why did gaming on Linux need `futex_waitv`?

## FAQ

### Is a futex a lock?

No. It's a wait queue keyed by an address, with an atomic "sleep only if the value is still X" check. Locks, condition variables and semaphores are user-space protocols that use futexes to sleep and wake.

### Do futexes exist on other operating systems?

The idea does: Windows has `WaitOnAddress`/`WakeByAddressSingle`, macOS has `__ulock_wait`/`__ulock_wake` (used under `os_unfair_lock`), FreeBSD has `_umtx_op`, and OpenBSD has `futex(2)`. C++20's `std::atomic::wait`/`notify` exposes the same idea portably.

### Why is the futex word 32 bits?

That's what the original API supported on all architectures, and it's enough for lock states and sequence counters. The newer futex2 interface adds 8-, 16- and 64-bit sizes.

### Why are my threads spending time in futex_wait in a profile?

Sleeping threads show up there: idle worker threads waiting for work, threads blocked on contended locks, or condition variables waiting for events. Idle waiting is normal. What matters is whether useful work is waiting on contended locks.

### How do futexes interact with the scheduler?

`FUTEX_WAIT` blocks the thread like any other sleep, and `FUTEX_WAKE` makes it runnable. The scheduler then decides when it runs. Wake-up latency (often microseconds, more if the target core is in a deep idle state) is part of what makes contended locks expensive.

## Key takeaways

- A **futex** is a kernel **wait queue keyed by a user-memory address**, with atomic **check-and-sleep** (`FUTEX_WAIT`) and **wake** (`FUTEX_WAKE`).
- Locks are **user-space protocols**: the **three-state mutex** takes and releases an uncontended lock with single atomic instructions.
- The expected-value check makes **lost wakeups impossible**.
- Mutexes, **condition variables**, rwlocks, semaphores, once, **thread join** and runtime parking all build on futexes.
- **PI**, **robust** and **multi-wait** futexes add priority inheritance, owner-death recovery and Windows-style waits.

## References

1. H. Franke, R. Russell, M. Kirkwood. [Fuss, Futexes and Furwocks: Fast Userlevel Locking in Linux](https://www.kernel.org/doc/ols/2002/ols2002-pages-479-495.pdf). *Ottawa Linux Symposium 2002*.
2. U. Drepper. [Futexes Are Tricky](https://www.akkadia.org/drepper/futex.pdf). 2011.
3. Linux man pages. [futex(2)](https://man7.org/linux/man-pages/man2/futex.2.html), [futex(7)](https://man7.org/linux/man-pages/man7/futex.7.html), [set_robust_list(2)](https://man7.org/linux/man-pages/man2/set_robust_list.2.html).
4. Linux kernel docs. [Robust futexes](https://docs.kernel.org/locking/robust-futexes.html) and [PI-futex](https://docs.kernel.org/locking/pi-futex.html).
5. Linux kernel docs. [futex2](https://docs.kernel.org/userspace-api/futex2.html).
6. M. Bos. [Rust Atomics and Locks](https://marabos.nl/atomics/), chapters 8–9 (operating system primitives, building locks). O'Reilly, 2023.
7. J. Corbet. [A futex overview and update](https://lwn.net/Articles/360699/). *LWN*, 2009.

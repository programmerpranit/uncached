---
summary: Why deadlocks happen, the four conditions that must all hold, and the practical ways to prevent, avoid, detect and recover from them in threads, databases, thread pools and async code.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **deadlock** is a set of threads (or transactions, or processes) where each waits for a resource held by another, so none can ever proceed. Coffman and colleagues showed in 1971 that deadlock requires **four conditions at once**: **mutual exclusion**, **hold and wait**, **no preemption** and **circular wait**. Break any one and deadlock is impossible. In practice, programs break **circular wait** by acquiring locks in a **consistent global order**, break **hold and wait** by acquiring everything at once, and break **no preemption** with **try-lock and timeouts**. Databases take a different route: they let deadlocks happen, **detect** cycles in the wait-for graph, and **abort a victim** transaction, which the application must retry. Watch out for deadlocks without explicit locks too: thread pools waiting on their own tasks, async code blocking an event loop, and processes waiting on each other through pipes.

## The problem: everyone waiting, forever

![Thread 1 holds lock A and waits for lock B; thread 2 holds lock B and waits for lock A.](/figures/deadlocks/cycle.svg "The textbook case: two threads take the same two locks in opposite order.")

Take a bank transfer that locks both accounts:

```
transfer(from, to):  lock(from); lock(to); move money; unlock both
```

Thread 1 runs `transfer(a, b)` and thread 2 runs `transfer(b, a)` at the same moment. Thread 1 locks `a`, thread 2 locks `b`, then each waits for the other's lock. Neither will ever release, because each is waiting to finish. The program doesn't crash: it just stops making progress, often with 0% CPU usage, which can make it hard to notice.

Deadlocks are timing-dependent. This code can pass every test and run for months, then hang under production load when two transfers happen to interleave.

## The four conditions

![Table of the four Coffman conditions with a way to break each: mutual exclusion (lock-free or per-thread data), hold and wait (acquire all at once), no preemption (try-lock with timeout), circular wait (global lock ordering).](/figures/deadlocks/conditions.svg "All four are necessary. Prevention means guaranteeing at least one never holds.")

1. **Mutual exclusion.** A resource can be held by only one thread at a time.
2. **Hold and wait.** A thread holds at least one resource while waiting for another.
3. **No preemption.** A resource can't be forcibly taken away. The holder must release it voluntarily.
4. **Circular wait.** There is a cycle of threads, each waiting for a resource held by the next.

Model the system as a **wait-for graph**: an edge from T1 to T2 means T1 is waiting for something T2 holds. With single-instance resources like locks, **a deadlock exists exactly when the graph has a cycle**.

## Four strategies

### 1. Prevention: make a condition impossible

**Break circular wait with lock ordering.** This is the most common and practical technique. Define a total order over locks and always acquire them in that order.

![transfer sorts the two accounts by id and locks the lower id first, so both transfers lock id 17 before id 42.](/figures/deadlocks/ordering.svg "Whoever loses the race for the first lock waits while holding nothing, so no cycle can form.")

- For instances of the same type, order by a **stable key**: account id, or memory address as a last resort.
- For different kinds of locks, assign **levels** (for example, "connection lock before session lock before buffer lock") and document them.
- Enforce the order with tools: Linux's **lockdep** records every lock acquisition order it sees and warns when a new order could form a cycle, even if the deadlock never actually happened. Abseil's `Mutex` has similar debug-mode detection, and thread sanitizers report lock-order inversions.

**Break hold and wait.** Acquire all needed locks at once, or none. C++'s `std::scoped_lock(m1, m2)` (and `std::lock`) locks multiple mutexes with a deadlock-avoidance algorithm, backing off and retrying rather than holding one while blocking on another. Alternatively, **never call out** (to callbacks, other modules, or I/O) while holding a lock.

**Break no preemption.** Use `try_lock` or a lock with a timeout. If you can't get the second lock, release the first, back off (with jitter) and retry. This avoids deadlock but can cause **livelock**: threads repeatedly backing off and retrying in lockstep without progress.

**Break mutual exclusion.** Avoid sharing mutable state: use immutable data, per-thread data, message passing, or lock-free data structures. Not always possible, but often the cleanest design.

### 2. Avoidance: refuse unsafe requests

The **Banker's algorithm** (Dijkstra) grants a resource only if the system stays in a "safe state", where some order exists in which every process can finish. It requires knowing each process's maximum needs in advance, so it's rare outside textbooks and some embedded or resource-allocation systems.

### 3. Detection and recovery

Let deadlocks happen, find cycles, and break them by aborting something. This is what **databases** do, because transactions lock rows in unpredictable order and can always be rolled back.

![Transaction T1 locks row 1, T2 locks row 2, T1 waits for row 2, T2 waits for row 1; the database detects the cycle and aborts T2 so T1 proceeds.](/figures/deadlocks/database.svg "Rollback makes preemption safe, so databases detect cycles rather than prevent them.")

- **PostgreSQL** checks for a cycle when a lock wait exceeds `deadlock_timeout` (1 second by default) and aborts one transaction with error `40P01`.
- **MySQL InnoDB** checks on each lock wait (`innodb_deadlock_detect`, on by default) and rolls back the transaction that's cheapest to undo, with error `1213`.
- **The JVM** can find deadlocked threads on demand (`jstack` prints "Found one Java-level deadlock", and `ThreadMXBean.findDeadlockedThreads()` returns them), though it can't recover automatically.
- **Go's runtime** detects the special case where every goroutine is blocked ("fatal error: all goroutines are asleep - deadlock!"), but not partial deadlocks.

### 4. Ignore it

The "ostrich algorithm": most operating systems don't try to prevent deadlocks between user processes, because the checks would cost more than the rare deadlock. Applications are responsible for their own locking.

## Deadlocks without obvious locks

- **Thread pool starvation.** A task running on a bounded pool submits a subtask to the same pool and blocks waiting for it. With all workers doing this, no worker is free to run the subtasks. Common with nested `CompletableFuture.get()` or `Future.result()` calls on a fixed-size pool.
- **Async code blocking the event loop.** In a single-threaded context, synchronously waiting for an async result (`.Result` or `.Wait()` on a Task in old ASP.NET, `run_until_complete` inside a running loop) blocks the very thread that would complete it.
- **Pipes and buffers.** A parent writes a large input to a child's stdin and only then reads its stdout, while the child blocks writing to a full stdout pipe. Each waits for the other. Python's `subprocess.communicate()` exists to avoid this.
- **Distributed locks.** Services holding locks in a lock service or database and calling each other can form cycles across machines. Leases with timeouts act as preemption.
- **Database plus application locks.** A thread holding an in-process mutex waits for a row lock, while a transaction holding that row waits for the mutex. Neither the database nor the runtime sees the full cycle.

## Related hazards

- **Livelock.** Threads keep changing state in response to each other without progress, like two people stepping aside in a corridor in the same direction. Randomized backoff fixes it.
- **Starvation.** One thread never gets the resource because others always win. Fair locks and aging help.
- **Priority inversion.** A high-priority task waits for a lock held by a low-priority task, which is preempted by medium-priority tasks. The 1997 Mars Pathfinder lander kept resetting because of this, until engineers enabled **priority inheritance** on the mutex remotely.

## Where it's used

| System | Deadlock strategy |
| --- | --- |
| **Linux kernel** | Lock ordering, checked by lockdep in debug builds |
| **PostgreSQL / MySQL** | Wait-for graph detection, abort a victim |
| **C++ `std::scoped_lock`** | Acquire multiple mutexes together with a deadlock-avoidance algorithm |
| **Java** | `tryLock(timeout)` in `ReentrantLock`; detection via `ThreadMXBean` |
| **Go** | Detects global deadlock only. Channels encourage message passing |
| **Distributed lock services** (etcd, ZooKeeper) | Leases and session timeouts release locks of dead or stuck holders |

### Use case walk-through: the hung payment service

A payment service hangs a few times a week. CPU drops to zero, and requests time out.

1. **Capture thread dumps** while it's hung: `jstack <pid>` (or `kill -3`). It reports a Java-level deadlock: thread A holds `ledgerLock` and waits on `accountLock`, while thread B holds `accountLock` and waits on `ledgerLock`.
2. **Find the paths.** `postTransfer()` locks ledger then account. A newer `refund()` method locks account then ledger.
3. **Fix the order.** Document "ledger before account", and change `refund()` to match. Better still, restructure so neither method calls out while holding a lock.
4. **Guard against regressions.** Add a debug wrapper around the locks that records each thread's acquisition order and fails tests on an inversion (the lockdep approach). Add a watchdog that runs deadlock detection every minute and alerts.
5. **Database side.** The service also sees occasional Postgres `40P01` errors. Sorting the account ids before updating rows in a transaction removes most of them, and a retry wrapper handles the rest.

## Pitfalls

- **Inconsistent lock order across code paths**, especially when a new feature takes existing locks in a new order.
- **Calling unknown code while holding a lock**: callbacks, listeners, logging that takes its own locks, virtual methods.
- **Non-reentrant locks re-entered** by the same thread: a self-deadlock.
- **Not retrying database transactions** that were aborted as deadlock victims.
- **Blocking on futures inside a bounded pool** that runs those futures.
- **Timeouts that hide deadlocks.** A lock timeout turns a hang into an error, but if you retry immediately without backoff, you may livelock.

> [!TIP]
> When a process hangs with idle CPU, take a thread dump first: `jstack` for Java, `py-spy dump` for Python, `gdb -p <pid>` then `thread apply all bt` for native code, or `SIGQUIT` for Go. A deadlock shows up as threads blocked on locks held by each other.

## Discussion questions

1. Why is breaking circular wait usually more practical than breaking mutual exclusion or hold and wait?
2. How would you order locks for objects that have no natural id?
3. Why can databases use detection and recovery, while most application code can't?
4. How does a try-lock with backoff avoid deadlock, and what new problem can it introduce?
5. Describe how a fixed-size thread pool can deadlock without any locks in your code.
6. How did priority inheritance fix the Mars Pathfinder resets?

## FAQ

### What's the difference between a deadlock and a livelock?

In a deadlock, threads are **blocked** and do nothing. In a livelock, threads are **active**, repeatedly reacting to each other (backing off, retrying), but make no progress. Both stop the work, but a livelock burns CPU.

### Can a single thread deadlock?

Yes: by trying to acquire a non-reentrant lock it already holds, or by waiting synchronously for a task that must run on the same thread (blocking an event loop on its own future).

### Do lock-free data structures eliminate deadlocks?

They eliminate deadlocks from locks, because no thread ever blocks holding something. But they're hard to write correctly, and a system that uses them can still deadlock elsewhere (pools, I/O, databases).

### How do I make database deadlocks rarer?

Access rows and tables in a consistent order, keep transactions short, avoid user interaction or network calls inside a transaction, use appropriate indexes (so updates lock fewer rows), and always wrap transactions in a retry loop for deadlock and serialization errors.

### Does Rust prevent deadlocks?

No. Rust's ownership rules prevent **data races** at compile time, but two threads can still lock two `Mutex`es in opposite orders and deadlock.

## Key takeaways

- Deadlock needs **mutual exclusion, hold and wait, no preemption and circular wait**. Break one.
- **Consistent lock ordering** is the standard prevention. Enforce it with tools like **lockdep**.
- **Try-lock with timeout and backoff** avoids deadlock but risks **livelock**.
- **Databases detect cycles and abort a victim**, so applications must **retry** transactions.
- Deadlocks also come from **thread pools, event loops, pipes and distributed locks**, not just mutexes.

## References

1. E. G. Coffman, M. Elphick, A. Shoshani. [System Deadlocks](https://dl.acm.org/doi/10.1145/356586.356588). *ACM Computing Surveys*, 1971.
2. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapter 32: [Common Concurrency Problems](https://pages.cs.wisc.edu/~remzi/OSTEP/threads-bugs.pdf).
3. PostgreSQL docs. [Explicit Locking: Deadlocks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-DEADLOCKS).
4. MySQL docs. [Deadlocks in InnoDB](https://dev.mysql.com/doc/refman/8.0/en/innodb-deadlocks.html).
5. Linux kernel docs. [Runtime locking correctness validator (lockdep)](https://docs.kernel.org/locking/lockdep-design.html).
6. G. Reeves. [What really happened on Mars?](https://www.cs.cornell.edu/courses/cs614/1999sp/papers/pathfinder.html) (Mars Pathfinder priority inversion). 1997.
7. cppreference. [std::scoped_lock](https://en.cppreference.com/w/cpp/thread/scoped_lock).
8. S. Lu, S. Park, E. Seo, Y. Zhou. [Learning from Mistakes: A Comprehensive Study on Real World Concurrency Bug Characteristics](https://people.cs.uchicago.edu/~shanlu/paper/asplos122-lu.pdf). *ASPLOS 2008*.

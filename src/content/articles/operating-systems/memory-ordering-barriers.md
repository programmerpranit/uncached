---
summary: Why compilers and CPUs reorder memory operations, what store buffers and weak memory models do to concurrent code, how acquire/release and fences restore order, and how to write correct lock-free code (or avoid having to).
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Inside one thread, everything appears to happen in program order. Across threads, it doesn't. **Compilers** reorder, merge and hoist memory accesses, and **CPUs** let loads and stores complete out of order, buffering stores in **store buffers**. On **x86** (a strong, "TSO" model), the only visible reordering is a later load passing an earlier store. On **ARM, POWER and RISC-V** (weak models), almost any reordering between independent accesses is possible. Correct concurrent code doesn't reason about hardware directly: it uses the **language memory model** (C++, Rust, Java, Go) and **atomics** with **memory orders**. **Release** stores and **acquire** loads publish data safely from one thread to another. **Sequentially consistent** (seq_cst) atomics, the default, give one global order at a small cost. **Fences** (barriers) order surrounding accesses explicitly. Locks and channels already include the right barriers, which is why most code never needs to think about this, and why hand-rolled lock-free code that "works on my laptop" breaks on ARM servers and Apple Silicon.

## The problem: your intuition assumes one global order

Intuitively, a multithreaded program behaves as if operations from all threads are **interleaved** into one order, with each thread's operations in program order. Leslie Lamport called this **sequential consistency** (1979). No mainstream hardware or language provides it by default, because it would forbid most optimizations.

A classic example: one thread publishes data with a flag, and another waits for the flag.

```
// thread 1                 // thread 2
data = 42;                  while (!ready) {}
ready = true;               print(data);
```

With plain variables, thread 2 can print 0, or loop forever:

- The **compiler** may reorder the two stores in thread 1, since they look independent. It may also hoist the load of `ready` out of thread 2's loop, since nothing in the loop changes it.
- On ARM, the **CPU** may make `ready = true` visible to other cores before `data = 42`, or thread 2 may load `data` before `ready`.

## Why hardware reorders

![Store-buffer litmus test: core 1 writes x then reads y; core 2 writes y then reads x. Both stores wait in store buffers, so both loads see 0.](/figures/memory-ordering/store-buffer.svg "Even x86 shows this one: each store waits in a store buffer while the next load goes ahead.")

CPUs reorder memory accesses to hide latency:

- **Store buffers.** A store goes into a per-core buffer and drains to the cache later, so the core doesn't stall waiting for the cache line. Later loads go ahead, which is why both threads can read 0 in the litmus test above. A core always sees its own buffered stores (store-to-load forwarding), so single-threaded code never notices.
- **Out-of-order execution and speculation.** Loads issue early, before earlier loads or branches resolve.
- **Invalidation queues and cache coherence timing** (on weak architectures). Different cores may see stores to different addresses become visible in different orders.

![Table of allowed reorderings: x86-64 (TSO) allows only store→load; ARMv8, POWER and RISC-V allow all four; sequential consistency allows none.](/figures/memory-ordering/architectures.svg "x86 is forgiving. ARM, POWER and RISC-V are not. Compilers reorder on all of them.")

- **x86-64: Total Store Order (TSO).** Stores become visible in program order, loads aren't reordered with each other, and the only allowed reordering is a store followed by a load to a different address. Locked instructions (`lock cmpxchg`, `xchg`) and `mfence` are full barriers.
- **ARMv8, POWER, RISC-V (RVWMO):** loads and stores to different addresses can be reordered in every combination, unless something orders them (a barrier, an acquire/release instruction, or a data or address dependency).

This is why porting concurrent code from x86 to ARM (Graviton servers, Apple Silicon, phones) uncovers latent bugs. Apple Silicon even has a hardware TSO mode, which Rosetta 2 uses so translated x86 programs keep x86 ordering.

## The language memory model

Since both compilers and CPUs reorder, you can't write portable correct code by reasoning about hardware. Languages define a **memory model**: C and C++ since 2011, Java since JSR-133 (Java 5), Rust (adopting C++'s model), Go (revised in 2022), and the Linux kernel's own LKMM. They share a core idea:

- A **data race**, meaning two threads access the same non-atomic location concurrently with at least one write, is a bug. In C, C++ and Rust it's **undefined behavior**: the compiler may assume it never happens.
- Use **atomics** (or locks) for shared variables. Atomics have a **memory order** that says what ordering they impose on surrounding accesses.
- If the program is **data-race-free**, it behaves as if sequentially consistent ("SC for DRF"), as long as you use seq_cst atomics and locks.

### Release and acquire: publishing data

![The producer writes data = 42 then stores ready = true with release; the consumer loads ready with acquire until true, then reads data and is guaranteed to see 42.](/figures/memory-ordering/message-passing.svg "When an acquire load reads a value written by a release store, everything before the release happens-before everything after the acquire.")

- A **release** store: no reads or writes before it (in program order) may move after it.
- An **acquire** load: no reads or writes after it may move before it.
- When an acquire load reads the value written by a release store, the two **synchronize-with** each other: everything the producer did before the release is visible to the consumer after the acquire. This creates a **happens-before** relationship.

That's exactly what a mutex does: `unlock()` is a release, and `lock()` is an acquire, so everything written inside one critical section is visible to the next thread that takes the lock. Channels, futures and thread `join` provide the same guarantee.

### Memory orders

![Four memory orders with uses: relaxed for counters and statistics; acquire/release for locks and publishing data; acq_rel for compare-and-swap in lock-free code; seq_cst as the default when unsure.](/figures/memory-ordering/orders.svg "Stronger orders forbid more reordering. On x86 most of them are free; on ARM they map to specific instructions.")

| Order | Guarantees | Typical use |
| --- | --- | --- |
| `relaxed` | Atomicity, plus a single order of writes to *that one variable*. No ordering with other memory | Event counters, statistics, IDs |
| `acquire` (loads) / `release` (stores) | One-way ordering, synchronizes-with | Publishing data, implementing locks |
| `acq_rel` | Both, for read-modify-write operations | Compare-and-swap in lock-free structures |
| `seq_cst` | Acquire/release plus one global total order of all seq_cst operations | Default. Needed for the store-buffer pattern (Dekker-style flags) |

Java's `volatile` and Go's `sync/atomic` operations behave like seq_cst. C++ and Rust let you choose.

### Fences

A **fence** (barrier) orders memory accesses around it without being tied to a particular atomic variable:

- **Compiler barrier:** stops the compiler from reordering across it, but emits no instruction (`asm volatile("" ::: "memory")` in GCC, `std::atomic_signal_fence`).
- **Hardware fences:** `mfence` on x86, `dmb ish` on ARM, `sync`/`lwsync` on POWER, `fence` on RISC-V. In C++, `std::atomic_thread_fence(order)`. In the Linux kernel, `smp_mb()`, `smp_rmb()`, `smp_wmb()`.

### What it costs

- On **x86**, acquire loads and release stores are plain `mov` instructions, because TSO already provides that ordering. Only seq_cst **stores** need an `xchg` or `mfence` (roughly 20–30+ cycles, mostly draining the store buffer).
- On **ARMv8**, acquire and release map to `ldar`/`stlr` (and `ldapr` from ARMv8.3), which are cheap but restrict some reordering. Full barriers (`dmb`) cost more.
- **Relaxed** atomics cost about the same as plain accesses, apart from contention.

## Where it matters

| Place | How ordering shows up |
| --- | --- |
| **Locks, channels, futures** | Contain acquire/release barriers internally, so code using them is safe |
| **Lock-free queues and stacks** | Carefully chosen acquire/release CAS operations (e.g. Folly, crossbeam, `java.util.concurrent`) |
| **Linux kernel** | `READ_ONCE`/`WRITE_ONCE`, `smp_store_release`/`smp_load_acquire`, RCU, and the LKMM tool `herd7` to check litmus tests |
| **Double-checked locking** | Broken in old Java and C++ without volatile/atomics. Fixed with release/acquire |
| **Device drivers** | Memory-mapped I/O needs ordering between CPU writes and device registers (`wmb()`, DMA barriers) |
| **Language runtimes** | GC write barriers, safe publication of objects, JIT-compiled code |

### Use case walk-through: a flag that works on x86 but not on ARM

A C++ service caches config in a struct, and a background thread reloads it:

```
// writer: cfg = new Config(...); cfg_ready = true;   (plain bool)
// readers: if (cfg_ready) use(*cfg);
```

It ran fine for years on x86. After moving to Graviton (ARM) instances, readers occasionally see a half-initialized config and crash.

1. **Diagnose.** ThreadSanitizer, run in tests, reports a data race on `cfg_ready` and `cfg`.
2. **Why x86 hid it:** TSO keeps the writer's stores in order and the reader's loads in order, and the compiler happened not to reorder them. ARM allows both kinds of reordering, so a reader can see `cfg_ready == true` before the stores that built the `Config`.
3. **Fix.** Publish through a single atomic pointer: `std::atomic<Config*> cfg`. The writer does `cfg.store(new_cfg, std::memory_order_release)`, and readers do `Config* c = cfg.load(std::memory_order_acquire)`. The data and the flag are now one thing, and ordering is guaranteed.
4. **Reclamation.** The old config can't be freed while readers might hold it. Use `std::shared_ptr` with atomic operations, hazard pointers or RCU, or keep old versions alive for a grace period.
5. **Prevent regressions.** Run TSan in CI, and test on ARM hardware too.

## Pitfalls

- **Using `volatile` in C or C++ for threads.** It prevents some compiler optimizations but provides **no atomicity and no hardware ordering**. (Java's `volatile` is different and does provide ordering.)
- **Testing only on x86.** Weak-ordering bugs may never show up there.
- **Using relaxed for flags that publish data.** Relaxed orders nothing else.
- **Mixing atomics and plain accesses** to the same data without happens-before between them.
- **Hand-rolling lock-free structures.** Beyond ordering, there's the ABA problem and safe memory reclamation. Prefer well-tested libraries.
- **Assuming fences fix data races.** In C++ and Rust, a data race on non-atomic variables is undefined behavior even with fences. Use atomics.

> [!WARNING]
> If you are not sure which memory order you need, use `seq_cst`, or better, a mutex or channel. The performance difference rarely matters, and subtle ordering bugs can take months to show up.

## Discussion questions

1. Why can both threads read 0 in the store-buffer example, even on x86?
2. How does a mutex's unlock and lock create a happens-before relationship?
3. Why might code that's correct on x86 fail on ARM?
4. When is a relaxed atomic enough, and when is it a bug?
5. What does the compiler assume about data races, and why does that make them dangerous even on x86?
6. Why are acquire and release nearly free on x86 but seq_cst stores aren't?

## FAQ

### Do I need to worry about this if I use locks?

No, as long as every access to shared data happens under the same lock (or through channels, futures or other synchronization). Locks include the required barriers. Memory ordering only becomes your problem when you use atomics or lock-free techniques directly.

### What's the difference between a memory barrier and a memory order?

A **memory order** is attached to a specific atomic operation and orders accesses relative to it. A **fence** stands alone and orders accesses on either side. Fences are more general but harder to reason about, and in C++ a fence only synchronizes when combined with atomic operations.

### Is x86 sequentially consistent?

No. It's **TSO**: stores can be delayed in the store buffer past later loads, as the store-buffer litmus test shows. It's much stronger than ARM, but not SC.

### What is a data dependency, and why does it matter?

On ARM and POWER, if a load's address depends on the value of an earlier load (following a pointer), the hardware keeps them in order. RCU and C++'s `memory_order_consume` rely on this to avoid barriers on readers. Compilers can break dependencies through optimization, which is why `consume` is effectively implemented as `acquire` today.

### How can I test for ordering bugs?

Use ThreadSanitizer to find data races, run on weakly ordered hardware (ARM), use model checkers such as CDSChecker or `loom` for Rust, and for the Linux kernel, check litmus tests with `herd7` against the kernel memory model.

## Key takeaways

- Compilers and CPUs **reorder memory operations**. Single-threaded code never notices, but multithreaded code does.
- **x86 (TSO)** only reorders a store followed by a load. **ARM, POWER and RISC-V** reorder much more.
- Program against the **language memory model**: avoid data races, use **atomics** or **locks**.
- **Release/acquire** publishes data safely. **seq_cst** adds a single global order. **Relaxed** gives only atomicity.
- Locks and channels already include barriers. Hand-written lock-free code needs care, testing on ARM, and tools like TSan.

## References

1. L. Lamport. [How to Make a Multiprocessor Computer That Correctly Executes Multiprocess Programs](https://www.microsoft.com/en-us/research/publication/make-multiprocessor-computer-correctly-executes-multiprocess-programs/). *IEEE Transactions on Computers*, 1979.
2. P. Sewell, S. Sarkar, S. Owens, F. Zappa Nardelli, M. Myreen. [x86-TSO: A Rigorous and Usable Programmer's Model for x86 Multiprocessors](https://www.cl.cam.ac.uk/~pes20/weakmemory/cacm.pdf). *CACM*, 2010.
3. cppreference. [std::memory_order](https://en.cppreference.com/w/cpp/atomic/memory_order).
4. M. Bos. [Rust Atomics and Locks](https://marabos.nl/atomics/), chapters 3 and 7 (memory ordering, processors). O'Reilly, 2023.
5. P. McKenney. [Memory Barriers: a Hardware View for Software Hackers](http://www.rdrop.com/users/paulmck/scalability/paper/whymb.2010.07.23a.pdf). 2010.
6. Linux kernel docs. [Linux kernel memory barriers](https://docs.kernel.org/core-api/wrappers/memory-barriers.html).
7. J. Preshing. [Memory Ordering at Compile Time](https://preshing.com/20120625/memory-ordering-at-compile-time/) and [Acquire and Release Semantics](https://preshing.com/20120913/acquire-and-release-semantics/).
8. R. Cox. [Memory Models](https://research.swtch.com/mm) (Hardware, Programming Language and Go memory models). 2021.
9. D. Bacon et al. [The "Double-Checked Locking is Broken" Declaration](https://www.cs.umd.edu/~pugh/java/memoryModel/DoubleCheckedLocking.html).

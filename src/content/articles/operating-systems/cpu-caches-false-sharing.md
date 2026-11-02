---
summary: How CPU caches work (lines, levels, prefetching and coherence), why access patterns often matter more than instruction counts, and how false sharing makes perfectly parallel code slower than single-threaded code.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A DRAM access costs ~100 ns, enough time for hundreds of instructions. CPUs hide this with **caches**: small, fast memories (L1 ~1 ns, L2 ~4 ns, L3 ~15 ns) that hold recently used data in **64-byte lines**. Code that walks memory **sequentially** uses every byte of each line and lets **hardware prefetchers** fetch ahead, so it runs near memory bandwidth. Code that jumps around **randomly** or **chases pointers** misses on almost every access. In multicore systems, caches are kept **coherent** (MESI-style protocols): before a core writes a line, every other core's copy is invalidated. **False sharing** happens when threads write **different variables that sit on the same cache line**: the line ping-pongs between cores on every write, and code with no logical sharing at all can run **slower with more threads**. The fixes are layout fixes: pad or align hot per-thread data to its own line (`alignas(64)`, Java's `@Contended`), use thread-local accumulators, and design data structures around contiguous, cache-friendly access.

## The problem: the memory wall

CPU speed improved much faster than DRAM latency for decades. Today a core can execute several instructions per cycle at 3–5 GHz, while a load from DRAM takes ~80–100 ns (300+ cycles). Without caches, a CPU would spend nearly all its time waiting for memory.

## The cache hierarchy

![Latency bars: register under 1 ns; L1 about 1 ns; L2 about 3–5 ns; L3 about 10–20 ns; DRAM about 80–100 ns; DRAM on another socket about 130–200 ns.](/figures/cpu-caches/hierarchy.svg "Each level is bigger and slower. A DRAM miss costs about 100 L1 hits.")

| Level | Typical size | Latency | Scope |
| --- | --- | --- | --- |
| L1 data / instruction | 32–48 KiB each | ~4–5 cycles | Per core |
| L2 | 1–2 MiB | ~12–16 cycles | Per core (or pair) |
| L3 (last-level cache) | Tens to hundreds of MiB | ~40–70 cycles | Shared by a socket or chiplet |
| DRAM | GBs to TBs | ~80–100 ns local | Per NUMA node |

Key mechanics:

- **Cache lines:** caches store and transfer data in fixed blocks, 64 bytes on x86 and most ARM cores (128 bytes on Apple M-series for some levels). Reading one byte brings in its whole line, so its neighbors become nearly free.
- **Set associativity:** each address can only live in a few slots of a cache, so data whose addresses map to the same sets can evict each other (conflict misses), even if the cache isn't full.
- **Hardware prefetchers** watch access patterns and fetch lines before they're requested: sequential streams, constant strides, sometimes more. They can't predict random accesses or the next node in a linked list.
- **Memory-level parallelism:** an out-of-order core can have ~10–20+ cache misses outstanding at once, but only if the addresses are known in advance. Pointer chasing serializes them.

## Access patterns

![Illustrative times for summing 100 million integers: sequential array about 30 ms; strided access touches about 16× more lines; random indexes about 1 s; a linked list about 1–2 s.](/figures/cpu-caches/patterns.svg "The same arithmetic, up to 50× apart, purely from memory access patterns.")

The same work can differ by an order of magnitude or more:

- **Sequential array:** every byte of each line is used, prefetchers stream ahead, and the loop runs at memory bandwidth.
- **Strided access** (one field from each large struct, or every 16th element) uses a fraction of each line fetched.
- **Random access** into a large array misses the cache (and often the TLB) on almost every access.
- **Linked structures** (lists, trees, hash chains) are worse still: each node's address comes from the previous load, so misses can't overlap.

This is why:

- `std::vector` usually beats `std::list` even for insertions in the middle, and B-trees beat binary trees in memory as well as on disk.
- **Structure of arrays** (one array per field) beats **array of structures** when a loop touches only a few fields, the core idea of **data-oriented design** in game engines and of columnar databases.
- Open-addressing hash tables (Swiss tables, `absl::flat_hash_map`) beat chaining.
- Blocking or tiling loops (matrix multiplication) keeps working sets in cache.

## Coherence and false sharing

Each core has private L1 and L2 caches, so the same line can be cached in several cores. **Cache coherence** protocols (MESI and variants like MOESI and MESIF) keep them consistent: each line in each cache is Modified, Exclusive, Shared or Invalid. To **write** a line, a core must hold it exclusively, which **invalidates** every other core's copy. The next time another core touches the line, it must fetch it from the writer: a cache-to-cache transfer of tens of nanoseconds, more across sockets.

That's fine when threads really share data. **False sharing** is when they don't:

![Core 0 increments counter_a and core 1 increments counter_b, adjacent in memory on one 64-byte line; each write invalidates the other core's copy, so the line ping-pongs.](/figures/cpu-caches/false-sharing.svg "The hardware tracks ownership per line, not per variable.")

```
struct { long a; long b; } counters;   // 16 bytes, one cache line
// thread 1: counters.a++ in a loop;  thread 2: counters.b++ in a loop
```

Each thread only touches its own counter, so there's no data race and no lock. But both counters live on one line, so every increment by one core invalidates the other's copy, and the line bounces back and forth. Each increment becomes a coherence miss instead of an L1 hit.

![Illustrative throughput: padded per-thread counters scale linearly to 16 threads; adjacent counters fall below single-thread speed.](/figures/cpu-caches/scaling.svg "Code that looks embarrassingly parallel can get slower as you add threads.")

Common places it hides:

- arrays of per-thread counters or statistics (`stats[thread_id]++`),
- a lock next to the data it protects, or two hot locks in one struct,
- the head and tail indexes of a queue written by producer and consumer,
- small objects allocated next to each other and handed to different threads.

### Fixes

- **Pad or align** hot, per-thread fields to separate lines: `alignas(64)` (or `std::hardware_destructive_interference_size`) in C++, `#[repr(align(64))]` or `crossbeam::CachePadded` in Rust, `@jdk.internal.vm.annotation.Contended` in the JDK (used by `LongAdder` and `ConcurrentHashMap` internally).
- **Thread-local accumulation:** each thread updates a local variable and merges at the end, or uses striped counters like Java's `LongAdder`.
- **Separate read-mostly from write-heavy fields** in shared structures.
- **Find it with tools:** `perf c2c` on Linux reports cache lines with heavy cross-core "HITM" traffic and which code touches them. Intel VTune has a similar analysis.

Note that **true sharing** has the same cost: a single atomic counter incremented by all threads bounces just as badly. The fix there is to stop sharing (sharding, per-thread counters), not padding.

## Where it matters

| System | Cache-aware design |
| --- | --- |
| **LMAX Disruptor** | Ring buffer with padded sequence counters to avoid false sharing |
| **Java `LongAdder`, `ConcurrentHashMap`** | Striped, `@Contended` cells |
| **Linux kernel** | Per-CPU variables, `____cacheline_aligned` annotations |
| **Columnar databases** (DuckDB, ClickHouse) | Contiguous column vectors, vectorized execution |
| **Game engines** (ECS architectures) | Components stored in contiguous arrays by type |
| **Swiss tables / `absl::flat_hash_map`** | Open addressing with metadata bytes scanned with SIMD |

### Use case walk-through: metrics that killed scalability

A service keeps request counters in a global array `uint64_t hits[64]`, indexed by worker thread. Moving from 8 to 32 worker threads made throughput **drop** 20%.

1. **Profile.** `perf stat` shows IPC (instructions per cycle) falling as threads increase, with no lock contention.
2. **Find the line.** `perf c2c record` then `perf c2c report` shows one cache line with massive HITM counts, in the metrics array: 8 counters share each 64-byte line.
3. **Fix.** Make each counter its own cache line (`struct alignas(64) Counter { uint64_t v; }`), or keep counters thread-local and have the metrics exporter sum them on read.
4. **Result.** Throughput scales with threads again, and IPC returns to single-thread levels.

## Pitfalls

- **Per-thread arrays of small counters or flags** without padding.
- **Putting a hot lock next to hot data** written by other threads.
- **Assuming no lock means no contention**: atomics and plain writes both cause coherence traffic.
- **Over-padding everything**: padding wastes memory and cache capacity. Pad only measured hot spots.
- **Pointer-heavy data structures** in hot loops. Prefer contiguous storage and indexes.
- **Benchmarking with tiny datasets** that fit in L1/L2, then deploying with data that doesn't.

> [!TIP]
> `perf stat -e cache-misses,cache-references,L1-dcache-load-misses` gives a quick picture of cache behavior, and `lscpu --caches` (or `getconf -a | grep CACHE`) shows your machine's cache sizes and line size.

## Discussion questions

1. Why can a sorted array lookup beat a hash table or a tree in practice for small or medium sizes?
2. How does a hardware prefetcher help sequential loops, and why can't it help linked lists?
3. Explain why two threads incrementing different variables can be slower than one thread doing both.
4. How would you find false sharing in a large codebase?
5. When is "structure of arrays" better than "array of structures"?
6. Why doesn't padding help when all threads update one shared atomic counter?

## FAQ

### What's the difference between false sharing and true sharing?

In **true sharing**, threads access the same variable, so coherence traffic is inherent. In **false sharing**, they access different variables that happen to be on the same cache line, and the traffic is an accident of memory layout, fixable by moving the variables apart.

### Is the cache line always 64 bytes?

On current x86 CPUs and most ARM server cores, yes. Some designs differ (Apple's M-series uses 128-byte lines in some caches, and some prefetchers fetch pairs of lines), so libraries often pad to 128 bytes to be safe for false-sharing purposes.

### Do caches affect single-threaded code too?

Hugely. Most performance differences between "equivalent" algorithms come from cache behavior: data layout, access order and working-set size relative to L1, L2 and L3.

### Does garbage collection affect cache behavior?

Yes. Compacting collectors move objects next to each other, which can improve locality, and allocation from thread-local buffers keeps a thread's new objects together. But pointer-heavy object graphs still suffer from pointer chasing, which is why value types (Java's Project Valhalla, C# structs) matter for performance.

### What's cache associativity aliasing?

Each address maps to a limited set of cache slots. Arrays whose sizes are large powers of two can map many elements to the same sets, causing conflict misses even when the cache has free space. Padding row lengths to non-power-of-two sizes is a classic fix in numeric code.

## Key takeaways

- Caches hold **64-byte lines**. L1 ~1 ns, DRAM ~100 ns: **access patterns** often dominate performance.
- **Sequential, contiguous** access is fast (prefetching, full use of lines). **Random** and **pointer-chasing** access is slow.
- **Coherence** invalidates other cores' copies on every write, at line granularity.
- **False sharing**: independent variables on one line make parallel code slow. Fix with **padding/alignment** or **thread-local** data.
- Use **`perf c2c`** and cache counters to find problems before guessing.

## References

1. U. Drepper. [What Every Programmer Should Know About Memory](https://people.freebsd.org/~lstewart/articles/cpumemory.pdf). 2007.
2. J. Hennessy, D. Patterson. *Computer Architecture: A Quantitative Approach*, 6th ed., chapter 2 (memory hierarchy design). Morgan Kaufmann, 2017.
3. Linux man pages. [perf-c2c(1)](https://man7.org/linux/man-pages/man1/perf-c2c.1.html).
4. M. Thompson et al. [LMAX Disruptor: High performance alternative to bounded queues](https://lmax-exchange.github.io/disruptor/disruptor.html). 2011.
5. cppreference. [std::hardware_destructive_interference_size](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size).
6. M. Acton. [Data-Oriented Design and C++](https://www.youtube.com/watch?v=rX0ItVEVjHc). CppCon 2014.
7. Abseil. [Swiss Tables Design Notes](https://abseil.io/about/design/swisstables).

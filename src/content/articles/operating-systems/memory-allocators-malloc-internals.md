---
summary: What happens inside malloc and free, including size classes, thread caches, arenas and how memory goes back to the kernel, why long-running services fragment and bloat, and how jemalloc, tcmalloc, mimalloc and glibc differ.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** The kernel hands out memory in **pages** through slow system calls (`brk`, `mmap`). Programs make millions of small, short-lived allocations. The **allocator** (`malloc`/`free`, `new`/`delete`, Rust's global allocator) bridges the two. It grabs large chunks from the kernel and carves them into objects. Modern allocators round each request up to a **size class** and keep **free lists** of equal-size slots, so allocation is a pop and free is a push. **Thread caches** (or per-CPU caches) serve most calls without locks in ~10–20 ns. **Arenas** and central heaps refill caches, and large requests go straight to `mmap`. The hard problems are **fragmentation** (free memory spread across pages that each still hold a live object, so it can't be reused for other sizes or returned to the kernel) and **multithreaded scaling**. They explain why RSS stays high after `free()`, why glibc's malloc can bloat services with many threads, and why switching to **jemalloc**, **tcmalloc** or **mimalloc** (often just an `LD_PRELOAD`) can cut memory by tens of percent.

## The problem: the kernel thinks in pages, programs think in objects

A typical service allocates strings, request objects, buffers and nodes of every size, millions of times per second, and frees most of them soon after. The kernel only offers:

- **`brk`/`sbrk`**: grow or shrink the heap segment, a single contiguous region.
- **`mmap`/`munmap`**: map or unmap page-aligned regions anywhere.
- **`madvise(MADV_DONTNEED / MADV_FREE)`**: tell the kernel some pages' contents aren't needed, so it can reclaim the physical memory but keep the mapping.

Each is a system call (hundreds of nanoseconds to microseconds), works in units of 4 KiB pages, and can involve page faults and TLB shootdowns. An allocator must make small allocations fast, keep memory overhead low, scale across threads, and avoid fragmentation. Those goals conflict.

## The layers of a modern allocator

![From top to bottom: malloc and free calls; thread caches with per-thread free lists by size class, no lock, about 10–20 ns; arenas or central heaps with shared bins; a page allocator splitting runs of pages; and kernel calls brk, mmap and madvise.](/figures/allocators/layers.svg "Each layer is bigger, slower and shared by more threads than the one above.")

1. **Thread cache** (tcache in glibc, tcache in jemalloc, per-CPU caches in tcmalloc): small per-thread (or per-CPU) free lists for each size class. Most `malloc`/`free` pairs never leave this layer: no locks, no atomics, just a pointer pop or push.
2. **Arenas / central free lists:** when a cache runs empty or overflows, it exchanges batches of objects with a shared structure, which takes a lock (or uses per-CPU partitions).
3. **Page-level allocation:** objects of one size class live in **spans** (or "slabs", "runs"): a few contiguous pages divided into equal slots. The allocator tracks spans with metadata (often a radix tree from page address to span), so `free(p)` can find `p`'s size class from its address alone, without a header in front of each object.
4. **Large allocations** (typically above a few hundred KiB, configurable) get their own `mmap` and are returned with `munmap` when freed.
5. **Returning memory:** allocators release empty pages to the kernel with `madvise` on their own schedule (jemalloc uses time-based **decay**), balancing RSS against the cost of faulting pages back in later.

### Size classes

![Rows of equal-size slots for classes 16, 32, 48, 64, 80, 96 and 128 bytes; a 50-byte request is rounded to the 64-byte class, wasting 14 bytes.](/figures/allocators/size-classes.svg "Rounding up wastes a little per object but makes allocation and free nearly free.")

Requests are rounded up to one of a few dozen classes, spaced so that worst-case **internal fragmentation** (waste inside an allocation) stays around 10–25%: 8, 16, 32, 48, 64, 80, 96, 112, 128, then larger steps. All slots in a span have the same size, so:

- allocation needs no searching (pop the free list),
- free needs no coalescing with neighbors (push onto the list),
- and objects of the same size are packed densely.

Older designs like the classic **dlmalloc** (the ancestor of glibc's `ptmalloc`) kept variable-size chunks with headers, boundary tags and coalescing, and searched bins of free chunks. glibc still works that way underneath its tcache, which is one reason its behavior differs from size-class allocators.

## Fragmentation

![Ten pages after a burst of allocations was mostly freed: about 90% of slots are free, but nearly every page holds at least one live object, so only one page can be returned.](/figures/allocators/fragmentation.svg "Free memory that can't be used for other sizes or given back to the OS.")

**External fragmentation** is free memory the allocator can't use for the request at hand, or can't return because pages are only partly empty. It builds up in long-running processes:

- a burst of requests allocates many objects, then most are freed, but a few long-lived ones (a cache entry, a connection, a log buffer) stay scattered across pages,
- objects of different lifetimes share pages,
- memory freed in one size class can't serve another class until a whole span is empty.

The result: RSS grows over hours or days and never comes back down, even though the program's live data is stable. Mitigations:

- allocators that **segregate by size and thread** and **purge** empty pages regularly (jemalloc's decay, tcmalloc's background release),
- **arenas or pools per lifetime** in the application: allocate a request's objects from a per-request arena and free them all at once (also called region or bump allocation),
- **compaction**: garbage collectors in Java, Go (non-moving, but size-segregated) and .NET move objects. Mesh (2019) showed compaction for C/C++ by merging pages with non-overlapping live slots,
- for glibc: limiting arenas (`MALLOC_ARENA_MAX`) and calling `malloc_trim`.

## Allocators compared

![glibc ptmalloc2 with per-thread arenas and tcache; jemalloc with per-CPU arenas and decay purging; tcmalloc with per-CPU caches and huge-page awareness; mimalloc with free-list sharding; musl mallocng, small and hardened.](/figures/allocators/comparison.svg "All modern allocators use caches and size classes. The differences show up in multithreaded and long-running workloads.")

- **glibc malloc (ptmalloc2):** the default on most Linux distributions. Creates extra **arenas** for threads under contention (up to 8 × cores on 64-bit), each with its own heap, plus a per-thread **tcache** (since glibc 2.26). Services with hundreds of threads can accumulate many partly used arenas and bloat. `MALLOC_ARENA_MAX=2` or 4 is a common fix.
- **jemalloc:** created for FreeBSD and adopted by Facebook, Redis, and Rust (as its default until 2018). Size classes, multiple arenas, thread caches, and **decay-based purging**. Excellent fragmentation behavior and rich statistics (`malloc_stats_print`, profiling).
- **tcmalloc:** Google's allocator. The modern version uses **per-CPU caches** via Linux restartable sequences (rseq), and its **Temeraire** page heap packs allocations into huge pages to reduce TLB misses, with Google reporting fleet-wide throughput gains.
- **mimalloc:** Microsoft's compact allocator, with **free-list sharding** per page and per thread for locality. Fast, small, with a secure mode.
- **musl's mallocng:** prioritizes small code size and hardening. Much slower for heavily multithreaded workloads, which is a common surprise in Alpine-based containers.

## Where it's used

| System | Allocator choice |
| --- | --- |
| **Redis** | Ships with jemalloc for its fragmentation control (`INFO memory` reports fragmentation ratio) |
| **Firefox** | mozjemalloc |
| **Chromium** | PartitionAlloc (security-hardened partitions by type) |
| **Linux kernel** | SLUB slab allocator for kernel objects, a buddy allocator for pages |
| **Go, Java, .NET** | Runtime-managed heaps with thread-local allocation buffers and GC |
| **Rust** | System allocator by default, with `#[global_allocator]` for jemalloc or mimalloc |

### Use case walk-through: a service that grows 1 GB a day

A C++ service handling bursts of large JSON requests starts at 2 GB RSS and reaches 9 GB after a week, when it's restarted. Heap profiling shows live data steady at ~2 GB.

1. **Confirm it's fragmentation, not a leak.** glibc's `malloc_info()` shows many arenas (the service runs 200 threads), each with lots of free but unreturned memory.
2. **Quick experiment:** `MALLOC_ARENA_MAX=4` reduces growth, but throughput drops 5% from arena contention.
3. **Try jemalloc** via `LD_PRELOAD=libjemalloc.so`, with `background_thread:true`. RSS now plateaus at ~3 GB, and throughput is unchanged.
4. **Fix the pattern too.** Request parsing allocated many temporary objects of mixed sizes alongside long-lived cache entries. Using a per-request arena for parsing, freed at the end of the request, stops short-lived objects from pinning pages.
5. **Monitor.** Export allocator stats (jemalloc's `stats.resident`, `stats.allocated`) next to RSS, and alert on their ratio.

## Pitfalls

- **Calling RSS growth a leak** before checking allocator statistics: it may be fragmentation or cached free memory.
- **Many threads on glibc malloc** without tuning arenas.
- **Alpine/musl images for allocation-heavy multithreaded services** without benchmarking (or switching allocator).
- **Freeing memory from a different allocator** than the one that allocated it (mixing `LD_PRELOAD`ed and statically linked allocators, or across DLL boundaries).
- **Huge numbers of tiny allocations** where a pool, arena or struct-of-arrays would be faster and denser.
- **Use-after-free and double-free**: the classic allocator-related security bugs. Hardened allocators and sanitizers (ASan) catch them in testing.

> [!TIP]
> To compare allocators quickly, run the same load test with `LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2` (or tcmalloc/mimalloc), and track throughput, p99 latency and RSS over at least several hours. Fragmentation often only shows up over long runs.

## Discussion questions

1. Why do size classes make `free()` fast without a header before each object?
2. What's the difference between internal and external fragmentation?
3. Why doesn't freeing memory reduce a process's RSS right away?
4. How do thread caches avoid locks, and what happens when a thread frees memory allocated by another thread?
5. Why can glibc malloc use much more memory in a process with hundreds of threads?
6. When would a per-request arena allocator beat a general-purpose malloc?

## FAQ

### What's the difference between malloc and the kernel's memory allocator?

`malloc` runs in user space within your process and manages memory the process got from the kernel. The kernel has its own allocators: a **buddy allocator** for physical pages and **slab allocators** (SLUB) for kernel objects. They solve similar problems for kernel data structures.

### Why is free() sometimes slow?

Usually because it had to do more than push onto a cache: returning a batch to a shared arena (taking a lock), coalescing chunks (in glibc), or releasing pages to the kernel (a system call, possibly a TLB shootdown). Freeing memory allocated on another thread can also be slower, depending on the allocator.

### Does a garbage-collected language avoid these problems?

It avoids manual `free` and use-after-free bugs, and compacting collectors fix fragmentation. But GCs have their own costs (pauses, CPU, memory headroom), and runtimes still use size classes and thread-local allocation buffers internally. Native libraries called from them still use malloc.

### What are MADV_FREE and MADV_DONTNEED?

Both tell the kernel that page contents aren't needed. `MADV_DONTNEED` drops the pages immediately (the next access gets zero-filled pages). `MADV_FREE` lets the kernel reclaim them lazily under memory pressure, which is cheaper but makes RSS look higher until reclaim happens. That surprises monitoring.

### Should I always replace the default allocator?

No. Many programs never notice. Consider it when profiling shows allocation hot spots, when multithreaded scaling is poor, or when RSS grows over time without growing live data. Then benchmark realistically.

## Key takeaways

- The allocator turns the kernel's **pages** into program **objects**, using **size classes**, **free lists** and **thread/per-CPU caches** for ~10–20 ns operations.
- Memory comes from **`brk`/`mmap`** in big chunks and goes back via **`madvise`/`munmap`** on the allocator's schedule, so RSS lags `free()`.
- **Fragmentation** (partly used pages) makes long-running processes bloat. Allocator choice, **purging**, and **lifetime-based arenas** help.
- **glibc** can bloat with many threads. **jemalloc**, **tcmalloc** and **mimalloc** often use less memory and scale better.
- Measure with allocator stats and long-running tests before and after switching.

## References

1. J. Evans. [A Scalable Concurrent malloc(3) Implementation for FreeBSD](https://people.freebsd.org/~jasone/jemalloc/bsdcan2006/jemalloc.pdf). *BSDCan 2006*.
2. glibc wiki. [Malloc Internals](https://sourceware.org/glibc/wiki/MallocInternals).
3. A. H. Hunter et al. [Beyond malloc efficiency to fleet efficiency: a hugepage-aware memory allocator](https://www.usenix.org/conference/osdi21/presentation/hunter). *OSDI 2021* (tcmalloc Temeraire).
4. D. Leijen, B. Zorn, L. de Moura. [Mimalloc: Free List Sharding in Action](https://www.microsoft.com/en-us/research/publication/mimalloc-free-list-sharding-in-action/). *APLAS 2019*.
5. B. Powers, D. Tench, E. Berger, A. McGregor. [Mesh: Compacting Memory Management for C/C++ Applications](https://arxiv.org/abs/1902.04738). *PLDI 2019*.
6. P. Wilson, M. Johnstone, M. Neely, D. Boles. [Dynamic Storage Allocation: A Survey and Critical Review](https://www.cs.northwestern.edu/~pdinda/icsclass/doc/dsa.pdf). 1995.
7. jemalloc. [jemalloc documentation](https://jemalloc.net/jemalloc.3.html).

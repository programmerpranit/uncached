---
summary: How the JVM, Go, .NET, V8 and Python reclaim memory — tracing vs reference counting, generational heaps, concurrent collectors — and how GC behaviour shows up as latency and memory in backend services.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR** — A garbage collector frees memory that the program can no longer reach. Most runtimes use **tracing** GC: start from roots (stacks, globals), mark everything reachable, reclaim the rest. **Generational** heaps exploit the fact that most objects die young, collecting a small young space often and the big old space rarely. Modern collectors (G1, ZGC, Shenandoah, Go's, .NET background GC) do most work **concurrently** with the application, leaving only short stop-the-world pauses. For backend services, GC is a trade-off between throughput, pause latency and memory headroom — and the best tuning is usually allocating less.

## The problem: memory you didn't free

In C, you call `free`. Forget, and you leak; free twice or too early, and you corrupt memory. Managed runtimes — Java, C#, Go, JavaScript, Python, Ruby — take that job away: you allocate, and the runtime decides when an object is dead.

That convenience isn't free. The collector needs CPU, it needs spare memory to work efficiently, and at some points it must pause the application (or slow it with barriers) to get a consistent view of the heap. In a backend serving thousands of requests per second, those costs surface as **tail latency spikes**, **CPU overhead**, and **container OOM kills**. Understanding how the collector works tells you which knob — or which code change — fixes which symptom.

## How it works

### Tracing vs reference counting

![Mark and sweep](/figures/gc-runtimes/mark.svg "Objects reachable from roots are kept; unreachable objects, including cycles, are reclaimed")

**Tracing** collectors find live objects by graph traversal. Roots are the references the program can use directly: local variables on thread stacks, CPU registers, static/global fields, JNI handles. The collector marks everything reachable from them; anything unmarked is garbage. Reclamation then happens by:

- **Sweeping** — adding dead objects' memory to free lists (non-moving; can fragment).
- **Compacting** — sliding live objects together so free space is contiguous.
- **Copying** — evacuating live objects to a fresh region; cost is proportional to *live* data, not heap size.

**Reference counting** keeps a counter per object, decremented when a reference goes away; at zero, the object is freed immediately. It gives prompt, predictable reclamation (CPython, Swift's ARC, Rust's `Rc`) but costs a write on every pointer copy and cannot free cycles on its own. CPython therefore adds a cycle-detecting generational collector on top.

### Generational collection

![Generational heap](/figures/gc-runtimes/generational.svg "New objects go to Eden; survivors are copied and eventually promoted to the old generation")

The **weak generational hypothesis** — most objects die young — holds remarkably well for request-oriented servers: a request allocates buffers, DTOs and strings that are garbage milliseconds later. Generational collectors split the heap:

- **Young generation** (Eden + survivor spaces in HotSpot; gen0/gen1 in .NET; the "new space"/nursery in V8). Allocation is a pointer bump. A **minor GC** copies the few survivors out and resets the space wholesale — cheap because cost tracks survivors, not garbage.
- **Old generation.** Objects that survive several minor GCs are **promoted**. It's collected less frequently by a **major** (or "mixed") collection.

To avoid scanning the whole old generation on every minor GC, the runtime uses a **write barrier**: code injected on pointer stores that records old→young references in a card table or remembered set.

Go is a notable exception: its collector is non-generational and non-moving, relying instead on escape analysis to keep short-lived values on the stack and a concurrent mark-sweep for the heap.

### Stop-the-world vs concurrent

![GC pauses by collector](/figures/gc-runtimes/pauses.svg "Older collectors pause for the whole cycle; modern ones run concurrently with brief pauses")

The simplest collectors stop all application threads ("stop-the-world", STW), do the whole job, and resume. That maximises throughput but pause time grows with heap size. Concurrent collectors run marking (and sometimes compaction) alongside the application, using barriers to track mutations made while they work:

- **HotSpot Parallel GC** — STW, multi-threaded; good for batch throughput.
- **G1** (Java default) — region-based, concurrent marking, STW evacuation of selected regions to hit a pause goal (`-XX:MaxGCPauseMillis`, default 200 ms).
- **ZGC / Shenandoah** — concurrent compaction using load barriers / forwarding pointers; pauses typically well under a millisecond regardless of heap size. Generational ZGC is default ZGC mode since JDK 23.
- **Go** — concurrent tri-colour mark-sweep with sub-millisecond STW phases; pacing controlled by `GOGC` and the soft limit `GOMEMLIMIT`.
- **.NET** — generational with background gen2 collection; Server GC uses a heap per core for throughput, Workstation GC favours responsiveness.
- **V8 (Node.js)** — Scavenger for the young generation, concurrent/incremental mark-compact (Orinoco) for the old.

Concurrent collectors trade pause time for **throughput and memory**: barriers slow the app slightly, and the heap needs headroom so the app can keep allocating while the collector catches up. If allocation outpaces the collector, you get an "allocation stall" or a fallback full GC — the worst pause of all.

### What tuning actually controls

All collectors balance three variables; you can pick two:

1. **Throughput** — fraction of CPU spent on the application.
2. **Latency** — length/frequency of pauses.
3. **Footprint** — heap size relative to live data.

Giving a collector more memory (larger heap, higher `GOGC`) means fewer cycles and less CPU, at the cost of footprint. Asking for shorter pauses costs throughput or memory. The heap size relative to the **live set** is the most important number: a collector with 2–3× the live set in headroom is comfortable; at 1.1× it thrashes.

## Where it's used

| Runtime | Default collector | Key knobs |
|---|---|---|
| Java (HotSpot) | G1 (generational, region-based) | `-Xmx`, `MaxGCPauseMillis`, `-XX:+UseZGC`, `MaxRAMPercentage` |
| Go | Concurrent mark-sweep, non-moving | `GOGC`, `GOMEMLIMIT` |
| .NET | Generational, background gen2 | Server vs Workstation GC, `GCHeapHardLimit`, concurrent on/off |
| Node.js (V8) | Generational: Scavenger + Mark-Compact | `--max-old-space-size`, `--max-semi-space-size` |
| CPython | Reference counting + cycle collector | `gc.freeze()`, `gc.set_threshold()` |
| Ruby (CRuby) | Generational incremental mark-sweep + compaction | `RUBY_GC_HEAP_*` environment variables |

## Use case walk-through: p99 spikes in a JSON API

A Java service on Kubernetes (2 GiB container limit) serves a JSON API. p50 is 8 ms but p99 jumps to 400 ms every few minutes.

1. Enabling GC logging (`-Xlog:gc*`) shows G1 "Pause Young (Mixed)" events of 300–400 ms lining up with the spikes, and occasional "Pause Full" events.
2. Heap is set to `-Xmx1800m` in a 2 GiB container; after a full GC the live set is ~1.4 GiB. Headroom is only ~1.3×, so G1 runs constantly and sometimes gives up into full GCs. Separately, the pod is occasionally OOM-killed because metaspace, thread stacks and direct buffers live *outside* the heap.
3. An allocation profile (async-profiler / JFR) shows 60% of allocation from building large intermediate `String`s while serialising responses, and a per-request cache that accidentally retains entries in a static map.
4. Fixes: stream JSON directly to the response, bound the cache with size-based eviction, and set `-XX:MaxRAMPercentage=70` so non-heap memory has room.
5. Live set falls to ~400 MiB; allocation rate drops by half. Minor GCs now take 5–10 ms.
6. For the strict-latency endpoints the team also tries ZGC: pauses fall under 1 ms at the cost of ~5% more CPU, which they accept.

**Result:** p99 drops from 400 ms to 25 ms, OOM kills stop, and most of the gain came from allocating less, not from GC flags.

## Pitfalls

- **Heap = container limit.** Runtimes use memory beyond the heap (stacks, metaspace, JIT code, native buffers). Leave 25–30% headroom or you'll be OOM-killed.
- **Ignoring the live set.** Tuning pause goals is pointless if the heap is nearly full of live data.
- **Calling `System.gc()` / `GC.Collect()`.** Usually triggers a full, expensive collection at the worst moment.
- **Unbounded caches and listeners.** "Leaks" in managed languages are objects still reachable — static maps, event subscriptions, closures.
- **Finalizers for cleanup.** They run late, unpredictably, or never; use try-with-resources / `using` / `defer`.
- **Huge object graphs of tiny objects.** Pointer-heavy structures make marking slow; prefer arrays of primitives or off-heap storage for big datasets.
- **Measuring averages.** GC hurts the tail; look at p99/p999 and GC logs, not mean latency.

> [!TIP]
> The cheapest garbage is the garbage you never create. Before touching GC flags, run an allocation profiler and fix the top three allocation sites — streaming instead of buffering, reusing buffers, avoiding boxing — then size the heap to 2–3× the remaining live set.

## Discussion questions

1. Why does a copying collector's cost depend on live data rather than heap size, and when is that a disadvantage?
2. What does a write barrier do in a generational collector, and what would break without it?
3. How do `GOGC` and `GOMEMLIMIT` interact in a containerised Go service?
4. When would you choose Parallel GC over ZGC for a JVM workload?
5. How can a managed-language program "leak" memory, and how would you find it with a heap dump?
6. Why might a reference-counted runtime have more predictable latency but lower throughput than a tracing one?

## FAQ

### Is GC slower than manual memory management?
Not necessarily for throughput — bump allocation and bulk reclamation of young objects can beat `malloc`/`free`. The costs are memory headroom and pause or barrier overhead, which matter most for latency-sensitive or memory-constrained systems.

### What's a "GC pause" exactly?
A period where application threads are halted (at safepoints) so the collector can do work that requires a consistent heap view, such as scanning roots or moving objects.

### Should I use ZGC/Shenandoah everywhere?
They're excellent for large heaps and strict latency. For small heaps or batch jobs, G1 or Parallel often give better throughput with less CPU. Measure on your workload.

### Why does my Node.js process crash with "heap out of memory"?
V8's old-space limit may be lower than the container allows. Raise `--max-old-space-size` to match the container, and check for retained objects (closures, global caches) with a heap snapshot.

### Does Rust or C++ need GC?
They use ownership/RAII for deterministic freeing; reference counting (`Rc`, `Arc`, `shared_ptr`) is available where shared ownership is needed. Some apps still embed tracing GCs for specific data structures.

## Key takeaways

- GC reclaims unreachable memory; tracing handles cycles, reference counting is prompt but needs cycle help.
- Generational heaps make the common case — short-lived objects — almost free.
- Concurrent collectors shrink pauses by trading CPU and memory headroom.
- Tune in this order: allocate less, size heap to 2–3× live set, then choose collector and pause goals.
- Leave non-heap headroom in containers; watch tail latency and GC logs, not averages.

## References

- Jones, R., Hosking, A. & Moss, E. — *The Garbage Collection Handbook*, 2nd ed., CRC Press, 2023
- [Oracle — HotSpot Virtual Machine Garbage Collection Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/)
- [Go — A Guide to the Go Garbage Collector](https://go.dev/doc/gc-guide)
- [Microsoft Learn — Fundamentals of garbage collection (.NET)](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/fundamentals)
- [V8 blog — Trash talk: the Orinoco garbage collector](https://v8.dev/blog/trash-talk)
- [OpenJDK — JEP 439: Generational ZGC](https://openjdk.org/jeps/439)

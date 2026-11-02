---
summary: Why every memory access needs a cached address translation, what happens on a TLB miss and on a page fault, how huge pages extend TLB reach, and why TLB shootdowns and major faults show up as mysterious latency.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Translating a virtual address through 4-level page tables takes four dependent memory reads, far too slow to do on every access. The **Translation Lookaside Buffer (TLB)** is a small per-core cache of recent translations, and it hits more than 99% of the time for typical code. On a **TLB miss**, the hardware **walks the page tables** (tens to hundreds of cycles). If the page isn't present, or the access isn't allowed, the CPU raises a **page fault** and the kernel takes over: a **minor fault** (no I/O, around a microsecond) allocates or maps a page; a **major fault** reads from disk (tens of microseconds to milliseconds); an invalid access kills the process with `SIGSEGV`. Big random-access working sets overflow the TLB, which is why **huge pages** help databases and JVMs. And because TLBs aren't kept coherent by hardware, changing mappings requires **TLB shootdowns** across cores.

## The problem: translation on every access

With virtual memory, every instruction fetch, load and store uses a virtual address that must be translated before the cache or RAM can be accessed. A full x86-64 page walk reads four page-table entries, one after another, each potentially from DRAM at ~100 ns. Doing that on every access would make programs several times slower.

The fix is the same as for data: cache it.

## How the TLB works

![A virtual address goes to the TLB. On a hit, the physical access happens with about one extra cycle. On a miss, the hardware page walker reads the tables (tens to hundreds of cycles) and fills the TLB. If the PTE is not present or the access is denied, a page fault traps into the kernel.](/figures/tlb/paths.svg "Three outcomes for every memory access, with costs that differ by orders of magnitude.")

The TLB maps **virtual page numbers** to **physical frame numbers** plus permission bits. Modern cores have a hierarchy:

- **L1 TLBs** (separate for instructions and data): tens of entries, checked in parallel with the L1 cache lookup, effectively free.
- **L2 (shared) TLB**: around 1,000 to 3,000 entries, a few cycles slower.
- **Page-walk caches**: cache the upper levels of the page table so most walks don't start from the top.

On a TLB miss, x86 and ARM CPUs walk the page tables **in hardware**: no kernel involvement, just extra memory accesses (often hitting the CPU's data caches). Some architectures (old MIPS, SPARC) used software-managed TLBs, where every miss trapped to the kernel.

### Context switches and ASIDs

Translations are per address space. When the kernel switches to another process, the old TLB entries are wrong for the new page tables. Older x86 CPUs flushed the whole TLB on every switch. Modern CPUs tag entries with an address-space ID (**PCID** on x86, **ASID** on ARM), so entries from several processes can coexist and survive switches. Linux has used PCIDs since 4.14, which became important when the Meltdown mitigation (KPTI) started switching page tables on every system call.

### TLB reach and huge pages

![Bars for a roughly 1,500-entry L2 TLB: 4 KiB pages cover about 6 MiB; 2 MiB pages about 3 GiB; 1 GiB pages many GiB.](/figures/tlb/reach.svg "TLB reach = entries × page size. Huge pages cover 512 times more per entry.")

**TLB reach** is how much memory the TLB can map at once: entries × page size. With 4 KiB pages, ~1,500 entries cover only about 6 MiB. A program doing random lookups across a 50 GB hash table will miss the TLB on almost every access, and each miss adds a page walk on top of the cache miss for the data itself. Research on big-memory workloads has measured page walks consuming a substantial fraction of execution time (up to tens of percent).

**Huge pages** fix this by mapping 2 MiB (or 1 GiB) per entry:

- **Explicit huge pages (hugetlbfs):** reserved at boot or runtime. Used by databases (Oracle, PostgreSQL's `huge_pages`), DPDK and VMs.
- **Transparent huge pages (THP):** the kernel automatically backs suitable anonymous memory with 2 MiB pages and promotes regions in the background (`khugepaged`). Convenient, but it can cause latency spikes from memory compaction and wasted memory in sparse regions. A common compromise is `madvise` mode, where only regions that ask for huge pages get them.
- **JVM:** `-XX:+UseTransparentHugePages` or `-XX:+UseLargePages` for the heap.

## Page faults

When the page walk finds an entry that isn't present, or the access violates the entry's permissions, the CPU raises a **page fault** exception. It saves the faulting address (in `CR2` on x86) and jumps to the kernel's fault handler, which looks up the address in the process's list of memory regions (VMAs) and decides what to do.

![Bars on a log scale: a minor fault takes about 0.5 to 5 µs; a major fault from NVMe about 50 to 200 µs; a major fault from a spinning disk about 5 to 10 ms; an invalid access gets SIGSEGV.](/figures/tlb/faults.svg "Minor faults are cheap and constant. Major faults are disk I/O on the critical path.")

### Minor faults (no I/O)

- **First touch of anonymous memory:** allocate a frame, zero it, map it. This is how `malloc`'d memory gets real pages.
- **Copy-on-write:** after `fork()` or for private file mappings, copy the page on first write.
- **Page already in the page cache:** a file page that's in memory but not yet mapped in this process (another process read it, or readahead fetched it).
- **Permission upgrades** for tracking, such as the kernel marking pages read-only to detect writes.

### Major faults (I/O)

- **Memory-mapped file page not in RAM:** read it from storage.
- **Swapped-out page:** read it back from swap.

The faulting thread blocks until the I/O completes. On NVMe that's tens to hundreds of microseconds; on spinning disks it's milliseconds. Readahead and fault-around (mapping neighboring cached pages in one fault) reduce how often this happens.

### Invalid faults

If the address isn't in any region, or the access isn't allowed (a write to read-only code, executing a non-executable page), the kernel sends `SIGSEGV` (or `SIGBUS` for, say, accessing a mapped file beyond its end).

## TLB shootdowns

![Core 0 calls munmap and sends inter-processor interrupts to cores 1 to 3, which run the same process; each flushes the entry with invlpg and acknowledges, while core 0 waits.](/figures/tlb/shootdown.svg "Changing a mapping means stopping every other core that might cache it.")

Each core's TLB is private, and on x86 hardware doesn't keep them coherent. If one thread unmaps or changes permissions on a page (`munmap`, `mprotect`, `madvise(MADV_DONTNEED)`, page migration, swapping out), other cores running threads of the same process may still hold the old translation. The kernel must:

1. Update the page table.
2. Send an **inter-processor interrupt (IPI)** to every core that might have the mapping cached.
3. Wait for each core to invalidate the entry and acknowledge.

This costs microseconds on each core involved, and the initiating thread waits for all of them. Programs with many threads that frequently map and unmap memory (memory allocators returning memory to the OS, some garbage collectors) can spend significant time in shootdowns. Allocators like jemalloc and tcmalloc batch and delay returning memory partly for this reason. Newer hardware adds broadcast invalidation instructions (ARM's TLBI with inner-shareable scope, AMD's `INVLPGB`) that reduce the need for IPIs.

## Where it matters

| Workload | TLB / fault concern | Typical fix |
| --- | --- | --- |
| **Large in-memory databases** (Redis, Memcached, Postgres buffers) | TLB misses on random access | Huge pages (explicit or THP in `madvise` mode) |
| **JVMs with big heaps** | GC scanning the heap misses TLB | `-XX:+UseLargePages` / THP |
| **VMs** | Two-dimensional page walks (up to 24 memory reads) | Huge pages in both guest and host |
| **Latency-sensitive services** | Major faults from swap or cold mmap | Disable swap or `mlock`, pre-fault memory |
| **Memory allocators** | Shootdowns when returning memory | Batching, delayed purging |
| **Databases using mmap** | Unpredictable major faults and eviction | Manage your own buffer pool |

### Use case walk-through: p99 latency spikes with no CPU spike

A trading gateway shows rare 3 ms latency spikes. CPU usage is flat.

1. **Measure faults.** `perf stat -e page-faults,major-faults -p <pid>` shows a handful of major faults per minute that line up with the spikes.
2. **Find the source.** `perf record -e major-faults` shows the faults in a rarely used configuration table read from a memory-mapped file, and in heap pages swapped out overnight.
3. **Pre-fault and lock.** At startup, the service touches every page it will need and calls `mlockall(MCL_CURRENT | MCL_FUTURE)` so nothing gets swapped out. Alternatively, `MAP_POPULATE` pre-faults a mapping.
4. **Reduce TLB misses.** The order book lives in a 2 GiB arena backed by explicit 2 MiB huge pages, shrinking its translations from 524,288 PTEs to 1,024.
5. **Result.** The spikes disappear and median latency improves slightly too, from fewer page walks.

## Pitfalls

- **Ignoring dTLB misses when profiling.** `perf stat -e dTLB-load-misses` can reveal that a "memory-bound" workload is really translation-bound.
- **THP `always` mode on latency-sensitive systems:** compaction and `khugepaged` can add stalls. Test `madvise` mode.
- **Counting all page faults as bad.** Minor faults are normal and cheap. Watch **major** faults.
- **Relying on `mmap` for a database buffer pool.** You lose control over eviction and get unpredictable major faults and shootdowns. See "Are You Sure You Want to Use MMAP in Your DBMS?"
- **Churning mappings in multithreaded code.** Repeated `mmap`/`munmap` of temporary buffers causes shootdowns. Reuse buffers.

> [!TIP]
> On Linux, `/proc/<pid>/stat` fields 10 and 12 are cumulative minor and major fault counts, and `/usr/bin/time -v` prints both for a single command.

## Discussion questions

1. Why does a TLB miss cost more inside a virtual machine than on bare metal?
2. A hash table lookup misses the CPU cache. How many DRAM accesses might it take with 4 KiB pages vs 2 MiB pages?
3. Why do PCIDs/ASIDs matter more after the Meltdown mitigations?
4. When is a page fault the *intended* behavior of a program?
5. Why can't the kernel simply update the page table and let other cores notice the change?
6. What are the downsides of backing all memory with huge pages?

## FAQ

### Is a page fault an error?

Usually not. Most page faults are the kernel lazily setting up memory: zero-filling a new page, copying a COW page, or mapping a cached file page. Only faults on invalid addresses or forbidden accesses are errors, and those turn into `SIGSEGV` or `SIGBUS`.

### How do I see TLB misses?

On Linux, `perf stat -e dTLB-loads,dTLB-load-misses,iTLB-load-misses` counts them, and on Intel, `perf stat -M` exposes metrics such as the fraction of cycles spent in page walks. On a large-memory random-access workload, compare runs with and without huge pages.

### Does the TLB have to be flushed on every context switch?

Not on modern hardware. With PCID (x86) or ASID (ARM) tags, entries from different address spaces coexist. Switching between threads of the **same** process never needs a flush, since they share page tables.

### What does mlock do?

It pins pages in RAM: they are faulted in immediately and never swapped out. Real-time and latency-critical programs use `mlockall` to avoid major faults. It's limited by `RLIMIT_MEMLOCK`, because locked memory can't be reclaimed.

### What is fault-around?

When a file-backed page faults, Linux also maps nearby pages that are already in the page cache (by default 64 KiB worth), so sequential access through an mmap takes far fewer faults.

## Key takeaways

- The **TLB** caches virtual-to-physical translations. Hits are nearly free, and misses trigger a **hardware page walk**.
- **TLB reach** (entries × page size) is small with 4 KiB pages. **Huge pages** increase it 512× and help large random-access workloads.
- **Page faults** are mostly normal: **minor** faults cost about a microsecond, **major** faults wait on storage, and **invalid** faults kill the process.
- **Major faults** cause latency spikes without CPU spikes. Pre-fault, lock, or avoid swap for latency-critical services.
- Changing mappings requires **TLB shootdowns** via IPIs, which can limit scalability for code that churns mappings.

## References

1. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapter 19: [Paging: Faster Translations (TLBs)](https://pages.cs.wisc.edu/~remzi/OSTEP/vm-tlbs.pdf).
2. A. Basu, J. Gandhi, J. Chang, M. Hill, M. Swift. [Efficient Virtual Memory for Big Memory Servers](https://research.cs.wisc.edu/multifacet/papers/isca13_direct_segment.pdf). *ISCA 2013*.
3. A. Crotty, V. Leis, A. Pavlo. [Are You Sure You Want to Use MMAP in Your Database Management System?](https://db.cs.cmu.edu/papers/2022/cidr2022-p13-crotty.pdf) *CIDR 2022*.
4. Linux kernel docs. [Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html) and [HugeTLB Pages](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html).
5. U. Drepper. [What Every Programmer Should Know About Memory](https://people.freebsd.org/~lstewart/articles/cpumemory.pdf), section 4.3: Optimizing TLB Usage.
6. N. Amit. [Optimizing the TLB Shootdown Algorithm with Page Access Tracking](https://www.usenix.org/conference/atc17/technical-sessions/presentation/amit). *USENIX ATC 2017*.
7. Linux man pages. [mlock(2)](https://man7.org/linux/man-pages/man2/mlock.2.html), [perf-stat(1)](https://man7.org/linux/man-pages/man1/perf-stat.1.html).

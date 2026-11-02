---
summary: How 2 MiB and 1 GiB pages cut TLB misses and page-table overhead, the difference between explicit hugetlbfs pages and transparent huge pages, why THP sometimes causes latency spikes and memory bloat, and how databases, JVMs, VMs and allocators use huge pages well.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** With 4 KiB pages, a TLB with ~1,500 entries covers only ~6 MiB, and mapping 1 GiB takes 262,144 page-table entries. **Huge pages** (2 MiB, or 1 GiB on x86-64) map the same memory with **512× (or 262,144×) fewer entries**: fewer TLB misses, shorter page walks, less page-table memory and fewer page faults. Linux offers two mechanisms. **Explicit huge pages** (`hugetlbfs`, `MAP_HUGETLB`) are **reserved** up front, guaranteed and never swapped, and applications must ask for them (Oracle, PostgreSQL's `huge_pages`, DPDK, VM hypervisors). **Transparent Huge Pages (THP)** let the kernel back ordinary anonymous memory with 2 MiB pages automatically, best effort, either at fault time or later via `khugepaged`. THP is convenient but has costs: it needs **physically contiguous** free memory, which leads to **compaction stalls**; it can **bloat** memory by using 2 MiB where a few KB were touched; and it interacts badly with `fork()`-based snapshots. That's why Redis, MongoDB and others have recommended disabling it, and why `madvise` mode, opting in only for regions that benefit, is a common middle ground.

## The problem: page tables don't scale with memory

Every memory access needs a virtual-to-physical translation. With 4 KiB pages:

- A process using 100 GB needs ~26 million page-table entries (about 200 MB of page tables).
- The TLB covers a few MB, so random access over large memory misses the TLB almost constantly, and each miss is a multi-level page walk.
- Faulting in 100 GB takes 26 million page faults.

Bigger pages fix all three, at the price of coarser granularity.

## How huge pages work

![Rows for mapping 1 GiB: 4 KiB pages need 262,144 entries and a 4-level walk, TLB covers about 6 MiB; 2 MiB pages need 512 entries and a 3-level walk, TLB covers about 3 GiB; 1 GiB pages need 1 entry. A bar shows one 2 MiB page as 512 contiguous 4 KiB frames.](/figures/huge-pages/sizes.svg "A huge page is a leaf entry higher up the page-table tree.")

On x86-64, a page-table walk normally goes through four levels down to a 4 KiB page. A **2 MiB page** is simply a leaf entry one level up, in the page directory (PMD): the walk stops early, and one TLB entry covers 2 MiB. A **1 GiB page** stops one level higher still (PUD). ARM64 supports similar sizes (and with 64 KiB base pages, 512 MiB huge pages). Requirements:

- the physical memory must be **contiguous** (512 adjacent 4 KiB frames for 2 MiB),
- and **aligned** to the page size, both physically and virtually.

## Explicit huge pages vs THP

![Comparison table: hugetlbfs pages are reserved and guaranteed, not swappable, must be requested by the app, risk unused reserved memory, and are used by Oracle, PostgreSQL, DPDK and VMs; THP is automatic and best effort, swappable after splitting, needs no app changes, risks compaction stalls and bloat, and is used by JVMs, general apps and tcmalloc.](/figures/huge-pages/kinds.svg "Reserved and predictable, or automatic and opportunistic.")

### Explicit: hugetlbfs

- Reserve a pool: `vm.nr_hugepages = 4096` (8 GiB of 2 MiB pages), or at boot with `hugepages=` (and `hugepagesz=1G` for 1 GiB pages, which usually must be reserved at boot while memory is still unfragmented).
- Applications map them with `mmap(MAP_HUGETLB)`, `shmget(SHM_HUGETLB)`, or files on a `hugetlbfs` mount.
- They're **pinned**: never swapped, never split. Reserved memory is unavailable to the rest of the system even when unused.
- Users: Oracle SGA, PostgreSQL (`huge_pages = try` or `on`) for shared buffers, DPDK packet buffers, QEMU/KVM guest memory, and Kubernetes pods requesting `hugepages-2Mi` resources.

### Transparent Huge Pages

![Five steps: a page fault in an eligible region; if a free 2 MiB block exists, zero and map it; otherwise the defrag setting decides between compaction, deferral or 4 KiB fallback; khugepaged later collapses small pages into huge ones; under memory pressure huge pages can be split.](/figures/huge-pages/thp-flow.svg "THP tries to use huge pages wherever it can, and falls back when it can't.")

- Controlled by `/sys/kernel/mm/transparent_hugepage/enabled`: `always` (any suitable anonymous region), `madvise` (only regions marked with `madvise(MADV_HUGEPAGE)`), or `never`.
- On a page fault in an eligible, 2 MiB-aligned region, the kernel tries to allocate a huge page and maps it with one entry.
- If no contiguous 2 MiB block is free, the **defrag** setting decides: compact memory synchronously (can stall the faulting thread for milliseconds), wake background compaction and fall back to 4 KiB now, or just fall back.
- **khugepaged** scans eligible regions in the background, copying 512 small pages into a new huge page ("collapse").
- Huge pages can be **split** back into 4 KiB pages when needed (partial `munmap`, swap-out, memory pressure).
- Since Linux 6.8, **multi-size THP (mTHP)** also allows intermediate sizes (16 KiB, 64 KiB...), useful on ARM's contiguous-PTE feature and for regions too small for 2 MiB.
- THP for page-cache (file) pages is supported by some filesystems and for executables (`CONFIG_READ_ONLY_THP_FOR_FS`), so hot code can also use huge pages.

## The costs of THP

- **Compaction stalls:** to create contiguous 2 MiB blocks, the kernel migrates pages around. Done synchronously during a page fault, this adds latency spikes, often milliseconds.
- **Memory bloat:** touching one byte of a fresh 2 MiB-aligned region allocates 2 MiB. Sparse data structures, many small arenas, or allocators that free memory in pieces smaller than 2 MiB can use much more RSS than with 4 KiB pages.
- **Zeroing cost:** each huge page fault zeroes 2 MiB at once, which is fine for throughput but a latency blip.
- **khugepaged CPU** and occasional lock contention while collapsing pages.
- **fork() and copy-on-write:** historically, a write after `fork` copied a full 2 MiB page. Since Linux 5.8 the kernel splits the mapping and copies 4 KiB, but THP still makes fork-heavy patterns (Redis `BGSAVE`) slower and more memory-hungry. Redis warns at startup when THP is set to `always`.

## Where they pay off

![Illustrative effects: random access over 100 GB −10% to −30% run time; large JVM heap −5% to −15%; VM guest memory −10% or more; small cache-friendly working set about 0%; fork-heavy or sparse memory like Redis gets latency spikes and bloat.](/figures/huge-pages/impact.svg "Huge pages help big, randomly accessed memory, and hurt sparse or fork-heavy memory.")

| Workload | Recommendation |
| --- | --- |
| **Large in-memory databases** (Oracle, PostgreSQL shared buffers) | Explicit huge pages for the shared memory pool |
| **Redis, MongoDB (older versions)** | Disable THP or set `madvise`; Redis forks for snapshots |
| **JVMs with large heaps** | `-XX:+UseTransparentHugePages` (with THP in `madvise` mode) or `-XX:+UseLargePages` |
| **VMs** | Back guest memory with huge pages on the host, and use them in the guest too (nested page walks are expensive) |
| **DPDK / SPDK** | Explicit huge pages (required) for DMA-able buffers |
| **Allocators** | tcmalloc's Temeraire packs allocations into huge pages; jemalloc has THP-aware options |

### Use case walk-through: random p99 spikes after an OS upgrade

After moving to a new OS image, a latency-sensitive service sees p99 spikes of 5–20 ms every few minutes, with no change in code.

1. **Correlate.** The spikes line up with rising `compact_stall` and `thp_fault_alloc` counters in `/proc/vmstat`. The new image set THP `enabled=always` and `defrag=always`.
2. **Understand.** Request threads fault in new heap memory. With fragmented free memory, each such fault may trigger synchronous compaction before returning.
3. **Fix.** Set `enabled=madvise` and `defrag=defer+madvise`. Only regions that ask for huge pages get them, and those use background compaction.
4. **Keep the benefit where it helps.** The service's big lookup table is allocated with `madvise(MADV_HUGEPAGE)` at startup, after which it's read-only. The table keeps its TLB benefits, and the general heap stops stalling.
5. **Verify.** `AnonHugePages` in `/proc/meminfo` shows the table backed by huge pages, and `compact_stall` stops increasing during traffic.

## Pitfalls

- **THP `always` + `defrag=always`** on latency-sensitive systems.
- **Reserving too many explicit huge pages**: they're unavailable for anything else, and the OOM killer can strike while gigabytes sit reserved and unused.
- **Expecting huge pages after hours of uptime**: fragmentation may make 2 MiB blocks (and especially 1 GiB) impossible to find. Reserve at boot.
- **Sparse or fragmented heaps** under THP, which bloat RSS.
- **Misaligned regions**: memory that isn't 2 MiB-aligned can't use huge pages. Allocators and `mmap` hints matter.
- **Measuring only throughput**: THP problems usually show up in tail latency and RSS.

> [!TIP]
> `grep -i huge /proc/meminfo` shows explicit pool usage (`HugePages_Total`, `HugePages_Free`) and THP usage (`AnonHugePages`). `grep thp /proc/vmstat` and `grep compact /proc/vmstat` show THP allocations, fallbacks and compaction stalls.

## Discussion questions

1. Why does a 2 MiB page need physically contiguous memory, and why does that get harder over time?
2. When would you choose explicit huge pages over THP?
3. How can THP make a process use more memory than with 4 KiB pages?
4. Why do VMs benefit especially from huge pages?
5. What do the THP `madvise` modes trade off compared with `always`?
6. How does a huge-page-aware allocator like tcmalloc's Temeraire improve on plain THP?

## FAQ

### Do huge pages help every program?

No. Programs with small or cache-friendly working sets rarely miss the TLB, so they see little benefit, and sparse memory can get worse. Huge pages help large, randomly accessed memory: databases, analytics, big heaps, VMs.

### Can huge pages be swapped?

Explicit hugetlbfs pages can't. THP pages can be: the kernel splits them into 4 KiB pages first (or, in newer kernels, can swap some THPs whole).

### How do I check whether my process uses THP?

Look at `AnonHugePages` in `/proc/<pid>/smaps_rollup` (or per mapping in `smaps`). For explicit pages, the mapping is backed by `hugetlbfs` and counted in `/proc/meminfo`'s `HugePages_*` fields.

### Are huge pages related to "large pages" on Windows?

Yes, the same hardware feature. Windows calls them large pages, requires the "Lock pages in memory" privilege, and allocates them with `VirtualAlloc(MEM_LARGE_PAGES)`, similar to explicit huge pages on Linux.

### What page size does Apple Silicon use?

macOS on Apple Silicon uses 16 KiB base pages, which quadruples TLB reach compared with 4 KiB. Some Linux ARM64 distributions offer 16 KiB or 64 KiB base-page kernels for similar reasons.

## Key takeaways

- **Huge pages** (2 MiB, 1 GiB) cut **TLB misses**, **page-walk depth**, **page-table memory** and **page faults** for large memory.
- **Explicit (hugetlbfs)**: reserved, guaranteed and pinned, for databases, DPDK and VMs. **THP**: automatic, best effort, for general workloads.
- THP's costs are **compaction stalls**, **memory bloat** and **fork interactions**. `madvise` mode is the common compromise.
- Huge pages need **contiguous, aligned** physical memory, so reserve early and watch fragmentation.
- Measure **tail latency, RSS and `/proc/vmstat` counters**, not just throughput.

## References

1. Linux kernel docs. [Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html).
2. Linux kernel docs. [HugeTLB Pages](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html).
3. A. H. Hunter et al. [Beyond malloc efficiency to fleet efficiency: a hugepage-aware memory allocator](https://www.usenix.org/conference/osdi21/presentation/hunter). *OSDI 2021*.
4. Y. Kwon et al. [Coordinated and Efficient Huge Page Management with Ingens](https://www.usenix.org/conference/osdi16/technical-sessions/presentation/kwon). *OSDI 2016*.
5. Redis docs. [Diagnosing latency issues: latency induced by transparent huge pages](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/).
6. PostgreSQL docs. [Linux Huge Pages](https://www.postgresql.org/docs/current/kernel-resources.html#LINUX-HUGE-PAGES).
7. M. Gorman. [Huge pages part 1 (Introduction)](https://lwn.net/Articles/374424/). *LWN*, 2010.

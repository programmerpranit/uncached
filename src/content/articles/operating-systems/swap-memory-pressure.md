---
summary: What actually happens when a Linux machine runs low on memory. Covers free-memory watermarks, kswapd and direct reclaim, why file and anonymous pages cost different amounts to evict, what swappiness really means, zswap and zram, PSI, and how to tell parked cold pages apart from thrashing.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** On Linux, "free" memory is meant to be small. Unused RAM goes to the **page cache**, and the kernel **reclaims** pages when it needs them back. Reclaim is driven by per-zone **watermarks**. Below *low*, the background thread **kswapd** evicts pages. Below *min*, the allocating thread does **direct reclaim** itself and stalls, which is where latency spikes come from. Evictions differ in cost:
>
> - A **clean file page** can be dropped and re-read later.
> - A **dirty file page** must be written back first.
> - An **anonymous page** (heap, stack) can only go to **swap**.
>
> Without swap, anonymous memory is pinned, so under pressure the kernel evicts file pages instead, including the code of running programs. That is why a swapless box can grind to a halt before the OOM killer acts. `vm.swappiness` sets the *relative cost* of swapping versus dropping cache. It is not a usage threshold. Modern practice:
>
> - Keep a modest swap, often compressed (**zswap**/**zram**), so cold pages have somewhere to go.
> - Watch swap-in rate and **PSI** stall time, not swap used.
> - Kill early with a PSI-based userspace OOM daemon (systemd-oomd) rather than letting the system thrash.

## The problem: RAM is a cache, and caches fill up

A long-running server's memory looks "full" almost immediately. Every file it reads stays in the page cache in case it's needed again. That's good: unused RAM is wasted RAM. But it means every new allocation eventually has to take a page from something else. The questions are **which** page to take, **who** pays the cost of taking it, and **what happens** when nothing cheap is left.

Swap is often misread as "emergency extra RAM for when you run out". It's better understood as **somewhere to put anonymous pages that aren't being used**, so the RAM they occupied can hold something hotter.

## How reclaim works

![Free memory watermarks: below low kswapd reclaims in the background, below min allocating threads do direct reclaim, and if reclaim fails the OOM killer runs](/figures/swap/watermarks.svg "Watermarks decide who pays for reclaim: a background thread, or your request.")

Each memory zone has three watermarks, derived from `vm.min_free_kbytes` and `vm.watermark_scale_factor`:

- **Above low:** allocations come straight off the free lists. This is the fast path.
- **Below low:** the per-node **kswapd** thread wakes up and reclaims in the background until free memory is back above **high**. Applications don't notice.
- **Below min:** the allocation can't wait for kswapd, so the **allocating thread reclaims directly**. It scans LRU lists, may start writeback or swap-out, and only then gets its page. This **direct reclaim** shows up as unexplained latency in otherwise-idle code paths.
- **Reclaim makes no progress:** the OOM killer runs (see the OOM killer & memory overcommit topic).

So a sudden burst of allocations, faster than kswapd can keep up with, turns into tail latency. Raising `watermark_scale_factor` widens the gap between *low* and *min*, so kswapd starts earlier and direct reclaim happens less often.

### What gets evicted

![Page types and reclaim cost: clean file pages are dropped, dirty file pages written back, anonymous pages need swap, and mlocked pages are unevictable](/figures/swap/reclaim-choices.svg "Eviction cost depends on whether the data exists anywhere else.")

The kernel keeps separate **LRU lists** for file-backed and anonymous pages, each split into active and inactive. Recent kernels can use **multi-gen LRU (MGLRU)** instead, which tracks page age in generations. Reclaim takes from the inactive tail:

| Page type | Examples | To evict it | Cost |
|---|---|---|---|
| Clean file | executables, libraries, read cache | just drop it | a disk read if needed again |
| Dirty file | recently written file data | write back, then drop | a write now, maybe a read later |
| Anonymous | heap, stack, tmpfs, shared memory | write to swap | a swap write now, a swap read later |
| Unevictable | `mlock()`ed pages, ramfs | can't | memory is simply gone |

**`vm.swappiness`** (0–200, default 60) tunes the balance between scanning anon and file lists: it's the relative I/O cost of swap versus filesystem I/O. At 100, the two are treated as equally expensive. Values above 100 make sense with fast swap like zram. It does **not** mean "start swapping at 60% memory used". Even at 0, the kernel will still swap to avoid OOM.

### Why "no swap" can be worse

Without swap, anonymous pages can't be evicted. As memory fills, the only reclaimable pages are file pages. The kernel drops cache, then starts dropping **the executable code and libraries of running processes**. These are clean file pages, so they're "cheap". Then every process faults its own code back in from disk on every few instructions. The machine is technically not out of memory, so the OOM killer doesn't fire, but it's completely unresponsive. This is the classic "box froze for 20 minutes, then a process finally got killed".

With some swap, cold anonymous pages get parked on disk early and quietly. Think of the initialisation data a daemon touched once at startup. That leaves room for the working set and its code to stay resident.

## Pressure stages

![Memory pressure stages from healthy cache reclaim to thrashing, with zswap/zram and PSI-based userspace OOM as mitigations](/figures/swap/pressure-stages.svg "The amount of swap used matters less than how often pages come back.")

1. **Healthy:** reclaim drops cold cache. Nobody notices.
2. **Working set fits:** some cold anonymous pages are swapped out and rarely read back. Swap is "used" but swap-in is near zero. This is fine.
3. **Pressure:** **refaults** rise. Pages evicted recently are needed again, so the working set is larger than RAM.
4. **Thrashing:** most time is spent waiting on swap-in or code refaults. Throughput collapses.

### Measuring it: PSI

**Pressure Stall Information** (`/proc/pressure/memory`, and per-cgroup `memory.pressure`) reports the share of wall time in which tasks were stalled waiting on memory:

```text
some avg10=4.12 avg60=2.03 avg300=0.80 total=1234567
full avg10=1.10 avg60=0.45 avg300=0.12 total=345678
```

- `some` means at least one task was stalled.
- `full` means all non-idle tasks were stalled at once, so no useful work happened.

These numbers describe the user-visible impact, unlike "swap used". `vmstat 1` columns `si`/`so` (swap in/out) and `/proc/vmstat` counters like `workingset_refault_*` and `pgmajfault` round out the picture.

### Compressed swap: zswap and zram

- **zswap** is a compressed cache in front of a swap device. Pages being swapped out are compressed into a RAM pool, and only spill to disk when the pool fills. Many cold pages compress 2–4×, so swap-out costs CPU instead of I/O.
- **zram** is a compressed RAM block device used *as* swap, with no disk at all. Fedora, ChromeOS and Android enable it by default. It's useful on laptops, phones and diskless or flash-wear-sensitive systems.

### Kill early, not late

The kernel OOM killer only acts when reclaim fails completely, which often comes after minutes of thrashing. **Userspace OOM daemons** act on PSI instead: they kill the biggest offender when stall time stays above a threshold. Examples are Meta's **oomd**, **systemd-oomd** (the default on Fedora and Ubuntu desktops) and Android's **lmkd**.

## Where it's used

| System | How it handles memory pressure |
|---|---|
| Meta fleet | swap plus cgroup v2 `memory.high`/`memory.low` and oomd; Senpai-style probing to find real working-set sizes |
| Kubernetes | historically required swap off; `NodeSwap` (LimitedSwap) support has matured since 1.28 |
| Android | zram swap plus lmkd killing background apps based on PSI |
| Fedora / Ubuntu desktop | zram (Fedora) or swapfile, plus systemd-oomd |
| Databases (PostgreSQL, MySQL) | rely on page cache or their own buffer pool; swapping the buffer pool is very bad, so size it to leave headroom |
| JVM / Go services | GC walks the whole heap; a partly swapped heap makes every GC cycle page-fault heavily |

## Use case walk-through: the "random" p99 spikes

A service on a 64 GB host has p99 latency spikes every few minutes, but CPU is low and "free" shows 1 GB free with 40 GB in buff/cache.

1. `/proc/pressure/memory` shows `some avg10` of 3–8%, with bursts. Memory stalls are real.
2. `/proc/vmstat` `allocstall_*` counters climb during spikes. Request threads are doing **direct reclaim**.
3. The cause: a log-shipping job reads large files in bursts, each burst pulls gigabytes into page cache, and the service's allocation bursts hit *min* before kswapd catches up.
4. Fixes, in order of preference:
   - Raise `vm.watermark_scale_factor` (e.g. to 100–200) so kswapd starts earlier.
   - Put the log shipper in a cgroup with `memory.high` so its cache gets reclaimed first.
   - Give the service `memory.low` protection.
5. After the change, `allocstall` stays flat and PSI drops to near zero. Total "free" memory barely changed: what changed is *who* pays for reclaim.

## Pitfalls

- **Reading "free" as available.** Look at `MemAvailable` in `/proc/meminfo`, not `MemFree`. Cache is reclaimable.
- **Treating swap used as an alarm.** Swap used with near-zero swap-in is healthy. Alert on PSI and `si` instead.
- **`swappiness=0` as a cure-all.** It shifts reclaim to file pages, including program code, and doesn't stop swapping near OOM.
- **No swap "for performance".** It removes the safety valve for cold anon pages and turns pressure into code-page thrashing.
- **Huge swap on spinning disks.** Enough swap to hold the whole working set only delays OOM while the system crawls. Keep it modest, or compressed.
- **Containers without memory limits.** One cgroup's page cache or leak puts every neighbour into direct reclaim.

> [!TIP]
> For services, set cgroup `memory.high` (throttle and reclaim) a bit below `memory.max` (hard OOM). Hitting `memory.high` slows the offender down and makes it reclaim its own pages, instead of OOM-killing it outright or dragging the whole host into reclaim.

## Discussion questions

1. Why can a system with zero swap freeze for minutes before the OOM killer fires, and what kind of pages is it evicting during that time?
2. What's the difference between kswapd and direct reclaim, and which one shows up in your latency graphs?
3. `vm.swappiness=100` and zram: why does a higher value make sense when swap is in compressed RAM?
4. A host shows 30 GB of swap used. What two other metrics would you check before deciding whether that's a problem?
5. How would you design a userspace OOM policy that's less disruptive than the kernel's, and what signal would it act on?
6. Why are garbage-collected runtimes especially sensitive to having part of their heap swapped out?

## FAQ

### Should production servers have swap?

Usually yes, a modest amount: a few GB, or zram/zswap, so cold anonymous pages have somewhere to go and the system degrades gradually instead of falling off a cliff. Pair it with PSI monitoring or a userspace OOM daemon so pressure ends in a clean kill, not prolonged thrashing. Latency-critical systems that size memory carefully sometimes disable it, but they then need strict cgroup limits.

### What does swappiness actually control?

The ratio at which reclaim scans anonymous versus file LRU lists, which reflects the assumed relative cost of swap I/O versus filesystem I/O. It's not a percentage threshold. Lower values favour dropping cache. Higher values favour swapping anon pages, and that is sensible when swap is fast (zram, NVMe).

### Is zram better than a swap file?

They solve different problems. zram trades CPU for avoiding disk I/O entirely, which is great for memory-constrained devices and SSD wear. A swap file on fast storage can hold far more. zswap combines them: a compressed RAM cache in front of a disk swap device.

### Why did my process get slow but not killed?

It was probably under memory pressure: refaulting its own pages, or doing direct reclaim. That pressure was never severe enough for reclaim to *fail*, which is the only time the kernel OOM killer acts. PSI will show it. A cgroup `memory.high` limit can produce the same behaviour intentionally, through throttling.

### What's a "refault"?

A page that was evicted and then accessed again soon after. The kernel tracks this with "shadow entries" left in the page cache's tree. A high refault rate means the working set doesn't fit and reclaim is evicting pages that are still needed. That's the leading indicator of thrashing, and the kernel also uses it to rebalance the active and inactive lists.

## Key takeaways

- Linux uses spare RAM as cache, so reclaim is constant and normal. Watermarks decide whether kswapd or your thread pays for it.
- File pages can be dropped or written back. Anonymous pages need swap. Without swap, the kernel evicts program code instead.
- `swappiness` is a cost ratio, not a usage threshold.
- Measure pressure with PSI, swap-in rate and refaults, not "free" or "swap used".
- Compressed swap (zswap/zram) and PSI-based userspace OOM killers are the modern defaults for degrading gracefully.

## References

- Linux kernel documentation: [Memory management concepts](https://docs.kernel.org/admin-guide/mm/concepts.html)
- Linux kernel documentation: [Documentation for /proc/sys/vm](https://docs.kernel.org/admin-guide/sysctl/vm.html)
- Linux kernel documentation: [PSI: Pressure Stall Information](https://docs.kernel.org/accounting/psi.html)
- Linux kernel documentation: [zswap](https://docs.kernel.org/admin-guide/mm/zswap.html) and [zram](https://docs.kernel.org/admin-guide/blockdev/zram.html)
- Linux kernel documentation: [Multi-Gen LRU](https://docs.kernel.org/admin-guide/mm/multigen_lru.html)
- Chris Down, "In defence of swap: common misconceptions" (2018)
- Johannes Weiner et al., "TMO: Transparent Memory Offloading in Datacenters", ASPLOS 2022
- systemd: [systemd-oomd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd-oomd.service.html)

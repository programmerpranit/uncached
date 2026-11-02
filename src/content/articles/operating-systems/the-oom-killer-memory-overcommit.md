---
summary: Why Linux lets programs allocate more memory than the machine has, what happens when they actually use it, how the OOM killer picks a victim, and how to keep the right processes alive on servers and in containers.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** On Linux, `malloc` and `mmap` usually only **reserve address space**. Physical memory is assigned page by page when it's first **touched**. Because programs routinely reserve far more than they use (thread stacks, heap arenas, `fork()` of large processes), Linux **overcommits** by default: it lets total promised memory exceed RAM plus swap, betting that it won't all be touched. When the bet fails, the shortage shows up at a **page fault**, where there's no way to return an error, so the kernel first **reclaims** (drops cache, swaps, compacts), often **thrashing** for a while, and finally invokes the **OOM killer**, which `SIGKILL`s the process with the highest **oom_score** (mostly its memory share, adjusted by `oom_score_adj`). Containers hit the same mechanism per cgroup at `memory.max`, which is what Kubernetes' **OOMKilled** (exit code 137) means. To stay in control: set memory limits that include all memory (not just heap), protect critical processes with `oom_score_adj`, watch **memory pressure (PSI)**, and consider earlier user-space killers like **systemd-oomd**.

## The problem: allocation isn't usage

```
char *p = malloc(10UL << 30);   // "10 GB" — succeeds instantly on a 4 GB laptop
```

The call succeeds because the kernel only records a 10 GB region in the process's memory map. No physical memory is used until the program writes to the pages. This is **demand paging**, and it's everywhere:

- Each thread reserves an 8 MiB stack (glibc default) but typically touches a few KB.
- Allocators (glibc arenas, jemalloc, Go, the JVM) reserve large regions up front.
- `fork()` of a 20 GB process "duplicates" 20 GB that's shared copy-on-write.
- Programs map large files or sparse arrays they only partly use.

If the kernel required physical backing for every reservation, machines would run out of "memory" while most RAM sat unused.

## Overcommit

![Bars on a 16 GiB machine: RAM plus swap 16 GiB; committed memory 41 GiB; actually touched 11 GiB.](/figures/oom/overcommit.svg "Commitments can exceed what exists, as long as actual use doesn't.")

Linux tracks **committed memory** (`Committed_AS` in `/proc/meminfo`): the total that processes could touch. `vm.overcommit_memory` decides how strict to be:

![Three policies: 0, heuristic, refuses only obviously impossible requests; 1, always, never refuses; 2, strict, refuses when commitments exceed swap plus RAM times overcommit_ratio.](/figures/oom/modes.svg "Mode 0 is the default on most systems.")

- **0, heuristic (default):** refuse only allocations that are obviously impossible (bigger than all RAM and swap). Nearly everything succeeds.
- **1, always:** never refuse. Redis recommends this, so `fork()` for background saves never fails on a large dataset.
- **2, strict:** refuse once `Committed_AS` would exceed swap + RAM × `overcommit_ratio` (50% by default). `malloc` can return `NULL`, and `fork` can fail with `ENOMEM`. Failures happen at a point where programs can handle them, but programs that over-reserve run out of "memory" early.

Most systems run mode 0, accepting that the kernel will occasionally have to deal with running out at fault time.

## Running out

![Five stages: free memory falls below the watermark and kswapd reclaims; allocation can't be satisfied, so the faulting thread reclaims directly; reclaim makes no progress and the system thrashes; out of memory, the OOM killer sends SIGKILL; memory is freed and the allocation retried.](/figures/oom/path.svg "The kernel tries hard before killing anything, and that effort can itself freeze the machine.")

When a page fault needs a frame and free memory is low:

1. **Background reclaim.** Below the low **watermark**, the `kswapd` thread frees memory: drops clean page cache, writes back dirty pages, swaps out anonymous pages (if swap exists).
2. **Direct reclaim.** If memory is still short, the allocating thread itself reclaims and compacts, so allocations stall.
3. **Thrashing.** With almost everything in use, the kernel evicts executable code and hot cache, which immediately faults back in. The machine becomes unresponsive, sometimes for minutes, with heavy I/O wait. This is often the worst phase for users.
4. **OOM.** When reclaim repeatedly fails to make progress, the kernel declares out-of-memory and runs the **OOM killer**.
5. The victim gets `SIGKILL` (it can't be caught). Since Linux 4.6, the **OOM reaper** frees the victim's memory right away, without waiting for it to exit. The allocation is retried.

The kernel log records it:

```
Out of memory: Killed process 31337 (java) total-vm:12582912kB, anon-rss:8123456kB, ...
```

## Choosing a victim

![Examples: java with 8 GiB RSS and adj 0 scores about 500; postgres with adj −900 scores about 0; a batch job with adj +500 scores about 620; sshd with adj −1000 is never killed.](/figures/oom/score.svg "The process with the highest score dies.")

Each process has an **`oom_score`** (`/proc/<pid>/oom_score`, 0–1000), computed mainly from its resident memory, swap and page-table usage as a fraction of available memory, plus **`oom_score_adj`** (−1000 to +1000):

- `−1000` makes a process **unkillable** by the OOM killer (use sparingly: if everything is protected, the kernel panics or kills something worse).
- Negative values protect important daemons (databases, `sshd`, the container runtime).
- Positive values mark expendable work (batch jobs, caches that can be rebuilt).

The goal is to free the most memory by killing the fewest, least important processes, but "biggest" is often the main application.

### OOM in cgroups and containers

When a cgroup reaches `memory.max`, the kernel reclaims within that cgroup first. If that fails, it runs the OOM killer **scoped to that cgroup**, even if the host has plenty of free memory. Setting `memory.oom.group = 1` kills the whole group together, which is useful when a partially killed set of processes would be broken anyway.

**Kubernetes:**

- A container that exceeds its **memory limit** is OOM-killed by the kernel: status **OOMKilled**, exit code **137** (128 + `SIGKILL`'s 9), then restarted per its policy.
- When the **node** runs low, the kubelet **evicts** pods (BestEffort first, then Burstable using more than their requests) before the kernel's OOM killer has to act.
- The kubelet sets `oom_score_adj` by QoS class: **Guaranteed** −997, **BestEffort** 1000, **Burstable** in between based on requests.

## Acting earlier: pressure-based killers

The kernel's OOM killer acts late, after thrashing. **PSI** (pressure stall information, `/proc/pressure/memory` and per-cgroup `memory.pressure`) reports the share of time tasks were stalled waiting for memory. User-space daemons use it to act earlier and more selectively:

- **systemd-oomd** (default on Fedora and Ubuntu desktops) kills the cgroup with the most reclaim activity when pressure stays high.
- **earlyoom** kills the largest process when available memory and swap drop below thresholds.
- **Android's lmkd** kills background apps by importance based on pressure.
- **Meta's oomd** (the origin of systemd-oomd) uses PSI with per-workload policies in production.

## Where it matters

| Situation | What to do |
| --- | --- |
| **Databases** (Postgres, MySQL) | Protect with negative `oom_score_adj`. Postgres docs recommend strict overcommit (mode 2) or protecting the postmaster |
| **Redis** | `vm.overcommit_memory = 1` so fork-based snapshots succeed; leave headroom for copy-on-write |
| **JVM in containers** | Size heap with `MaxRAMPercentage`, and account for metaspace, threads, direct buffers |
| **Kubernetes** | Set requests = limits for critical pods (Guaranteed QoS); watch OOMKilled events |
| **Desktops** | systemd-oomd or earlyoom to avoid minutes-long freezes |
| **Build machines** | Limit parallel jobs to memory, not just cores (`make -j` with heavy linkers) |

### Use case walk-through: the mystery restarts

A Node.js service in Kubernetes restarts a few times a day, with no errors in its logs.

1. **Check status.** `kubectl describe pod` shows `Last State: Terminated, Reason: OOMKilled, Exit Code: 137`. The process got `SIGKILL`, so it couldn't log anything.
2. **Measure real usage.** `container_memory_working_set_bytes` climbs steadily to the 1 GiB limit, then drops at each restart. The V8 heap is only 600 MiB.
3. **Find the rest.** Native memory from a compression library and large `Buffer`s (outside the V8 heap) grows with traffic. Page cache from writing temp files is also charged to the cgroup.
4. **Fix.** Set `--max-old-space-size` to ~60% of the limit, stream large payloads instead of buffering them, delete temp files promptly, and raise the limit to cover measured peak native usage.
5. **Detect earlier.** Alert on working set > 85% of limit and on `memory.pressure`, not just on restarts.

## Pitfalls

- **Trusting `malloc` returning non-NULL** as proof that memory exists. Under overcommit, failure arrives later as an OOM kill.
- **Container limits sized to the heap only**: runtimes, thread stacks, native libraries and page cache all count.
- **Disabling swap and overcommit without thought**: strict mode can make programs fail to start or fork. Test your workload under the policy.
- **Protecting everything** with `oom_score_adj = −1000`. Then the kernel has nothing to kill.
- **Ignoring thrashing.** A machine that's "up" but unusable for 10 minutes is often worse than a quick kill. Use PSI-based killers or memory limits.
- **Assuming exit code 137 always means OOM.** It means `SIGKILL`. Check `dmesg`, the kubelet events or the cgroup's `memory.events`.

> [!TIP]
> `dmesg -T | grep -i -A5 "out of memory"` shows recent OOM kills with the memory state at the time, and `cat /sys/fs/cgroup/<group>/memory.events` counts `oom` and `oom_kill` events for a cgroup.

## Discussion questions

1. Why can't the kernel just make `malloc` fail when memory runs out?
2. What are the trade-offs of `vm.overcommit_memory = 2`?
3. Why might a server freeze for minutes before the OOM killer acts?
4. How should a database's `oom_score_adj` compare with a batch job's, and why?
5. Why can a container be OOM-killed when the node has free memory?
6. How does PSI let user-space killers act earlier than the kernel?

## FAQ

### Does swap prevent OOM kills?

It delays them and gives the kernel somewhere to put cold anonymous pages. With heavy swapping, performance may collapse before the OOM point. Small amounts of swap are often useful for evicting truly cold pages. Kubernetes historically required swap off, and has added swap support in recent versions.

### Can a process catch an OOM kill?

No. The OOM killer sends `SIGKILL`, which can't be caught or ignored. If you need to clean up, react earlier: watch memory usage or pressure and shed load before reaching the limit.

### Why did the OOM killer kill my main app instead of the process that was leaking?

The score favors the process using the most memory, which is often the main app, not the newest or the leaking one. Use `oom_score_adj` to express priorities, and memory limits per service so a leak kills only the leaking service.

### What does panic_on_oom do?

`vm.panic_on_oom = 1` makes the kernel panic (and typically reboot) instead of killing a process. Some clusters prefer a clean reboot and failover over a node in an unknown state.

### Is overcommit unique to Linux?

No, but policies differ. Windows doesn't overcommit: every committed page must be backed by RAM or the page file, so allocations fail early. macOS and the BSDs overcommit with their own low-memory handling (macOS's jetsam kills apps by priority).

## Key takeaways

- **Allocation reserves address space**. Touching pages uses memory. Linux **overcommits** by default.
- When memory really runs out, the kernel **reclaims**, may **thrash**, then the **OOM killer** `SIGKILL`s the highest **oom_score**.
- **`oom_score_adj`** expresses priorities. **cgroups** scope OOM kills to a container at `memory.max` (exit code 137).
- Size limits for **all** memory (native, stacks, page cache), not just the heap.
- Use **PSI-based** tools (systemd-oomd, earlyoom) and alerts to act before thrashing and kills.

## References

1. Linux kernel docs. [Overcommit Accounting](https://docs.kernel.org/mm/overcommit-accounting.html).
2. Linux kernel docs. [Documentation for /proc/sys/vm](https://docs.kernel.org/admin-guide/sysctl/vm.html) (overcommit, panic_on_oom, watermarks).
3. Linux kernel docs. [PSI: Pressure Stall Information](https://docs.kernel.org/accounting/psi.html).
4. Linux man pages. [proc_pid_oom_score_adj(5)](https://man7.org/linux/man-pages/man5/proc_pid_oom_score_adj.5.html).
5. Kubernetes docs. [Node-pressure Eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/).
6. systemd docs. [systemd-oomd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd-oomd.service.html).
7. PostgreSQL docs. [Linux Memory Overcommit](https://www.postgresql.org/docs/current/kernel-resources.html#LINUX-MEMORY-OVERCOMMIT).
8. J. Corbet. [Taming the OOM killer](https://lwn.net/Articles/317814/). *LWN*, 2009.

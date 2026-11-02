---
summary: How an OS decides which thread runs next, how Linux's Completely Fair Scheduler shares CPU using virtual runtime and weights, why it was replaced by EEVDF in Linux 6.6, and what scheduling means for containers, latency and real-time work.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A CPU scheduler decides which runnable thread gets each core, and for how long. It balances **fairness** (everyone gets their share), **latency** (interactive work responds quickly), **throughput** (few wasted switches) and **cache locality**. From 2007 to 2023, Linux used the **Completely Fair Scheduler (CFS)**: each task accumulates **virtual runtime** (CPU time scaled by its weight, which comes from its **nice** value), runnable tasks are kept in a red-black tree, and the task with the **smallest vruntime** runs next. Linux 6.6 replaced it with **EEVDF** (Earliest Eligible Virtual Deadline First), which keeps the same fairness but adds a **virtual deadline** per task, so latency-sensitive tasks with short time slices get picked sooner without getting more total CPU. Around it sit **real-time classes** (`SCHED_FIFO`, `SCHED_RR`, `SCHED_DEADLINE`), **load balancing** across cores, and **cgroup** controls that turn into container CPU requests and limits, where quota-based **throttling** is a common source of latency.

## The problem: thousands of threads, a few cores

A busy server has thousands of threads and a few dozen cores. Some threads are CPU hogs (a compiler, a batch job), some wake briefly and need to respond fast (a UI thread, an audio thread, a request handler), and some are more important than others. The scheduler must decide, many times a second on every core:

- **Who runs next?** Fairness says the one that's had the least CPU. Responsiveness says the one that just woke up.
- **For how long?** Long slices mean fewer switches and warmer caches. Short slices mean lower latency for everyone waiting.
- **Where?** Keeping a thread on the same core keeps its cache warm, but leaving cores idle while others are overloaded wastes capacity.

Classic textbook algorithms each solve part of this: **FIFO** (simple, terrible latency), **round robin** (fair, ignores priority), **priority scheduling** (can starve low-priority tasks), **multi-level feedback queues** (guess interactivity from behavior; used by older Linux, Windows and BSD schedulers). Linux's answer since 2007 has been proportional-share scheduling.

## How CFS works

![A red-black tree of tasks keyed by vruntime: vim 410 at the root, make 212 and java 780 below, then ssh 95, gcc 300 and db 905. The leftmost, ssh 95, runs next.](/figures/cpu-scheduling/cfs-tree.svg "CFS keeps runnable tasks sorted by how much weighted CPU they've had.")

CFS, written by Ingo Molnar and merged in Linux 2.6.23, models an **ideal multitasking CPU** that runs all runnable tasks simultaneously, each at a fraction of full speed. Real CPUs can't, so CFS tracks how far each task is from its fair share:

1. Each task has a **vruntime**. While it runs, `vruntime += actual_runtime × 1024 / weight`. A task at the default weight (1024) accrues vruntime at wall-clock speed. Heavier tasks accrue it more slowly.
2. Runnable tasks sit in a **red-black tree** ordered by vruntime (one tree per CPU run queue).
3. The scheduler runs the **leftmost** task: the one with the smallest vruntime, which is the one furthest behind its fair share.
4. A task runs until it blocks, or until another task's vruntime is sufficiently smaller (within a target latency and minimum granularity, a few milliseconds).
5. A task that **sleeps** accrues no vruntime, so it would otherwise wake far behind and hog the CPU. CFS places it near the tree's minimum vruntime instead, which gives it a small boost (good for interactivity) without letting it bank unlimited credit.

### Weights and nice values

![Bars: nice 0 vs nice 0 gives 50/50; nice 0 vs nice 1 gives 56/44; nice 0 vs nice 5 gives 75/25; nice −10 vs nice 10 gives 99/1.](/figures/cpu-scheduling/weights.svg "Each nice level multiplies weight by about 1.25, so adjacent levels differ by about 10% of CPU.")

The `nice` value (−20 to +19) maps to a weight through a fixed table: nice 0 is 1024, and each step changes the weight by about 1.25×. A task's share of a CPU is its weight divided by the sum of runnable weights. Shares are **relative**: a single nice-19 task on an idle core still gets 100%.

The same mechanism extends to **groups**. With cgroups, CFS schedules groups first, then tasks within each group (hierarchically), so one container with 1,000 threads can't take 1,000 times the CPU of a container with one thread. **Autogroup** applies this to desktop sessions, so a `make -j64` in one terminal doesn't starve your browser.

## EEVDF: fairness plus latency

CFS is fair over time, but it has no direct way to express "I need small amounts of CPU, *soon*". It relied on wake-up heuristics and tunables that accumulated over the years. In Linux 6.6 (2023), Peter Zijlstra replaced CFS's core with **EEVDF**, an algorithm from a 1995 paper by Ion Stoica and Hussein Abdel-Wahab.

![Three tasks on a virtual-time axis: a batch job with a 3 ms slice and a late deadline; an audio thread with a 0.5 ms slice and the earliest deadline; a web worker that ran ahead of its share and isn't eligible.](/figures/cpu-scheduling/eevdf.svg "EEVDF first filters for tasks that are owed CPU, then picks the most urgent of them.")

EEVDF tracks two things per task:

- **Lag:** the difference between the CPU time the task *should* have received (its fair share) and what it *did* receive. A task with lag ≥ 0 is owed time and is **eligible**. A task with negative lag has run ahead and must wait.
- **Virtual deadline:** the eligible time plus the task's requested **slice** divided by its weight. A task that asks for shorter slices gets earlier deadlines.

The rule: **among eligible tasks, run the one with the earliest virtual deadline**. Shares stay exactly as fair as before, since weight still determines how much CPU each task gets over time. But a latency-sensitive task can request a short slice (via `sched_setattr()`, supported since Linux 6.12) and gets its share in small, frequent pieces, while a batch task gets fewer, longer runs and better cache efficiency. EEVDF also preserves lag across sleeps (with decay), replacing several CFS heuristics with one principled rule.

## The rest of the Linux scheduler

**Scheduling classes**, checked in priority order:

| Class | Policies | Used for |
| --- | --- | --- |
| Deadline | `SCHED_DEADLINE` | Periodic real-time tasks with runtime, deadline and period (EDF + constant bandwidth server) |
| Real-time | `SCHED_FIFO`, `SCHED_RR` | Fixed priorities 1–99. Always preempt normal tasks |
| Fair (EEVDF, formerly CFS) | `SCHED_NORMAL`, `SCHED_BATCH`, `SCHED_IDLE` | Everything else |
| Idle | | Runs when nothing else can |

Real-time tasks can starve the system, so by default Linux reserves 5% of each second for non-RT tasks (`sched_rt_runtime_us = 950000`).

**Load balancing.** Each CPU has its own run queue to avoid lock contention. Periodically, and whenever a CPU goes idle, the scheduler moves tasks between queues, following a hierarchy of **scheduling domains** (SMT siblings, cores sharing a cache, sockets, NUMA nodes), so it prefers moves that lose less cache locality. On wakeup, it picks a CPU near where the task last ran, or near its waker.

**sched_ext** (Linux 6.12) lets you load a scheduling policy written in **BPF** at runtime, so companies and researchers can experiment with custom schedulers without patching the kernel. Meta and Google have both shown scheduling gains from workload-specific policies.

## Containers: requests, limits and throttling

![Four threads in a container limited to 0.4 CPU run for 10 ms at the start of each 100 ms period, then are throttled for 90 ms.](/figures/cpu-scheduling/throttling.svg "A multithreaded app can burn its whole period's quota in a burst and then sit idle while requests wait.")

Kubernetes CPU settings map to cgroup controls:

- **Requests** become `cpu.weight` (proportional shares). They only matter under contention, and never leave CPU idle.
- **Limits** become `cpu.max` (CFS bandwidth control): a **quota** of CPU time per **period**, 100 ms by default. Once a cgroup uses its quota, all its threads are **throttled** until the next period, even if the machine is idle.

A 0.4-CPU limit is 40 ms per 100 ms. A service with 4 busy threads can use that in 10 ms, then wait 90 ms. Average usage looks low, but tail latency spikes by up to the remaining period. Check `nr_throttled` and `throttled_usec` in `cpu.stat`. Many teams set requests but no CPU limits for latency-sensitive services, or use `cpu.max.burst` to allow short bursts.

### Use case walk-through: keeping an API responsive next to batch jobs

An API server and a nightly ETL job share 32-core nodes. During ETL runs, API p99 latency triples.

1. **Measure.** `perf sched latency` shows API threads waiting up to 8 ms in run queues behind ETL threads.
2. **Weight the groups.** Put the ETL in a cgroup with a low `cpu.weight` (or `SCHED_BATCH` / `SCHED_IDLE` for its threads), so it still uses idle CPU but loses under contention.
3. **Use shorter slices for the API** (on Linux 6.12+ with EEVDF), so request threads get picked sooner when they wake.
4. **Avoid limits on the API pod** that could throttle it in bursts. Use requests to guarantee its share instead.
5. **Pin if needed.** For the strictest latency targets, reserve cores with a cpuset so ETL never runs there.
6. **Result.** The ETL finishes about as fast (it still uses all spare CPU), and API latency returns to normal.

## Pitfalls

- **CPU limits on latency-sensitive services**, leading to throttling at low average utilization.
- **Busy-looping `SCHED_FIFO` threads**, which can starve everything else on that core, including kernel threads.
- **Using `nice` to fix starvation between containers**, when cgroup weights are the right tool.
- **Too many runnable threads** for the cores: scheduling latency grows with the queue no matter how fair the scheduler is.
- **Tuning old CFS knobs.** Many `sched_*` tunables were moved to debugfs or removed with EEVDF. Check what your kernel actually supports.

> [!TIP]
> `perf sched record` followed by `perf sched latency` shows, per task, the maximum and average delay between becoming runnable and actually running. That's the number your users feel.

## Discussion questions

1. Why does CFS place a waking task near the minimum vruntime instead of letting it keep its old, smaller value?
2. How does EEVDF give a task lower latency without giving it more CPU?
3. Why are per-CPU run queues better than one global queue, and what problem do they create?
4. When would you use `SCHED_DEADLINE` instead of `SCHED_FIFO`?
5. Why can a container with a 2-CPU limit be throttled on a 64-core machine that's 10% busy?
6. What could a BPF-based scheduler (sched_ext) do better than a general-purpose one?

## FAQ

### Is EEVDF a completely new scheduler?

It replaced CFS's core pick-next logic and some of its heuristics, but kept much of the surrounding machinery: weights, cgroup hierarchy, run queues, load balancing. Many people still call the fair class "CFS". The kernel calls it the fair scheduling class.

### What does nice actually do?

It changes the task's **weight**, and therefore its share of CPU under contention. It doesn't make a task run faster when the CPU is free, and it doesn't affect I/O priority (use `ionice` for that).

### How long is a time slice?

There's no fixed quantum. Under CFS, the scheduler aimed to run every runnable task once per target latency (6 ms by default, scaled with CPU count), with a minimum granularity of 0.75 ms. Under EEVDF, the default slice is about 3 ms, and tasks can request their own.

### Why do real-time priorities exist if the fair scheduler is fair?

Some tasks need guarantees, not fairness: audio, industrial control, network packet processing. Real-time tasks always preempt normal ones. Combined with the PREEMPT_RT patches, merged into mainline Linux in 6.12, they give bounded latency.

### How do Windows and macOS schedule?

Windows uses priority-based preemptive scheduling with 32 priority levels and dynamic boosts for foreground and I/O-completing threads. macOS uses a priority-based scheduler with Quality of Service classes and, on Apple Silicon, places work on performance or efficiency cores by QoS. Both target interactivity more directly than proportional share.

## Key takeaways

- Schedulers trade off **fairness, latency, throughput and locality**.
- **CFS** runs the task with the smallest **weighted virtual runtime**, kept in a red-black tree. **Nice values** set weights, and **cgroups** apply the same weights to groups.
- **EEVDF** (Linux 6.6+) adds **lag-based eligibility** and **virtual deadlines**, so short-slice tasks get lower latency at the same share.
- **Real-time classes** preempt fair tasks. **Load balancing** spreads work across cores while trying to preserve cache locality.
- In containers, **CPU limits throttle** in 100 ms periods and can cause latency spikes. Prefer **requests and weights** for latency-sensitive services.

## References

1. Linux kernel docs. [CFS Scheduler](https://docs.kernel.org/scheduler/sched-design-CFS.html) and [EEVDF Scheduler](https://docs.kernel.org/scheduler/sched-eevdf.html).
2. I. Stoica, H. Abdel-Wahab. *Earliest Eligible Virtual Deadline First: A Flexible and Accurate Mechanism for Proportional Share Resource Allocation*. Technical report, Old Dominion University, 1995.
3. J. Corbet. [An EEVDF CPU scheduler for Linux](https://lwn.net/Articles/925371/). *LWN*, 2023.
4. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapters 7–10 (scheduling, MLFQ, proportional share, multiprocessor).
5. Linux kernel docs. [CFS Bandwidth Control](https://docs.kernel.org/scheduler/sched-bwc.html) and [Deadline Task Scheduling](https://docs.kernel.org/scheduler/sched-deadline.html).
6. Linux kernel docs. [Extensible Scheduler Class (sched_ext)](https://docs.kernel.org/scheduler/sched-ext.html).
7. J.-P. Lozi et al. [The Linux Scheduler: a Decade of Wasted Cores](https://people.ece.ubc.ca/sasha/papers/eurosys16-final29.pdf). *EuroSys 2016*.
8. Kubernetes docs. [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/).

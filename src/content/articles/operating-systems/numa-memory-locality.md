---
summary: Why memory on large servers isn't equally close to every core, how Linux decides which NUMA node a page lives on, and how to place threads and memory so databases, JVMs and VMs don't silently pay for remote access.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** On multi-socket servers (and many large single-socket chips), each socket has its own **memory controller** and **local DRAM**. A core can read any memory, but reaching the **remote** node's memory crosses an interconnect (Intel UPI, AMD Infinity Fabric), costing roughly **1.3–2× the latency** and sharing limited cross-socket bandwidth. This is **Non-Uniform Memory Access (NUMA)**. Linux places each page on the node of the thread that **first touches** it, and the scheduler tries to keep threads near their memory. Problems appear when one thread initializes data that many threads use, when threads migrate across sockets, or when a process grows beyond one node's memory. Tools like `numactl`, `mbind` and cgroup cpusets let you **bind** threads and memory to a node, **interleave** pages across nodes, or run **one instance per socket**. Automatic **NUMA balancing** migrates pages toward the threads using them. Cache-friendly code barely notices NUMA. Memory-bound databases, analytics, JVMs with huge heaps and VMs can lose 20–50% or more to bad placement.

## The problem: not all memory is equally close

Early multiprocessors shared one memory bus, so every CPU had the same memory latency (**UMA**, uniform memory access). As core counts grew, a single memory controller couldn't feed them all. Modern servers put a memory controller on each socket (and often several per chip), each with its own DIMMs.

![Two NUMA nodes, each with four cores, a shared L3 cache and 256 GiB of local DRAM, connected by an interconnect. Local access takes about 80–100 ns; remote access about 130–200 ns.](/figures/numa/topology.svg "Every core can reach all memory, but not at the same cost.")

Memory bandwidth scales with the number of controllers, which is great. But now each piece of memory is **local** to some cores and **remote** to others. A remote access:

- takes longer (typically 1.3–2× local latency),
- uses interconnect bandwidth, which is smaller than local memory bandwidth,
- and can create contention when many cores hammer one node's controller.

The kernel exposes the topology: `numactl --hardware` or `lscpu` lists nodes, their CPUs and memory, and a **distance table** (10 = local, larger = farther). Large single-socket chips can expose multiple nodes too: AMD EPYC with NPS settings, Intel's sub-NUMA clustering.

## How Linux places memory

### First touch

![Bad: one thread initializes all 64 GiB on node 0, so workers on node 1 always go remote and node 0's memory controller saturates. Good: each worker initializes its own half, so memory is split 32/32 across nodes.](/figures/numa/first-touch.svg "Where a page lives is decided when it's first written, not when it's allocated.")

`malloc` and `mmap` only reserve address space. Under the default **local** policy, each page is allocated on the NUMA node of the CPU running the thread that **first faults it in**. That's usually right, since the thread that creates data often uses it, but it fails for a classic pattern: a main thread allocates and zeroes a huge array, then starts workers on every core. All the memory ends up on the main thread's node.

Fixes: initialize data **in parallel**, with each worker touching the part it will use, or set an explicit policy.

### Memory policies

![Four policies: local (default) allocates on the node where the thread runs; bind restricts to given nodes; preferred tries a node and falls back; interleave round-robins pages across nodes.](/figures/numa/policies.svg "Set per process with numactl, or per memory range with mbind.")

- **local** (default): allocate on the current node.
- **bind**: allocate only on these nodes. If they're full, reclaim or fail rather than going remote.
- **preferred**: try this node first, fall back to others.
- **interleave**: spread pages round-robin across nodes. Every thread sees the same average latency, and bandwidth is spread across all controllers. A good choice for large shared structures used by all threads (big caches and buffer pools). MongoDB's production notes recommend `numactl --interleave=all`.

Set them with `numactl --membind=0 --cpunodebind=0 ./app`, `numactl --interleave=all ./db`, or in code with `mbind()`, `set_mempolicy()` and libnuma's `numa_alloc_onnode()`. Containers and systemd units can be confined with cpusets (`cpuset.cpus`, `cpuset.mems`).

### The scheduler and NUMA balancing

The scheduler prefers to keep threads on CPUs in the same node (scheduling domains are NUMA-aware) and to wake them near where they last ran. **Automatic NUMA balancing** (`kernel.numa_balancing`, enabled by default on many distributions) periodically unmaps sample pages to catch which node accesses them via page faults, then **migrates** pages toward the threads that use them, or moves threads toward their memory. It helps long-running processes but adds overhead from the hinting faults and migrations, so some latency-sensitive deployments turn it off and pin explicitly.

## What it costs

![Illustrative bars for a memory-bound scan: all local 1.0×; interleaved about 1.2×; all memory on the other node about 1.6×; one node's memory with threads on both about 1.8×.](/figures/numa/impact.svg "The penalty depends on whether you're latency-bound or bandwidth-bound.")

- **Latency-bound** code (pointer chasing in trees, hash tables, linked lists) pays the remote latency on every cache miss.
- **Bandwidth-bound** code (scans, analytics, memcpy) is limited by one controller and the interconnect if memory isn't spread out.
- **Cache-friendly** code that mostly hits L1–L3 barely notices.

Other NUMA effects:

- **Imbalanced reclaim:** if one node fills up, the kernel may reclaim or swap on that node while another has free memory (`vm.zone_reclaim_mode`), or allocate remotely. MySQL users famously hit swapping on NUMA machines with lots of free memory overall, which led to interleave recommendations.
- **Lock and cache-line contention across sockets** costs more, because cache lines bounce over the interconnect.
- **I/O devices are local to a node too.** A NIC or NVMe drive attached to socket 0's PCIe lanes is faster to drive from node 0's cores. Pin network interrupts and processing threads to the device's node.

## Where it matters

| Workload | Typical approach |
| --- | --- |
| **Databases with big buffer pools** (MySQL, MongoDB, PostgreSQL) | Interleave memory, or one instance per socket |
| **JVMs with large heaps** | `-XX:+UseNUMA` (Parallel GC, G1 in recent JDKs) for NUMA-aware allocation |
| **VMs** | Size VMs to fit one node and pin vCPUs and memory, or expose a virtual NUMA topology to the guest |
| **HPC / analytics** (OpenMP, MPI) | Parallel first-touch initialization, one MPI rank per node or socket |
| **Packet processing** (DPDK) | Allocate buffers and run cores on the NIC's node |
| **Kubernetes** | Topology Manager aligns CPU, memory and device allocation to one NUMA node for Guaranteed pods |

### Use case walk-through: a cache that got slower on a bigger box

An in-memory cache moved from a 1-socket, 32-core server to a 2-socket, 64-core server. Throughput only rose 30%, and p99 latency got worse.

1. **Check placement.** `numastat -p <pid>` shows 95% of the process's memory on node 0.
2. **Why.** The cache loads its dataset at startup in a single thread, so first touch put everything on node 0. Half the worker threads run on node 1 and go remote for every miss, and node 0's memory controller is saturated.
3. **Option A: interleave.** Start with `numactl --interleave=all`. Memory spreads evenly, every thread sees average latency, and bandwidth doubles. Throughput rises 60% over the old box.
4. **Option B: shard per node.** Run two cache instances, each bound to one node with `--cpunodebind` and `--membind`, and shard keys between them. All accesses are local. Throughput nearly doubles, and p99 improves further.
5. **Also.** Pin the NIC's interrupts to node 0's cores, and make sure each instance's network threads sit on the node closest to the NIC queue they serve.

## Pitfalls

- **Single-threaded initialization** of data used by all threads.
- **Assuming free memory is free everywhere**: a node can be full while the machine has free memory, causing swapping, remote allocation or OOM under `bind`.
- **Threads migrating** between sockets, leaving their memory behind. Pin latency-critical threads.
- **VMs or containers larger than a node** without exposing topology, so the guest can't optimize.
- **Ignoring device locality** for NICs, NVMe drives and GPUs.
- **Benchmarking on one socket** and deploying on two.

> [!TIP]
> `numastat -p <pid>` shows how a process's memory is spread across nodes, `numastat -m` shows node-level usage, and `perf stat -e node-load-misses,node-loads` (where supported) counts remote memory accesses.

## Discussion questions

1. Why did servers move from uniform memory to NUMA?
2. A program allocates a 100 GB array and zeroes it in `main()`, then starts 64 threads. Where does the memory live, and what's the effect?
3. When would you interleave memory rather than bind it?
4. What trade-offs does automatic NUMA balancing make?
5. Why can a NUMA machine swap while it still has free memory?
6. How should you place a packet-processing thread relative to its network card?

## FAQ

### Is my laptop NUMA?

Almost certainly not in a way that matters: consumer CPUs have one memory controller domain, so `numactl --hardware` shows a single node. NUMA matters on multi-socket servers and large server chips.

### Does NUMA affect GPUs?

Yes, indirectly: a GPU sits on one socket's PCIe lanes, so host memory used for transfers should be on that node, and the threads feeding it should run there. Multi-GPU systems have their own interconnect topologies (NVLink) with similar locality concerns.

### Should I disable NUMA in the BIOS?

Some BIOSes offer "node interleaving", which hides NUMA by interleaving at the hardware level. That gives uniform average latency but removes the possibility of local placement. It's usually better to keep NUMA visible and use interleave policies only where needed.

### How do I know if NUMA is hurting me?

Compare performance with `numactl --interleave=all` and with per-node binding. Check `numastat` for imbalance, and look for high remote-access counters. If interleaving or binding changes performance significantly, placement matters for your workload.

### What's the difference between NUMA and ccNUMA?

Nearly all modern NUMA systems are **cache-coherent** (ccNUMA): hardware keeps caches coherent across sockets, so software sees one shared memory, just with non-uniform latency. Non-coherent designs exist in some specialized systems, but you're unlikely to meet them.

## Key takeaways

- On NUMA machines, each node has **local memory**. Remote access costs **~1.3–2× latency** and shared interconnect bandwidth.
- Linux allocates pages on **first touch**: single-threaded initialization concentrates memory on one node.
- Choose a **policy**: local (default), **bind** for partitioned work, **interleave** for big shared data.
- **NUMA balancing** migrates pages automatically, at some overhead. Pin latency-critical work explicitly.
- Consider **devices, VMs and containers** in placement too, and measure with `numastat` and `perf`.

## References

1. C. Lameter. [NUMA (Non-Uniform Memory Access): An Overview](https://queue.acm.org/detail.cfm?id=2513149). *ACM Queue*, 2013.
2. Linux kernel docs. [What is NUMA?](https://docs.kernel.org/mm/numa.html) and [NUMA Memory Policy](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html).
3. Linux man pages. [numactl(8)](https://man7.org/linux/man-pages/man8/numactl.8.html), [mbind(2)](https://man7.org/linux/man-pages/man2/mbind.2.html), [numa(7)](https://man7.org/linux/man-pages/man7/numa.7.html).
4. U. Drepper. [What Every Programmer Should Know About Memory](https://people.freebsd.org/~lstewart/articles/cpumemory.pdf), section 5: NUMA Support. 2007.
5. J. Cole. [The MySQL "swap insanity" problem and the effects of the NUMA architecture](https://blog.jcole.us/2010/09/28/mysql-swap-insanity-and-the-numa-architecture/). 2010.
6. MongoDB docs. [Production Notes: MongoDB and NUMA Hardware](https://www.mongodb.com/docs/manual/administration/production-notes/).
7. Kubernetes docs. [Control Topology Management Policies on a node](https://kubernetes.io/docs/tasks/administer-cluster/topology-manager/).

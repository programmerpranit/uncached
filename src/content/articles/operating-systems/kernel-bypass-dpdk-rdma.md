---
summary: Why the kernel network stack caps packets per core, how DPDK moves drivers into user space with polling, batching and hugepage buffers, how RDMA lets NICs read and write remote memory without the remote CPU, and when XDP or a tuned kernel is the better choice.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** The kernel's network stack is general and safe, but each packet pays for interrupts, softirqs, protocol layers, system calls and copies. That limits one core to roughly **1–2 million small packets per second** through sockets, far below what a 100 Gb/s NIC can deliver (about 148 million 64-byte packets per second). **Kernel bypass** moves the data path out of the kernel. **DPDK** binds the NIC to a user-space **poll-mode driver**: dedicated cores spin on the NIC's rings, process packets in **batches**, use preallocated buffers in **hugepage** memory, and pass work between cores through **lock-free rings**, reaching tens of millions of packets per second per core with microsecond latency. The cost: those cores run at 100% even when idle, and you give up the kernel's TCP/IP stack, firewall, `tcpdump` and normal sockets. **RDMA** goes further: applications post requests straight to the NIC, and **one-sided** reads and writes move data between registered memory on two machines **without the remote CPU or kernel**, in a few microseconds (over InfiniBand, RoCE v2 or iWARP). Between a tuned kernel and full bypass sit **XDP/AF_XDP**, which keep the kernel in charge while giving much of the speed.

## The problem: per-packet overhead

At 10 Gb/s, minimum-size Ethernet frames arrive every **67 nanoseconds** (14.88 million packets per second). At 100 Gb/s, every 6.7 ns. A core gets a couple of hundred cycles per packet at 10 Gb/s, and a few dozen at 100 Gb/s.

The kernel path spends far more than that. For each received packet it runs interrupt and NAPI handling, allocates a `sk_buff`, runs GRO, IP and TCP or UDP processing, netfilter hooks, socket queuing and wakeups, then the application makes a system call and copies the data. Each layer is reasonable, but together they cost microseconds per packet, plus cache misses and lock contention. For most applications, which spend far more time on business logic than on packets, that's fine. For packet processing (routers, firewalls, load balancers, telecom functions, trading gateways, storage targets), the stack itself is the bottleneck.

## DPDK: drivers in user space

![The kernel stack goes from recv through syscall and copy, sockets, TCP/IP, netfilter, softirq and driver to the NIC; DPDK goes from the app and DPDK libraries through a user-space poll-mode driver and rings in hugepage memory to the NIC, with the kernel not involved after setup.](/figures/kernel-bypass/stacks.svg "DPDK removes the kernel from the per-packet path entirely.")

The **Data Plane Development Kit** (DPDK), started at Intel and now a Linux Foundation project, works like this:

1. At setup, the NIC is unbound from its kernel driver and bound to `vfio-pci` (or `uio`), which lets a user-space process map the device's registers and do DMA safely through the IOMMU.
2. DPDK's **Environment Abstraction Layer** reserves hugepage memory, pins threads to cores, and initializes a **poll-mode driver (PMD)** for the NIC model.
3. Each **lcore** (a pinned thread on a dedicated core) loops forever: poll a receive ring for a burst of packets, process them, push them to a transmit ring.

![Five techniques: poll-mode drivers on dedicated cores; batching 32–64 packets per loop; hugepage memory pools; lock-free rings between cores; core and NUMA pinning. Each with its cost.](/figures/kernel-bypass/dpdk.svg "Every technique trades generality or efficiency at idle for speed under load.")

Where the speed comes from:

- **No interrupts, no system calls:** the driver polls descriptor rings in shared memory.
- **Batching:** `rte_eth_rx_burst` fetches up to 32–64 packets at once, amortizing every fixed cost and keeping instruction caches hot.
- **Preallocated buffers:** packets live in fixed-size `mbuf`s from per-core **mempools** in hugepage memory, so there's no `malloc` per packet and few TLB misses.
- **Lock-free rings** (`rte_ring`) pass packets between pipeline stages on different cores.
- **Core and NUMA affinity:** each core owns its own queues (RSS spreads flows), and memory sits on the NIC's NUMA node.
- **Vectorized code:** PMDs use SIMD to process descriptors several at a time.

The result: a single core can forward at 10 Gb/s line rate with minimum-size packets, and a few cores can handle 100 Gb/s.

What you give up:

- **The kernel's TCP/IP stack.** DPDK is mostly used for L2/L3 processing (switching, routing, NAT, load balancing), or with a user-space TCP stack (F-Stack, mTCP, Seastar's native stack).
- **Kernel tools and features:** `tcpdump`, `iptables`, `ip`, standard monitoring. DPDK provides its own equivalents (`dpdk-pdump`), and "exception" packets can be sent back to the kernel through virtual interfaces.
- **Efficiency when idle:** polling cores burn 100% CPU regardless of traffic (adaptive polling and interrupt modes exist, at a latency cost).
- **Sharing:** the NIC (or a virtual function of it, with SR-IOV) belongs to one application.

**SPDK** applies the same approach to NVMe storage: user-space drivers, polling for completions, no interrupts or system calls, and millions of IOPS per core.

## RDMA: remote memory access

![Host A's app issues an RDMA WRITE through its RNIC into a registered memory region on host B; host B's CPU never sees the write.](/figures/kernel-bypass/rdma.svg "The NICs do the transfer. The remote application isn't interrupted at all.")

**Remote Direct Memory Access** lets a NIC read or write memory on another machine directly:

1. Applications **register** memory regions with their RDMA NIC (RNIC). The pages are pinned, and the NIC gets the translation plus access keys.
2. They create **queue pairs** (send and receive queues) connected to a peer, and **completion queues** to learn when work finishes. All of this lives in memory mapped into the application.
3. To transfer data, the app posts a **work request** directly to the NIC from user space, without a system call:
   - **One-sided** `RDMA WRITE` and `RDMA READ`: move data to or from a remote address (with the remote key). The remote CPU and OS aren't involved.
   - **Two-sided** `SEND`/`RECV`: like messages, the receiver posts buffers in advance.
   - **Atomics** (compare-and-swap, fetch-and-add) on remote memory.
4. The app **polls** its completion queue (or waits for an event).

Latency is a few microseconds end to end, with full bandwidth and almost no CPU use. Transports:

- **InfiniBand:** a separate lossless network, common in HPC and AI training clusters.
- **RoCE v2** (RDMA over Converged Ethernet): over UDP/IP on Ethernet. It needs a carefully configured, lossless or congestion-controlled fabric (PFC, ECN, DCQCN). Microsoft documented running it at datacenter scale (SIGCOMM 2016).
- **iWARP:** RDMA over TCP, simpler to network but less common.

Uses include distributed storage (NVMe over Fabrics, Azure storage's backend traffic), distributed databases and caches (Microsoft's FaRM), HPC message passing (MPI), and **AI training**, where NCCL and GPUDirect RDMA move gradients directly between GPU memory on different machines. AWS offers a related transport, EFA/SRD, for HPC and ML.

## The spectrum

![From tuned kernel sockets, to AF_XDP and XDP, to user-space TCP stacks, to DPDK/SPDK, to RDMA: less kernel means more speed and more work.](/figures/kernel-bypass/spectrum.svg "Most services never need to go past the first rows.")

- **Tuned kernel networking:** RSS and IRQ affinity, GRO, busy polling, `SO_REUSEPORT`, io_uring, zero-copy sends. Enough for nearly all services.
- **XDP and AF_XDP:** eBPF programs run in the NIC driver before `sk_buff` allocation, able to drop, redirect or rewrite packets at near-DPDK speeds (Cloudflare's DDoS mitigation, Facebook's Katran load balancer), and AF_XDP sockets deliver raw frames to user space with zero copy, while the kernel keeps its tools and other traffic flows normally.
- **User-space stacks on DPDK:** for applications that need TCP at bypass speeds.
- **DPDK/SPDK:** network functions, appliances and storage targets.
- **RDMA:** cluster interconnects for storage, HPC, databases and AI.

## Where it's used

| Domain | Technology |
| --- | --- |
| **Telecom / NFV** (5G user plane, vRouters) | DPDK, SR-IOV |
| **Software routers and load balancers** | DPDK (e.g. VPP), or XDP (Katran) |
| **High-frequency trading** | Kernel bypass NICs (Solarflare/AMD Onload, ef_vi), DPDK |
| **Storage** | SPDK, NVMe-oF over RDMA or TCP |
| **AI training clusters** | InfiniBand or RoCE RDMA, GPUDirect, NCCL |
| **Cloud hypervisors and virtual switches** | DPDK-accelerated Open vSwitch, smart NICs/DPUs |
| **DDoS mitigation** | XDP |

### Use case walk-through: a UDP gateway that tops out at 2 Mpps

A telemetry gateway receives small UDP packets from millions of devices. With kernel sockets it peaks around 2 million packets per second per server, using all cores, and drops packets in bursts.

1. **Tune the kernel first.** `recvmmsg` batching, `SO_REUSEPORT` with one socket per core, RSS and IRQ affinity, and larger socket buffers raise it to ~5 Mpps. Still short of the 12 Mpps target.
2. **Try AF_XDP.** An XDP program steers the telemetry port's packets to AF_XDP sockets (zero copy), and everything else goes to the normal stack. Each core now handles ~8–10 Mpps, while SSH, monitoring and other traffic keep working.
3. **Consider DPDK.** A full DPDK version reaches the target with fewer cores, but needs dedicated NIC queues, its own ARP/ICMP handling and new tooling. The team stays with AF_XDP, which meets the target with headroom.
4. **Lesson.** Move down the spectrum only as far as needed, and measure at each step.

## Pitfalls

- **Bypassing the kernel when a tuned kernel would do**: big operational cost for little gain.
- **Forgetting what the kernel provided**: ARP, ICMP, firewalling, TCP, observability. You must rebuild or forward them.
- **Polling cores counted as "busy"**: monitoring shows 100% CPU at idle. Track packets and loop utilization instead.
- **NUMA mistakes**: lcores or mempools on the wrong socket halve performance.
- **RoCE on a lossy, unconfigured network**: pause storms and collapsing throughput. RDMA needs careful network design.
- **Security and isolation**: user-space drivers and RDMA access keys bypass the kernel's protections. Rely on the IOMMU, SR-IOV and careful key management.

> [!TIP]
> Before reaching for bypass, measure where kernel time goes: `perf top` on a busy core, `/proc/softirqs`, `ethtool -S` drop counters and `nstat` for UDP/TCP errors. Often the bottleneck is one core handling all interrupts, which is a configuration fix.

## Discussion questions

1. Why does the kernel stack struggle with small packets at 10–100 Gb/s?
2. What does DPDK gain by polling, and what does it lose?
3. How do hugepages and mempools help per-packet performance?
4. Why can a one-sided RDMA write complete without the remote CPU, and what are the implications for application design?
5. When would you choose AF_XDP over DPDK?
6. Why does RoCE need a lossless or carefully congestion-controlled network?

## FAQ

### Is DPDK only for networking?

Mostly, but its libraries (memory pools, rings, hashing, crypto, compression, event scheduling) are used for other data-plane work, and its sibling SPDK handles NVMe storage.

### Can containers use DPDK?

Yes, with SR-IOV virtual functions or vhost-user interfaces passed into the container, hugepages allocated to the pod, and CPU pinning (Kubernetes CPU manager, topology manager). It's common in telecom deployments.

### Is RDMA the same as kernel bypass?

RDMA includes kernel bypass on the data path (applications talk to the NIC directly), but adds remote memory semantics and hardware transport offload. The kernel is still involved in setup: creating queue pairs and registering memory.

### Does io_uring replace kernel bypass?

No. io_uring reduces syscall and copy overhead within the kernel stack, narrowing the gap for many workloads. Bypass removes the stack entirely, which still matters at the highest packet rates and lowest latencies.

### What are SmartNICs and DPUs?

NICs with programmable processors (ARM cores, FPGAs or P4 pipelines) that run networking, storage and security functions on the card itself, offloading the host CPU. They are often used to implement virtual switches and storage for cloud VMs, taking the bypass idea one step further: the host never sees those packets at all.

## Key takeaways

- The kernel stack's per-packet cost limits a core to roughly **1–2 Mpps** through sockets.
- **DPDK** moves drivers to user space: **polling, batching, hugepage mempools, lock-free rings and pinning** give tens of Mpps per core, at the cost of dedicated cores and losing kernel features.
- **RDMA** lets NICs **read and write remote memory directly**: microsecond latency with little CPU use, used for storage, HPC and AI.
- **XDP/AF_XDP** offer much of the speed while keeping the kernel in charge.
- Go only as far down the spectrum as needed, and **measure** first.

## References

1. DPDK. [Programmer's Guide](https://doc.dpdk.org/guides/prog_guide/).
2. SPDK. [Storage Performance Development Kit documentation](https://spdk.io/doc/).
3. C. Guo et al. [RDMA over Commodity Ethernet at Scale](https://www.microsoft.com/en-us/research/publication/rdma-over-commodity-ethernet-at-scale/). *SIGCOMM 2016*.
4. A. Dragojević et al. [FaRM: Fast Remote Memory](https://www.usenix.org/conference/nsdi14/technical-sessions/dragojevi%C4%87). *NSDI 2014*.
5. T. Høiland-Jørgensen et al. [The eXpress Data Path: Fast Programmable Packet Processing in the Operating System Kernel](https://dl.acm.org/doi/10.1145/3281411.3281443). *CoNEXT 2018*.
6. Linux kernel docs. [AF_XDP](https://docs.kernel.org/networking/af_xdp.html).
7. M. Marty et al. [Snap: a Microkernel Approach to Host Networking](https://research.google/pubs/snap-a-microkernel-approach-to-host-networking/). *SOSP 2019*.
8. RDMA Core. [rdma-core and libibverbs](https://github.com/linux-rdma/rdma-core).

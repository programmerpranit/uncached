---
summary: How hardware gets the CPU's attention, why interrupt handlers must be tiny, how Linux splits work into a fast top half and deferred bottom halves (softirqs, tasklets, workqueues, threaded IRQs), and how NAPI polling, interrupt coalescing and RSS keep high-speed networking from drowning in interrupts.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Devices signal the CPU with **interrupts**: the CPU stops what it's doing, saves state and runs a registered **handler**. While a hard interrupt handler runs, its interrupt (and often every interrupt on that core) is **masked**, and the handler **can't sleep**, so it must be extremely short. Linux therefore splits interrupt processing in two. The **top half** acknowledges the device and schedules work, in microseconds. The **bottom half** does the real work later, with interrupts enabled: **softirqs** (network receive and transmit, block completions, timers, RCU), **tasklets** (being phased out), **workqueues** (kernel threads that can sleep), and **threaded IRQ handlers**. At high event rates, one interrupt per event would consume entire cores (**receive livelock**), so NICs **coalesce** interrupts and Linux's **NAPI** switches to **polling** in batches under load. Multi-queue NICs with **RSS** spread interrupts across cores, and tools like `irqbalance`, `smp_affinity` and `/proc/interrupts` let you see and tune where interrupt work runs, which matters for both throughput and tail latency.

## The problem: devices need attention now

A NIC receives a packet, a disk finishes a read, a timer expires, a key is pressed. The CPU could **poll** each device in a loop, but that wastes cycles when nothing is happening and adds latency when something is. **Interrupts** reverse the direction: the device signals the CPU when it needs service.

- Devices raise interrupts through an interrupt controller (APIC on x86, GIC on ARM). Modern PCIe devices use **MSI/MSI-X**: an interrupt is a memory write, and a device can have many separate vectors, for example one per queue.
- The CPU finishes the current instruction, saves registers, switches to kernel mode if needed, and jumps to the handler registered for that vector (via the IDT on x86).
- Besides device interrupts, there are **timer interrupts** (scheduler ticks), **inter-processor interrupts** (IPIs: TLB shootdowns, rescheduling other CPUs) and **exceptions** (page faults, which are synchronous and handled similarly).

## Top halves and bottom halves

![Six stages: the NIC DMAs a packet into a ring and raises an interrupt; the CPU jumps to the handler; the top half acknowledges and schedules NAPI; a softirq polls the ring and runs TCP/IP; the reader thread is woken; recv copies data to user space.](/figures/interrupts/packet-flow.svg "Most of the work to receive a packet happens after the interrupt handler has already returned.")

Hard interrupt context is special:

- The handler **interrupts whatever was running**: a user thread, a system call, even another kernel path.
- It runs with its interrupt line (and often all local interrupts) **disabled**, so long handlers delay other interrupts and add latency for everyone.
- It **can't sleep** or block: there's no thread to put to sleep. So no mutexes, no memory allocation that might wait, no I/O.

So drivers do the minimum in the **top half**: read status registers, acknowledge the device, maybe grab a timestamp, and **schedule** the rest. The **bottom half** runs soon after, in a context where interrupts are enabled.

### Linux's deferred work mechanisms

![Four mechanisms: softirqs, a fixed set that can't sleep and run right after interrupts or in ksoftirqd; tasklets, dynamic and built on softirqs; workqueues, kernel threads that can sleep; threaded IRQs, handlers in their own kernel threads.](/figures/interrupts/mechanisms.svg "Pick based on whether the deferred work needs to sleep, and how latency-sensitive it is.")

- **Softirqs:** a small, fixed set of high-priority deferred handlers: `NET_RX`, `NET_TX`, `BLOCK`, `TIMER`, `HRTIMER`, `SCHED`, `RCU`, and a few others. They run on the CPU that raised them, right after hard interrupts return (or when bottom halves are re-enabled), and the same softirq can run on several CPUs at once. They can't sleep. `/proc/softirqs` counts them per CPU.
- **ksoftirqd:** if softirq work keeps arriving, processing it inline would starve user threads. After a budget of time or iterations, the kernel defers the rest to a per-CPU `ksoftirqd` thread, which the scheduler treats like other threads. A `ksoftirqd` at 100% CPU in `top` means that core is overwhelmed by interrupt-driven work.
- **Tasklets:** dynamically created deferred functions built on softirqs, serialized per tasklet. Long used by drivers, they're being replaced by BH workqueues (Linux 6.9+).
- **Workqueues:** work items run by kernel worker threads (`kworker/...`). They **can sleep**, take mutexes and do I/O. Used for anything that isn't latency-critical.
- **Threaded IRQs:** `request_threaded_irq()` lets the hard handler just wake a dedicated kernel thread (`irq/42-eth0`) that does the processing. Threads can sleep, have scheduling priorities and can be pinned, which matters for real-time systems. **PREEMPT_RT** threads nearly all interrupt handlers this way.

## Too many interrupts

![Four approaches: one interrupt per packet consumes most of a core; NIC interrupt coalescing fires once per N packets or microseconds; NAPI interrupts once then polls in batches; busy polling has application threads poll directly.](/figures/interrupts/napi.svg "Interrupts are efficient at low rates. At high rates, polling wins.")

At 10–100 Gb/s, a NIC can receive millions of packets per second. With one interrupt per packet, each costing around a microsecond of entry, exit and cache disruption, the CPU spends all its time entering and leaving handlers and none actually processing packets or running applications. Mogul and Ramakrishnan called this **receive livelock** (1997): throughput collapses as load increases.

The fixes:

- **Interrupt coalescing** (in the NIC): raise an interrupt only after N packets or T microseconds (`ethtool -C`). Fewer interrupts, at the cost of some added latency. Adaptive modes adjust with load.
- **NAPI** (in the kernel): the first packet raises an interrupt. The driver then **disables** the queue's interrupt and schedules a `NET_RX` softirq that **polls** the ring, processing up to a budget of packets per round (`net.core.netdev_budget`, default 300). When the ring is empty, it re-enables interrupts. At low load you get interrupt latency, and at high load polling efficiency.
- **Busy polling** (`SO_BUSY_POLL`, `net.core.busy_poll`): application threads poll the device queue themselves while waiting for data, trading CPU for the lowest latency. Kernel bypass (DPDK) takes this to the extreme with dedicated polling cores.
- **GRO** (generic receive offload) merges many small packets of a flow into larger ones early, so the stack does less per-packet work.

Storage follows the same pattern: NVMe has per-CPU submission and completion queues with coalescing, and io_uring and SPDK can poll for completions.

## Spreading interrupt work across cores

![A NIC hashes each flow's 5-tuple to one of four queues; each queue has its own IRQ pinned to its own CPU.](/figures/interrupts/rss.svg "Multiple queues let receive processing run in parallel, flow by flow.")

A single core can't handle all interrupt and softirq work for a fast NIC. **Receive Side Scaling (RSS)** in the NIC hashes each packet's flow (source/destination IPs and ports) to one of several receive queues, each with its own MSI-X interrupt. Pinning each queue's interrupt to a different core spreads the softirq work, while keeping each flow on one core (so packets stay in order).

- `/proc/interrupts` shows per-CPU counts for each interrupt vector.
- `/proc/irq/<n>/smp_affinity_list` sets which CPUs handle an interrupt. **irqbalance** adjusts it automatically.
- **RPS/RFS** (receive packet/flow steering) do the hashing in software for NICs with fewer queues. **aRFS** asks the NIC to steer each flow to the core where its consuming application thread runs, so the data is already in that core's cache.
- For latency-critical systems, people do the opposite: keep interrupts **off** isolated cores (`isolcpus`, `nohz_full`, IRQ affinity), so application threads there are never interrupted.

## Where it matters

| Situation | What to tune |
| --- | --- |
| **High packet rate servers** (load balancers, DNS, proxies) | RSS queues, IRQ affinity, NAPI budget, GRO, coalescing |
| **Low-latency trading / real-time** | Isolated cores, IRQs pinned elsewhere, busy polling, threaded IRQs with priorities |
| **Storage-heavy servers** | NVMe queue-per-CPU, completion polling (io_uring `IOPOLL`) |
| **Virtual machines** | Virtio with multiqueue, interrupt remapping, posted interrupts to avoid VM exits |
| **Containers and Kubernetes** | Keep latency-sensitive pods off cores handling heavy network IRQs |

### Use case walk-through: one core at 100% `si`

A load balancer handling 2 million packets per second drops packets while overall CPU is only 30%.

1. **Look per core.** `mpstat -P ALL 1` shows CPU 0 at 100% in `%soft` (softirq) and other cores mostly idle. `top` shows `ksoftirqd/0` busy.
2. **Check interrupts.** `/proc/interrupts` shows all NIC interrupts landing on CPU 0. The NIC has 8 queues, but every queue's IRQ is pinned to CPU 0 (irqbalance was disabled by an old tuning script).
3. **Spread.** Set each queue's `smp_affinity_list` to a different core on the NIC's NUMA node, or re-enable irqbalance. Check `ethtool -l` to use as many combined queues as cores.
4. **Tune.** Enable GRO, and increase `netdev_budget` slightly. Check `ethtool -S` for drops due to ring overflow, and enlarge rings with `ethtool -G` if needed.
5. **Result.** Softirq load spreads across 8 cores, drops vanish, and throughput rises without new hardware.

## Pitfalls

- **Doing real work in a hard IRQ handler** (or anything that might sleep): latency spikes and kernel warnings.
- **All interrupts on one core**: a single-core bottleneck invisible in average CPU usage.
- **Over-aggressive coalescing** on latency-sensitive services: it adds tens of microseconds per packet.
- **IRQs on the NUMA node far from the NIC**, or far from the application thread.
- **Ignoring `ksoftirqd`**: when it's busy, network processing competes with application threads for that core.
- **Isolating cores** for latency without also moving IRQs, timers and kernel threads off them.

> [!TIP]
> `watch -d -n1 cat /proc/interrupts` highlights which interrupt counters are moving, and `cat /proc/softirqs` shows which bottom halves run where. `perf top -C <cpu>` on a busy `%soft` core shows which handlers dominate.

## Discussion questions

1. Why can't an interrupt handler sleep?
2. What is receive livelock, and how does NAPI prevent it?
3. When would you use a workqueue instead of a softirq or tasklet?
4. How does RSS keep packets of one TCP connection in order while using many cores?
5. Why do real-time and trading systems move interrupts off certain cores?
6. What does a `ksoftirqd` thread at 100% CPU tell you?

## FAQ

### What's the difference between an interrupt and an exception?

An **interrupt** is asynchronous, from outside the current instruction stream (a device, a timer, another CPU). An **exception** is synchronous, caused by the instruction being executed (page fault, divide by zero, breakpoint, system call instruction on some architectures). Both enter the kernel through the same kind of vector table.

### Are top and bottom halves Linux terms?

The idea is universal. Windows calls them ISRs (interrupt service routines) and DPCs (deferred procedure calls). The BSDs use interrupt threads and taskqueues. "Bottom half" is also the name of Linux's original deferred mechanism, long since replaced by softirqs and tasklets.

### What is the timer tick, and why does nohz matter?

Traditionally the kernel took a timer interrupt on every core hundreds or thousands of times per second (`HZ`) for scheduling and timekeeping. **Tickless** kernels (`NO_HZ_IDLE`) stop the tick on idle cores to save power, and **`nohz_full`** stops it on cores running a single task, removing periodic interruptions for latency-critical work.

### Do VMs make interrupts more expensive?

Historically yes: delivering interrupts to a guest required VM exits. Modern hardware supports **posted interrupts** and interrupt remapping, so devices assigned to a VM (SR-IOV) can deliver interrupts to a guest vCPU with little or no hypervisor involvement.

### Why are tasklets being removed?

They have awkward semantics (they run in softirq context but are serialized per tasklet, with surprising interactions), and most uses are better served by threaded IRQs or workqueues. Linux 6.9 added BH workqueues as a replacement, and drivers are being converted.

## Key takeaways

- **Interrupts** let devices demand attention. **Hard handlers** run with interrupts masked, can't sleep, and must be tiny.
- The **top half** acknowledges and schedules. **Bottom halves** (softirqs, tasklets, workqueues, threaded IRQs) do the work later.
- At high rates, use **coalescing**, **NAPI polling**, **GRO** and **busy polling** to avoid **receive livelock**.
- **RSS**, IRQ affinity and RPS/RFS **spread** interrupt work across cores. Isolation keeps it **away** from latency-critical cores.
- Watch **`/proc/interrupts`**, **`/proc/softirqs`**, `%soft` and **`ksoftirqd`** to find interrupt bottlenecks.

## References

1. J. Mogul, K. K. Ramakrishnan. [Eliminating Receive Livelock in an Interrupt-driven Kernel](https://www.usenix.org/legacy/publications/library/proceedings/sd96/full_papers/mogul.pdf). *ACM TOCS*, 1997 (earlier version at USENIX 1996).
2. Linux kernel docs. [Scaling in the Linux Networking Stack](https://docs.kernel.org/networking/scaling.html) (RSS, RPS, RFS, XPS).
3. Linux kernel docs. [NAPI](https://docs.kernel.org/networking/napi.html).
4. R. Love. *Linux Kernel Development*, 3rd ed., chapters 7–8: Interrupts and Interrupt Handlers; Bottom Halves and Deferring Work. Addison-Wesley, 2010.
5. Linux kernel docs. [Workqueue](https://docs.kernel.org/core-api/workqueue.html).
6. Linux kernel docs. [NO_HZ: Reducing Scheduling-Clock Ticks](https://docs.kernel.org/timers/no_hz.html).
7. Red Hat. [Monitoring and Tuning the RHEL Network Stack](https://access.redhat.com/sites/default/files/attachments/20150325_network_performance_tuning.pdf).

---
summary: What a system call actually is, how the CPU switches between user and kernel mode, what crossing that boundary costs (and why it got more expensive in 2018), and the techniques that cut the number of crossings, from buffering and batching to the vDSO, io_uring and kernel bypass.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** User programs run in an unprivileged CPU mode (ring 3 on x86, EL0 on ARM). They can't touch hardware, other processes' memory or kernel data. To do anything outside their own memory, such as reading a file, sending a packet, allocating memory or creating a thread, they make a **system call**: put a call number and arguments in registers, execute a special instruction (`syscall` on x86-64, `svc` on ARM), and the CPU switches to **kernel mode** at a fixed entry point. The kernel **validates everything**, does the work, and returns. A trivial system call costs roughly **50–100 ns** on modern x86, more with the **Meltdown/Spectre mitigations** added in 2018. That's cheap per call but expensive at millions per second, and a call that blocks adds a full context switch. Fast software **crosses the boundary less often**: buffered I/O, bigger reads, vectored and batched calls (`writev`, `sendmmsg`, io_uring), zero-copy calls (`sendfile`), the **vDSO** for time functions, and, at the extreme, **kernel bypass** (DPDK, SPDK).

## The problem: protection needs a gatekeeper

If any program could execute any instruction, one bug or malicious program could read every process's memory, reprogram the disk controller, or disable interrupts and hang the machine. CPUs therefore provide **privilege levels**:

- **User mode:** privileged instructions (changing page tables, talking to devices, disabling interrupts) fault. Memory is restricted to the process's own mappings.
- **Kernel mode:** full access to hardware and all memory.

Programs still need the kernel's services. A system call is the **controlled doorway**: a fixed set of entry points (about 450 on Linux x86-64) where the kernel takes over, checks the request and acts on the program's behalf.

## How a system call works

![Six rows: your code calls read(fd, buf, 4096); the libc wrapper puts SYS_read in rax and arguments in rdi, rsi, rdx; the syscall instruction switches to ring 0; kernel entry saves registers and switches stack; sys_read validates and copies data; sysret returns to ring 3 with the byte count.](/figures/syscalls/path.svg "The libc wrapper is ordinary code. The mode switch happens at one instruction, and only into one kernel entry point.")

On Linux x86-64:

1. Your code calls a libc function like `read(fd, buf, n)`, an ordinary function.
2. The wrapper puts the **system call number** in `rax` (0 for `read`) and up to six arguments in `rdi`, `rsi`, `rdx`, `r10`, `r8`, `r9`, then executes `syscall`.
3. The CPU switches to ring 0, saves the user instruction pointer and flags, and jumps to the kernel's entry point (configured in a model-specific register at boot).
4. The kernel entry code switches to the thread's **kernel stack**, saves user registers, applies security mitigations, and dispatches through the **system call table** to `sys_read`.
5. `sys_read` looks up the file descriptor, checks permissions and that `buf` points into user memory, then calls the filesystem or socket code. Data is copied with `copy_to_user`, which safely handles a bad pointer by returning an error instead of crashing the kernel.
6. The return value goes in `rax` (negative values are errors, which libc turns into `-1` and `errno`), and `sysret` drops back to ring 3.

If the call has to wait (no data on the socket yet), the kernel puts the thread to sleep and schedules another thread: a context switch on top of the mode switch.

Other ways into the kernel follow the same pattern: **interrupts** from devices, **exceptions** like page faults, and **signals** going the other way.

### The kernel never trusts user space

Every argument is hostile until proven otherwise:

- File descriptors are looked up in the process's own table, so you can only use what you opened.
- Pointers are checked to point into user space, and copies tolerate faults. Hardware features (SMAP and SMEP on x86, PAN on ARM) make the kernel fault if it accidentally reads or executes user memory without going through the proper routines.
- Values that the kernel reads from user memory are copied once before being checked, avoiding **time-of-check-to-time-of-use** races where another thread changes them in between.

This boundary is also a security surface: **seccomp** filters let a process (or container runtime) restrict which system calls it may make, and every container sandbox (gVisor, Firecracker) is a different answer to "how much of the syscall interface do we expose?"

## What it costs

![Log-scale bars: function call ~1 ns; vDSO clock_gettime ~20 ns; trivial syscall ~50–100 ns; with mitigations hundreds of ns; read of 4 KiB from page cache ~1 µs; blocking syscall microseconds plus wakeup.](/figures/syscalls/costs.svg "The mode switch is cheap compared with a context switch, but not compared with a function call.")

Costs on modern x86 Linux, roughly:

- **Mode switch:** the `syscall` and `sysret` instructions, saving and restoring registers, and dispatch: tens of nanoseconds.
- **Mitigations:** after Meltdown (2018), **KPTI** switches page tables on every kernel entry and exit on affected CPUs, and Spectre mitigations add barriers and buffer flushes. On older affected CPUs these can multiply the cost of a trivial syscall. Newer CPUs fix Meltdown in hardware and skip KPTI.
- **Indirect costs:** the kernel's code and data displace some of your cache and TLB entries. FlexSC (OSDI 2010) measured that after a syscall, user-mode instructions per cycle could stay degraded for thousands of cycles.
- **The actual work:** copying data, filesystem and network stack logic. For a 4 KiB read from the page cache, the copy and lookup dominate.

A server making 1 million syscalls per second at ~200 ns each spends a fifth of a core just crossing the boundary.

## Crossing less often

### Batching and bigger buffers

![Log-scale bars for copying 1 GiB: 1-byte reads and writes need ~2.1 billion syscalls; a 4 KiB buffer ~524,000; a 128 KiB buffer ~16,000; copy_file_range or sendfile a few.](/figures/syscalls/batching.svg "Fixed per-call overhead disappears when each call moves more data.")

- **User-space buffering:** `stdio`, Java's `BufferedOutputStream`, Go's `bufio`, Rust's `BufWriter` turn many small writes into one `write()`. Forgetting to buffer (one `write` per log line or per byte) is a classic performance bug.
- **Vectored I/O:** `readv`/`writev` move several buffers in one call (a header and body without copying them together).
- **Multi-message calls:** `recvmmsg`/`sendmmsg` send or receive many UDP datagrams per call. DNS servers and QUIC stacks use them heavily.
- **io_uring:** queue hundreds of operations in a shared ring and submit them with one call, or none with kernel-side polling.
- **Zero-copy:** `sendfile`, `splice` and `copy_file_range` move data between files and sockets inside the kernel, never copying through user space. Kafka and nginx use `sendfile` to serve files.

### Avoiding the kernel entirely

![Four rows: vDSO for clock_gettime, gettimeofday and getcpu; futex fast path for uncontended locks; user-space buffering; kernel bypass with DPDK, SPDK and RDMA.](/figures/syscalls/avoiding.svg "Some operations never need the kernel at all.")

- **vDSO:** the kernel maps a small shared library and a data page into every process. `clock_gettime()` and `gettimeofday()` read the time from that page directly, costing ~20 ns instead of a syscall. That's why timestamping every request is affordable.
- **Futexes:** uncontended locks are an atomic instruction in user memory. The kernel is only involved to sleep or wake.
- **Memory-mapped I/O:** after `mmap`, reading a file is plain memory access (page faults bring data in, without per-read syscalls).
- **Kernel bypass:** DPDK (networking) and SPDK (NVMe storage) map device queues into the application, which polls them directly. There are no syscalls or interrupts in the data path, at the cost of dedicating cores and giving up the kernel's network stack. RDMA lets NICs read and write remote memory directly.

## Where it's used

| Technique | Who uses it |
| --- | --- |
| `sendfile` / zero copy | nginx, Kafka, Apache serving static files and log segments |
| `recvmmsg` / `sendmmsg` | DNS servers, QUIC implementations, game servers |
| io_uring | High-performance storage engines, proxies, ScyllaDB/Seastar alternatives |
| vDSO | Every program that reads the time (logging, tracing, metrics) |
| seccomp filters | Docker, Chrome sandboxes, systemd services |
| Kernel bypass | Trading systems, NFV, storage appliances, some cloud network data planes |

### Use case walk-through: a logger that ate a core

A service's CPU profile shows 25% of time in the kernel, mostly in `write`.

1. **Trace.** `strace -c -p <pid>` shows ~800k `write` calls per second, each writing one log line to a file.
2. **Cause.** The logging library flushes after every line for durability. Each line costs a syscall, plus filesystem locking.
3. **Fix.** Buffer log lines in user space and flush every 64 KiB or every 100 ms, on a background thread. For crash safety, flush on shutdown and on fatal errors.
4. **Also.** The service calls `gettimeofday` per log line, but that goes through the vDSO, so it costs no syscalls. (On some VMs with an unstable clocksource, the vDSO falls back to a real syscall: check `/sys/devices/system/clocksource/clocksource0/current_clocksource`.)
5. **Result.** Kernel time falls from 25% to ~2%, and p99 latency drops because request threads no longer contend on file locks.

## Pitfalls

- **Unbuffered small writes**: logging, sockets with tiny messages, `print` without buffering in a hot loop.
- **Polling with syscalls**: calling `stat()` in a loop, or `epoll_wait` with zero timeout continuously. Use notifications (inotify, blocking waits).
- **Assuming syscalls are free after mitigations**: re-benchmark on your production CPUs and kernel.
- **Ignoring short reads and writes**: `read` and `write` may move fewer bytes than asked, and must be looped.
- **Not handling `EINTR`**: a signal can interrupt a blocking call, which then fails with `EINTR` and must be retried (or use `SA_RESTART`).

> [!TIP]
> `strace -c` counts syscalls and their time, and `perf trace -s` does the same with lower overhead. `perf top` showing `entry_SYSCALL_64` or `do_syscall_64` near the top means you're paying for many crossings.

## Discussion questions

1. Why can't user programs just call kernel functions directly?
2. What does the kernel have to check before using a pointer passed by a program?
3. Why did system calls get more expensive in 2018, and why less so on newer CPUs?
4. How does the vDSO make `clock_gettime` cheaper than a system call, and why can't `read` work the same way?
5. When is kernel bypass worth giving up the kernel's network stack?
6. How does `sendfile` avoid copying data through user space?

## FAQ

### Is a system call a context switch?

No. It's a **mode switch**: the same thread moves into the kernel and back. It becomes a context switch only if the call blocks (or the scheduler decides to preempt on return) and another thread runs.

### Why does libc wrap system calls instead of programs calling them directly?

The wrapper handles the calling convention, converts negative return values to `errno`, retries or adapts to kernel versions, and sometimes implements the call in user space (the vDSO time functions, or `getpid` caching in older glibc). Go is an exception: it makes system calls directly on Linux without libc.

### How do I see which system calls a program makes?

`strace` (or `strace -f` for child threads and processes) on Linux, `dtruss` or `fs_usage` on macOS. eBPF tools like `bpftrace` and `perf trace` give lower-overhead tracing in production.

### What's the difference between a system call and an interrupt?

A system call is a deliberate, synchronous request from the running program. An **interrupt** is an asynchronous signal from hardware (a packet arrived, a timer fired) that pauses whatever is running. An **exception** (page fault, divide by zero) is a synchronous event caused by the current instruction. All three switch to kernel mode through entry points set up by the kernel.

### Does the kernel have its own address space?

On Linux, the kernel is mapped into the top half of every process's address space, protected by the supervisor bit, so a syscall doesn't need to switch page tables. KPTI changes that on CPUs vulnerable to Meltdown by keeping the kernel mostly unmapped while in user mode.

## Key takeaways

- A **system call** is the controlled entry from user mode into the kernel: a number and arguments in registers, one special instruction.
- The kernel **validates every argument** and copies data with fault-safe routines. The boundary is also a **security surface** (seccomp).
- A trivial syscall costs **~50–100 ns**, more with **2018-era mitigations**, plus cache disruption. Blocking adds a context switch.
- Cut crossings with **buffering, vectored and batched calls, io_uring, zero-copy**, the **vDSO** and **futexes**.
- **Kernel bypass** removes syscalls from the data path entirely, at the cost of dedicated cores and complexity.

## References

1. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapter 6: [Limited Direct Execution](https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-mechanisms.pdf).
2. Linux man pages. [syscall(2)](https://man7.org/linux/man-pages/man2/syscall.2.html), [syscalls(2)](https://man7.org/linux/man-pages/man2/syscalls.2.html), [vdso(7)](https://man7.org/linux/man-pages/man7/vdso.7.html), [sendfile(2)](https://man7.org/linux/man-pages/man2/sendfile.2.html).
3. L. Soares, M. Stumm. [FlexSC: Flexible System Call Scheduling with Exception-Less System Calls](https://www.usenix.org/legacy/events/osdi10/tech/full_papers/Soares.pdf). *OSDI 2010*.
4. Linux kernel docs. [Page Table Isolation](https://docs.kernel.org/arch/x86/pti.html) and [Seccomp BPF](https://docs.kernel.org/userspace-api/seccomp_filter.html).
5. M. Kerrisk. *The Linux Programming Interface*, chapter 3: System Programming Concepts. No Starch Press, 2010.
6. DPDK. [Programmer's Guide: Overview](https://doc.dpdk.org/guides/prog_guide/overview.html).
7. B. Gregg. [KPTI/KAISER Meltdown Initial Performance Regressions](https://www.brendangregg.com/blog/2018-02-09/kpti-kaiser-meltdown-performance.html). 2018.

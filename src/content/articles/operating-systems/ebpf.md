---
summary: How eBPF lets you load small, verified programs into the running Linux kernel to trace any function, process packets at line rate, and enforce security policy, and why its verifier, maps and CO-RE made it the foundation of modern observability and cloud networking.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** **eBPF** lets you run small programs **inside the Linux kernel**, attached to events (a kernel or user function being called, a tracepoint, a packet arriving, a system call, a socket operation), **without writing a kernel module or rebooting**. Programs are written in restricted C (or Rust, or bpftrace's scripting language), compiled to BPF bytecode, and loaded with the `bpf()` system call. A **verifier** checks every possible path to prove the program **terminates** and only touches memory it's allowed to, then a **JIT** compiles it to native code. Programs share data with user space and each other through **maps** (hash tables, arrays, per-CPU arrays, ring buffers). With **BTF** type information and **CO-RE**, one compiled tool runs across kernel versions. The result is a safe, programmable kernel used for **observability** (bpftrace, BCC, profilers, Pixie, Parca), **networking** (XDP for line-rate packet processing, Cilium for Kubernetes, Katran load balancing, DDoS mitigation), **security** (Falco, Tetragon, BPF LSM) and even **CPU scheduling** (sched_ext).

## The problem: the kernel is hard to change and hard to see into

Many questions about a running system can only be answered from inside the kernel: which process is causing these disk writes, why is this TCP connection retransmitting, where does this request spend its 40 ms. Many behaviors (packet filtering, load balancing, security policy) are fastest when done in the kernel too. Traditionally, the options were:

- **Change the kernel** and wait years for the change to reach production.
- **Write a kernel module**: full power, but a bug can crash the machine, and modules must be built for each kernel version.
- **Use fixed interfaces** (`/proc`, `perf`, `strace`, `iptables`), which only expose what someone anticipated, often with high overhead. `strace` can slow a process by orders of magnitude.

eBPF adds a safe, programmable layer: load new logic at runtime, with guarantees that it can't crash or hang the kernel.

## How eBPF works

![Source compiled with clang to BPF bytecode with BTF type info, loaded with the bpf syscall, checked by the verifier, JIT-compiled to native code and attached to a hook; BPF maps connect the program to a user-space tool.](/figures/ebpf/pipeline.svg "Load, verify, compile, attach. User space and kernel share state through maps.")

1. **Write** a program in restricted C (with libbpf), Rust (Aya), Go (cilium/ebpf, with C for the program), or a high-level tool like **bpftrace**, which compiles one-liners for you.
2. **Compile** to BPF bytecode: a simple 64-bit instruction set with 11 registers and a 512-byte stack. **BTF** (BPF Type Format) records the types used.
3. **Load** with the `bpf()` system call (usually via libbpf).
4. **Verify.** The kernel's verifier simulates every path through the program, tracking register types and value ranges, and rejects it unless it can prove that:
   - it **terminates** (loops must be provably bounded),
   - every memory access is **in bounds** and every pointer is checked for NULL,
   - it only calls **helper functions** allowed for its program type,
   - it doesn't leak kernel pointers to unprivileged users.
5. **JIT-compile** to native machine code, so it runs at near-native speed.
6. **Attach** to a hook. The program runs every time that event happens.
7. **Communicate through maps**: kernel-side programs update maps (count events, record latencies into histograms, store config), and user-space tools read them, or stream events through a **ring buffer**.

### CO-RE: compile once, run everywhere

Tracing programs read kernel data structures whose layout changes between kernel versions and configurations. Originally, tools like BCC compiled programs **on the target machine** at startup, requiring kernel headers and a compiler there. **CO-RE** uses the BTF type information the kernel ships (`/sys/kernel/btf/vmlinux`) to relocate field offsets at load time, so a tool compiled once runs on many kernels. That made eBPF practical to ship in products.

## Where programs attach

![Observability hooks: kprobes, uprobes, tracepoints, USDT and perf events. Networking: XDP, tc and socket and cgroup hooks. Security: seccomp, BPF LSM and cgroup hooks. Scheduling: sched_ext and struct_ops.](/figures/ebpf/hooks.svg "One verified runtime, many attachment points.")

**Observability**

- **kprobes/kretprobes** and **fentry/fexit**: any kernel function's entry or return.
- **uprobes**: any function in a user-space binary or library (for example, `SSL_write` in OpenSSL to see plaintext, or a Go function).
- **tracepoints** and **USDT** probes: stable, predefined instrumentation points.
- **perf events**: sample stacks at a frequency for CPU profiling, with stack aggregation done in the kernel.

Tools: `bpftrace` one-liners, the **BCC** collection (`execsnoop`, `opensnoop`, `biolatency`, `tcpretrans`, `runqlat`...), continuous profilers (Parca, Pyroscope, the Datadog and Elastic profilers), and Kubernetes observability (Pixie, Hubble).

**Networking**

- **XDP** (eXpress Data Path): runs in the NIC driver before the kernel allocates a socket buffer, and can drop, pass, redirect or rewrite packets at tens of millions of packets per second. Cloudflare drops DDoS traffic with it, and Meta's **Katran** load balancer is built on it.
- **tc** (traffic control) hooks on ingress and egress: rewriting, NAT, redirect between interfaces.
- **Socket and cgroup hooks**: intercept `connect`, `bind` and `sendmsg` to implement service load balancing without iptables, or enforce per-container network policy.
- **Cilium**, a popular Kubernetes networking layer, implements services, network policy and observability with eBPF instead of long iptables chains.

**Security**

- **BPF LSM** attaches programs to Linux Security Module hooks, so policy (block this binary from opening that file) can be written and updated at runtime.
- Runtime security tools such as **Falco** and **Tetragon** watch process execution, file access and network activity, and can block it in kernel.
- **seccomp** filters use the older classic BPF to restrict system calls per process.

**Beyond that**

- **sched_ext** (Linux 6.12) lets whole CPU scheduling policies be written in BPF.
- **struct_ops** lets BPF implement kernel interfaces such as TCP congestion control algorithms.

## eBPF vs kernel modules

![Table: eBPF programs are verified and can't crash the kernel, load at runtime, run across kernels with CO-RE, have limited helpers and need CAP_BPF; kernel modules can panic the machine, must match the kernel build, can do anything, and need root.](/figures/ebpf/vs-modules.svg "Less power, much more safety and deployability.")

The trade-off is expressiveness: BPF programs have bounded complexity (the verifier caps how many instructions it will analyze, currently one million), can only call approved helpers and kfuncs, and can't block in most contexts. In exchange, they can be loaded into production machines with confidence.

## Where it's used

| Area | Examples |
| --- | --- |
| **Observability** | bpftrace, BCC tools, Pixie, Parca, Hubble, continuous profilers |
| **Kubernetes networking** | Cilium (services, policy, encryption, observability) |
| **Load balancing and DDoS** | Katran (Meta), Cloudflare's XDP-based mitigation |
| **Runtime security** | Falco, Tetragon, Tracee, BPF LSM policies |
| **Performance** | Off-CPU analysis, run-queue latency, I/O latency histograms |
| **Scheduling** | sched_ext schedulers (scx_rusty, scx_lavd) |

### Use case walk-through: finding a mysterious latency source

A service has occasional 200 ms latency spikes. Application metrics show nothing unusual, and CPU isn't saturated.

1. **Run-queue latency.** `runqlat` (BCC) shows a histogram of how long threads wait for a CPU: mostly microseconds, with no 200 ms tail. Not scheduling.
2. **Off-CPU time.** `offcputime -p <pid>` records stacks while threads are blocked. A tail of 200 ms waits appears in `fsync`, called from the logging library.
3. **Block I/O latency.** `biolatency -D` shows the disk itself has occasional 150–200 ms write latencies, and `biosnoop` ties them to a nightly backup process reading the same disk.
4. **Confirm with a one-liner:** `bpftrace -e 'kprobe:vfs_fsync_range { @start[tid] = nsecs } kretprobe:vfs_fsync_range /@start[tid]/ { @us = hist((nsecs - @start[tid]) / 1000); delete(@start[tid]) }'` gives a live histogram of `fsync` latency.
5. **Fix.** Make logging asynchronous (no `fsync` on the request path), and throttle the backup's I/O with cgroup `io.max`. All of this was diagnosed on the production box, with no restarts and negligible overhead.

## Pitfalls

- **Overhead on very hot paths:** a probe on a function called millions of times per second still costs. Prefer tracepoints and in-kernel aggregation (histograms in maps) over sending every event to user space.
- **kprobes on internal functions are unstable:** functions get renamed or inlined between kernel versions. Prefer tracepoints and fentry with BTF.
- **Old kernels:** many features (BTF, CO-RE, ring buffers, bounded loops, BPF LSM) need relatively recent kernels (5.x and later).
- **Verifier rejections** can be cryptic, and code must be structured to help the verifier prove bounds.
- **Security:** loading BPF programs needs privileges (`CAP_BPF`, `CAP_PERFMON`, `CAP_NET_ADMIN`, or root). Unprivileged BPF has had vulnerabilities and is disabled by default on most distributions. A malicious loaded program can read sensitive data even if it can't crash the kernel.

> [!TIP]
> Start with ready-made tools before writing programs: `execsnoop` (new processes), `opensnoop` (file opens), `biolatency` (disk latency), `tcpretrans` (retransmits), `runqlat` (scheduler delay) and `profile` (CPU flame graphs) answer a surprising number of production questions. `bpftool prog list` shows what's already loaded.

## Discussion questions

1. What does the verifier need to prove before a program can run in the kernel, and why?
2. How do maps let kernel programs and user space cooperate?
3. Why is XDP faster than iptables for dropping DDoS traffic?
4. What problem does CO-RE solve for distributing eBPF tools?
5. When would you still write a kernel module instead of an eBPF program?
6. How can eBPF-based observability have lower overhead than strace?

## FAQ

### What's the difference between BPF and eBPF?

The original **BPF** (Berkeley Packet Filter, 1992) was a tiny virtual machine for filtering packets, used by `tcpdump`. **eBPF** ("extended", Linux 3.18 in 2014) generalized it with 64-bit registers, maps, helper calls, a JIT and many attachment points. Today "BPF" usually means eBPF, and classic BPF survives in seccomp and socket filters.

### Is eBPF only on Linux?

It started on Linux and that's where it's most capable, but Microsoft develops **eBPF for Windows**, and there are user-space BPF runtimes. The eBPF Foundation coordinates cross-platform work.

### Can eBPF programs modify kernel data?

Only in limited, controlled ways: through specific helpers (rewriting packets, setting return values in some hooks, writing to maps, sending signals). They can't write arbitrary kernel memory.

### How is eBPF tracing different from strace?

`strace` uses ptrace, stopping the traced process at every system call and switching to the tracer, which can slow it down 10–100×. eBPF programs run inside the kernel at the event and can aggregate data there, so overhead is typically small enough for production use.

### Do I need to write C to use eBPF?

No. bpftrace provides a high-level language for one-liners and short scripts, BCC offers Python front-ends, and Go and Rust libraries let you write the user-space side in those languages. Aya even lets the kernel-side program be written in Rust.

## Key takeaways

- eBPF runs **verified, JIT-compiled programs** inside the kernel, attached to **events**, without modules or reboots.
- The **verifier** guarantees termination and memory safety, and **maps** share state with user space.
- **BTF + CO-RE** let one tool binary work across kernel versions.
- Uses span **observability** (bpftrace, BCC, profilers), **networking** (XDP, Cilium, Katran), **security** (BPF LSM, Falco, Tetragon) and **scheduling** (sched_ext).
- It's powerful and safe, but **privileged**: treat loading BPF like loading kernel code.

## References

1. ebpf.io. [What is eBPF?](https://ebpf.io/what-is-ebpf/)
2. Linux kernel docs. [BPF Documentation](https://docs.kernel.org/bpf/index.html) and [eBPF verifier](https://docs.kernel.org/bpf/verifier.html).
3. B. Gregg. *BPF Performance Tools*. Addison-Wesley, 2019.
4. S. McCanne, V. Jacobson. [The BSD Packet Filter: A New Architecture for User-level Packet Capture](https://www.tcpdump.org/papers/bpf-usenix93.pdf). *USENIX Winter 1993*.
5. A. Nakryiko. [BPF CO-RE (Compile Once – Run Everywhere)](https://nakryiko.com/posts/bpf-portability-and-co-re/). 2020.
6. T. Høiland-Jørgensen et al. [The eXpress Data Path: Fast Programmable Packet Processing in the Operating System Kernel](https://dl.acm.org/doi/10.1145/3281411.3281443). *CoNEXT 2018*.
7. bpftrace. [Reference guide](https://github.com/bpftrace/bpftrace/blob/master/docs/reference_guide.md).
8. Cilium docs. [Introduction to Cilium](https://docs.cilium.io/en/stable/overview/intro/).

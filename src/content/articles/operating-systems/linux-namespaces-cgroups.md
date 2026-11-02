---
summary: How containers are built from two Linux kernel features (namespaces, which control what a process can see, and cgroups, which control what it can use), plus root filesystems, capabilities and seccomp, and what that means for isolation, resource limits and security.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** There is no "container" object in the Linux kernel. A container is an ordinary process that a runtime (runc, crun) sets up with several kernel features. **Namespaces** give it a private view of some resource: its own process IDs (PID 1 inside), network interfaces and ports, mount table and root filesystem, hostname, IPC, and user IDs (root inside, unprivileged outside). **Control groups (cgroups)** put it in a group whose CPU, memory, I/O and process count are **accounted and limited**. Add a root filesystem assembled from image layers (**overlayfs**), dropped **capabilities**, a **seccomp** filter and an **AppArmor/SELinux** profile, and you have what Docker and Kubernetes run. Because every container shares **one kernel**, containers are lighter than VMs but isolate less. A kernel bug or a misconfiguration (privileged mode, mounted Docker socket) can let a process escape, which is why multi-tenant platforms add **gVisor** or **microVMs** like Firecracker.

## The problem: isolation without a VM

Running each application in its own virtual machine gives strong isolation, but every VM boots a whole OS, reserves memory, and takes seconds to start. Running everything as plain processes on one host is efficient, but processes see each other, compete for resources, and clash over ports, files and library versions.

Linux gradually gained features to get most of the isolation at process cost: mount namespaces (2002), cgroups (2008, contributed by Google engineers), network and PID namespaces (around 2.6.24–2.6.29), and user namespaces (completed in 3.8, 2013). LXC combined them first. Docker (2013) made them easy with images and a simple CLI.

## Namespaces: what a process can see

![Eight namespace types: pid, net, mnt, uts, ipc, user, cgroup and time, each with what it isolates.](/figures/containers/namespaces.svg "Each namespace type virtualizes one kind of kernel resource.")

A namespace wraps a global resource so that processes inside it see their own isolated instance. Every process belongs to one namespace of each type, and new ones are created with `clone()` or `unshare()` flags, or joined with `setns()`.

| Namespace | Isolates | Effect |
| --- | --- | --- |
| **PID** | Process IDs | Container sees only its processes, starting at PID 1 |
| **Network** | Interfaces, IPs, routing, ports, firewall rules | Container gets its own `eth0` (a veth pair to the host), can bind port 80 independently |
| **Mount** | Mount table | Container has its own root filesystem and mounts |
| **UTS** | Hostname, domain name | `hostname` inside differs from the host |
| **IPC** | System V IPC, POSIX message queues | No shared memory segments with other containers |
| **User** | UIDs, GIDs and capabilities | UID 0 inside maps to an unprivileged UID outside (rootless containers) |
| **Cgroup** | View of the cgroup hierarchy | Container sees its own cgroup as the root |
| **Time** | `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` offsets | Useful for checkpoint/restore |

![The host PID namespace lists systemd as 1, sshd, nginx as 4242 and postgres as 5100. Container A sees nginx as PID 1; container B sees postgres as PID 1.](/figures/containers/pid-namespace.svg "Namespaces are nested views onto one set of kernel objects.")

You can try it without any container tooling:

```
sudo unshare --pid --fork --mount-proc --uts bash
hostname sandbox; ps aux     # only bash and ps, as PID 1 and 2
```

Since namespaces are views, the host can always see in: `nsenter -t <pid> -n ip addr` runs a command inside a container's network namespace, which is how many debugging tools work.

## cgroups: what a process can use

![A cgroup v2 tree: root with system.slice, kubepods.slice and user.slice; under kubepods, pods with cpu.weight; under pods, containers with memory.max and cpu.max.](/figures/containers/cgroup-tree.svg "Kubernetes and systemd organize processes into a tree, and limits apply to whole subtrees.")

A **control group** is a set of processes with resource accounting and limits. In **cgroup v2** (the unified hierarchy, stable since Linux 4.5 and now the default in major distributions), groups form one tree under `/sys/fs/cgroup`. Each group is a directory, and you configure it by writing files:

- **CPU:** `cpu.weight` (relative share under contention) and `cpu.max` (hard quota per period, which can throttle). See the CPU scheduling deep dive.
- **Memory:** `memory.max` (hard limit; exceeding it triggers reclaim, then the OOM killer **within the group**), `memory.high` (soft limit that throttles via reclaim), `memory.min`/`memory.low` (protection). Page cache counts toward usage.
- **I/O:** `io.max` (bandwidth or IOPS limits per device), `io.weight`.
- **Processes:** `pids.max` stops fork bombs.
- **Pressure:** `cpu.pressure`, `memory.pressure` and `io.pressure` (PSI) report how much time tasks spent stalled on each resource, which is a better signal than utilization.

systemd puts every service in its own cgroup (`system.slice/nginx.service`). Kubernetes maps each **pod** to a cgroup and each **container** to a child: **requests** become weights and **limits** become `cpu.max` and `memory.max`.

## Putting it together: what a container runtime does

![A process at the center, combined with namespaces, cgroups, a root filesystem from overlayfs layers, capabilities, seccomp and an LSM profile.](/figures/containers/recipe.svg "A container is a process plus a recipe of independent kernel features.")

When you `docker run` or Kubernetes starts a pod, containerd calls an OCI runtime such as **runc**, which:

1. **Prepares the root filesystem**: the image's read-only layers stacked with a writable layer using **overlayfs**.
2. **Clones** a process into new namespaces (PID, mount, network, UTS, IPC, and optionally user).
3. **Joins a cgroup** with the configured limits.
4. **Sets up mounts**: `/proc`, `/sys`, `/dev`, volumes, then `pivot_root` into the new root.
5. **Drops capabilities**: root's powers are split into ~40 capabilities, and containers keep only a small default set (no `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, etc.).
6. **Applies a seccomp filter** blocking dozens of risky system calls (such as `kexec_load`, `mount` and most `keyctl` operations).
7. **Applies an LSM profile** (AppArmor or SELinux).
8. **`exec`s the entrypoint**, which becomes PID 1 inside.

The network namespace is wired up by the runtime or a CNI plugin: a **veth pair** connects the container's `eth0` to a bridge or routing on the host, with NAT or an overlay for external traffic.

## Where it's used

| System | How it uses namespaces and cgroups |
| --- | --- |
| **Docker / Podman** | All namespaces + cgroups via runc/crun. Podman runs rootless with user namespaces |
| **Kubernetes** | Pods share network and IPC namespaces between containers. cgroups from requests and limits |
| **systemd** | A cgroup per service, `systemd-run` for transient units, sandboxing options like `PrivateTmp`, `ProtectSystem` |
| **Chrome and Firefox** | Namespaces and seccomp sandbox renderer processes |
| **Flatpak / bubblewrap** | Unprivileged sandboxes for desktop apps |
| **gVisor, Kata, Firecracker** | Add a user-space kernel or a microVM boundary for untrusted code |

### Use case walk-through: a Java service OOM-killed at 60% usage

A JVM service in a container with `memory.max = 4 GiB` is OOM-killed several times a day, though the heap never exceeds 2.5 GiB.

1. **Check the cgroup.** `memory.events` shows `oom_kill` increments, and `memory.current` peaked at 4 GiB. Kubernetes reports `OOMKilled`.
2. **Account for everything.** The cgroup charges **all** memory: heap, metaspace, thread stacks (300 threads × ~1 MiB), direct buffers used by Netty, JIT code cache, GC structures, and page cache from log files. Native Memory Tracking (`-XX:NativeMemoryTracking=summary`) shows ~1.3 GiB outside the heap.
3. **Size for the container.** Modern JVMs are container-aware (since JDK 10, backported to 8u191): they read cgroup limits. Use `-XX:MaxRAMPercentage=60` instead of a fixed `-Xmx`, and cap direct memory and thread counts.
4. **Use the early warning.** Set `memory.high` slightly below `memory.max`, so the group gets reclaim pressure (dropping cache) before hard OOM, and alert on `memory.pressure`.
5. **CPU too.** The same container had a 2-CPU limit on a 64-core host. Old runtimes sized thread pools for 64 cores and got throttled. Make sure runtimes read cgroup CPU limits (the JVM does; Go does since 1.25).

## Pitfalls

- **Treating containers as a security boundary for hostile code.** They share a kernel. Kernel exploits and runtime bugs (like runc's CVE-2019-5736) can escape. Use gVisor or microVMs for untrusted multi-tenant workloads.
- **`--privileged`, `CAP_SYS_ADMIN`, or mounting `/var/run/docker.sock`**: each effectively gives root on the host.
- **Running as root inside without user namespaces**: UID 0 inside is UID 0 on the host for anything that escapes.
- **Apps that read host-wide info**: `/proc/meminfo` and `nproc` show the host, not the cgroup limits, unless the runtime is cgroup-aware (or LXCFS is used).
- **No init process**: a PID 1 that doesn't reap zombies or forward signals leads to leaked processes and slow shutdowns. Use `tini` or `--init`.
- **Memory limits without accounting for page cache and native memory**, leading to surprise OOM kills.

> [!TIP]
> `systemd-cgls` shows the cgroup tree with processes, `systemd-cgtop` shows live usage per group, and `lsns` lists all namespaces on the host with their processes.

## Discussion questions

1. What's the difference between what namespaces and cgroups control?
2. Why does PID 1 inside a container need special behavior?
3. How do user namespaces make rootless containers possible, and what risks remain?
4. Why can a container be OOM-killed when the host has plenty of free memory?
5. Why are containers considered weaker isolation than VMs, and how do gVisor and Firecracker change that?
6. How do two containers in the same Kubernetes pod talk over `localhost`?

## FAQ

### Is a container just a chroot?

`chroot` only changes the root directory, and it's easy to escape for root. Containers use a mount namespace with `pivot_root`, plus all the other namespaces, cgroups, capabilities and seccomp. A chroot is one ingredient of an old, weaker version of the idea.

### What's the difference between cgroup v1 and v2?

v1 had a separate hierarchy per controller (cpu, memory, blkio…), which made consistent policies hard. v2 has a single unified tree, better memory and I/O control, pressure stall information, and safer delegation to unprivileged users. Most distributions and Kubernetes now default to v2.

### Do containers have their own kernel?

No. All containers on a host share the host kernel, which is why a Linux container can't run a different OS kernel, and why `uname -r` inside shows the host's kernel version. Docker Desktop on macOS and Windows runs a Linux VM to provide that kernel.

### How do containers get their own IP address?

The runtime creates a network namespace and a **veth pair**: one end becomes `eth0` inside the container, and the other attaches to a bridge (docker0) or is routed by a CNI plugin on the host. NAT or an overlay network connects it to the outside.

### What are rootless containers?

Containers started by an unprivileged user, using a user namespace that maps container root to the user's own UID (and a range of subordinate UIDs). Even if a process breaks out of the container, it only has the user's privileges on the host. Podman and Docker both support it.

## Key takeaways

- A **container** is a process plus kernel features. There's no container object in the kernel.
- **Namespaces** control **visibility**: PID, network, mount, UTS, IPC, user, cgroup and time.
- **cgroups** control **resources**: CPU weights and quotas, memory limits (with per-group OOM), I/O and process counts, with pressure metrics.
- Runtimes add **overlayfs root filesystems, capabilities, seccomp and LSMs**.
- One **shared kernel** makes containers light but weaker than VMs. Use **gVisor or microVMs** for hostile workloads.

## References

1. Linux man pages. [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html), [cgroups(7)](https://man7.org/linux/man-pages/man7/cgroups.7.html), [user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html), [unshare(1)](https://man7.org/linux/man-pages/man1/unshare.1.html).
2. Linux kernel docs. [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html).
3. M. Kerrisk. [Namespaces in operation](https://lwn.net/Articles/531114/), *LWN* series, 2013.
4. Open Container Initiative. [Runtime Specification](https://github.com/opencontainers/runtime-spec).
5. Kubernetes docs. [About cgroup v2](https://kubernetes.io/docs/concepts/architecture/cgroups/).
6. A. Agache et al. [Firecracker: Lightweight Virtualization for Serverless Applications](https://www.usenix.org/conference/nsdi20/presentation/agache). *NSDI 2020*.
7. gVisor docs. [What is gVisor?](https://gvisor.dev/docs/)
8. Docker docs. [Seccomp security profiles](https://docs.docker.com/engine/security/seccomp/).

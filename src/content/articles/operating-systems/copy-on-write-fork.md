---
summary: How fork() clones a process in milliseconds by sharing memory and copying pages only when someone writes, and what that means for Redis snapshots, pre-forking servers, Python workers and launching programs from big processes.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** `fork()` creates a child process that is a copy of its parent, but the kernel doesn't copy memory. It copies the **page tables**, marks every writable private page **read-only** in both processes, and bumps each page's reference count. The first time either process **writes** to a shared page, the CPU raises a page fault and the kernel copies **just that page** (**copy-on-write**, COW). Pages that are never written are never copied. This makes `fork()` cheap, lets Redis and PostgreSQL-style servers take consistent snapshots or spawn workers, and lets Android start apps from a pre-warmed **Zygote**. The costs are: fork time still grows with the size of the page tables (~10 ms per GB), memory use **grows with the write rate** while parent and child coexist, and `fork()` interacts badly with threads. For running a new program, prefer `posix_spawn()`.

## The problem: cloning a process

Unix creates processes in two steps: `fork()` clones the current process, and `exec()` replaces the clone's program with a new one. The shell runs every command this way, and servers have long used `fork()` to hand each connection or job to a worker.

A naive `fork()` would copy the parent's entire address space. For a 10 GB process that means copying 10 GB of RAM, taking seconds, doubling memory use, and then, if the child calls `exec()` right away, throwing it all away. Early Unix did copy (whole processes were tiny then). Modern kernels share instead.

## How copy-on-write works

![Parent and child page tables, each with entries A to D marked read-only, both pointing at the same four physical frames whose reference count is 2.](/figures/cow/shared.svg "After fork(), both processes see the same physical memory. Nothing has been copied yet.")

When a process calls `fork()`, Linux:

1. Creates a new task with a copy of the parent's registers, file descriptor table, signal handlers and so on.
2. Duplicates the **memory map** (the list of mapped regions, `vm_area_struct`s) and the **page tables** that translate the child's virtual addresses to physical frames.
3. For each **private, writable** page, clears the write bit in **both** parent and child page table entries (PTEs) and increments the page's reference count.
4. Returns twice: the child gets 0, and the parent gets the child's PID.

Both processes now read the same physical memory. **Shared** mappings (`MAP_SHARED`, shared memory segments) are not write-protected: both processes keep seeing each other's writes, which is the point of sharing.

### The copy-on-write fault

![Five steps: the child stores to page B; the PTE is read-only so the MMU faults; the kernel sees refs greater than 1 and copies the 4 KiB page into a new frame; the child's PTE now points to the new writable frame; the store is retried and succeeds.](/figures/cow/fault.svg "Only the page that was written is copied, and only once.")

When either process writes to a write-protected page:

1. The MMU sees the PTE is read-only and raises a **page fault**.
2. The kernel checks the memory map: the region is writable, so this is a COW fault, not a bug (otherwise the process gets `SIGSEGV`).
3. If the page is still shared (reference count > 1), the kernel allocates a new frame, copies the 4 KiB, points the faulting process's PTE at the copy, makes it writable and flushes that TLB entry.
4. If the page is no longer shared (the other process already copied it or exited), the kernel **reuses** it: it just marks the PTE writable again, with no copy.
5. The faulting instruction is retried and succeeds.

Each COW fault costs a few microseconds. A process that writes to a million distinct pages after `fork()` takes a million faults and copies 4 GB.

The same trick shows up elsewhere in the kernel:

- **The zero page:** reading a never-touched anonymous page maps one shared, read-only page of zeros. The first write triggers a COW-style fault that allocates a real page.
- **Private file mappings** (`mmap(..., MAP_PRIVATE)`): pages come from the page cache and are shared until written, then copied, so your writes never reach the file. This is how the text and data segments of programs and shared libraries are mapped.

## Where the cost goes

### fork() isn't free: page tables scale with memory

`fork()` doesn't copy pages, but it does copy page tables and region metadata. With 4 KiB pages, mapping 1 GB takes 262,144 PTEs (2 MB of page tables), and all of them must be copied and write-protected. Redis's latency documentation measured about **9–13 ms per GB** of resident memory on bare metal and modern VMs, and over 200 ms per GB on old Xen-based EC2 instances. During that time the parent is blocked inside `fork()`, so a 25 GB Redis can stall for a quarter of a second.

Huge pages help here: a 2 MiB page needs one entry instead of 512.

### Memory grows with the write rate

![Bar chart for a 10 GB Redis snapshot: read-mostly cache adds about 0.2 GB; moderate writes about 2.5 GB; write-heavy random keys about 8 GB; write-heavy with transparent huge pages on kernels before 5.8 about 10 GB.](/figures/cow/snapshot.svg "COW defers copying, but every page written while both processes live is eventually copied once. The numbers are illustrative.")

While parent and child both exist, each page written by either one gets duplicated. A child that lives for a long time (writing a snapshot of a large dataset) while the parent keeps taking writes can, in the worst case, **double** memory use. Things that make it worse:

- **Writes spread over many pages.** Updating random keys dirties far more pages than appending to one region.
- **Transparent huge pages (THP).** Before Linux 5.8, a COW fault on a 2 MiB huge page copied all 2 MiB. Since 5.8, the kernel splits the huge page mapping and copies 4 KiB, but THP still adds latency spikes to fork-heavy workloads, and Redis still warns you to disable it.
- **Language runtimes that write to "read-only" data.** CPython stores a reference count in every object, so merely *reading* an object writes to its page. A garbage collector that sets mark bits inside objects does the same. Both silently un-share memory in forked workers.

### Memory accounting and overcommit

After `fork()`, the kernel has promised the child its own copy of every private page, even though it hasn't made them. Under strict accounting (`vm.overcommit_memory = 2`), a large process can fail to fork because the kernel won't commit that much memory. That's why Redis recommends `vm.overcommit_memory = 1`, and why a forking process on a nearly full machine can be killed by the OOM killer later, when COW faults actually need the memory.

## fork() and threads

`fork()` copies only the **calling thread**. Every other thread vanishes in the child, but the memory they were using doesn't, including any **locks they held**. If another thread held the `malloc` lock at the moment of `fork()`, the child's first `malloc()` deadlocks forever.

POSIX therefore says that after `fork()` in a multithreaded program, the child may only call **async-signal-safe** functions until it calls `exec()`. In practice:

- Fork early, before starting threads, or fork only to `exec()` immediately.
- Don't fork from a process that uses threads internally (many libraries do, including gRPC, CUDA and some database drivers) unless you exec right away.
- Python 3.12 started warning when `os.fork()` is called in a process with multiple threads, and Python 3.14 switched the default `multiprocessing` start method on Linux from `fork` to `forkserver`.

## Starting new programs: fork vs vfork vs posix_spawn

![Bars: fork plus exec costs roughly 10 ms per GB mapped; vfork plus exec and posix_spawn are constant, tens of microseconds.](/figures/cow/spawn.svg "If the child is going to exec, copying the page tables is wasted work.")

When the child immediately calls `exec()`, all the work of copying page tables is thrown away. Alternatives:

- **`vfork()`:** the child **borrows** the parent's memory (no page table copy), and the parent is suspended until the child calls `exec()` or `_exit()`. Fast, but dangerous: the child must not modify memory or return from the calling function.
- **`posix_spawn()`:** a portable "create a process running this program" call. glibc implements it with `clone(CLONE_VM | CLONE_VFORK)` and a separate stack, which gives vfork-like speed without its hazards. Java's `ProcessBuilder` on Linux uses posix_spawn by default (since JDK 13), and Go's `os/exec` uses vfork-style clone.

The 2019 paper *A fork() in the road* argues that `fork()` is a poor fit for modern systems: it is slow for big processes, unsafe with threads, conflicts with strict memory accounting, and complicates the kernel. For new code, use `posix_spawn()` to run programs, and use threads or explicit shared memory for parallelism.

## Where it's used

| System | How it uses fork + COW |
| --- | --- |
| **Redis** | `BGSAVE` and AOF rewrite fork a child that writes a consistent snapshot while the parent keeps serving |
| **PostgreSQL** | The postmaster forks a backend process per connection, sharing code and initial state |
| **Android Zygote** | A pre-initialized runtime with common classes loaded forks each app, so apps share those pages |
| **Pre-fork servers** | Apache prefork, Gunicorn and Unicorn load the app once, then fork workers |
| **Python multiprocessing** | The `fork` start method gives workers the parent's state for free (with caveats) |
| **Unix shells** | `fork()` + `exec()` for every external command |

Copy-on-write as an idea goes far beyond `fork()`: **ZFS** and **Btrfs** never overwrite blocks in place, which makes snapshots nearly free; **LMDB** uses copy-on-write B-trees; and Swift arrays and Rust's `Cow` type copy a value only when it is mutated.

### Use case walk-through: Python workers that stop sharing memory

A team runs a Gunicorn app that loads a 3 GB model at startup, then forks 8 workers. They expected ~3 GB total, but each worker grows to ~2.5 GB of private memory within an hour, and the box runs out of RAM.

1. **Diagnose.** `/proc/<pid>/smaps_rollup` shows `Private_Dirty` climbing in every worker, while `Shared_Clean` shrinks. Pages are being un-shared.
2. **Cause.** Every Python object carries a reference count in its header. Workers *reading* model objects increment and decrement refcounts, which writes to the page and triggers COW. The cyclic garbage collector also touches object headers when it scans.
3. **Fix 1: freeze the heap.** Call `gc.freeze()` (Python 3.7+) in the parent right before forking. It moves all existing objects into a permanent generation the collector never scans. Instagram introduced this after finding that GC scans were un-sharing memory in their Django workers.
4. **Fix 2: keep big data out of Python objects.** Store the model weights in a NumPy array or a memory-mapped file. One array object holds a single refcount, and its gigabytes of data are never touched by refcounting.
5. **Result.** Shared memory stays high, and total RSS stays close to the size of one copy plus per-worker working sets.

## Pitfalls

- **Forking a huge process to run a tiny command.** A 30 GB JVM or Python process that calls `subprocess` with fork pays for copying page tables. Use `posix_spawn` (Python's `subprocess` already uses `vfork` or `posix_spawn` where it safely can).
- **No memory headroom for snapshots.** A fork-based snapshot of a write-heavy dataset can nearly double memory. Leave headroom, or schedule snapshots at quiet times.
- **Forking a multithreaded process** and calling anything but async-signal-safe functions before `exec()`.
- **Transparent huge pages** with fork-heavy databases: latency spikes, and on old kernels huge per-write copies.
- **Shared resources you didn't mean to share.** The child inherits open file descriptors (use `O_CLOEXEC`), connection pools and random number generator state. Two workers with the same RNG seed generate the same "random" IDs. Linux offers `MADV_WIPEONFORK` for exactly this case.

> [!WARNING]
> Copy-on-write logic is subtle enough to have produced one of the most famous Linux privilege escalations: **Dirty COW** (CVE-2016-5195), a race in COW handling that let an unprivileged user write to read-only files such as `/etc/passwd`. It existed in the kernel for about nine years.

## Discussion questions

1. Why does `fork()` still take time proportional to memory size even though no pages are copied?
2. A Redis instance with 40 GB of data runs on a 64 GB machine. Under what workload might `BGSAVE` get it OOM-killed?
3. Why can merely reading Python objects in a forked worker increase memory use?
4. Why is calling `malloc()` in the child of a multithreaded program dangerous?
5. When would you choose `posix_spawn()` over `fork()` + `exec()`, and when is `fork()` still the right tool?
6. How do copy-on-write filesystems apply the same idea to disk blocks?

## FAQ

### Does the child see changes the parent makes after fork()?

Not for private memory. Each process sees its own copy as soon as either one writes. Only shared mappings (`MAP_SHARED`, `shmget`, memory-mapped files opened shared) stay shared. Open file descriptors are shared too: parent and child share the same file offset.

### How can I see how much memory is actually shared?

Look at `/proc/<pid>/smaps_rollup`. `Shared_*` lines count pages mapped by more than one process, and `Private_*` lines count pages only this process maps. **PSS** (proportional set size) divides shared pages among the processes that map them, so summing PSS across processes gives the real total, unlike RSS.

### Is fork() slower on virtual machines?

It used to be much slower on paravirtualized Xen guests, where every page table update went through the hypervisor (Redis measured 239 ms per GB). With hardware-assisted virtualization (EPT/NPT), fork costs about the same as on bare metal.

### Does Windows have fork()?

No. Windows creates processes with `CreateProcess`, which starts a new program, much like `posix_spawn`. Cygwin emulates `fork()` on Windows, slowly. WSL 1 implemented it in its Linux compatibility layer, and WSL 2 runs a real Linux kernel.

### What's the difference between fork(), vfork() and clone()?

On Linux, all three are built on `clone()`, which takes flags saying what to share: memory (`CLONE_VM`), file descriptors (`CLONE_FILES`), signal handlers, namespaces and more. `fork()` shares nothing (memory is COW). `vfork()` shares memory and suspends the parent. A thread is a `clone()` that shares almost everything.

## Key takeaways

- `fork()` copies **page tables**, not memory. Pages are shared read-only, and copied **one page at a time on first write**.
- Fork time scales with **mapped memory** (~10 ms per GB). Extra memory scales with **how many pages get written** while both processes live.
- Refcounting and GC in language runtimes can **defeat COW** by writing to pages you only read. `gc.freeze()` and keeping data in flat arrays help.
- `fork()` in a **multithreaded** process is a trap: only async-signal-safe calls until `exec()`.
- To run another program, use **`posix_spawn()`**. Reserve `fork()` for snapshots and pre-fork worker models.

## References

1. A. Baumann, J. Appavoo, O. Krieger, T. Roscoe. [A fork() in the road](https://www.microsoft.com/en-us/research/publication/a-fork-in-the-road/). *HotOS 2019*.
2. Linux man pages. [fork(2)](https://man7.org/linux/man-pages/man2/fork.2.html), [vfork(2)](https://man7.org/linux/man-pages/man2/vfork.2.html), [posix_spawn(3)](https://man7.org/linux/man-pages/man3/posix_spawn.3.html), [madvise(2)](https://man7.org/linux/man-pages/man2/madvise.2.html).
3. Redis docs. [Diagnosing latency issues: latency generated by fork](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/).
4. Redis docs. [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).
5. Instagram Engineering. [Copy-on-write friendly Python garbage collection](https://instagram-engineering.com/copy-on-write-friendly-python-garbage-collection-ad6ed5233ddf). 2017.
6. Python docs. [gc.freeze()](https://docs.python.org/3/library/gc.html#gc.freeze).
7. M. Gorman. [Understanding the Linux Virtual Memory Manager](https://www.kernel.org/doc/gorman/html/understand/), chapter on process address space.
8. [Dirty COW (CVE-2016-5195)](https://dirtycow.ninja/).
9. Android Open Source Project. [Overview of memory management](https://developer.android.com/topic/performance/memory-overview) (Zygote and shared memory).

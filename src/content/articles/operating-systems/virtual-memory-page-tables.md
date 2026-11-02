---
summary: How the MMU gives every process its own private address space, how multi-level page tables translate virtual addresses to physical frames, and how the same mechanism enables isolation, shared libraries, lazy allocation, swapping and memory-mapped files.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Programs never use physical memory addresses directly. Every load and store uses a **virtual address**, which the CPU's **memory management unit (MMU)** translates to a physical address using **page tables** the kernel maintains for each process. Memory is managed in fixed-size **pages** (usually 4 KiB). On x86-64, a 48-bit virtual address is split into four 9-bit indexes and a 12-bit offset, and the MMU **walks four levels** of tables to find the physical frame. Because each process has its own tables, processes are **isolated**, can't see each other's memory, and can all use the same addresses. The same indirection lets the kernel **share** pages (libraries, copy-on-write), allocate **lazily** (a page gets real memory only on first touch), **swap** pages to disk, and **map files** into memory. The cost is translation overhead, which the **TLB** hides.

## The problem: many programs, one RAM

Without virtual memory, every program would use physical addresses. That causes problems:

- **No isolation.** A bug in one program can overwrite another program's memory, or the kernel's.
- **Relocation.** Programs must be loaded at different addresses each time, or agree on who gets which range.
- **Fragmentation.** A program that needs 1 GB contiguous may fail even when 1 GB is free in scattered pieces.
- **Overcommitment.** You can't run programs whose total memory exceeds physical RAM.

Virtual memory solves all four with one level of indirection: a per-process map from virtual pages to physical frames.

## How it works

![Two processes, each with stack, heap, libc and code regions; their arrows point to different physical frames for stack and heap, and to the same frames for libc and code.](/figures/virtual-memory/spaces.svg "Each process sees a private, contiguous address space. Physical frames can be anywhere, and can be shared.")

Memory is divided into **pages** (virtual) and **frames** (physical) of the same size, typically 4 KiB. The kernel keeps a **page table** for each process that says, for each virtual page, which physical frame backs it and what access is allowed. On every memory access, the MMU:

1. Splits the virtual address into a **page number** and an **offset** within the page.
2. Looks up the page number to get a **frame number** (first in the TLB, otherwise by walking the page table).
3. Checks the permissions, and raises a **page fault** if the page is absent or the access isn't allowed.
4. Forms the physical address as frame number + offset.

On a context switch to another process, the kernel loads a different page table root into a register (**CR3** on x86, **TTBR0** on ARM). From that moment, the same virtual addresses mean different memory.

### The page walk

![A 48-bit virtual address split into PML4, PDPT, PD and PT indexes of 9 bits each and a 12-bit offset. CR3 points to the PML4 table; each selected entry points to the next table; the PT entry points to the 4 KiB page.](/figures/virtual-memory/walk.svg "Four dependent memory reads to translate one address, before the actual access.")

A 64-bit address space is far too big for one flat table, so x86-64 uses a **radix tree** of tables. Each table is exactly one 4 KiB page holding 512 eight-byte entries, so each level consumes 9 bits of the address:

| Bits | Level | Covers |
| --- | --- | --- |
| 47–39 | PML4 (level 4) | 512 GiB per entry |
| 38–30 | PDPT (level 3) | 1 GiB per entry |
| 29–21 | Page directory (level 2) | 2 MiB per entry |
| 20–12 | Page table (level 1) | 4 KiB per entry |
| 11–0 | Offset in page | 1 byte |

4 × 9 + 12 = 48 bits, which gives 256 TiB of virtual address space, split into a lower half for user space and an upper half for the kernel. Newer CPUs support **5-level paging** (57 bits, 128 PiB) for machines with enormous memory. ARM64 uses a similar scheme, with configurable 4 KiB, 16 KiB or 64 KiB pages.

**Huge pages** fall out of the tree structure naturally: if a page directory entry is marked as a leaf, it maps a whole **2 MiB** page and the walk stops one level early. A leaf at the PDPT level maps a **1 GiB** page.

### Why a tree?

![Bars: a flat table for a 48-bit space would take 512 GiB; four-level tables for 1 GiB of 4 KiB pages take about 2 MiB; with 2 MiB huge pages, 12 KiB.](/figures/virtual-memory/sizes.svg "A tree only pays for the parts of the address space that are actually mapped.")

A flat table for 48 bits of 4 KiB pages would need 2³⁶ entries, or 512 GiB per process. But address spaces are **sparse**: some code at the bottom, a heap, libraries in the middle, a stack near the top, and huge empty holes. A multi-level table only allocates lower-level tables for regions that are mapped. Other designs exist (inverted page tables on PowerPC and IA-64 hash the page number), but radix trees dominate.

### What's in an entry

![The 64-bit x86-64 PTE: NX at bit 63, frame number in bits 51–12, then dirty, accessed, user/supervisor, read/write and present bits.](/figures/virtual-memory/pte.svg "The flags are how the kernel enforces protection and tracks usage.")

Each page table entry holds the **physical frame number** plus flags:

- **Present:** if clear, any access faults. The kernel uses the remaining bits to remember where the page is (for example, a swap slot).
- **Read/write, user/supervisor, no-execute:** the protection checks. They enforce read-only code, non-executable stacks and heaps (W^X), and keep user code out of kernel memory.
- **Accessed and dirty:** set by hardware on use and on write. The kernel reads them to find cold pages to reclaim and dirty pages that must be written back before reuse.

## Page faults are a feature

A **page fault** isn't necessarily an error. It's how the kernel implements most of what makes virtual memory useful:

- **Demand paging (lazy allocation).** `malloc(1 GB)` or `mmap` just records a region in the process's memory map. Physical frames are allocated only when a page is first touched. A fault on a never-touched page allocates a zeroed frame (**minor fault**).
- **Memory-mapped files.** Mapping a file creates a region backed by the file. The first access to each page faults, and the kernel reads that page from the page cache, or from disk (**major fault**).
- **Copy-on-write.** After `fork()`, shared pages are read-only. A write faults, and the kernel copies just that page.
- **Swapping.** When RAM is short, the kernel writes cold pages to swap and clears their present bit. A later access faults, and the kernel reads the page back.
- **Guard pages and stack growth.** An unmapped page below the stack catches overflows, and access to an invalid address delivers `SIGSEGV`.

Every process's **memory map** (`/proc/<pid>/maps` on Linux) is a list of regions (**VMAs**): start, end, permissions and backing (anonymous, a file or a device). On a fault, the kernel checks the VMA list to decide whether to allocate, read, copy or kill.

## Where it's used

| Feature | How virtual memory makes it work |
| --- | --- |
| **Process isolation** | Separate page tables per process. User/supervisor bit protects the kernel |
| **Shared libraries** | `libc.so` code pages are mapped into every process from the same frames |
| **Containers and VMs** | Containers share one kernel but get separate address spaces. VMs add a second level of translation (EPT/NPT) |
| **ASLR** | Stack, heap, libraries and the executable are mapped at random virtual addresses to defeat exploits |
| **Databases** (LMDB, MongoDB's old MMAPv1 engine) | Map data files directly and let the kernel page them in and out |
| **Garbage collectors and runtimes** | Reserve huge virtual ranges cheaply, and use page protection for write barriers and guard pages |
| **Sparse arrays and hash tables** | Reserve terabytes of address space and touch only the pages actually used |

### Use case walk-through: "my process uses 40 GB?!"

An engineer sees a Java service with `VIRT` at 40 GB in `top` on a 16 GB machine, and panics.

1. **Virtual size isn't memory use.** `VIRT` counts every mapped region: reserved but untouched heap, thread stacks, memory-mapped JAR files, and allocator arenas. None of it uses RAM until touched.
2. **Check resident memory.** `RES` (RSS) is the number of frames actually mapped: 3.2 GB. That's real usage, but it double-counts pages shared with other processes.
3. **Check what's in it.** `/proc/<pid>/smaps_rollup` splits RSS into anonymous memory (heap, stacks) and file-backed memory (mapped JARs, libraries), which the kernel can drop and re-read under pressure.
4. **For accurate totals across processes**, sum **PSS** (proportional set size), which divides each shared page among the processes that map it.
5. **Conclusion.** The service is fine. The JVM reserves address space up front (`-Xmx`, code cache, metaspace) and commits it lazily.

## Pitfalls

- **Treating virtual size as memory use.** It's address space, not RAM.
- **Touching memory you don't need.** Zeroing a huge buffer "just in case" forces every page to be allocated. Let demand paging work for you.
- **Huge pages without thought.** Transparent huge pages cut page-walk and TLB cost but can waste memory (a 2 MiB page for 4 KiB of data) and cause latency spikes during compaction. Many databases recommend `madvise` mode rather than `always`.
- **Assuming memory is local.** On multi-socket (NUMA) machines, the frame backing a page may be on another socket, with higher latency. Where a page is first touched usually decides where it lives.
- **Ignoring major faults.** A latency-sensitive service that pages to disk, or reads cold `mmap`ed data, can stall for milliseconds. Watch `major-faults` in `perf` or `/proc/<pid>/stat`.

> [!TIP]
> Run `cat /proc/self/maps` to see a real process's memory map: the executable, heap, every library, the stack and the vDSO, each with its address range and permissions.

## Discussion questions

1. Why is the page size a trade-off? What gets better and worse with 64 KiB pages instead of 4 KiB?
2. How many memory accesses does one load instruction cost on a TLB miss with 4-level paging? With 5-level paging inside a VM?
3. Why can 100 processes each "use" 500 MB of shared libraries without using 50 GB of RAM?
4. What's the difference between a minor and a major page fault, and which ones should a latency-sensitive service worry about?
5. How does the kernel know that a page fault at a given address should allocate memory rather than kill the process?
6. Why do inverted page tables save memory, and why haven't they caught on?

## FAQ

### What's the difference between virtual memory and swap?

They are often confused. **Virtual memory** is the address translation mechanism: per-process address spaces mapped to frames. **Swap** is one feature built on top of it: moving cold anonymous pages to disk. A system with no swap still uses virtual memory for every memory access.

### Does the kernel have its own page tables?

The kernel is mapped into the upper half of every process's address space, marked supervisor-only, so a system call doesn't need to switch page tables. After the Meltdown vulnerability (2018), Linux added **kernel page table isolation (KPTI)**, which keeps a separate, mostly empty kernel mapping while in user mode on affected CPUs, at some cost to system call performance.

### What is a segmentation fault, exactly?

It's what happens when a page fault can't be resolved: the address isn't in any mapped region, or the access breaks the region's permissions (writing to read-only code, executing a non-executable page). The kernel delivers `SIGSEGV`, and by default the process dies. The name is a leftover from segmented memory.

### Why is 4 KiB the standard page size?

It's a historical compromise between table size and wasted memory. Small pages waste less in partially used pages and give fine-grained protection. Large pages mean smaller tables and better TLB coverage. Apple Silicon uses 16 KiB pages, some ARM servers use 64 KiB, and x86 adds 2 MiB and 1 GiB huge pages alongside 4 KiB.

### How does virtualization handle page tables?

A guest OS translates guest-virtual to guest-physical addresses, and the hypervisor translates guest-physical to host-physical. Modern CPUs do both in hardware (Intel EPT, AMD NPT). A TLB miss can then need up to 24 memory reads for a 4-level guest on a 4-level host, which is why huge pages matter even more in VMs.

## Key takeaways

- Every memory access uses a **virtual address** that the **MMU** translates through per-process **page tables**.
- x86-64 uses a **4-level radix tree** of 4 KiB tables (9 bits per level, 12-bit offset). Huge pages stop the walk early.
- Trees keep page tables small because address spaces are **sparse**.
- **PTE flags** enforce protection (present, writable, user, no-execute) and track usage (accessed, dirty).
- **Page faults** are how the kernel implements lazy allocation, `mmap`, copy-on-write and swapping.
- **Virtual size is not memory use.** Look at RSS, PSS and the anonymous vs file-backed split.

## References

1. R. Arpaci-Dusseau, A. Arpaci-Dusseau. [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/), chapters 13–23 (address spaces, paging, TLBs, multi-level tables, swapping).
2. Intel. [Intel 64 and IA-32 Architectures Software Developer's Manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), Volume 3A, chapter 4: Paging.
3. Linux kernel docs. [Page Tables](https://docs.kernel.org/mm/page_tables.html).
4. M. Gorman. [Understanding the Linux Virtual Memory Manager](https://www.kernel.org/doc/gorman/html/understand/).
5. U. Drepper. [What Every Programmer Should Know About Memory](https://people.freebsd.org/~lstewart/articles/cpumemory.pdf), section 4: Virtual Memory. 2007.
6. Linux man pages. [proc_pid_maps(5)](https://man7.org/linux/man-pages/man5/proc_pid_maps.5.html), [mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html).
7. Linux kernel docs. [Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html).
8. Linux kernel docs. [Page Table Isolation](https://docs.kernel.org/arch/x86/pti.html).

---
summary: How Linux keeps file data in RAM so repeat reads are fast, how writes are buffered and flushed, why "free" memory looks low, and when mapping a file with mmap beats read() (and when it badly doesn't).
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** The kernel keeps recently used file data in RAM in the **page cache**. The first `read()` of a block goes to disk, while later reads by **any** process are served from memory, which is why the second `grep` over a directory is instant. **Writes** also land in the page cache: `write()` returns as soon as the data is copied into RAM, and the kernel **writes dirty pages back** later (within ~30 seconds by default, or sooner under memory pressure), unless you call **`fsync()`**. Unused RAM is used as cache because empty RAM is wasted, so look at "available", not "free". **`mmap`** maps page-cache pages straight into your address space: no copy, no syscall per access, just page faults on first touch. It's great for read-mostly, random-access, shared data (shared libraries, LMDB, indexes). It's a poor fit when you need control over I/O, eviction and errors, which is why most databases use `read`/`write` (or `O_DIRECT`) with their own buffer pool.

## The problem: disks are slow, RAM is fast

An NVMe SSD read takes ~50–100 µs, and a spinning disk ~5–10 ms. RAM takes ~100 ns. Programs read the same files repeatedly (config files, libraries, hot database pages, log tails), and often write data that's overwritten or deleted soon after. Caching file data in memory avoids most of that I/O, and doing it in the kernel means **all processes share one cache**.

## How the page cache works

![read() copies bytes from the page cache into the caller's buffer, while mmap maps page-cache pages into the address space without copying. On a miss, the page is read from disk into the cache.](/figures/page-cache/read-vs-mmap.svg "Both paths go through the same cache. They differ in how your program gets at the data.")

The page cache is a collection of **pages** (4 KiB) of file data, indexed per file (each file's `address_space`) by offset. On `read(fd, buf, n)`:

1. The kernel finds which pages of the file cover the requested range.
2. **Hit:** the page is in the cache, so the kernel copies the bytes into `buf`.
3. **Miss:** the kernel allocates a page, issues a read to the storage device, sleeps until it completes, then copies.
4. **Readahead:** when it detects sequential access, the kernel reads ahead (128 KiB by default, growing adaptively), so the next reads are hits. `posix_fadvise` and `madvise` let you hint `SEQUENTIAL`, `RANDOM`, `WILLNEED` or `DONTNEED`.

### Writes and writeback

![A memory bar with dirty pages filling the first part, and two thresholds: at 10% background flushing starts, at 20% writers are throttled. fsync forces a file's dirty pages to storage.](/figures/page-cache/writeback.svg "Buffered writes are fast because they don't wait for the disk, until there are too many of them.")

`write()` copies data into page-cache pages and marks them **dirty**. It returns without touching the disk. Kernel flusher threads write dirty pages back:

- when they've been dirty longer than `dirty_expire_centisecs` (30 s by default);
- when dirty memory exceeds `dirty_background_ratio` (10% of available memory) in the background;
- and when it exceeds `dirty_ratio` (20%), processes that write are **throttled** inside `write()` until writeback catches up.

Delaying writes lets the kernel merge them into bigger I/Os, and skip data that's rewritten or deleted before it's flushed (temporary files). The price is **durability**: until writeback, the data exists only in RAM, so a power loss or kernel crash loses it. `fsync(fd)` forces the file's dirty data and metadata to stable storage and waits. `fdatasync` skips metadata that isn't needed to read the data back. (See the companion deep dive on journaling and fsync.)

### Eviction

When memory is needed, the kernel **reclaims** page-cache pages. Clean pages are simply dropped, since they can be re-read from disk. Dirty pages must be written back first. To pick victims, Linux keeps **active** and **inactive** lists approximating LRU (and, since 6.1, optionally the **multi-generational LRU**). A page that's accessed once lands on the inactive list and is promoted only if accessed again, so a one-off scan of a huge file doesn't flush out your hot data.

![A 64 GiB bar: 18 GiB used by processes, 42 GiB page cache, 4 GiB truly free; available is about 44 GiB.](/figures/page-cache/memory.svg "Low 'free' memory is normal. Most of the cache can be reclaimed on demand.")

This is why `free` on a long-running server shows almost no free memory: the kernel fills idle RAM with cache. The **available** column estimates how much could be handed to processes without swapping. In containers, page cache is charged to the cgroup that brought the page in, which can surprise you when a container's memory usage looks high after reading big files.

## mmap: mapping files into memory

`mmap(NULL, len, PROT_READ, MAP_SHARED, fd, 0)` returns a pointer, and the file's contents appear at that address:

- **No data is read at map time.** The kernel just records the mapping (a VMA).
- **First access to each page faults.** The fault handler finds or reads the page in the page cache and maps that **same physical page** into your page tables. (Fault-around maps neighboring cached pages too.)
- **Later accesses are plain memory loads**, with no syscall and no copy.
- **Writes** to a `MAP_SHARED` mapping dirty the page-cache page directly, and they're written back like any other dirty page (`msync` forces it). With `MAP_PRIVATE`, writes trigger copy-on-write and never reach the file.

Every process mapping the same file shares the same physical pages, which is how shared libraries and executables are loaded: one copy of `libc.so` in RAM for every process.

### read() or mmap?

![Table comparing read/write and mmap: copies, per-access cost, random small reads, large sequential scans, error handling and control over caching.](/figures/page-cache/comparison.svg "mmap trades control for convenience and avoided copies.")

`mmap` wins when:

- access is **random** and data is **read-mostly** (an index, a lookup table, a B-tree),
- the data is **shared** across processes,
- you want simple code: treat the file as an array.

`read`/`write` win when:

- you scan large files **sequentially**: big buffered reads plus readahead are just as fast, without page-fault and TLB overhead;
- you need to **control what's cached**, and when I/O happens;
- you need **sane error handling**: with mmap, an I/O error (or the file being truncated underneath you) arrives as `SIGBUS` at whatever instruction touched the page;
- you're on **many threads changing mappings**, where page-table updates and TLB shootdowns limit scaling.

Many databases tried mmap and moved away (MongoDB's MMAPv1 engine was replaced by WiredTiger). The CIDR 2022 paper "Are You Sure You Want to Use MMAP in Your DBMS?" lists the problems: no control over eviction timing, transactional safety (the OS can write a dirty page at any time), I/O stalls on page faults that you can't schedule around, error handling, and performance at high throughput. LMDB is the famous counterexample: it uses a read-only mmap plus careful copy-on-write B-trees, and is extremely fast for read-heavy workloads.

### Bypassing the cache: O_DIRECT

`O_DIRECT` reads and writes straight between your buffers and the device, skipping the page cache. Databases with their own buffer pool (InnoDB with `innodb_flush_method=O_DIRECT`, Oracle, ScyllaDB) use it to avoid **double caching** the same data in their pool and the page cache. It requires aligned buffers and sizes, and gives up readahead and write-back. PostgreSQL traditionally relies on buffered I/O and the page cache alongside its `shared_buffers`.

## Where it's used

| System | How it uses the page cache |
| --- | --- |
| **Kafka** | Relies on the page cache for recent log segments; consumers reading the tail never touch disk. Serves data with `sendfile` |
| **PostgreSQL** | Buffered I/O: hot pages in `shared_buffers`, warm pages in the page cache |
| **LMDB, BoltDB** | Read-only `mmap` of the whole database file |
| **Elasticsearch / Lucene** | `mmap`s index files (`MMapDirectory`) and leaves half of RAM for the page cache |
| **Shared libraries and executables** | `mmap`ed `MAP_PRIVATE`, shared across processes |
| **InnoDB, ScyllaDB** | Bypass with `O_DIRECT`, manage their own cache |

### Use case walk-through: a cold start that takes minutes

After a deploy, a search service takes 4 minutes to reach normal latency, though the index is only 30 GB and the machine has 128 GB.

1. **Observe.** Major page faults spike right after start (`perf stat -e major-faults`), and disk read throughput is maxed.
2. **Cause.** The service `mmap`s its index. On a fresh host (new instance, or after the old process's pages were evicted), every first touch of a page is a disk read on the request path, in random order.
3. **Warm up proactively.** Before taking traffic, read the index files sequentially (with big `read()`s, or `madvise(MADV_WILLNEED)`) so readahead pulls them into the page cache at full disk bandwidth. Tools like `vmtouch` do this and can report how much of a file is cached.
4. **Protect the cache.** A nightly backup job was reading other large files and evicting index pages. Run it with `posix_fadvise(DONTNEED)` after reading, or in a cgroup with a memory limit so its cache pressure stays local.
5. **Result.** Warm-up takes ~40 s at sequential disk speed, and the service only receives traffic after it's done.

## Pitfalls

- **Panicking about low "free" memory.** Check "available" and actual swap activity.
- **Assuming `write()` means durable.** Only `fsync`/`fdatasync` (or `O_SYNC`/`O_DSYNC`) wait for stable storage.
- **Ignoring fsync errors.** If writeback fails, Linux may mark the pages clean anyway, so retrying `fsync` can falsely succeed. PostgreSQL's "fsyncgate" (2018) led it to crash and recover from WAL on fsync failure rather than retry.
- **`mmap` + truncation or I/O errors** → `SIGBUS`.
- **Huge dirty ratios on big-memory machines.** 20% of 512 GB is a lot of unwritten data and a long stall when it's flushed. Use the `dirty_bytes` / `dirty_background_bytes` settings instead.
- **`echo 3 > /proc/sys/vm/drop_caches` in production** as a "fix": it just makes the next reads slow. Useful only for benchmarking cold-cache behavior.

> [!TIP]
> To see what's cached: `fincore <file>` (util-linux) or `vmtouch <file>` shows how many pages of a file are in the page cache, and `cachestat` (bcc tools) shows cache hit ratios system-wide.

## Discussion questions

1. Why does Linux use almost all free RAM as page cache, and why isn't that a problem?
2. What happens to data written with `write()` if the machine loses power 5 seconds later?
3. When would `mmap` be faster than `read()`, and when slower?
4. Why do some databases use `O_DIRECT` while others rely on the page cache?
5. How does the kernel avoid evicting hot pages when someone scans a huge file once?
6. Why does an I/O error show up as `SIGBUS` with mmap, but as an error code with `read`?

## FAQ

### Is the page cache the same as the buffer cache?

Historically, Unix had a separate **buffer cache** for disk blocks and a page cache for file pages. Linux unified them around 2.4: file data lives in the page cache, and "buffers" in `free` now mostly refers to block-device metadata cached through the same mechanism.

### Does mmap make reading a file faster?

Not automatically. For a single sequential pass, `read()` with large buffers is usually as fast or faster. mmap helps when you access the same data repeatedly, randomly, or from several processes, because it avoids copies and syscalls once pages are mapped.

### Can I limit the page cache?

Not directly with a global knob. In cgroups (v2), `memory.high` and `memory.max` include page cache, so the kernel reclaims a group's cache when it hits the limit. Per file, `posix_fadvise(POSIX_FADV_DONTNEED)` drops cached pages you no longer need.

### What does O_DIRECT guarantee?

It bypasses the page cache, but it does **not** by itself guarantee durability: the device may still have a volatile write cache. You still need `fsync`/`fdatasync` (or `O_DSYNC`) for durability.

### Why is the second run of my benchmark much faster?

The first run populated the page cache. To measure cold-cache performance, drop caches between runs (on a test machine) or use files bigger than RAM. To measure warm performance, run once to warm up and discard that run.

## Key takeaways

- The **page cache** keeps file data in RAM, shared by all processes. Repeat reads are memory-speed.
- Writes are **buffered**: `write()` returns before data hits disk. **Writeback** happens later, so use **`fsync`** for durability.
- High cache usage is normal. Watch **available** memory, not free.
- **`mmap`** maps cache pages directly: no copies, faults on first touch, `SIGBUS` on errors. Good for random, read-mostly, shared data.
- Databases needing control use **`read`/`write`** with their own buffer pool, sometimes with **`O_DIRECT`**.

## References

1. R. Love. *Linux Kernel Development*, 3rd ed., chapter 16: The Page Cache and Page Writeback. Addison-Wesley, 2010.
2. Linux kernel docs. [Documentation for /proc/sys/vm](https://docs.kernel.org/admin-guide/sysctl/vm.html) (dirty ratios, writeback).
3. A. Crotty, V. Leis, A. Pavlo. [Are You Sure You Want to Use MMAP in Your Database Management System?](https://db.cs.cmu.edu/papers/2022/cidr2022-p13-crotty.pdf) *CIDR 2022*.
4. Linux man pages. [mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html), [posix_fadvise(2)](https://man7.org/linux/man-pages/man2/posix_fadvise.2.html), [fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html).
5. J. Corbet. [PostgreSQL's fsync() surprise](https://lwn.net/Articles/752063/). *LWN*, 2018.
6. Linux kernel docs. [Multi-Gen LRU](https://docs.kernel.org/admin-guide/mm/multigen_lru.html).
7. Apache Kafka docs. [Design: Persistence](https://kafka.apache.org/documentation/#persistence) ("Don't fear the filesystem!").
8. H. Chu. [LMDB: Lightning Memory-Mapped Database](http://www.lmdb.tech/doc/).

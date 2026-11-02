---
summary: How one thread can serve tens of thousands of connections, why select and poll stopped scaling, how epoll and kqueue track readiness in the kernel, and how io_uring's shared ring buffers move Linux to completion-based, batched I/O.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A server with 10,000 mostly idle connections shouldn't need 10,000 threads. **I/O multiplexing** lets one thread wait on many sockets and handle only the ones that are ready. **select** and **poll** (1980s) take the whole list of file descriptors on every call, so the cost grows with connections, not activity. **epoll** (Linux, 2002) and **kqueue** (BSDs and macOS, 2000) register descriptors **once** in the kernel, which keeps a **ready list**. Each wait returns only the ready descriptors, in time proportional to how many are ready. These are **readiness** APIs: they tell you a socket *can* be read, and you call `read()`. **io_uring** (Linux 5.1, 2019) is a **completion** API like Windows IOCP: you submit the operation itself through a **shared-memory ring**, the kernel does it, and puts the result on a completion ring. It batches many operations per system call (or none, with kernel polling) and works for regular files too. Event loops in nginx, Redis, Node.js (libuv), Netty, Go's runtime and Rust's Tokio all sit on these APIs.

## The problem: many connections, little activity

A chat server, proxy or API gateway holds thousands of connections, but at any moment only a few have data. The simplest design, a **thread per connection** with blocking `read()`, wastes resources:

- Each thread needs a stack (often 8 MiB of reserved virtual memory, with at least tens of KB actually used) and kernel structures.
- Wake-ups and context switches grow with connections, and scheduling latency grows with runnable threads.
- In the late 1990s, this became known as the **C10K problem**: how to serve 10,000 clients on one machine.

The alternative: one thread asks the kernel "which of these sockets are ready?", then handles exactly those.

## Four generations

![Rows for thread per connection, select/poll (O(n) per call), epoll/kqueue (O(ready) per call) and io_uring (batched, few syscalls).](/figures/io-multiplexing/generations.svg "Each generation reduces the work done per wake-up when most connections are idle.")

### select and poll

`select()` takes bitmaps of descriptors to watch, and `poll()` takes an array of `pollfd` structs. On each call:

1. The program passes the **entire set** to the kernel (copying it in).
2. The kernel checks **every descriptor**, registering the thread on each one's wait queue.
3. When anything becomes ready, the kernel returns, and the program scans the **whole set** again to find which ones.

With 10,000 connections and 10 ready, every call does work for 10,000. `select` is also limited to descriptor numbers below `FD_SETSIZE` (1024 on Linux). Both remain fine for a handful of descriptors, and they're portable.

### epoll and kqueue

![The app adds sockets with epoll_ctl into the interest list, a red-black tree in the kernel. When a packet arrives, a socket callback adds the fd to the ready list. epoll_wait returns only ready fds.](/figures/io-multiplexing/epoll.svg "The kernel does the bookkeeping once, so each wait costs work proportional to activity.")

**epoll** (Linux 2.5.44) splits registration from waiting:

- `epoll_create1()` makes an epoll instance.
- `epoll_ctl(ADD | MOD | DEL)` registers interest in a descriptor once. The kernel stores it in a red-black tree and hooks a callback into that socket's wait queue.
- When data arrives, the callback appends the socket to the instance's **ready list**.
- `epoll_wait()` returns up to N entries from the ready list, sleeping if it's empty.

**kqueue** (FreeBSD 4.1, also on macOS and the other BSDs) works the same way, with a more general design: `kevent()` registers changes and retrieves events in a single call, and it watches more than sockets: files, processes, signals, timers and filesystem changes (vnode events).

### Level-triggered vs edge-triggered

![4 KB arrives and the app reads 1 KB. Level-triggered reports the socket on every wait while data remains. Edge-triggered reports it once, then stays silent.](/figures/io-multiplexing/triggering.svg "Edge-triggered mode reports changes, not state, so you must drain the socket.")

- **Level-triggered** (the default): a descriptor is reported on every `epoll_wait` as long as it's readable. Forgiving: if you don't read everything, you'll hear about it again.
- **Edge-triggered** (`EPOLLET`, or `EV_CLEAR` in kqueue): reported once when it becomes ready. You must read (or write) until `EAGAIN`, or leftover data may never be reported.
- `EPOLLONESHOT` disables a descriptor after one event until re-armed, which is useful when several threads share an epoll instance and you want only one handling a connection at a time. `EPOLLEXCLUSIVE` (Linux 4.5) avoids waking every thread when one event arrives.

### io_uring

![Two ring buffers: the app writes submission queue entries (read, send, recv, fsync) into the SQ; the kernel performs the I/O and writes results into the CQ, which the app reads.](/figures/io-multiplexing/io-uring.svg "Requests and results flow through memory shared between the app and the kernel.")

Readiness APIs still need a system call per operation (`read`, `write`, `accept`), and they don't help with regular files: a disk file is always "ready", so `read()` can still block on I/O. Linux's older AIO (`io_submit`) only worked well with `O_DIRECT` and could still block.

**io_uring**, by Jens Axboe, merged in Linux 5.1, fixes both:

1. The app and kernel share two ring buffers: a **submission queue (SQ)** and a **completion queue (CQ)**.
2. The app writes **submission queue entries** describing operations (read this file at this offset into this buffer, accept on this socket, send this buffer, fsync, open, timeout, and many more) and advances the tail.
3. One `io_uring_enter()` call submits many entries and optionally waits for completions. With **SQPOLL**, a kernel thread polls the submission ring, so a busy app needs no system calls at all.
4. The kernel performs each operation (asynchronously, using worker threads when needed) and writes a **completion entry** with the result to the CQ.

Extra features reduce overhead further: **registered buffers and files** (avoiding per-operation lookups and pinning), **linked operations** (do B only after A succeeds), **multishot** accept and receive (one submission, many completions), and provided buffer rings. Libraries such as `liburing` hide the ring details.

The catch is **security**: io_uring has had many kernel vulnerabilities. Google reported in 2023 that 60% of the exploits submitted to its kernel bug bounty in 2022 targeted io_uring, and restricted it on ChromeOS, Android apps and its production servers. Some container runtimes block it in their default seccomp profiles.

## Event loops built on them

All of these APIs lead to the same structure: an **event loop**.

```
loop:
  events = wait(ready descriptors or completions)
  for each event: run its handler (non-blocking reads/writes, parse, respond)
  run expired timers
```

- **nginx and HAProxy:** one event loop per worker process, one worker per core, often with `SO_REUSEPORT` so each worker has its own listening socket.
- **Redis:** a single-threaded event loop (its `ae` library) over epoll or kqueue.
- **Node.js:** libuv runs the loop (epoll, kqueue or IOCP) and uses a thread pool for file I/O and DNS.
- **Go:** the runtime's netpoller uses epoll or kqueue underneath, so goroutines look blocking but parked goroutines cost no OS thread.
- **Rust:** Tokio (via mio) uses epoll or kqueue. `tokio-uring` and Glommio use io_uring.
- **Java:** NIO selectors, and Netty, which also has native epoll and io_uring transports.

## Where it's used

| API | Platform | Model | Notes |
| --- | --- | --- | --- |
| `select` / `poll` | POSIX, everywhere | Readiness, O(n) | Fine for small sets |
| `epoll` | Linux | Readiness, O(ready) | Level or edge triggered |
| `kqueue` | FreeBSD, macOS, other BSDs | Readiness | Also files, processes, signals, timers |
| IOCP | Windows | Completion | Thread pool friendly |
| `io_uring` | Linux 5.1+ | Completion, batched | Works for files and sockets; security concerns |
| event ports | Solaris / illumos | Readiness | |

### Use case walk-through: a proxy that tops out at 50% CPU

A home-grown TCP proxy written with one thread per connection struggles beyond 20,000 connections. CPU is high but throughput is poor.

1. **Diagnose.** `pidstat -w` shows ~600k context switches per second, and memory is mostly thread stacks.
2. **Move to an event loop.** Rewrite on epoll: one loop per core, `SO_REUSEPORT` listeners, non-blocking sockets, edge-triggered mode with read-until-`EAGAIN`.
3. **Handle backpressure.** When the upstream socket's send buffer fills (`EAGAIN` on write), stop reading from the client (remove `EPOLLIN`) and wait for `EPOLLOUT` on the upstream. Otherwise, buffers grow without bound.
4. **Reduce syscalls further.** Profiling shows most CPU in `read`/`write` syscall overhead. An io_uring backend with multishot receive and registered buffers batches the work, cutting syscalls by an order of magnitude.
5. **Result.** 100k+ connections on the same box, with lower and more stable latency.

## Pitfalls

- **Blocking in the event loop.** A slow DNS lookup, disk read or CPU-heavy task stalls every connection on that loop. Offload to a thread pool.
- **Edge-triggered without draining** to `EAGAIN`: connections that silently stop.
- **Forgetting backpressure:** reading faster than you can write, so buffers grow unbounded.
- **epoll and file descriptions:** epoll tracks the underlying open file description, not the fd number. After `dup` or `fork`, closing one fd may not remove the registration. Use `EPOLL_CTL_DEL` before closing.
- **Thundering herd** when many threads wait on the same epoll or listening socket. Use `EPOLLEXCLUSIVE`, `SO_REUSEPORT` or one epoll per thread.
- **Assuming epoll helps with disk files.** Regular files are always "ready". Use a thread pool or io_uring for file I/O.

> [!TIP]
> `strace -c -f -p <pid>` summarizes which syscalls a server spends time in. Lots of `epoll_wait` returning one event each, or `read`/`write` dominating, are hints that batching (or io_uring) would help.

## Discussion questions

1. Why does `select` cost O(n) per call even when only one socket is ready?
2. When would you choose edge-triggered over level-triggered epoll?
3. What's the difference between a readiness API and a completion API, and why does it matter for disk files?
4. How does io_uring reduce the number of system calls, and what does SQPOLL trade for that?
5. Why does a single slow handler hurt every connection in an event loop?
6. Why might a security-conscious platform disable io_uring?

## FAQ

### Is epoll faster than poll for a few connections?

Not meaningfully. For a handful of descriptors, `poll` is simple and portable. epoll's advantage appears with thousands of descriptors and few active ones.

### Does Go use epoll?

Yes. Go's runtime has a network poller built on epoll (Linux), kqueue (BSD and macOS) or IOCP (Windows). When a goroutine reads from a socket with no data, the runtime parks the goroutine and registers the socket with the poller, so no OS thread blocks.

### Should I switch my server to io_uring?

Only if profiling shows system call overhead or file I/O blocking as the bottleneck, and your kernel and security policy allow it. Many workloads are well served by epoll. Use io_uring through a mature library (liburing, Netty's transport, tokio-uring, Glommio) rather than raw rings.

### What does Windows use?

**I/O completion ports (IOCP)**, a completion-based model since Windows NT 3.5. Windows 11 added an "IoRing" API inspired by io_uring, initially for file reads.

### Can epoll watch regular files?

No. `epoll_ctl` refuses regular files with `EPERM`, because they're always considered ready. kqueue can watch files for changes (vnode events) but that isn't the same as asynchronous reading. For async file I/O, use a thread pool or io_uring.

## Key takeaways

- **I/O multiplexing** lets one thread serve thousands of connections by waiting on many descriptors at once.
- **select/poll** cost O(watched) per call. **epoll/kqueue** register once and cost O(ready).
- **Level-triggered** reports state, **edge-triggered** reports changes, so drain to `EAGAIN` in edge mode.
- **io_uring** is **completion-based** and **batched** through shared rings, and it works for files, but has a security track record to weigh.
- Every major event loop (nginx, Redis, libuv, Netty, Go, Tokio) builds on these APIs. **Never block the loop.**

## References

1. D. Kegel. [The C10K problem](http://www.kegel.com/c10k.html).
2. J. Lemon. [Kqueue: A generic and scalable event notification facility](https://people.freebsd.org/~jlemon/papers/kqueue.pdf). *USENIX ATC 2001*.
3. Linux man pages. [epoll(7)](https://man7.org/linux/man-pages/man7/epoll.7.html), [select(2)](https://man7.org/linux/man-pages/man2/select.2.html), [io_uring(7)](https://man7.org/linux/man-pages/man7/io_uring.7.html).
4. J. Axboe. [Efficient IO with io_uring](https://kernel.dk/io_uring.pdf). 2019.
5. Lord of the io_uring. [Unofficial io_uring guide](https://unixism.net/loti/).
6. Google Security Blog. [Learnings from kCTF VRP's 42 Linux kernel exploits submissions](https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html). 2023.
7. libuv docs. [Design overview](https://docs.libuv.org/en/v1.x/design.html).
8. M. Kerrisk. *The Linux Programming Interface*, chapter 63: Alternative I/O Models. No Starch Press, 2010.

---
summary: Why serving a file with read() and write() copies every byte through user space twice, how sendfile, splice, copy_file_range and MSG_ZEROCOPY move data without CPU copies, and how Kafka, nginx and Netflix use them, including what changes with TLS.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A server that sends a file with a `read()`/`write()` loop makes the CPU **copy every byte twice**: from the page cache into a user buffer, then from that buffer into the socket's kernel buffer. That's two extra copies, two system calls per chunk, and polluted CPU caches, for bytes the program never looks at. **Zero-copy** APIs keep the data inside the kernel. **`sendfile(sock, file, ...)`** sends file data straight from the page cache to a socket, and with scatter-gather-capable NICs the payload is never copied by the CPU at all: the NIC DMAs directly from page-cache pages. **`splice()`** moves page references between file descriptors through a pipe (great for proxies), **`copy_file_range()`** copies between files in the kernel (or just shares blocks via reflinks), and **`MSG_ZEROCOPY`** / io_uring zero-copy sends transmit from user memory without copying. These are why **Kafka** consumers, **nginx** static file serving and **Netflix**'s video CDN reach tens to hundreds of gigabits per second per server. **TLS** gets in the way because bytes must be encrypted, and **kernel TLS (kTLS)** restores zero copy by encrypting in the kernel or on the NIC.

## The problem: copying bytes you never look at

![The read plus write path: DMA from disk into the page cache, a CPU copy into the app buffer, a CPU copy into the socket buffer, then DMA to the NIC.](/figures/zero-copy/read-write.svg "Two of the four copies, and all of the system calls, exist only because the data passes through user space.")

A simple file server:

```
while ((n = read(file, buf, 64 KiB)) > 0)  write(sock, buf, n);
```

For each chunk:

1. **DMA:** disk → page cache (only on a cache miss).
2. **CPU copy:** page cache → `buf` (inside `read`).
3. **CPU copy:** `buf` → socket send buffer (inside `write`).
4. **DMA:** socket buffer → NIC.

Plus two system calls (four mode switches) per chunk. At 10–100 Gb/s, those CPU copies consume a large share of memory bandwidth and CPU time, and every copied byte evicts useful data from the CPU caches. The application never inspects the bytes. It's just a courier.

## sendfile

![With sendfile, the app makes one call; the page cache passes page references to the socket; the NIC DMAs directly from the page cache.](/figures/zero-copy/sendfile.svg "The data path never leaves the kernel, and with scatter-gather DMA it never passes through the CPU.")

`sendfile(out_fd, in_fd, &offset, count)` tells the kernel: send `count` bytes of this file to that socket.

- The data goes from the page cache to the socket **inside the kernel**, so there's no user buffer and only one system call for a large range.
- With a NIC that supports **scatter-gather DMA** and checksum offload, the socket buffer holds only **references** to page-cache pages, and the NIC reads the bytes directly. The CPU copies **nothing** but metadata.
- Since Linux 2.6.33 the output can be any file descriptor, but the input must be something that can be mapped (a regular file), not a socket.

Users:

- **nginx** with `sendfile on;` for static files (and `tcp_nopush` to send headers and the start of the file in full packets).
- **Kafka** consumers: brokers send log segments to consumers with `FileChannel.transferTo`, which uses `sendfile`. Since messages are stored in the same format they're sent in, the broker doesn't need to touch them.
- **Java** (`FileChannel.transferTo`), Go (`io.Copy` from a file to a TCP connection uses `sendfile` automatically), Node.js streams, and Python (`socket.sendfile`).

## splice, tee and vmsplice

`splice(in_fd, ..., out_fd, ..., len, flags)` moves data between two file descriptors where **one is a pipe**, by moving page references rather than bytes. A proxy can forward data from one socket to another without user-space copies:

```
splice(client_sock → pipe) ; splice(pipe → upstream_sock)
```

- **`tee()`** duplicates pipe contents to another pipe without consuming them (like the `tee` command, for page references).
- **`vmsplice()`** maps user pages into a pipe.

HAProxy uses `splice` for TCP forwarding when it doesn't need to inspect payloads. In practice, socket-to-socket `splice` still involves some copying on receive, since received packets aren't page-aligned, but it avoids the user-space round trip.

## The toolbox

![Five APIs: sendfile for file to socket; splice for fd to pipe; copy_file_range for file to file in the kernel; MSG_ZEROCOPY and io_uring send_zc for user buffers to the NIC; and mmap plus write, with one copy.](/figures/zero-copy/apis.svg "Pick by where the bytes come from and where they go.")

- **`copy_file_range()`** copies between files inside the kernel. On filesystems that support **reflinks** (Btrfs, XFS, and NFS server-side copy), it can complete instantly by sharing blocks copy-on-write. `cp` uses it on modern coreutils.
- **`MSG_ZEROCOPY`** (Linux 4.14) sends from **user memory** without copying into the kernel: the kernel pins the pages and the NIC reads them. The catch: you can't modify or free the buffer until the kernel tells you (via the socket's error queue) that transmission finished. It pays off for large sends (roughly 10 KB and up), since the bookkeeping is more expensive than copying small buffers. **io_uring** offers the same with `IORING_OP_SEND_ZC`, with completions in the ring.
- **`mmap` + `write`** avoids the read copy: the file is mapped, and `write` copies once from the mapped pages to the socket. Simpler, but you pay page-fault and TLB costs, and `SIGBUS` if the file is truncated.

## TLS and kernel TLS

Most traffic is encrypted, and encryption must read and transform every byte, which seemed to make zero copy irrelevant: user-space TLS libraries need the data in user memory to encrypt it.

**Kernel TLS (kTLS)**, in Linux since 4.13 and in FreeBSD, moves the **record encryption** into the kernel. The TLS handshake still happens in user space (OpenSSL), which then hands the session keys to the socket with `setsockopt`. After that:

- `sendfile` works on TLS sockets again. The kernel encrypts page-cache data as it builds records, which is one CPU pass instead of copy, copy, encrypt.
- With **NIC TLS offload** (supported by several Mellanox/NVIDIA and Chelsio NICs), the NIC encrypts during DMA, restoring true zero copy.

Netflix's Open Connect appliances serve video over HTTPS using FreeBSD with `sendfile`, kTLS and NIC offload, reaching hundreds of gigabits per second from a single server.

## Where it's used

| System | Zero-copy technique |
| --- | --- |
| **Kafka** | `sendfile` from log segments to consumers (not with user-space TLS) |
| **nginx** | `sendfile on`, kTLS support with OpenSSL 3 |
| **Netflix Open Connect** | FreeBSD `sendfile` + kTLS + NIC TLS offload |
| **HAProxy** | `splice` for TCP forwarding |
| **coreutils `cp`** | `copy_file_range`, reflinks on Btrfs/XFS |
| **Go, Java, Python standard libraries** | Automatic `sendfile` for file-to-socket copies |
| **High-throughput RPC and storage** | `MSG_ZEROCOPY` / io_uring zero-copy sends for large buffers |

### Use case walk-through: Kafka brokers maxing out CPU after enabling TLS

A Kafka cluster serving 2 GB/s to consumers ran at 25% CPU. After enabling TLS between brokers and consumers, CPU jumped to 80% and throughput dropped.

1. **Why.** Without TLS, brokers used `sendfile`: consumers' data went from the page cache to the NIC with no CPU copies. With TLS in the JVM, the broker must read data into the heap, encrypt it, and write it out, losing zero copy and adding encryption work.
2. **Quick wins.** Make sure AES-GCM uses hardware acceleration (AES-NI) and a modern JDK, and that consumers fetch in large batches.
3. **Bigger fix.** On brokers whose Kafka version and JVM can use kernel TLS, or behind a kTLS-capable proxy, encryption moves into the kernel and `sendfile` works again. Where that's not possible, add brokers to spread the encryption cost.
4. **Measure.** `perf top` before and after shows the time moving from `copy_user_*` and AES routines in the JVM to kernel TLS (or the NIC).

## Pitfalls

- **Modifying a file while it's being sent.** `sendfile` sends pages by reference, so concurrent writes can show up in transmitted data. Write new versions to new files and rename.
- **Reusing a buffer too early with `MSG_ZEROCOPY`**: wait for the completion notification.
- **Using zero copy for small messages**: the setup costs more than a copy of a few KB.
- **Expecting zero copy through user-space TLS**: it's not possible without kTLS.
- **Disk-backed `sendfile` blocking an event loop**: if the file isn't in the page cache, `sendfile` can block on disk reads. nginx offloads such reads to thread pools (`aio threads`).
- **Forgetting the NIC matters**: true zero copy needs scatter-gather DMA and checksum offload. Otherwise the kernel copies anyway.

> [!TIP]
> To see whether a server is spending time copying, look for `copy_user_enhanced_fast_string`, `copy_user_generic` or `memcpy` near the top of `perf top`. If they dominate on a file or proxy server, zero copy can help.

## Discussion questions

1. Count the copies and system calls for sending a 1 GB file with 64 KB `read`/`write` versus `sendfile`.
2. Why does `sendfile` require the input to be a regular file rather than a socket?
3. Why must one side of `splice` be a pipe?
4. When does `MSG_ZEROCOPY` cost more than it saves?
5. Why did TLS break zero-copy file serving, and how does kTLS fix it?
6. Why does Kafka store messages on disk in the same format it sends them over the network?

## FAQ

### Is zero copy really zero copies?

Not literally. DMA still moves data between devices and memory. "Zero copy" means the **CPU** doesn't copy the payload between kernel and user buffers. Some paths still copy in certain configurations, such as NICs without scatter-gather, or splice on receive.

### Does sendfile work on macOS and Windows?

macOS and FreeBSD have their own `sendfile` with different signatures (FreeBSD's can also send headers and trailers). Windows has `TransmitFile`. Language runtimes hide the differences.

### Is mmap a form of zero copy?

Partly. Mapping a file avoids the copy from the page cache into a user buffer, but writing the mapped data to a socket still copies it into the socket buffer. It also brings page faults, TLB pressure and `SIGBUS` risk.

### What's the relation to kernel bypass (DPDK, RDMA)?

Zero-copy APIs keep data in the kernel and avoid user-space copies. Kernel bypass moves the network stack into user space and avoids the kernel entirely. RDMA goes further, with NICs reading and writing remote application memory directly. They solve related problems at different layers.

### Does io_uring make sendfile obsolete?

No. io_uring can issue `splice` and zero-copy sends asynchronously, and batch them, but the underlying mechanisms are the same. It changes how you submit and complete the operations, not how data moves.

## Key takeaways

- `read` + `write` makes the CPU **copy every byte twice** through user space, with two syscalls per chunk.
- **`sendfile`** sends file data from the page cache to a socket inside the kernel, and with **scatter-gather DMA**, without CPU copies.
- **`splice`** (via pipes), **`copy_file_range`** (with reflinks) and **`MSG_ZEROCOPY`** cover other paths.
- **TLS** breaks zero copy in user space. **kTLS** and **NIC offload** restore it.
- Zero copy pays off for **large transfers** where the app doesn't inspect data: file servers, CDNs, Kafka, proxies.

## References

1. Linux man pages. [sendfile(2)](https://man7.org/linux/man-pages/man2/sendfile.2.html), [splice(2)](https://man7.org/linux/man-pages/man2/splice.2.html), [copy_file_range(2)](https://man7.org/linux/man-pages/man2/copy_file_range.2.html).
2. Linux kernel docs. [MSG_ZEROCOPY](https://docs.kernel.org/networking/msg_zerocopy.html) and [Kernel TLS](https://docs.kernel.org/networking/tls.html).
3. Apache Kafka docs. [Design: Efficiency](https://kafka.apache.org/documentation/#maximizingefficiency).
4. D. Stancevic. [Zero Copy I: User-Mode Perspective](https://www.linuxjournal.com/article/6345). *Linux Journal*, 2003.
5. J. Corbet. [Two new system calls: splice() and sync_file_range()](https://lwn.net/Articles/178199/). *LWN*, 2006.
6. W. de Bruijn, E. Dumazet. [sendmsg copy avoidance with MSG_ZEROCOPY](https://netdevconf.info/2.1/papers/netdev.pdf). *Netdev 2.1*, 2017.
7. D. Gallatin. [Serving Netflix Video at 400Gb/s on FreeBSD](https://people.freebsd.org/~gallatin/talks/euro2021.pdf). EuroBSDCon 2021.
8. nginx docs. [ngx_http_core_module: sendfile](https://nginx.org/en/docs/http/ngx_http_core_module.html#sendfile).

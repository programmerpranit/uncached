---
summary: How TCP opens and closes connections, what each state in netstat means, and why servers pile up TIME_WAIT, CLOSE_WAIT and overflowing listen queues.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — TCP opens a connection with **SYN → SYN-ACK → ACK**. Those three segments let both sides pick and confirm an **initial sequence number (ISN)** and agree on options such as MSS, window scaling and SACK. It closes with a **FIN/ACK in each direction**, because each direction shuts down on its own. Each socket moves through a small state machine along the way. Most production trouble shows up in three places: **TIME_WAIT** (normal, but huge numbers can use up ephemeral ports), **CLOSE_WAIT** (almost always an application that never called `close()`), and the **SYN and accept queues** in front of `accept()`, which overflow under SYN floods or when the app is too slow.

## The problem: agreeing to talk over an unreliable network

IP delivers packets on a best-effort basis. Packets can be lost, duplicated, reordered or delayed for a long time. To build a reliable byte stream on top of that, both endpoints need shared state before any data moves:

- **Where each byte stream starts.** Every byte is numbered. Each side picks a random-looking starting number, its ISN. The other side has to learn it and confirm it.
- **That the peer is really there and willing.** A server should not commit resources to a client that never answers.
- **That old packets can't be confused with new ones.** A delayed segment from an earlier connection on the same address/port pair must not be taken as data on a new one.
- **The parameters of the connection.** These include the maximum segment size, whether windows can be scaled past 64 KB, and whether selective ACKs and timestamps are in use.

Two messages are not enough. Each side has to send its own ISN *and* hear that the other side received it. With the server's SYN and its ACK of the client's SYN combined into one segment, that comes to three segments in total.

## How it works

### Opening, transferring, closing

![Sequence diagram: client sends SYN seq=x, server replies SYN-ACK seq=y ack=x+1, client sends ACK ack=y+1, data flows, then FIN/ACK in each direction with state names on each side](/figures/tcp-handshake/lifecycle.svg "The handshake costs one round trip before the first request byte. The close takes four segments because each direction closes on its own.")

1. **SYN.** The client picks an ISN `x`, sends a segment with the SYN flag set and its options, and enters `SYN_SENT`.
2. **SYN-ACK.** The server picks its own ISN `y` and acknowledges `x+1`. A SYN uses up one sequence number. The server enters `SYN_RCVD`.
3. **ACK.** The client acknowledges `y+1`. Both sides are now `ESTABLISHED`. The client may already put data in this third segment.

Options are only negotiated on SYN segments, so whatever is agreed here lasts for the whole connection:

- **MSS:** the largest segment each side wants to receive.
- **Window scale:** a shift count that lets the 16-bit window advertise up to about 1 GB.
- **SACK-permitted.**
- **Timestamps:** used to measure RTT and to protect against wrapped sequence numbers.

If a middlebox removes window scaling from the SYN, the connection is stuck at 64 KB windows for its whole life.

**ISNs are not zero.** RFC 6528 recommends a clock plus a keyed hash of the connection 4-tuple. That makes ISNs hard for off-path attackers to guess, which blocks blind spoofing and injection. It also keeps them increasing, so a new incarnation of the same 4-tuple doesn't overlap with old segments.

**Closing is half-duplex.** When one side calls `close()` or `shutdown(SHUT_WR)`, it sends a FIN, meaning "I have nothing more to send". The other side ACKs it and may keep sending until it closes too. That's why a graceful close takes four segments, although the middle ACK and FIN often travel together.

**RST is the abrupt alternative.** A reset aborts the connection at once and discards any unsent data. You get one when:

- you connect to a closed port (*connection refused*)
- a segment arrives for a connection the receiver doesn't know about
- an application closes a socket that still has unread data
- `SO_LINGER` is set with a zero timeout

### The state machine

![TCP state diagram: CLOSED to SYN_SENT or LISTEN, through SYN_RCVD to ESTABLISHED, then FIN_WAIT_1, FIN_WAIT_2, TIME_WAIT for the active closer and CLOSE_WAIT, LAST_ACK, CLOSED for the passive closer](/figures/tcp-handshake/states.svg "The left branch belongs to whoever closes first (the active closer). The right branch belongs to whoever closes second.")

The states you see in `ss -tan` or `netstat` say who closed first and what each side is waiting for:

| State | Meaning | Usually means |
|---|---|---|
| `LISTEN` | Waiting for SYNs on a port | A server socket |
| `SYN_SENT` | Sent SYN, waiting for SYN-ACK | Lots of these mean the peer or a firewall is dropping SYNs |
| `SYN_RCVD` | Got SYN, sent SYN-ACK, waiting for ACK | Lots of these mean a SYN flood or a lossy path |
| `ESTABLISHED` | Open | Normal |
| `FIN_WAIT_1/2` | We closed, waiting for the peer's ACK/FIN | The peer is slow to close its side |
| `CLOSE_WAIT` | The peer closed; we haven't | **Our application isn't calling `close()`** |
| `LAST_ACK` | We closed after the peer, waiting for the final ACK | Brief |
| `TIME_WAIT` | We closed first; waiting 2×MSL | Normal; can pile up |

**TIME_WAIT is a feature.** The side that closes first stays in TIME_WAIT for twice the maximum segment lifetime (60 s on Linux). It does this for two reasons:

- It can retransmit the final ACK if the peer's FIN is retransmitted.
- Stray segments from this connection die off before the same 4-tuple can be reused.

The cost is that the 4-tuple stays tied up. A client opening thousands of short connections per second to *one* destination IP:port can run out of ephemeral ports (about 28,000 by default on Linux), and `connect()` starts failing with `EADDRNOTAVAIL`. The fixes, best first:

1. **Reuse connections** with keep-alive and pooling.
2. **Widen `ip_local_port_range`.**
3. **Enable `net.ipv4.tcp_tw_reuse`.** It is safe for outgoing connections when timestamps are on.
4. **Spread load** across more destination IPs or ports.

Never use the removed `tcp_tw_recycle`, which broke clients behind NAT.

**CLOSE_WAIT is a bug signal.** The kernel can't leave CLOSE_WAIT on its own. Only the application calling `close()` moves the socket on. Thousands of CLOSE_WAIT sockets that keep growing mean leaked file descriptors, usually a code path that drops a connection without closing it, or a pool that never evicts dead connections.

### The listen queues

![Incoming SYNs enter the SYN queue as half-open connections; after the final ACK they move to the accept queue; accept() removes them. SYN floods fill the first queue; a slow application fills the second](/figures/tcp-handshake/queues.svg "Two queues sit between the network and your accept() loop, and each fails differently.")

On Linux a listening socket has two queues:

- **SYN queue (half-open).** Holds connections in `SYN_RCVD` that are waiting for the client's ACK. Its size is roughly set by `tcp_max_syn_backlog`.
- **Accept queue (fully established).** Holds connections that finished the handshake but haven't been returned by `accept()` yet. Its size is `min(backlog, net.core.somaxconn)`, where `backlog` is the argument to `listen()`.

**SYN floods** fill the first queue with spoofed SYNs that never complete. The standard defence is **SYN cookies**. When the queue is full, the server stores no state at all. Instead it encodes the connection parameters (MSS, a timestamp and a keyed hash of the 4-tuple) into its own ISN `y`. A real client's ACK of `y+1` lets the server rebuild the connection. Linux turns this on automatically under pressure (`tcp_syncookies=1`).

**Accept-queue overflow** happens when the application calls `accept()` more slowly than handshakes complete. This happens with a blocked event loop, too few worker threads, or a GC pause. By default Linux then drops the client's final ACK. The client thinks it is connected and sends its request, but the server keeps retransmitting the SYN-ACK. The user sees a delay of a second or more instead of an error. You can spot it with:

- `ss -lnt`: for listening sockets, `Recv-Q` is the current accept-queue depth and `Send-Q` its limit.
- `nstat` counters `TcpExtListenOverflows` and `TcpExtListenDrops`.

### Saving the round trip

The handshake adds a full RTT before the first request byte, and TLS adds more on top. There are several ways to cut that cost:

- **Connection reuse.** HTTP keep-alive, connection pools and HTTP/2 multiplexing pay the handshake once and spread it over many requests. This is by far the biggest win.
- **TCP Fast Open (RFC 7413).** On a repeat visit, the client sends a cookie the server gave it earlier, together with data, in the SYN. The server can then process the request before the handshake finishes. Middlebox interference and replay concerns have limited its use on the open internet.
- **QUIC.** It merges the transport and TLS handshakes into one round trip, or zero on resumption, by running over UDP.

## Where it's used

| Setting | Where the handshake and states matter |
|---|---|
| Web servers and proxies (NGINX, Envoy, HAProxy) | `backlog`/`somaxconn` tuning, accept-queue monitoring, upstream keep-alive pools |
| High-rate clients (crawlers, load generators, service-to-service calls) | Ephemeral port exhaustion from TIME_WAIT; connection pooling |
| Load balancers | Health checks via handshake; SYN proxying; deciding who closes first so TIME_WAIT lands on the right side |
| DDoS protection | SYN cookies, SYN proxies in front of origins |
| Databases and connection pools | Leaked connections showing up as CLOSE_WAIT; stale pooled sockets getting RST |
| Mobile and high-latency networks | Handshake RTT dominates small requests; motivation for reuse, TFO and QUIC |

## Use case walk-through: intermittent one-second stalls on an API

An internal API's p99 latency jumps to just over 1 s several times an hour. CPU is fine and the application logs show no slow requests.

1. **Look at the listening socket.** `ss -lnt sport = :8080` shows `Send-Q` 128 (the accept queue limit) and `Recv-Q` sometimes reaching 129 during bursts.
2. **Confirm with counters.** `nstat -az TcpExtListenOverflows` rises during each stall. The client's final ACKs are being dropped and the SYN-ACK retransmission timer (initially 1 s) explains the extra second.
3. **Find the cause.** The service calls `listen(fd, 128)`, and a stop-the-world GC pause briefly stops the accept loop while a client opens a burst of new connections.
4. **Raise the limits.** Set `net.core.somaxconn` and the application's backlog to 4096 so short pauses are absorbed.
5. **Reduce the bursts.** Enable keep-alive and pooling in the calling service, so new connections are rare and handshakes stop happening in bursts.
6. **Check the other side.** On the caller, `ss -tan state time-wait | wc -l` was 25,000, close to the ephemeral range. Pooling fixes that as well.
7. **Hunt for leaks.** `ss -tan state close-wait` shows 300 sockets to a downstream cache. A code path that returned early on errors never released the connection. Fixing it stops the slow file-descriptor leak.

**Result:** listen overflows drop to zero, the one-second p99 spikes disappear, TIME_WAIT on the caller drops by about 95%, and the CLOSE_WAIT leak is fixed before it would have hit the file-descriptor limit.

## Pitfalls

- **Treating TIME_WAIT as a leak.** It's expected on whichever side closes first. Only worry when it limits ports or memory, and fix it with reuse before tuning the kernel.
- **Ignoring CLOSE_WAIT.** It never times out by itself. It is an application bug that ends with "too many open files".
- **Small default backlogs.** Many frameworks still pass 128 or less to `listen()`. Accept-queue drops show up as latency, not errors.
- **Firewalls that silently drop SYNs.** The client sits in `SYN_SENT` and retries with exponential backoff (1 s, 2 s, 4 s…) for over a minute before it fails. A reject (RST) fails fast.
- **Idle connections killed by middleboxes.** NATs and load balancers forget idle flows after a few minutes, and the next send gets an RST or vanishes. Use TCP or application keep-alives shorter than the idle timeout.
- **`SO_LINGER` with timeout 0 as a TIME_WAIT "fix".** It turns every close into an RST, can lose data in flight and confuses peers.
- **Deciding who closes first by accident.** If the server closes first, TIME_WAIT builds up on the server. With HTTP, letting the client close, or using keep-alive, keeps it off busy servers.

> [!WARNING]
> Kernel tuning hides symptoms. If you have huge TIME_WAIT counts, a connection is being opened per request. If CLOSE_WAIT keeps growing, code is leaking sockets. If the accept queue overflows, the accept loop is being starved. Fix those first, then size buffers and queues.

## Discussion questions

1. Why can't a two-way handshake reliably set up both sequence number spaces?
2. Which side of an HTTP connection should close first on a busy reverse proxy, and why?
3. How do SYN cookies manage without per-connection state, and which TCP options do they struggle to preserve?
4. A client sees `connect()` hang for about 75 seconds before failing. What is happening on the wire?
5. Why does accept-queue overflow cause added latency rather than an immediate error?
6. When would you prefer TCP Fast Open over QUIC 0-RTT, or the other way round?

## FAQ

### Why is it three-way and not two-way or four-way?

Each side must send its ISN and receive an acknowledgement for it, which is four logical messages. The server's SYN and its ACK of the client's SYN go in the same segment, which leaves three. A two-way handshake would leave the server unsure that the client got its ISN, and it couldn't tell old duplicate SYNs from new ones.

### How long does TIME_WAIT last?

It lasts two times the Maximum Segment Lifetime. The standard suggests an MSL of 2 minutes. Linux hard-codes TIME_WAIT at 60 seconds, and other systems use 30–240 seconds.

### What's the difference between `tcp_tw_reuse` and `tcp_tw_recycle`?

`tcp_tw_reuse` lets a new *outgoing* connection reuse a 4-tuple that is in TIME_WAIT when TCP timestamps show it's safe. `tcp_tw_recycle` aggressively expired TIME_WAIT based on per-host timestamps. That broke clients behind NAT, and it was removed from Linux in 4.12.

### Does a closed port always reply with RST?

The TCP stack does, if the packet reaches it. A firewall in front may drop the SYN instead, and the client then times out. Telling "connection refused" apart from "connection timed out" is a quick way to know whether you're hitting the host or a filter.

### Can data be sent during the handshake?

The client can include data in the final ACK. Data in the SYN itself is only processed before the handshake completes with TCP Fast Open and a valid cookie. Without it, the server holds the data until the handshake finishes.

## Key takeaways

- **SYN, SYN-ACK, ACK** exchanges and confirms both ISNs and negotiates options that last for the whole connection.
- Closing is **one FIN per direction**. RST aborts at once.
- **TIME_WAIT** sits on the side that closed first and is normal. Run out of ports? Reuse connections.
- **CLOSE_WAIT** that keeps growing means your application isn't closing sockets.
- Two **listen queues**: the SYN queue is protected by SYN cookies, and an overflowing accept queue shows up as hidden latency. Monitor `ListenOverflows`.
- The handshake costs an RTT. **Connection reuse** saves it best, then TFO and QUIC.

## References

- [RFC 9293 — Transmission Control Protocol (TCP)](https://www.rfc-editor.org/rfc/rfc9293)
- [RFC 4987 — TCP SYN Flooding Attacks and Common Mitigations](https://www.rfc-editor.org/rfc/rfc4987)
- [RFC 7413 — TCP Fast Open](https://www.rfc-editor.org/rfc/rfc7413)
- [RFC 6528 — Defending against Sequence Number Attacks](https://www.rfc-editor.org/rfc/rfc6528)
- [RFC 7323 — TCP Extensions for High Performance](https://www.rfc-editor.org/rfc/rfc7323)
- [Linux kernel documentation — ip-sysctl (tcp_* settings)](https://docs.kernel.org/networking/ip-sysctl.html)
- W. Richard Stevens and Kevin R. Fall, *TCP/IP Illustrated, Volume 1: The Protocols*, 2nd ed., Addison-Wesley, 2011.

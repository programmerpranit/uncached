---
summary: QUIC rebuilds the transport layer on top of UDP, folding TLS 1.3 and streams into one protocol so connections start faster, survive network changes, and stop one lost packet from stalling every request.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — HTTP/2 fixed head-of-line blocking in HTTP but not in TCP: one lost packet still stalls every stream. QUIC replaces TCP + TLS with a single encrypted transport that runs over UDP. It handles loss per stream, sets up in one round trip (zero when resuming), and identifies connections by an ID instead of an IP/port pair, so they survive a switch from Wi-Fi to cellular. HTTP/3 is HTTP mapped onto QUIC.

## The problem: TCP is ossified and serial

HTTP/2 multiplexes many requests over one TCP connection. That works well on a clean network. TCP, though, promises the application a single ordered byte stream. When one packet is lost, the kernel holds back every byte after it, even bytes belonging to unrelated streams, until the retransmission arrives. On a lossy mobile link, one HTTP/2 connection can perform *worse* than six HTTP/1.1 connections.

TCP is also hard to change:

- It lives in operating-system kernels, which update slowly.
- Middleboxes (firewalls, NATs, load balancers) inspect TCP headers and drop anything unfamiliar. Extensions like TCP Fast Open never reached wide deployment because of this.
- TLS adds its own handshake on top of TCP's, so a new HTTPS connection costs two round trips before the first request byte, and three with TLS 1.2.

QUIC began at Google around 2012 and was standardized by the IETF in 2021. It takes a different approach: build a new transport in user space, encrypt almost all of it so middleboxes can't depend on its internals, and ride on UDP, which every network already passes.

## How it works

### One protocol instead of three layers

![HTTP/2 vs HTTP/3 stacks](/figures/http3-quic/stack.svg "QUIC absorbs reliability, congestion control, streams and TLS 1.3 into one layer over UDP")

QUIC (RFC 9000) provides everything TCP did: reliable delivery, congestion control and flow control. It also makes **streams** a transport-level concept. Each stream is an independent ordered byte sequence. Streams can be bidirectional or unidirectional, and either side can open them cheaply.

TLS 1.3 isn't layered on top. QUIC carries TLS handshake messages in its own CRYPTO frames and uses the resulting keys to encrypt its packets (RFC 9001). Even most of the packet header is protected. Only a few bits and the connection ID are visible to the network. This is deliberate: middleboxes can't ossify what they can't read.

HTTP/3 (RFC 9114) is the thin layer above. Each request/response pair uses one QUIC stream. Header compression switches from HPACK to **QPACK** (RFC 9204), because HPACK assumed in-order delivery across streams, which QUIC no longer guarantees.

Because QUIC ships as a library inside browsers, servers and apps, a new congestion controller or loss-recovery tweak reaches users with an app update instead of an OS upgrade.

### Faster handshakes

![Round trips before the first request](/figures/http3-quic/handshake.svg "TCP + TLS 1.3 needs two round trips; QUIC needs one, or zero on resumption")

A new QUIC connection merges the transport and cryptographic handshakes. The client's first packet (an *Initial*) carries the TLS ClientHello. The server's reply carries the ServerHello and certificate. After one round trip the client can send its HTTP request. TCP + TLS 1.3 needs two round trips for the same result.

If the client has connected before and kept a session ticket, it can use **0-RTT**: it sends the request in the very first flight, encrypted with keys derived from the earlier session. The catch is that 0-RTT data has no replay protection at the transport level. An attacker who captures the packet can resend it. Servers should therefore accept only idempotent, safe requests as 0-RTT. Many reject 0-RTT for anything except GET, and HTTP defines a `425 Too Early` status for refusing it.

QUIC also protects the server from being used as an amplifier. Until the client's address is validated, the server may send at most three times the bytes it received. That's why client Initial packets are padded to at least 1200 bytes.

### Per-stream loss recovery and connection migration

![Loss isolation and connection migration](/figures/http3-quic/loss-migration.svg "A lost packet blocks only the streams whose data it carried; a connection ID survives an address change")

Two design choices make loss cheap.

First, **packet numbers are separate from stream offsets.** Every packet gets a fresh, strictly increasing number, including retransmissions. Lost data is re-sent in a new packet rather than by resending the old one. This removes TCP's "retransmission ambiguity" (was this ACK for the original or the retransmit?), so RTT estimates stay accurate.

Second, **ordering is tracked per stream.** When a packet carrying stream 2's data is lost, streams 1 and 3 keep delivering to the application. Only stream 2 waits. The head-of-line blocking that HTTP/2 pushed down into TCP is now confined to one stream.

**Connection migration.** TCP identifies a connection by its 4-tuple (source IP, source port, destination IP, destination port). Change any of them, as a phone does when it leaves Wi-Fi, and the connection dies. QUIC identifies connections by **connection IDs** chosen by each endpoint. When the client's address changes, it keeps sending with a connection ID the server recognizes. The server validates the new path with a challenge/response, and the transfer continues without a new handshake. Endpoints rotate through several IDs so that an observer can't link the old path to the new one.

### Discovery: how a browser finds HTTP/3

A browser can't know in advance that a server speaks QUIC on UDP 443, so it usually starts over TCP. The server advertises HTTP/3 with an `Alt-Svc: h3=":443"` response header, or with an HTTPS DNS record (RFC 9460) that the browser sees before connecting at all. Later connections race QUIC against TCP ("happy eyeballs" style) and use whichever wins. Some networks block or throttle UDP, so TCP fallback is required, not optional.

## Where it's used

| Deployment | What QUIC brings |
|---|---|
| Google (Search, YouTube) | Origin of QUIC; reported lower search latency and fewer video rebuffers, especially on poor networks |
| Cloudflare, Fastly, Akamai CDNs | HTTP/3 at the edge for any customer, often a single toggle |
| Meta apps (Facebook, Instagram) | Most app traffic moved to QUIC; mobile users benefit from migration and loss isolation |
| All major browsers | Chrome, Edge, Firefox and Safari support HTTP/3 by default |
| DNS over QUIC (RFC 9250) | Encrypted DNS without TCP's handshake cost |
| Media over QUIC, WebTransport | Low-latency streaming and game traffic using unreliable datagrams and independent streams |

## Use case walk-through: a phone on a train

A news app fetches a feed, twenty thumbnails and an ad over HTTP/3 while the user rides a train.

1. **First open of the day.** The app has a session ticket from yesterday, so it sends the GET for the feed as 0-RTT in its first packet. The feed starts arriving after a single round trip, about 80 ms on this LTE link. TCP + TLS would have spent 160 ms before even sending the request.
2. **Thumbnails in parallel.** Twenty image requests each open their own QUIC stream on the same connection, sharing one congestion window.
3. **Packet loss in a tunnel.** Signal degrades and 3% of packets drop. A lost packet carrying thumbnail #7's bytes stalls only stream #7. The feed text and the other images keep rendering. Under HTTP/2 every stream would have frozen until each retransmission arrived.
4. **Network handover.** The train reaches a station and the phone switches to station Wi-Fi. Its IP changes. The client sends its next packet from the new address with a fresh connection ID. The server validates the path in one round trip and continues sending. No new handshake and no failed requests.
5. **Fallback check.** On a corporate network that blocks UDP, the same app sees QUIC time out and silently uses HTTP/2 over TCP.

**Result:** faster first paint, smoother rendering on a lossy link, and no dropped downloads across a network change — with graceful degradation where UDP isn't allowed.

## Pitfalls

- **UDP gets blocked or rate-limited.** Some enterprise firewalls and older middleboxes block UDP 443 or treat heavy UDP as an attack. Always keep a TCP fallback and measure what share of users actually negotiate h3.
- **CPU cost.** TCP benefits from decades of kernel and NIC offloads (TSO, GRO). QUIC encrypts every packet in user space, and early deployments used noticeably more CPU per byte. Generic Segmentation Offload for UDP, `sendmmsg`/`recvmmsg`, and batching close much of the gap. Benchmark before assuming it's free.
- **0-RTT replay.** Accepting non-idempotent requests (payments, writes) as 0-RTT invites duplicate side effects. Restrict 0-RTT to safe methods, or use anti-replay mechanisms.
- **Load balancer routing.** Connection migration breaks naive 4-tuple hashing: after an address change, packets may land on a different backend that has no state for the connection. Use QUIC-aware load balancers that route on connection ID (see the IETF QUIC-LB draft).
- **Observability loss.** Encrypted headers mean tools that read TCP sequence numbers to measure RTT or loss no longer work. Use qlog (endpoint-side structured logs) and the spin bit where enabled.
- **Not always faster.** On a clean, low-latency wired network, HTTP/3 may show little gain over HTTP/2. The wins concentrate on high-RTT, lossy and mobile connections.

> [!TIP]
> When rolling out HTTP/3, compare metrics by network type (Wi-Fi vs cellular, by region) rather than globally. Averages hide the long-tail users who benefit most.

## Discussion questions

1. Why did QUIC's designers build on UDP rather than defining a new IP protocol number alongside TCP and UDP?
2. QUIC never reuses a packet number, even for retransmitted data. What does that make easier for RTT estimation and loss detection compared with TCP?
3. Why can't HPACK be used unchanged with HTTP/3, and what tradeoff does QPACK make to avoid head-of-line blocking on header state?
4. How would you design a load balancer that keeps a QUIC connection on the same backend after the client's IP changes?
5. For which endpoints of a typical web API would you allow 0-RTT, and how would you enforce that?
6. Encrypting transport headers stops ossification but also blinds network operators. Is that a good trade? What would you lose operating a large network?

## FAQ

### Is HTTP/3 just HTTP/2 over UDP?

No. The semantics (methods, headers, status codes) are the same, but the framing differs. Stream multiplexing, flow control and reliability move into QUIC, so HTTP/3 drops HTTP/2's stream-level machinery, and HPACK is replaced by QPACK. The two versions aren't wire-compatible.

### Does QUIC work without TLS?

Not in the IETF version. TLS 1.3 is built into the protocol: packet protection keys come from the TLS handshake, and every QUIC connection is encrypted and authenticated. There is no plaintext mode.

### Is UDP unreliable, so is HTTP/3 unreliable?

UDP only carries QUIC's packets. QUIC itself adds acknowledgments, retransmission, ordering per stream, and congestion control, giving the same reliability guarantees as TCP. An extension (RFC 9221) also allows *unreliable* datagrams for apps such as games that want them.

### Will QUIC replace TCP everywhere?

Unlikely soon. TCP remains the default for databases, internal RPC inside data centers, SSH and most non-web protocols, where kernel offloads and mature tooling matter more than handshake latency or mobile migration. QUIC's biggest wins are on the public internet to end users.

### How do I check whether a site uses HTTP/3?

In browser dev tools, enable the Protocol column on the Network tab and look for `h3`. From the command line, `curl --http3 -I https://example.com` works if your curl was built with HTTP/3 support. Check the response for an `alt-svc` header advertising `h3`.

## Key takeaways

- QUIC merges TCP's reliability and congestion control with TLS 1.3 and native streams, and runs it in user space over UDP.
- Loss affects only the streams whose data was lost, which removes transport-level head-of-line blocking.
- New connections need one round trip and resumed ones can send data in zero, but 0-RTT data can be replayed.
- Connection IDs let connections survive IP changes; load balancers must route on them.
- Encryption of most headers prevents middlebox ossification and lets the protocol evolve with app releases.
- Gains are largest on lossy, high-latency, mobile networks; always keep a TCP fallback.

## References

- [RFC 9000 — QUIC: A UDP-Based Multiplexed and Secure Transport](https://www.rfc-editor.org/rfc/rfc9000)
- [RFC 9001 — Using TLS to Secure QUIC](https://www.rfc-editor.org/rfc/rfc9001)
- [RFC 9002 — QUIC Loss Detection and Congestion Control](https://www.rfc-editor.org/rfc/rfc9002)
- [RFC 9114 — HTTP/3](https://www.rfc-editor.org/rfc/rfc9114)
- [RFC 9204 — QPACK: Field Compression for HTTP/3](https://www.rfc-editor.org/rfc/rfc9204)
- [RFC 8470 — Using Early Data in HTTP (425 Too Early)](https://www.rfc-editor.org/rfc/rfc8470)
- [RFC 9460 — Service Binding and Parameter Specification via the DNS (SVCB and HTTPS RRs)](https://www.rfc-editor.org/rfc/rfc9460)
- [RFC 9221 — An Unreliable Datagram Extension to QUIC](https://www.rfc-editor.org/rfc/rfc9221)
- Langley et al., "The QUIC Transport Protocol: Design and Internet-Scale Deployment," ACM SIGCOMM 2017.

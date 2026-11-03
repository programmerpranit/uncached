---
summary: How HTTP/2 runs many requests over one connection with binary frames and streams, why that fixed HTTP-level head-of-line blocking, and why TCP packet loss still stalls everything.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — HTTP/2 keeps HTTP's meaning (methods, headers, status codes) but changes how it travels. Every request and response becomes a **stream** of binary **frames**, and frames from many streams **interleave on one TCP connection**. That removes HTTP/1.1's *application-level* head-of-line blocking, which is why browsers used to open six connections per origin. It also brings header compression (HPACK), per-stream flow control and cancellation. But TCP still delivers one **ordered byte stream**, so a single lost packet stalls *every* stream until it is retransmitted. That **TCP head-of-line blocking** is why HTTP/2 can lose to HTTP/1.1 on lossy networks, and why HTTP/3 moved to QUIC.

## The problem: HTTP/1.1 does one thing at a time

An HTTP/1.1 connection carries one request and its response at a time. Pipelining was specified but never worked reliably: responses had to come back in request order, and buggy proxies broke it. So:

- **A slow response blocks everything queued behind it on that connection.** This is *head-of-line (HOL) blocking* at the HTTP layer.
- **Browsers work around it by opening about 6 parallel connections per origin.** Each one costs a TCP and TLS handshake, its own slow start, and separate congestion state that competes with the others.
- **Sites worked around the browsers.** They used domain sharding (more origins, more connections), concatenated bundles, image sprites and inlined assets. All of these hurt caching and add complexity.
- **Headers are repeated as verbose text on every request.** Cookies and user-agent strings often add up to a kilobyte or more, sent again and again.

HTTP/2 (RFC 7540 in 2015, updated as RFC 9113 in 2022) grew out of Google's SPDY to fix these problems without changing HTTP's meaning.

## How it works

### Streams and frames

![HTTP/1.1 uses six parallel connections each carrying one request at a time; HTTP/2 uses one connection carrying interleaved frames from many numbered streams](/figures/http2-multiplexing/multiplexing.svg "Frames from different streams interleave freely. Responses complete in whatever order the server produces them.")

- **Connection.** One TCP+TLS connection per origin. ALPN chooses `h2` during the TLS handshake.
- **Stream.** A bidirectional, independent sequence of frames that carries one request/response exchange. Client-started streams have odd IDs (1, 3, 5, …). IDs are never reused on a connection.
- **Frame.** The unit sent on the wire. A `HEADERS` frame opens a stream. `DATA` frames carry the body. A flag (`END_STREAM`) marks the last frame in each direction.
- **Multiplexing.** The sender can interleave frames from any number of open streams, up to `SETTINGS_MAX_CONCURRENT_STREAMS`, which is often 100–250. The receiver reassembles them by stream ID.

Because streams are independent, a slow database query on stream 3 no longer blocks the CSS on stream 5. And because there's only one connection, there is one handshake, one congestion window that warms up once, and fair sharing between requests instead of six connections competing.

### Frames, HPACK and flow control

![An HTTP/2 frame: 24-bit length, 8-bit type, 8-bit flags, reserved bit plus 31-bit stream ID, then payload; followed by a list of frame types and their purpose](/figures/http2-multiplexing/frames.svg "Everything on an HTTP/2 connection is a frame with the same 9-byte header. Stream 0 carries connection-level control frames.")

- **Binary framing.** A fixed 9-byte header makes parsing exact and cheap, unlike HTTP/1.1's text parsing, which has led to request-smuggling bugs.
- **HPACK header compression (RFC 7541).** There is a static table of common headers, plus a dynamic table that each side builds up during the connection, plus Huffman coding. After the first request, a repeated cookie costs a byte or two. HPACK was designed to resist the CRIME-style attacks that broke generic DEFLATE compression over TLS.
- **Flow control.** `WINDOW_UPDATE` frames give credit **per stream and per connection**. A receiver can slow down one large download without starving the others. Note this is separate from, and sits on top of, TCP's own window.
- **Cancellation.** `RST_STREAM` cancels one request, for example when the user navigates away, without tearing down the connection. In HTTP/1.1 you had to close the connection.
- **Prioritization.** The original dependency-tree scheme was complex and poorly implemented. RFC 9218 replaced it with simple *urgency* and *incremental* parameters, sent as a header or a `PRIORITY_UPDATE` frame.
- **Server push.** `PUSH_PROMISE` let servers send resources before they were asked for. It rarely helped (pushed resources were often already cached), and Chrome removed support in 2022. Use `103 Early Hints` or preload instead.

### TCP head-of-line blocking

![Seven packets carrying streams 1, 3 and 5 are sent; packet 2 is lost, so packets 3 to 7 wait in the kernel buffer and the application receives only packet 1 until the retransmission arrives](/figures/http2-multiplexing/tcp-hol.svg "HTTP/2 moved head-of-line blocking down a layer instead of removing it.")

TCP guarantees that the application reads bytes in order. When one segment is lost, every segment after it waits in the kernel's receive buffer until the retransmission arrives. That takes at least one RTT, and much longer if a retransmission timeout fires. TCP has no idea those later bytes belong to unrelated HTTP/2 streams.

The effect depends on the network:

- **On clean networks** (wired connections, data-centre links) loss is rare, and HTTP/2's single warm connection wins clearly.
- **On lossy networks** (congested Wi-Fi, mobile handoffs, long-haul links with 1–2% loss) one connection is fragile:
  - every loss stalls *all* requests;
  - the one congestion window shrinks for all of them at once;
  - six HTTP/1.1 connections, by contrast, each lose only their own share.
  - Measurements have found HTTP/2 slower than HTTP/1.1 in high-loss conditions.

HTTP/3 fixes this at the root. QUIC runs over UDP and provides streams *in the transport*, so a lost packet only holds back the streams whose data it carried.

## Where it's used

| Setting | How HTTP/2 shows up |
|---|---|
| Browsers and CDNs | Default for HTTPS; ALPN `h2`. Most of the web now uses HTTP/2 or HTTP/3 |
| gRPC | Built on HTTP/2 streams. Uses long-lived and bidirectional streaming, trailers for status, and flow control for backpressure |
| Reverse proxies (NGINX, Envoy, HAProxy) | Terminate `h2` from clients. Often speak HTTP/1.1 or `h2` to upstreams, sometimes `h2c` (cleartext) in a mesh |
| Service meshes | One multiplexed connection per pair of services replaces large connection pools |
| API gateways | Many concurrent API calls per client without connection limits |
| Mobile apps | Fewer connections save radio wake-ups and battery; still exposed to loss on poor networks |

## Use case walk-through: moving a storefront to HTTP/2

A storefront still serves its assets from three sharded domains (`static1-3.example.com`) with concatenated bundles and a sprite sheet. The team enables HTTP/2 at the CDN.

1. **Measure first.** Lab tests on a cable-speed profile show about 18 TCP+TLS connections per page load and LCP at 2.6 s.
2. **Enable `h2`.** The CDN negotiates HTTP/2 through ALPN. Connection coalescing already merges the shards, because they share a certificate and IP, so the browser reuses one connection.
3. **Remove sharding.** Assets move to one origin. Connections per page drop to 2 (HTML/assets and an API).
4. **Unbundle carefully.** The giant bundle is split into route-level chunks. Many small files are now cheap and cache independently, so a change to one module no longer invalidates everything. The team stops at tens of chunks, not hundreds: per-request overhead and compression efficiency still matter.
5. **Set priorities.** The hero image gets `fetchpriority="high"`, which the browser maps to HTTP/2 urgency. Below-the-fold images are lazy-loaded.
6. **Check lossy conditions.** On a 3G profile with 2% loss, a few page loads are slower than before, because a single loss now stalls everything. The team enables HTTP/3 at the CDN with `h2` as a fallback.
7. **Watch upstream behaviour.** The CDN talks to the origin over a small pool of HTTP/2 connections. The origin's `max_concurrent_streams` is raised so CDN fan-in doesn't queue.

**Result:** connections per page fall about 9×, repeat-visit transfer drops because of finer-grained caching, LCP improves to 1.9 s on good networks, and HTTP/3 covers the lossy-network regression.

## Pitfalls

- **Keeping HTTP/1.1 workarounds.** Domain sharding defeats multiplexing and prioritization. Sprites and mega-bundles throw away caching for no remaining benefit.
- **Assuming HTTP/2 is always faster.** It is on clean networks. On lossy ones, TCP HOL blocking can make it worse. Measure on realistic network profiles.
- **Too many tiny files.** Requests are cheap but not free: each has headers, priority handling and less effective compression than one larger file.
- **Proxy downgrades.** An edge speaking `h2` to clients but HTTP/1.1 to the origin with a small pool can queue requests at the proxy, and the bottleneck simply moves there.
- **Stream limits.** `max_concurrent_streams` set too low (or a gRPC client with one connection to a busy server) causes queueing that looks like latency.
- **Load balancing long-lived connections.** One HTTP/2 connection can carry a client's whole load. L4 balancers that spread *connections* end up badly unbalanced. Balance per request at L7.
- **Protocol abuse.** HTTP/2's flexibility created new denial-of-service attacks. One example is "Rapid Reset" (CVE-2023-44487): open and cancel streams in a loop. Keep servers patched and limits configured.

> [!TIP]
> Before tuning anything, open the browser's network panel, add the "Protocol" column and the connection ID, and check how many connections a page actually opens. Leftover sharding and missed coalescing show up immediately.

## Discussion questions

1. Why couldn't HTTP/1.1 pipelining fix head-of-line blocking, when HTTP/2 multiplexing could?
2. At what packet-loss rate would you expect six HTTP/1.1 connections to beat one HTTP/2 connection, and why?
3. How does per-stream flow control interact with TCP's flow control? Can one starve the other?
4. Why did server push fail in practice, and what replaced it?
5. How should a load balancer distribute traffic for long-lived HTTP/2 or gRPC connections?
6. Which HTTP/1.1-era front-end optimizations become anti-patterns under HTTP/2?

## FAQ

### Does HTTP/2 require TLS?

The specification allows cleartext HTTP/2 (`h2c`), but every major browser only speaks HTTP/2 over TLS, negotiated with ALPN. `h2c` is used inside data centres, for example between proxies and gRPC services.

### Is HTTP/2 still relevant now that HTTP/3 exists?

Yes. HTTP/3 needs UDP, which some corporate networks block or throttle, so clients fall back to HTTP/2. Most server-to-server traffic, including gRPC, still uses HTTP/2 over TCP.

### What is connection coalescing?

A browser may reuse an existing HTTP/2 connection for a different hostname if that hostname resolves to the same IP and is covered by the connection's TLS certificate. This lets sharded domains collapse back into one connection.

### Does HTTP/2 change my application code?

Usually not. Methods, headers, status codes and bodies have the same meaning. Header names must be lowercase, and connection-specific headers such as `Connection` and `Keep-Alive` are forbidden. Frameworks and proxies deal with framing.

### How many concurrent streams should a server allow?

100 is the common default and the specification's recommended minimum. Raise it for proxies and gRPC services with high fan-in. Keep limits on header size, rapid stream resets and total memory so the setting can't be abused.

## Key takeaways

- HTTP/2 sends HTTP as **binary frames on independent streams** multiplexed over **one connection**.
- It removes **HTTP-level head-of-line blocking**, the reason for six connections, sharding and bundling.
- **HPACK**, **per-stream flow control**, **cancellation** and simple **priorities** come with it. Server push is effectively dead.
- **TCP head-of-line blocking remains:** one lost packet stalls every stream and shrinks the shared congestion window.
- On lossy networks, **measure**, and offer **HTTP/3** with HTTP/2 as the fallback.

## References

- [RFC 9113 — HTTP/2](https://www.rfc-editor.org/rfc/rfc9113)
- [RFC 7541 — HPACK: Header Compression for HTTP/2](https://www.rfc-editor.org/rfc/rfc7541)
- [RFC 9218 — Extensible Prioritization Scheme for HTTP](https://www.rfc-editor.org/rfc/rfc9218)
- [RFC 9000 — QUIC: A UDP-Based Multiplexed and Secure Transport](https://www.rfc-editor.org/rfc/rfc9000)
- [web.dev — Introduction to HTTP/2](https://web.dev/articles/performance-http2)
- [Chrome Developers — Removing HTTP/2 Server Push from Chrome](https://developer.chrome.com/blog/removing-push)
- [CVE-2023-44487 — HTTP/2 Rapid Reset](https://nvd.nist.gov/vuln/detail/CVE-2023-44487)
- Ilya Grigorik, *High Performance Browser Networking*, O'Reilly, 2013.

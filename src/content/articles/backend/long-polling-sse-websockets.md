---
summary: Three ways to push updates from server to client — held requests, a one-way event stream, or a full-duplex socket — and what each costs to run at scale.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — HTTP is request/response, so "push" needs a workaround. **Long polling** holds a request open until there is news, then the client asks again. **Server-Sent Events (SSE)** keep one HTTP response open and stream text events server→client, with built-in reconnect. **WebSocket** upgrades the connection to a full-duplex message channel. Pick by traffic direction: SSE for one-way feeds (notifications, dashboards, LLM token streams), WebSocket when the client also sends often (chat, games, collaborative editing), long polling only when streaming is blocked. The hard part is not the protocol — it's holding hundreds of thousands of long-lived connections and fanning events out to them.

## The problem: the server has news, but the client didn't ask

A chat message arrives, a build finishes, a stock price ticks. The browser only learns about it if it makes a request. Plain polling (`GET /updates` every 5 seconds) is simple but wasteful and slow: most responses are empty, and the average delay is half the interval. Shorten the interval and you multiply load; lengthen it and the UI feels stale.

What we want is for the server to send data the moment it exists, over a connection the client opened (clients sit behind NAT and firewalls; servers can't dial them). Three techniques do this, each a step further from classic HTTP.

## How it works

![Three transports](/figures/realtime-transports/timelines.svg "Long polling repeats held requests; SSE streams one response; WebSocket exchanges frames both ways")

### Long polling

The client sends a normal request. Instead of answering immediately, the server **parks** it until an event arrives or a timeout (typically 20–60 s) expires, then responds — with the event, or `204 No Content`. The client immediately sends the next request, usually including a cursor (`?since=evt_9123`) so nothing is missed between requests.

- **Pros:** works everywhere plain HTTP works — old proxies, strict corporate networks, any client library. Each response is a normal, cacheable-if-you-want, loggable HTTP exchange.
- **Cons:** a full request/response (headers, auth, TLS session reuse permitting) per event batch; a gap between response and re-request where events must be buffered server-side; bursts of events cause a request storm. Bidirectional chat needs separate POSTs for the upstream direction.

Long polling powered early Facebook chat and Comet-era apps, and still serves as the fallback transport in libraries such as Socket.IO and SignalR.

### Server-Sent Events

SSE is a standard browser API (`EventSource`) over a single long-lived HTTP response with `Content-Type: text/event-stream`. The body is a stream of UTF-8 text events:

```
id: 9124
event: order.shipped
data: {"orderId": 42}

```

The browser reconnects automatically if the connection drops, sending `Last-Event-ID: 9124` so the server can replay what was missed; the server can tune the reconnect delay with `retry:`.

- **Pros:** it's just HTTP — works with existing auth cookies, load balancers, CDNs, and HTTP/2 multiplexing. Reconnect and resume are built into the protocol. Trivial to implement on the server (write lines, flush).
- **Cons:** server→client only (upstream uses normal requests). Text only, so binary must be base64-encoded. Over HTTP/1.1 browsers allow only about six connections per origin, so multiple tabs can exhaust them — HTTP/2 or HTTP/3 removes this limit. The native `EventSource` API can't set custom headers (fetch-based clients can).

SSE has had a resurgence because LLM APIs stream tokens with it: the request is a POST, the response is an event stream.

### WebSocket

A WebSocket starts as an HTTP/1.1 request with `Upgrade: websocket` and a `Sec-WebSocket-Key`; the server replies `101 Switching Protocols`, and from then on the TCP connection carries **frames** in both directions with a 2–14 byte header (RFC 6455). HTTP/2 and HTTP/3 can carry WebSockets too via extended CONNECT (RFC 8441, RFC 9220).

- **Pros:** true full duplex with minimal per-message overhead; binary frames; ideal for high-frequency, two-way traffic.
- **Cons:** it's a separate protocol, so you rebuild what HTTP gave you for free: no automatic reconnect, no resume, no request/response correlation, no per-message status codes, no caching. Auth happens once at upgrade, so token expiry mid-connection needs explicit handling. Some proxies and corporate middleboxes still break it. You'll implement heartbeats (ping/pong) to detect dead peers and keep NAT mappings alive.

Most teams use a library (Socket.IO, SignalR, Phoenix Channels, Centrifugo) that adds rooms, acknowledgements, reconnection, and fallback transports on top.

### Scaling persistent connections

![Fan-out](/figures/realtime-transports/fanout.svg "Gateway nodes hold client sockets; a pub/sub bus routes events to whichever node holds the recipient")

Whatever the transport, real-time systems share the same architecture problems:

- **Connection state lives on a node.** A user's socket is pinned to one gateway process. Whoever produces the event (an API server, a worker) doesn't know which node that is. The standard answer is a **pub/sub bus** (Redis Pub/Sub, NATS, Kafka): gateways subscribe to the channels their connected users care about and forward matching events.
- **Memory and file descriptors, not CPU.** An idle connection costs a socket, kernel buffers, and per-connection application state — tens of KB each. Event-loop servers (Node.js, Go, Erlang/Elixir, Netty) hold hundreds of thousands per node; thread-per-connection servers can't. Raise `ulimit -n` and tune proxies' idle timeouts above your heartbeat interval.
- **Load balancing.** Connections are long-lived, so round-robin at connect time drifts out of balance after deploys. Long polling with in-memory session state needs sticky sessions; SSE and WebSocket don't, as long as reconnects can land anywhere and resume.
- **Reconnect storms.** Deploying a gateway drops every connection on it at once. Drain gradually, have the server suggest jittered retry delays, and make resume cheap (cursor-based replay rather than "send me everything").
- **Delivery guarantees.** The socket is not durable. Treat the stream as a low-latency *hint*; the source of truth is a log or database the client can catch up from using a last-seen ID.

### Choosing

![Decision guide](/figures/realtime-transports/choose.svg "Start from traffic direction, then network constraints")

## Where it's used

| Product / system | Transport | Why |
|---|---|---|
| LLM chat APIs (token streaming) | SSE over a POST response | One-way stream, plain HTTP, works through CDNs |
| GitHub / Vercel build logs, notifications | SSE or long polling | One-way updates, proxy-friendly |
| Slack, Discord clients | WebSocket | High-frequency two-way messages, presence, typing |
| Figma, Google Docs-style collaboration | WebSocket | Continuous bidirectional operations |
| Multiplayer browser games | WebSocket (or WebTransport) | Low-latency two-way, binary frames |
| Kubernetes `watch` API | Long-lived chunked HTTP stream | Watch events from a resource version |
| Telegram Bot API `getUpdates` | Long polling | Simple for bot authors, no public endpoint needed |

## Use case walk-through: live order tracking for a food delivery app

1. **Requirements.** Customers watch their order status and the courier's location (an update every ~3 s). Customers never send data on this screen except "cancel", which is a normal API call. Peak: 400k concurrent viewers.
2. **Transport.** Traffic is one-way, so the team picks **SSE** over HTTP/2: it reuses existing cookie auth, passes through the CDN and corporate proxies, and needs no new protocol on the mobile web.
3. **Gateway tier.** A fleet of Go gateway pods each hold ~60k connections. On connect, a pod subscribes to the NATS subject `order.<id>`; the dispatch and courier services publish to those subjects without knowing which pod is listening.
4. **Resume.** Each event carries an `id` from the order's event log. When a phone switches from Wi-Fi to cellular, `EventSource` reconnects to any pod with `Last-Event-ID`, which replays the missed events from the log.
5. **Deploys.** Pods drain over two minutes, sending `retry: <random 1–10 s>` before closing, so 60k clients don't reconnect in the same second.
6. **Couriers.** The courier app *sends* location every few seconds and receives job offers, so that client uses a WebSocket to a separate gateway — the right transport per traffic pattern.

**Result:** customer updates arrive in under a second, the CDN and existing auth stack were reused, and deploys no longer produce connection spikes.

## Pitfalls

- **Proxy buffering.** Nginx and some CDNs buffer responses, so SSE events arrive in clumps or not at all. Disable buffering (`X-Accel-Buffering: no`, `proxy_buffering off`) and flush after each event.
- **Idle timeouts.** Load balancers kill connections idle for 60 s by default. Send heartbeats (SSE comment lines `: ping`, WebSocket pings) more often than the shortest timeout on the path.
- **Treating the socket as durable.** Messages sent while a client is reconnecting are lost unless you can replay from a cursor.
- **No backpressure.** A slow client's send buffer grows until the server runs out of memory. Bound per-connection queues and drop or disconnect slow consumers.
- **Auth expiry on long connections.** A WebSocket authenticated at upgrade stays open after the token expires; re-validate periodically or close and force reauth.
- **Cross-site WebSocket hijacking.** Browsers send cookies on the upgrade request and don't enforce CORS; check the `Origin` header.
- **HTTP/1.1 connection limits** with SSE across many tabs — serve it over HTTP/2, or share one connection across tabs with a `SharedWorker` or `BroadcastChannel`.

> [!WARNING]
> Don't pick WebSocket by default "because it's real-time". For one-way updates SSE gives you reconnect, resume, HTTP auth and proxy compatibility for free; with WebSocket you'd rebuild all of them yourself.

## Discussion questions

1. Why does long polling need a cursor or event ID, and what goes wrong without one?
2. Compare the per-message overhead of long polling, SSE and WebSocket for a stream of 10 small events per second.
3. How would you route an event to a user who has three open tabs connected to three different gateway nodes?
4. What changes about the six-connection limit when SSE is served over HTTP/2, and why?
5. Design a graceful deploy for a gateway fleet holding 2 million WebSockets.
6. When would WebTransport (over HTTP/3/QUIC) be a better fit than WebSocket?

## FAQ

### Is SSE supported in all browsers?
All modern browsers support `EventSource`. For features it lacks — custom headers, POST bodies — use a `fetch`-based reader of the `text/event-stream` body, which is how most LLM SDKs consume streams.

### Can I use WebSockets through a CDN or serverless platform?
Many CDNs proxy WebSockets now, but serverless functions usually have execution-time limits that conflict with long-lived connections. Managed services (API Gateway WebSocket APIs, Pusher, Ably, Cloudflare Durable Objects) hold the connections for you.

### How many connections can one server handle?
With an event-loop runtime and tuned kernel limits, hundreds of thousands to over a million mostly idle connections per machine is achievable. The practical limit is usually memory per connection and the blast radius of losing one node.

### Is long polling obsolete?
Mostly as a primary transport, but it remains a robust fallback and a fine choice for low-frequency updates where simplicity wins, such as bot APIs.

### Do I need message acknowledgements?
If losing a message matters, yes — either application-level acks or, simpler, a durable log the client resumes from with its last-seen ID. The transport itself guarantees ordering on a connection, not delivery across reconnects.

## Key takeaways

- Plain polling trades latency for load; push transports avoid both.
- Long polling: held requests, universal compatibility, highest overhead.
- SSE: one-way text stream over HTTP with built-in reconnect and resume — the default for server→client feeds.
- WebSocket: full-duplex frames, lowest overhead, but you rebuild reconnect, auth refresh and resume.
- Scale with gateway nodes plus pub/sub fan-out; plan for heartbeats, backpressure and reconnect storms.
- Make the stream a hint over a durable, resumable source of truth.

## References

- [WHATWG HTML Standard — Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [RFC 6455 — The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455)
- [RFC 8441 — Bootstrapping WebSockets with HTTP/2](https://www.rfc-editor.org/rfc/rfc8441)
- [RFC 6202 — Known Issues and Best Practices for the Use of Long Polling and Streaming in Bidirectional HTTP](https://www.rfc-editor.org/rfc/rfc6202)
- [MDN — Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [MDN — The WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- Grigorik, I. — *High Performance Browser Networking*, O'Reilly, 2013, chapters 16–17

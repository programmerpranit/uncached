---
summary: How TCP senders probe for bandwidth, back off on loss or delay, and share a bottleneck they cannot see — from Reno's sawtooth to CUBIC, BBR and ECN.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — A TCP sender never knows how much bandwidth the path has, so it **guesses and adjusts**. It keeps a **congestion window (cwnd)** that limits how much unacknowledged data can be in flight. **Slow start** doubles cwnd every round trip until it hits a threshold or sees loss; **congestion avoidance** then grows it by about one segment per RTT and **halves** it on loss (AIMD). That gives the classic sawtooth. Modern variants change the curve: **CUBIC** (the Linux default) regrows faster on high-bandwidth paths, **BBR** models bottleneck bandwidth and minimum RTT instead of waiting for loss, and **ECN** lets routers signal congestion before dropping packets.

## The problem: sharing a bottleneck nobody can see

In October 1986 the link between Lawrence Berkeley Lab and UC Berkeley — 400 yards apart — dropped from 32 kbit/s to 40 bit/s. Nothing was broken. Senders were retransmitting lost packets as fast as they could, routers were dropping them because queues were full, and the network spent almost all its capacity carrying duplicates. This was **congestion collapse**.

Van Jacobson's fix, published in 1988, is still the foundation. The difficulty it addresses:

- A sender sees only its own packets and the ACKs that come back. It does not know the link speeds along the path, how many other flows share them, or how big the router buffers are.
- The available bandwidth **changes constantly** as other flows start and stop.
- If every sender pushes as hard as it can, queues overflow, packets drop, retransmissions add more load, and goodput collapses.
- If senders are too timid, expensive links sit idle.

Congestion control is the algorithm each sender runs so that thousands of independent flows **converge on high utilization and rough fairness** without any central coordinator.

## How it works

### Two windows: flow control vs congestion control

A TCP sender limits **inflight** data — bytes sent but not yet acknowledged — to:

> inflight ≤ min(**cwnd**, **rwnd**)

- **rwnd** (receive window) is advertised by the receiver in every ACK. It protects the **receiver's buffer**. That is *flow control*.
- **cwnd** (congestion window) is private to the sender. It protects the **network**. That is *congestion control*.

Throughput is roughly cwnd ÷ RTT. A 64 KB window over a 100 ms path caps a flow at about 5 Mbit/s no matter how fast the link is, which is why window size matters so much on long paths.

### Slow start, AIMD and the sawtooth

![cwnd over time: exponential slow start, a halving on three duplicate ACKs, linear congestion avoidance, then a collapse to 1 on timeout followed by slow start again](/figures/tcp-congestion/sawtooth.svg "Classic Reno behavior. Duplicate ACKs mean 'some data is getting through', so the sender halves; a timeout means 'nothing is getting through', so it starts over.")

**Slow start.** A new connection starts with a small cwnd: the initial window, 10 segments on modern stacks (RFC 6928). Each ACK grows cwnd by one segment, so cwnd **doubles every RTT**. The name is misleading, because growth is exponential. It is only "slow" compared with blasting the whole window at once.

**ssthresh.** The slow-start threshold marks where exponential growth stops. It starts very high, and after a loss it is set to half of the cwnd at the time of the loss.

**Congestion avoidance.** Above ssthresh, cwnd grows by about **one segment per RTT**: additive increase. On loss it is cut multiplicatively, usually by half. This **AIMD** rule (additive increase, multiplicative decrease) is what makes competing flows converge toward a fair share. A flow with a bigger window loses more on each cut and gains no faster, so windows drift toward equality.

**Detecting loss.** There are two signals, and they mean different things:

- **Three duplicate ACKs** (or a SACK gap). Later segments arrived, so the path still works. The sender performs **fast retransmit** of the missing segment and **fast recovery**: ssthresh = cwnd/2 and cwnd = ssthresh, then congestion avoidance continues.
- **Retransmission timeout (RTO).** No ACKs at all for a while. Something is badly wrong, so cwnd drops to **1 segment** and slow start begins again up to the new ssthresh.

### The feedback loop and its signals

![Sender with cwnd and pacing sends through a bottleneck router whose queue fills when inflight exceeds the bandwidth-delay product; ACKs return carrying SACK, ECN echo and timestamps](/figures/tcp-congestion/loop.svg "Congestion control is a closed loop: the only thing the sender can observe is the stream of ACKs. Algorithms differ in which signal they treat as 'too much'.")

Every algorithm reads congestion from the ACK stream, but they disagree on which signal to trust:

- **Loss-based** (Reno, NewReno, CUBIC). A drop means the queue overflowed. This is robust and simple, but it only reacts *after* the buffer is full.
- **Delay-based** (Vegas, LEDBAT, and partly BBR). Rising RTT means a queue is building. This reacts early, but such flows can be starved when they compete with loss-based flows that happily fill the buffer.
- **ECN** (Explicit Congestion Notification, RFC 3168). A router that supports it sets the **CE** (Congestion Experienced) bit in the IP header instead of dropping the packet. The receiver echoes the mark in its ACKs (the ECE flag), and the sender backs off as if a loss had occurred, but without losing any data. **DCTCP** and **L4S** take this further: they react *in proportion* to the fraction of marked packets, which keeps queues tiny.

### CUBIC: built for fat, long pipes

On a 10 Gbit/s path with 100 ms RTT, the bandwidth-delay product is about 83,000 full-size segments. After a single loss halves the window, Reno's one-segment-per-RTT growth would take **over an hour** to recover. Loss-based TCP on such paths simply never fills the pipe.

**CUBIC** (RFC 9438, the default in Linux, Windows and macOS) replaces linear growth with a **cubic function of time since the last loss**:

- It regrows quickly at first, then **flattens near the previous maximum** (W_max), where the last loss happened, probing carefully.
- If it passes W_max without loss, growth accelerates again to find new capacity.
- Growth depends on wall-clock time rather than ACK arrival, so flows with different RTTs get closer to fair shares than with Reno, which favors short-RTT flows.
- It cuts the window by 30% on loss instead of 50%.

CUBIC is still loss-based, though. It keeps the bottleneck buffer full on purpose, because that is how it finds the edge.

### BBR: aim for the knee, not the cliff

![Delivery rate rises with data in flight until the bandwidth-delay product, then stays flat while RTT climbs as the queue fills, until loss at BDP plus buffer](/figures/tcp-congestion/operating-point.svg "Below the BDP, more inflight data means more throughput. Between BDP and BDP + buffer, it only adds queueing delay. Loss-based algorithms operate at the right edge; BBR tries to sit at the knee.")

Picture what happens as a sender adds more data in flight:

1. **Below the BDP** (bottleneck bandwidth × minimum RTT), delivery rate rises and RTT stays at its minimum. The pipe is not full yet.
2. **Between BDP and BDP + buffer**, delivery rate is flat at the bottleneck bandwidth, but RTT climbs. The extra data just sits in a queue.
3. **Past BDP + buffer**, packets drop.

Loss-based algorithms only learn about the limit at point 3, so they spend their lives in zone 2 and add latency to every flow sharing the link. With large buffers, this is **bufferbloat**: hundreds of milliseconds of queueing on a home router while someone uploads a video.

**BBR** (Bottleneck Bandwidth and Round-trip propagation time, from Google) estimates the two quantities that define the knee:

- **BtlBw**: the maximum delivery rate seen recently.
- **RTprop**: the minimum RTT seen recently.

It then **paces** packets at BtlBw instead of sending bursts, and caps inflight at a small multiple of BtlBw × RTprop. It periodically probes for more bandwidth by briefly pacing faster, and periodically drains the queue so it can re-measure RTprop.

Trade-offs:

- BBR keeps queues short and is far less sensitive to random, non-congestive loss, as on Wi-Fi or long-haul links.
- BBR v1 could take more than its fair share against CUBIC and caused high retransmission rates in shallow buffers.
- BBR v2/v3 add loss and ECN signals to temper this.

### Fairness and coexistence

The internet carries a mix of algorithms. A few rules of thumb:

- AIMD flows sharing a bottleneck converge to roughly equal shares, but **shorter-RTT flows win** under Reno-style growth.
- Delay-based flows lose to loss-based ones, because the loss-based flow fills the queue and the delay-based flow backs off from it.
- **Active queue management** (AQM) in routers, such as CoDel and FQ-CoDel, drops or marks packets early based on queueing delay. It also schedules per-flow, which limits how much any one algorithm can hurt others.
- Applications that open many parallel connections, like old browsers and download accelerators, get a bigger share simply by having more windows.

## Where it's used

| Setting | Congestion control in practice |
|---|---|
| Linux, Windows, macOS default TCP | CUBIC |
| Google services, YouTube, many CDNs | BBR (v1, then v2/v3) for egress traffic |
| Data centers | DCTCP or similar ECN-based schemes with shallow switch buffers |
| QUIC / HTTP/3 | Congestion control in user space; NewReno, CUBIC or BBR selectable per stack |
| Background transfers (OS updates, BitTorrent µTP) | LEDBAT: delay-based, yields to interactive traffic |
| Home routers and ISPs | FQ-CoDel / CAKE AQM to fight bufferbloat |
| Low-latency access networks | L4S (RFC 9330): scalable ECN-based CC with dual-queue AQM |

## Use case walk-through: a video CDN switches from CUBIC to BBR

A video platform serves global traffic from edge servers running CUBIC. Viewers in regions with long RTTs and lossy last-mile links see frequent rebuffering, even though their links are nominally fast enough for HD.

1. **Measure first.** Per-connection telemetry (`ss -ti`, or TCP_INFO exported to metrics) shows delivery rate, RTT, retransmits and cwnd. On the worst paths, a 1–2% random loss rate keeps CUBIC's window small even though the bottleneck is idle much of the time.
2. **Check bufferbloat.** Smoothed RTT during a transfer is 3–5× the minimum RTT on some access networks. CUBIC is filling deep buffers in home routers.
3. **Enable pacing.** BBR needs pacing, which is the fq qdisc on Linux, or internal pacing in newer kernels. Switch the sysctl on a canary pool: `net.ipv4.tcp_congestion_control = bbr`.
4. **A/B test on user metrics.** Compare rebuffer rate, startup time and delivered bitrate between control and canary, split by region and access type, not just by average throughput.
5. **Watch the side effects.** Monitor the retransmission rate (BBR v1 can retransmit more in shallow buffers) and fairness to other traffic on shared links.
6. **Roll out gradually** by region, keeping CUBIC where results are neutral or negative. This might be paths with heavy policing, where BBR's probing triggers drops.

**Result:** on long, lossy paths, delivered bitrate rises substantially and rebuffering drops, because loss no longer collapses the window. Median RTT during playback falls because queues stay short. Short, clean paths see little change, and the rollout keeps per-region switches for that reason.

## Pitfalls

- **Blaming the algorithm for a window problem.** If rwnd or socket buffers are small (no window scaling, tiny `SO_RCVBUF`), no congestion control can fill a long pipe. Check `min(cwnd, rwnd)` first.
- **Treating all loss as congestion.** Radio links and policers drop packets for other reasons; loss-based CC overreacts to them.
- **Bufferbloat.** Big buffers plus loss-based CC means high latency for everyone sharing the link. Fix it with AQM at the bottleneck, not by shrinking buffers alone.
- **Disabling slow start or inflating the initial window.** Hacks that blast huge windows at connection start cause loss bursts and hurt neighbors.
- **Unpaced bursts.** Sending a full window back to back overflows shallow switch buffers even when the average rate is fine. Pacing smooths it.
- **Middleboxes and ECN.** Some old devices clear or mishandle ECN bits. Deployments negotiate ECN and fall back when it fails.
- **Comparing averages only.** A change that raises mean throughput can still hurt tail latency or fairness. Measure percentiles and the impact on competing flows.

> [!TIP]
> On Linux, `ss -ti` shows each connection's congestion algorithm, cwnd, ssthresh, RTT, delivery rate and retransmits. It is the fastest way to see whether a slow transfer is limited by the network, the receiver window or the application.

## Discussion questions

1. Why does AIMD converge toward fairness while additive-increase, additive-decrease does not?
2. What does a timeout tell the sender that three duplicate ACKs don't, and why does it justify a much harsher reaction?
3. How would you tell whether a slow transfer is limited by cwnd, rwnd, or the application not writing fast enough?
4. Why are delay-based algorithms at a disadvantage when they share a bottleneck with CUBIC?
5. What changes when congestion control moves into user space, as with QUIC?
6. How do AQM schemes like FQ-CoDel change the trade-offs between loss-based and model-based congestion control?

## FAQ

### Is congestion control the same as flow control?

No. Flow control (rwnd) stops the sender from overrunning the **receiver's** buffer, and the receiver states its limit explicitly. Congestion control (cwnd) stops the sender from overrunning the **network**, which never states a limit, so the sender has to infer it.

### Why is it called "slow start" if it grows exponentially?

Earlier TCPs sent the entire receive window at once as soon as a connection opened. Starting at a small window and doubling was slow compared with that.

### Should I switch my servers to BBR?

It often helps for bulk transfers over long or lossy paths, such as video, downloads and cross-region replication. Inside a data center with ECN and shallow buffers, DCTCP-style schemes are usually better. Test against user-facing metrics, and check the retransmission rate and fairness rather than assuming a win.

### Does UDP have congestion control?

Not built in. Applications on UDP are expected to implement it themselves. QUIC does, with algorithms equivalent to TCP's, and so do WebRTC media stacks (GCC). Raw UDP floods without congestion control are exactly what caused collapse in the first place.

### What is the bandwidth-delay product, and why does it matter here?

It is bottleneck bandwidth × round-trip time: the amount of data needed in flight to keep the pipe full. A 1 Gbit/s path at 80 ms needs about 10 MB in flight. cwnd, rwnd and socket buffers all need to reach that size, or throughput is capped below link speed.

## Key takeaways

- The sender limits inflight data to **min(cwnd, rwnd)**: cwnd protects the network, rwnd protects the receiver.
- **Slow start** grows exponentially to find capacity, and **AIMD** keeps flows stable and roughly fair.
- **Duplicate ACKs → halve**; **timeout → back to 1**.
- **CUBIC** fixes slow recovery on high-BDP paths but still fills buffers to find the limit.
- **BBR** models bottleneck bandwidth and minimum RTT, paces at the bottleneck rate and aims for the knee to avoid bufferbloat.
- **ECN, DCTCP and L4S** let the network signal congestion before dropping packets, keeping queues small.

## References

- [RFC 5681 — TCP Congestion Control](https://www.rfc-editor.org/rfc/rfc5681)
- [RFC 9438 — CUBIC for Fast and Long-Distance Networks](https://www.rfc-editor.org/rfc/rfc9438)
- [RFC 3168 — The Addition of Explicit Congestion Notification (ECN) to IP](https://www.rfc-editor.org/rfc/rfc3168)
- [RFC 8257 — Data Center TCP (DCTCP)](https://www.rfc-editor.org/rfc/rfc8257)
- [RFC 6928 — Increasing TCP's Initial Window](https://www.rfc-editor.org/rfc/rfc6928)
- [Cardwell et al. — BBR: Congestion-Based Congestion Control (ACM Queue, 2016)](https://queue.acm.org/detail.cfm?id=3022184)
- Van Jacobson and Michael J. Karels, "Congestion Avoidance and Control," *Proceedings of ACM SIGCOMM*, 1988.
- Kathleen Nichols and Van Jacobson, "Controlling Queue Delay," *ACM Queue*, 2012.

---
summary: What happens when data arrives faster than you can process it, why "just add a buffer" only delays the crash, and how pull-based demand, bounded queues, load shedding and lag-based autoscaling keep pipelines stable.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** If a producer is faster than its consumer for long enough, **something has to give**: memory (unbounded queues → OOM), latency (ever-growing queues), data (drops), or the producer's speed (**backpressure**). Backpressure means the slow side signals "send less", and the signal **propagates upstream** until it reaches something that can safely wait, like a durable log or a client that can retry. Get it with **bounded buffers** plus **blocking or pull-based demand** (`request(n)`, credits, TCP windows). Combine it with **load shedding** where waiting is worse than dropping, and **autoscaling** where the work can be parallelised.

## The problem: rates don't match

Every pipeline is a chain of stages with different speeds: an HTTP ingest, a parser, an enrichment call to another service, a database writer. If the downstream stage handles 1,000 msg/s and the upstream sends 1,200 msg/s, the 200 msg/s difference has to go somewhere.

![Line chart: an unbounded queue grows linearly to 12,000 messages in a minute, while a bounded queue with backpressure flattens at 2,000.](/figures/backpressure/queue-growth.svg "Any sustained mismatch grows a queue linearly. Buffers absorb bursts, but they can't absorb a rate difference forever.")

An **unbounded** buffer hides the problem for a while, then fails in the worst way:

- **Memory** grows until the process is OOM-killed and loses everything in the buffer.
- **Latency** grows with the queue. By Little's law (`queue length = arrival rate × wait time`), 12,000 queued messages at 1,000 msg/s means a 12-second delay, and rising.
- **GC pressure** grows, which makes the consumer even slower, a positive feedback loop.
- When it finally crashes, recovery has to reprocess a huge backlog while new data keeps arriving.

### Why "almost keeping up" is not enough

Queueing theory says latency explodes long before utilization hits 100%. In the simple M/M/1 queue model, the mean number in the system is `ρ / (1 − ρ)`. At 50% utilization that's 1. At 90% it's 9. At 99% it's 99. Traffic is bursty, so a consumer running at 95% of capacity on average will spend much of its time with a growing queue. Plan for headroom.

## The options

![Five cards: slow the producer, bounded buffer, drop or sample, scale consumers, batch or degrade.](/figures/backpressure/strategies.svg "Under sustained overload you can only choose how to fail: slower, lossy, or bigger.")

1. **Slow the producer (backpressure).** The consumer signals capacity and the producer waits. No data is lost, and the delay moves upstream to whatever can best absorb it.
2. **Buffer, with a bound.** Absorb short bursts. When the buffer is full, fall back to one of the other options.
3. **Drop or sample (load shedding).** Discard data on purpose: oldest (keep fresh data), newest (protect work already queued), or a sample (metrics, logs). The cost stays bounded and the loss is explicit.
4. **Scale consumers.** Add workers or partitions, if the work parallelises and the bottleneck isn't a shared downstream resource.
5. **Batch or degrade.** Bigger batches amortise per-item overhead (fewer DB round trips), or switch to a cheaper code path (skip enrichment, lower resolution).

Most real systems combine them: **bounded buffers + backpressure** inside the pipeline, **durable buffering** at the edge (Kafka), **autoscaling** on lag, and **shedding** as the last line of defence.

## How backpressure works

### Blocking with bounded queues

The simplest form: a fixed-size queue between stages. When it's full, `put()` **blocks** the producer thread (Java `ArrayBlockingQueue`, a buffered Go channel). The producer slows to the consumer's pace automatically.

It's simple, but blocking threads can tie up resources upstream. It's fine within a process. Across a network you need explicit signals.

### Pull-based demand

Instead of the producer pushing as fast as it can, the **consumer asks for data** when it has capacity:

![Subscriber sends request(16) to the publisher, receives at most 16 items, then requests 8 more after processing 8.](/figures/backpressure/pull-demand.svg "Reactive Streams: data flows down, demand flows up. A publisher may never send more than has been requested.")

- **Reactive Streams** (2015) standardised this for the JVM as `Subscription.request(n)`. It's built into Java 9's `Flow` API, RxJava, Project Reactor and Akka/Pekko Streams.
- **Kafka consumers pull.** A slow consumer just polls less often, and the broker keeps data durably on disk. Backpressure becomes **consumer lag** instead of memory pressure, which is why Kafka is such a good shock absorber.
- **Credit-based flow control.** The receiver grants credits (buffer slots) and the sender spends one per message. Flink uses this between tasks, and AMQP and HTTP/2 use the same idea.

### Transport-level windows

- **TCP** receive windows: the receiver advertises how many bytes it can accept, and the sender stops when the window is full. If an application stops reading from a socket, TCP backpressure eventually blocks the writer.
- **HTTP/2 and gRPC** add per-stream and per-connection flow-control windows, so one slow stream can't flood the connection.

### Propagation

Backpressure only works if **every stage** respects it and has a **bounded** buffer. Then a slowdown anywhere propagates back to the source:

![Pipeline source → parse → enrich → sink with small buffers; the slow sink's demand signal travels back to the source.](/figures/backpressure/propagation.svg "Each stage blocks or stops requesting when its output buffer is full, until the source simply reads more slowly.")

A single stage with an unbounded buffer breaks the chain. It accepts everything, hides the slowdown from upstream, and becomes the OOM point. Common culprits: an unbounded executor queue, `Promise.all` over an unbounded stream, or an async HTTP client firing requests without a concurrency limit.

## The boundary problem: you can't backpressure the internet

Inside your pipeline you can slow things down. At the **edge** (users, devices, third-party webhooks) you often can't tell the sender to wait. Options:

- **Durable ingest buffer:** accept fast and write to Kafka, Kinesis or SQS, then process at your own pace. Lag becomes visible and recoverable.
- **Reject early:** `429` / `503` with `Retry-After` turns overload into client-side backoff. It's backpressure for request/response systems.
- **Admission control with deadlines:** drop requests that have already waited longer than the client will wait. Facebook's "Fail at Scale" describes **adaptive LIFO** (serve the newest requests first when overloaded) and **CoDel-style** queue timeouts. Old requests whose clients have already given up get dropped instead of processed.

## Where it's used

| System | Mechanism |
| --- | --- |
| **Kafka consumers** | Pull model. Lag is the backpressure signal. Autoscale on lag (e.g. KEDA). |
| **Apache Flink** | Credit-based network flow control. The backpressure monitor shows which operator is the bottleneck. |
| **Node.js streams** | `highWaterMark`. `write()` returns `false` when the buffer is full, and `'drain'` signals when to resume. `pipe()` / `pipeline()` handle this for you. |
| **Reactive libraries** | `request(n)` demand, plus `onBackpressureBuffer` / `Drop` / `Latest` operators for explicit policies |
| **Go** | Bounded channels block senders. Worker pools cap concurrency. |
| **TCP, HTTP/2, gRPC** | Receive windows and flow-control frames |
| **Metrics and logging agents** | Bounded in-memory queues with drop counters, plus disk spooling |

### Use case walk-through: a clickstream pipeline during a sale

Traffic jumps 5× during a flash sale.

1. Edge collectors write to **Kafka**. Kafka absorbs the burst on disk.
2. Flink jobs consuming the topic hit their limit. **Consumer lag** rises from seconds to minutes. Nothing crashes, because Flink's credit-based flow control keeps every operator's buffers bounded.
3. **Autoscaling** on lag adds task slots, up to the partition count.
4. The real-time dashboard's sink (a database) is the bottleneck. It switches to **larger batches**, and non-critical enrichment is **disabled** under high lag.
5. After the sale, consumers drain the lag. No data is lost, and memory stays flat throughout.

## Pitfalls

> [!WARNING]
> **"Async" doesn't mean unbounded is OK.** Firing off a promise or goroutine per incoming message, with no limit, is an unbounded buffer in disguise. Always cap in-flight work with a semaphore, worker pool or concurrency limit.

- **Retries amplify overload.** A struggling consumer that times out triggers retries, which add load. Combine backpressure with **retry budgets** and **exponential backoff**.
- **Head-of-line blocking.** One slow key or partition backpressures everything sharing its queue. Isolate by partition or priority.
- **Backpressure into a non-durable source.** If the source can't wait (UDP, a sensor, a webhook with a short timeout), slowing down means **dropping upstream**, where it's invisible. Put a durable buffer at that boundary.
- **Only watching CPU.** Pipelines often bottleneck on downstream I/O. Monitor **queue depth, lag and time-in-queue** per stage.
- **Buffers sized for throughput, not latency.** A huge buffer gives great throughput benchmarks and terrible tail latency. Size buffers by how much delay you can tolerate.

## Discussion questions

1. Find a place in your system with an unbounded queue or unbounded concurrency. What happens at 3× normal load?
2. When should a pipeline drop data instead of applying backpressure? Give examples of each.
3. Why is Kafka described as a shock absorber? What's the downside of relying on it?
4. How does TCP flow control differ from TCP congestion control?
5. A Flink job shows backpressure on the source operator. Where is the bottleneck likely to be?
6. How would you design admission control for an API whose clients time out after 2 seconds?

## FAQ

### Is backpressure the same as rate limiting?

They're related but different. **Rate limiting** enforces a *fixed* policy ("100 req/s per client") whatever your current capacity. **Backpressure** is *dynamic*: it signals actual, current capacity from the consumer. Rate limits protect against abusive clients. Backpressure protects against overload from any cause.

### Doesn't backpressure just move the problem upstream?

Yes, on purpose: to a place better able to wait. A durable log, a client that can retry later, or a batch job that can run slower are all better places for delay than an in-memory buffer. If nothing upstream can wait, you have to shed load explicitly.

### How big should buffers be?

Big enough to smooth normal bursts. Small enough that the worst-case wait (`buffer size / service rate`) stays within your latency budget. A buffer worth seconds of work is usually plenty inside a pipeline. Minutes or hours of buffering belong in a durable log, not in memory.

### How do I detect backpressure in production?

Watch per-stage **queue depth**, **time in queue**, **consumer lag** (Kafka offsets, SQS age of oldest message), **blocked time** for producers, and **drop counters**. Flink and similar frameworks expose backpressure ratios per operator.

### What's the difference between dropping oldest and dropping newest?

**Drop oldest** (keep the latest) suits real-time data, where fresh values matter more than complete history: sensor readings, prices, UI updates. **Drop newest** (reject incoming) protects work already accepted and gives senders a clear signal to retry. It's the right default for request/response APIs.

### Can autoscaling replace backpressure?

No. Scaling takes time (seconds to minutes), has upper limits (partition counts, database capacity), and doesn't help if the bottleneck is a shared downstream resource. You still need bounded buffers and backpressure to stay stable while scaling catches up, or when it can't help.

## Key takeaways

- A sustained rate mismatch **grows queues linearly**. Unbounded buffers turn overload into OOMs and huge latency.
- **Backpressure**: bounded buffers + blocking or **pull-based demand**, propagated through **every** stage.
- Put **durable buffers** (Kafka) at boundaries where the source can't wait, and **shed load** where waiting is worse than dropping.
- Monitor **lag and queue time**, autoscale on them, and cap concurrency everywhere.
- Keep **headroom**: latency blows up well before 100% utilization.

## References

1. [Reactive Streams specification](https://www.reactive-streams.org/). 2015.
2. Apache Flink blog. [A Deep-Dive into Flink's Network Stack](https://flink.apache.org/2019/06/05/a-deep-dive-into-flinks-network-stack/). 2019.
3. Node.js docs. [Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams).
4. B. Maurer. [Fail at Scale: Reliability in the face of rapid change](https://queue.acm.org/detail.cfm?id=2839461). *ACM Queue*, 2015.
5. K. Nichols, V. Jacobson. [Controlling Queue Delay](https://queue.acm.org/detail.cfm?id=2209336) (CoDel). *ACM Queue*, 2012.
6. Apache Kafka docs. [Design: The Consumer (push vs pull)](https://kafka.apache.org/documentation/#design_pull).
7. J. D. C. Little. "A Proof for the Queuing Formula: L = λW". *Operations Research*, 1961.
8. M. Thompson et al. [The Reactive Manifesto](https://www.reactivemanifesto.org/). 2014.
9. KEDA docs. [Apache Kafka scaler](https://keda.sh/docs/latest/scalers/apache-kafka/).

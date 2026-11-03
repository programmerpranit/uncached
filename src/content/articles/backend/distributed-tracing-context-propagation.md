---
summary: How distributed tracing records a request as a tree of spans across services, how W3C Trace Context propagates trace IDs over HTTP and message queues, how head and tail sampling control cost, and how OpenTelemetry ties instrumentation, collectors and backends together.
updated: 2026-11-02
---

> [!KEY]
> A **trace** follows one request through every service it touches. It's a tree of **spans**, and each span is one timed operation (an HTTP handler, a DB query, a queue publish) with a name, start time, duration, attributes and a parent.
>
> Tracing only works if every hop **propagates context**. Each service:
> 1. reads the incoming trace ID and parent span ID, usually from the W3C `traceparent` header;
> 2. starts a child span;
> 3. passes the new IDs on to its own outgoing calls and messages.
>
> Because tracing everything is expensive, systems **sample**:
> - **head-based sampling** decides at the root, which is cheap but blind;
> - **tail-based sampling** decides after the trace completes, which keeps errors and slow requests but needs a collector tier.
>
> **OpenTelemetry** is the vendor-neutral standard for all of it.

## The problem: "checkout is slow" across twelve services

A user's checkout takes 4 seconds. The gateway's logs say "200 OK, 4,012 ms". The orders service says it took 3.9 s. Payments, inventory, fraud and the email service each have their own logs, with their own timestamps and no shared ID.

Which call was slow? Was it slow every time or only for some customers? Was the time spent in a queue, in a retry or in a lock?

Metrics tell you **that** p99 latency went up. Logs tell you **what** one service did. Neither tells you **where the time went for this request** across process boundaries. Distributed tracing does. It stitches the work done by every service on behalf of one request into a single timeline.

## How it works

### Traces, spans and the waterfall

![Trace waterfall showing nested spans for a checkout request with the Stripe call taking most of the time](/figures/tracing/waterfall.svg "A trace is a tree of spans sharing one trace ID. The waterfall view shows nesting and timing, so the slow span stands out.")

The data model, standardised by OpenTelemetry and descended from Google's Dapper paper:

- **Trace ID:** 16 random bytes shared by every span in the request.
- **Span ID:** 8 bytes unique to this operation.
- **Parent span ID:** the span that caused this one. This is what builds the tree.
- **Name and kind:** for example `POST /orders` with kind SERVER, or `INSERT orders` with kind CLIENT. Kinds are server, client, producer, consumer and internal.
- **Start and end timestamps.**
- **Attributes:** key/value pairs following **semantic conventions**, such as `http.request.method`, `http.response.status_code`, `db.system`, `messaging.destination.name`. Add your own too, like `tenant.id` or `cart.items`.
- **Events:** timestamped annotations inside a span, such as "retry #2" or an exception with its stack trace.
- **Status:** unset, OK or error.
- **Links:** references to spans in *other* traces. These are used when one consumer batch processes messages from many producers.

The backend (Jaeger, Tempo, Zipkin, Honeycomb, Datadog and so on) groups spans by trace ID and draws the **waterfall**. Gaps between a parent and its children show un-instrumented work or queueing. Sequential children that could have run in parallel show up at a glance.

### Context propagation

![The traceparent header carried from gateway to orders over HTTP and to a worker via a Kafka header](/figures/tracing/propagation.svg "Each hop extracts the incoming context, creates a child span, and injects the new context into outgoing calls.")

The hard part of tracing isn't recording spans. It's making sure **every hop knows which trace it's in**. That has two halves.

**Across processes**, the context travels in metadata. The W3C **Trace Context** standard defines:

- `traceparent: 00-<trace-id>-<parent-span-id>-<flags>`. The flags byte carries the *sampled* bit.
- `tracestate`, for vendor-specific extras.

Older systems used Zipkin's `X-B3-*` headers or vendor headers such as `uber-trace-id`. The OTel SDK lets you configure **propagators** for several formats during a migration. The same fields go into:

- gRPC metadata;
- Kafka record headers;
- SQS/SNS message attributes;
- AMQP properties;
- even job payloads in a task queue.

**Inside a process**, the current span lives in a context object that follows the request:

- a thread-local in classic Java;
- `context.Context` passed explicitly in Go;
- `AsyncLocalStorage` in Node;
- `contextvars` in Python.

Instrumentation libraries extract the incoming context in server middleware and inject it in HTTP and DB client wrappers. So most of the time, adding the OTel agent or SDK plus auto-instrumentation gives you traces with no code changes.

Propagation breaks in predictable places:

- a service in the middle that doesn't forward headers, like an old proxy or a custom HTTP client;
- work handed to a thread pool without copying the context;
- messages published without headers;
- batch consumers, where one span processes 100 messages from 100 traces. Use **span links** here rather than picking one parent.

**Baggage** is a related W3C header. It carries application key/values such as `tenant=acme` downstream so every service can attach them to its spans. Keep it small, and never put secrets in it. It goes to every downstream service, including third parties if you're careless.

### Sampling

![Comparison of head-based and tail-based sampling](/figures/tracing/sampling.svg "Head sampling decides blindly at the root. Tail sampling sees the whole trace before deciding, at the cost of buffering it.")

A busy system generates millions of spans per minute. Storing all of them is usually too expensive, so you keep a subset:

- **Head-based sampling.** The root service decides, for example with a `TraceIdRatioBased(0.05)` sampler, and sets the sampled flag. Downstream services use a `ParentBased` sampler to honour it, so you get whole traces or nothing. It's cheap, but it's random: 95% of your rare errors get thrown away.
- **Tail-based sampling.** Every service exports all spans to a **collector** tier, which buffers each trace for a decision window (say 10–30 s) and then applies policies like "keep if any span errored, keep if duration > 2 s, keep 1% of the rest". You keep exactly the interesting traces. The cost is collector memory, plus routing by trace ID (the OTel load-balancing exporter) so all of a trace's spans reach the same collector instance.
- **Rate-limited or adaptive sampling** caps traces per second per service or endpoint, so a low-traffic endpoint isn't drowned out by a high-traffic one.

Metrics such as request rate, error rate and latency histograms should be computed **before** sampling, from every request. Exemplars then link a metric data point to a sampled trace ID.

### The OpenTelemetry pipeline

A typical production setup looks like this:

1. **Instrument.** The OTel SDK plus auto-instrumentation for HTTP servers and clients, gRPC, DB drivers and messaging libraries. Add manual spans around important business steps.
2. **Export.** Send OTLP over gRPC or HTTP to a local **Collector** agent, either a sidecar or a DaemonSet.
3. **Collector gateway.** Processors for batching, attribute redaction (strip emails and tokens), tail sampling and resource detection (k8s pod, region, version).
4. **Backend.** Jaeger, Grafana Tempo, Zipkin or a commercial APM. Query by trace ID or by attributes, and drill in from logs (which carry the `trace_id`) and from metric exemplars.

The Collector keeps vendor choice out of your services. To switch backends, you change exporter config, not code.

## Where it's used

| System | How tracing shows up |
|---|---|
| Google Dapper | The 2010 paper that defined trace and span trees and low-overhead sampling at Google scale. |
| Twitter Zipkin, Uber Jaeger | Open-source tracers inspired by Dapper. Both now accept OpenTelemetry data. |
| OpenTelemetry | CNCF standard SDKs, semantic conventions, OTLP protocol and Collector. Merged OpenTracing and OpenCensus. |
| Grafana Tempo, Honeycomb, Datadog APM, AWS X-Ray | Trace storage and query backends. X-Ray also supports W3C trace IDs. |
| Service meshes (Istio, Linkerd) | Sidecars emit spans per hop, but apps must still **forward headers** to connect them. |
| Cloud load balancers, CDNs | Inject or forward `traceparent` so edge latency shows up in the trace. |
| Kafka, SQS, RabbitMQ instrumentation | Producer and consumer spans, linked through message headers. |

## Use case walk-through: finding a slow checkout

An e-commerce team gets reports that checkout sometimes takes more than 3 s, while the dashboard p50 is 400 ms.

1. **Instrument.** They add the OTel Java agent and the Node SDK with auto-instrumentation to six services, exporting to a Collector gateway. They add one manual span, `pricing.apply_promotions`, plus `customer.tier` and `cart.size` attributes.
2. **Fix a broken link.** Traces from the gateway stop at the legacy pricing service. It uses a homegrown HTTP client that doesn't forward `traceparent`. They switch it to the instrumented client, and the traces become complete.
3. **Sample the right things.** Head sampling at 5% rarely catches the slow requests. So they set the SDKs to sample 100% and configure the Collector's `tail_sampling` processor: keep errors, keep traces over 1.5 s, keep 2% of the rest. Storage stays roughly flat.
4. **Look at slow traces.** Filtering on `duration > 2s` shows the same shape every time. `pricing.apply_promotions` makes **40 sequential** calls to the promotions service, one per cart item, at about 60 ms each.
5. **Correlate.** Grouping slow traces by attribute shows they're all `cart.size > 25`, mostly B2B customers. The metric average hid them completely.
6. **Fix and verify.** They replace the loop with one batch endpoint. In new traces, that span drops from 2.4 s to 70 ms, and the latency histogram exemplars now link to fast traces.

**Result:** p99 checkout latency falls from 3.4 s to 650 ms. The trace view also becomes the first stop for on-call engineers, because every log line now carries `trace_id`.

## Pitfalls

- **Broken propagation.** One component that drops headers splits every trace in two. Test propagation end to end, and watch the share of "root spans" at services that shouldn't be roots.
- **Context lost across threads and queues.** Executors, callbacks and message consumers need explicit context capture, or the instrumented library versions.
- **High-cardinality span names.** Naming spans `GET /users/81723` instead of `GET /users/{id}` breaks aggregation. Put IDs in attributes.
- **Sensitive data in spans.** SQL statements with literals, request bodies and headers can leak PII or tokens. Redact in the SDK or the Collector.
- **Head sampling hides rare failures.** With 1% sampling, an error affecting 0.1% of requests is almost never captured. Use tail sampling or always sample errors you can detect early.
- **Clock skew.** Spans from different hosts use different clocks, so a child can appear to start before its parent. Backends adjust somewhat, but keep NTP healthy and prefer durations over cross-host timestamp comparison.
- **Too many spans.** A span for every function call adds overhead and clutters the view. Instrument boundaries and meaningful business steps.

> [!TIP]
> Put `trace_id` and `span_id` in every structured log line. Then you can jump from an error log straight to its trace, and from a slow span to the exact logs it produced. That one join is most of the value of "observability".

## Discussion questions

1. Your trace shows a 300 ms gap between the gateway span and the first child span. What could be happening in that gap, and how would you find out?
2. A consumer processes a batch of 50 Kafka messages from 50 different requests. How should its spans relate to the producers' traces?
3. Why is it a bad idea to let each service make its own independent sampling decision?
4. What are the costs of tail-based sampling, and how would you size a Collector gateway for it?
5. Which attributes would you add to spans so a trace answers "which customers are affected"?
6. A third-party API sits in the middle of your call chain and strips unknown headers. How can you still connect the traces on either side?

## FAQ

### What's the difference between tracing, logging and metrics?

**Metrics** are cheap aggregated numbers over time: request rate, error rate, latency percentiles. They tell you something is wrong. **Logs** are detailed events from one process. **Traces** connect work across processes for one request, so they show *where* time and errors occurred. They work best linked together: exemplars from metrics to traces, and `trace_id` in logs.

### Does tracing slow down my service?

A well-implemented SDK adds microseconds per span plus some allocation and export work. Batching exporters keep network cost off the request path. The real costs are in volume: storage, Collector CPU and memory. That's why you sample and avoid span-per-function instrumentation.

### Do I need a service mesh to get tracing?

No. A mesh can emit spans for each network hop, but it can't see inside your process. It also can't connect inbound and outbound requests unless your application **forwards the trace headers**. In-app OpenTelemetry instrumentation gives you DB spans, business spans and correct parenting. A mesh adds network-level detail on top.

### What does the sampled flag in `traceparent` do?

It tells downstream services that the root decided to record this trace. With `ParentBased` samplers, downstream services follow that decision, so traces are complete rather than missing random pieces. It doesn't stop context propagation. Unsampled requests still carry the trace ID, which is useful for log correlation.

### How do I trace through asynchronous jobs and queues?

Inject the context into message headers or job metadata when producing. Extract it when consuming, and start a CONSUMER span. If one message causes one piece of work, make it a child of the producer span. If the consumer batches many messages, start a new trace and add **span links** to each producer context.

## Key takeaways

- A trace is a tree of spans sharing a trace ID. The waterfall shows where a request's time went across services.
- **Propagation is the whole game:** extract, create a child span, inject. Use W3C `traceparent` over HTTP, gRPC and message headers, and a context object in-process.
- Auto-instrumentation covers frameworks and clients. Add manual spans and attributes for business steps.
- Sample deliberately. Head sampling is cheap. Tail sampling keeps errors and slow traces. Compute metrics before sampling.
- Put `trace_id` in logs, redact sensitive attributes, and keep span names low-cardinality.

## References

- [W3C Recommendation: Trace Context](https://www.w3.org/TR/trace-context/)
- [W3C: Baggage](https://www.w3.org/TR/baggage/)
- [OpenTelemetry documentation: Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- [OpenTelemetry documentation: Context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [OpenTelemetry documentation: Sampling](https://opentelemetry.io/docs/concepts/sampling/)
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry Collector: tail sampling processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor)
- [Jaeger documentation: Architecture](https://www.jaegertracing.io/docs/latest/architecture/)
- Benjamin H. Sigelman et al.: *Dapper, a Large-Scale Distributed Systems Tracing Infrastructure* (Google Technical Report, 2010)

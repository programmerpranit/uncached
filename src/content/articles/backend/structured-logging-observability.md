---
summary: Observability is being able to explain behaviour you didn't predict. This covers what metrics, traces and logs are each good for, why logs should be structured events, how to correlate the three, and how to keep cardinality and cost under control.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — **Metrics** tell you *that* something is wrong: they're cheap, aggregated, and what you alert on. **Traces** tell you *where*: the path of one request across services. **Logs** tell you *why*: detailed events with full context. Write logs as **structured events** (key/value fields, usually JSON) rather than prose, attach a **trace ID** to everything so you can jump between the three signals, and instrument once with **OpenTelemetry** so the choice of backend stays a routing decision. The hard part isn't collecting data. It's controlling **cardinality** and cost while keeping the fields you'll need during an incident you can't predict yet.

## The problem: "it's slow for some users" at 2 a.m.

A monolith with one log file can be debugged with `grep`. A system with 40 services, autoscaled pods and async queues can't:

- The failing request touched seven services. Which one was slow?
- The log line says `Payment failed for user 8812`. How many users hit this, on which version, in which region?
- The dashboard shows p99 latency doubled. Is that one tenant, one endpoint, or everyone?

**Monitoring** answers questions you thought of in advance: dashboards and alerts on known failure modes. **Observability** is the ability to answer *new* questions from the telemetry you already emit, without shipping new code. That depends on emitting rich, structured, correlated data.

## How it works

### Three signals, three questions

![Metrics answer whether something is wrong, traces answer where, logs answer why](/figures/observability/pillars.svg "Each signal is efficient for one kind of question")

- **Metrics** are numbers aggregated over time: request counts, error counts, latency histograms, queue depth. They're tiny to store and fast to query, so they're what you **alert** on. Their limit is **cardinality**. Every unique combination of label values is a separate time series. `http_requests_total{route, status}` is fine. Add `user_id` and you've created millions of series and probably taken down your metrics database.
- **Traces** record one request as a tree of **spans** (service, operation, start, duration, attributes) linked by a shared trace ID. They show where the time went and which call failed. They're expensive per request, so they're usually **sampled**.
- **Logs** are discrete events with as much context as you like. High cardinality is fine here: `user_id`, `order_id`, the full error. That's their strength and also their cost.

The **RED method** (Rate, Errors, Duration per service) and **USE method** (Utilisation, Saturation, Errors per resource) are useful starting points for which metrics to emit. **SLOs** built on those metrics decide when to page someone.

### Structured logs

![An unstructured log sentence compared with a structured JSON event with named fields](/figures/observability/structured.svg "Fields make logs queryable; the trace_id makes them joinable")

An unstructured line like `ERROR Payment failed for user 8812 after 3 retries` has to be parsed with regexes, and those break the moment someone rewords the message. A **structured** log is an event with named fields:

- **Fixed fields** on every line: timestamp, level, service, version, environment, host or pod, `trace_id`, `span_id`.
- **Event fields**: what happened (`msg` as a stable event name), and identifiers such as `user_id`, `order_id` and `tenant_id`.
- **Outcome fields**: `duration_ms`, `status`, `error.type`, `retries`.

That lets you run `level=error AND reason=card_declined | count by version`, and spotting a bad deploy takes one query.

Good practices:

- **Stable message keys.** `msg: "payment failed"` stays the same; the variable parts go in fields.
- **Context propagation.** Add request-scoped fields (`trace_id`, `user_id`, `tenant_id`) once in middleware, through a logger bound to the request context, so every line carries them automatically.
- **Consistent naming.** OpenTelemetry's *semantic conventions* (`http.request.method`, `http.response.status_code`, `db.system`) mean dashboards work across services and languages.
- **Levels with meaning.** ERROR means someone may need to act. WARN means degraded but handled. INFO marks business events. DEBUG is off in production, or enabled dynamically for one tenant.
- **Wide events.** Some teams (Honeycomb's approach, and Stripe's "canonical log lines") emit **one rich event per request per service** with dozens of fields, instead of many small lines. Analytics over those events can answer most questions, and many metrics can be derived from them.

### Correlation: jumping between signals

The power comes from linking the signals:

1. An **alert** fires: checkout p99 latency SLO is burning.
2. The latency histogram has **exemplars**, sample trace IDs attached to specific buckets. Click one in the slow bucket.
3. The **trace** shows 780 ms spent in `payment-service → fraud-api`.
4. Filter **logs** by that `trace_id` and you find `fraud-api` timeouts, each with `retry=3` and `region=eu-west-1`.
5. Group logs by `region` and `version` and you see it's only the newly deployed pods in one region.

Without a shared trace ID, each of those steps becomes a guess based on timestamps.

### The telemetry pipeline

![Service emits via OpenTelemetry SDK to a collector that batches, redacts, samples and routes to metric, trace and log stores](/figures/observability/pipeline.svg "The collector is where vendor-independence and cost control live")

**OpenTelemetry (OTel)**, a CNCF project, standardises the APIs, SDKs, wire protocol (OTLP) and semantic conventions for all three signals. A typical setup:

- **SDK in each service**, with auto-instrumentation for HTTP, gRPC, database and queue libraries, plus manual spans and attributes for business logic.
- **Collector** as an agent (DaemonSet) and/or a gateway. It batches and retries, adds Kubernetes metadata, **redacts PII**, drops noisy attributes, and does **tail-based sampling**: it keeps 100% of error and slow traces and 1% of the rest, deciding once the trace is complete.
- **Backends**, which you can swap independently: Prometheus or Mimir for metrics, Tempo or Jaeger for traces, Loki, Elasticsearch or ClickHouse for logs, or a commercial platform (Datadog, Honeycomb, Grafana Cloud, New Relic) for everything.

### Cost and cardinality

Observability bills grow faster than traffic if nobody owns them. The main levers:

- **Sample traces** with tail sampling so you keep the interesting ones.
- **Keep labels bounded** in metrics: no user IDs, raw URLs or error messages as labels. Put those in logs or trace attributes.
- **Log less at higher value.** One wide event per request beats 30 chatty debug lines.
- **Tiered retention**: hot storage for days, cheap object storage for weeks, aggregates for months.
- **Drop at the collector**, before data is ingested and billed.

## Where it's used

| Practice / tool | Context |
|---|---|
| **Google SRE book** | Popularised SLOs, error budgets and the "four golden signals" (latency, traffic, errors, saturation) |
| **Dapper (Google)** | The 2010 paper that inspired Zipkin, Jaeger and OpenTelemetry tracing |
| **Stripe canonical log lines** | One wide structured line per request, summarising everything that happened |
| **Honeycomb** | Built around high-cardinality wide events and exploratory queries |
| **Prometheus + Grafana** | De facto open-source metrics and dashboards on Kubernetes |
| **OpenTelemetry** | CNCF standard for instrumentation; supported by every major vendor |

## Use case walk-through: a latency regression after deploy

A food-delivery API sees p99 on `POST /orders` rise from 400 ms to 1.4 s, 20 minutes after a deploy.

1. **Alert.** The SLO burn-rate alert fires on the `http.server.duration` histogram for `route="/orders"`. That's a metric, cheap and reliable.
2. **Scope with metric labels.** Breaking down by `version` shows only `v212` pods are slow, so this isn't a traffic spike.
3. **Exemplar → trace.** A trace from the slow bucket shows `order-service` calling `menu-service` 14 times in a row, a new N+1 pattern.
4. **Trace → logs.** Filtering logs by that `trace_id` shows `menu-service` events with `cache: "miss"` on every call. The v212 change altered the cache key format.
5. **Confirm the blast radius.** A log query, `msg="menu lookup" AND cache="miss" | count by version`, confirms it: misses are about 95% on v212 and about 3% on v211.
6. **Mitigate and fix.** Roll back to v211 and p99 recovers within minutes. The fix restores the key format and batches the menu lookups.

**Result:** From alert to root cause in about 15 minutes, without adding a single log line or redeploying to investigate. That's the observability test: the data you needed was already being emitted.

## Pitfalls

- **High-cardinality metric labels.** `user_id`, `request_path` with IDs in it, or error messages as labels can explode series counts and costs. Normalise routes (`/orders/{id}`) and keep identifiers in logs and traces.
- **Logging secrets and PII.** Tokens, passwords, card numbers and full request bodies end up in logs that are widely accessible and kept for a long time. Use allow-listed fields and redaction at the SDK and the collector.
- **No trace context in logs.** Without `trace_id` on every line, correlation falls back to matching timestamps.
- **Head-based sampling only.** Deciding at the start of a request to keep 1% throws away 99% of the rare errors you care about. Tail-sample, or always keep errors.
- **Alerting on causes instead of symptoms.** Paging on CPU > 80% wakes people for things users never notice. Alert on SLO burn (user-visible symptoms) and keep cause metrics for diagnosis.
- **Synchronous log shipping.** A blocking log call to a remote endpoint makes your log pipeline part of your request latency. Write to stdout or a local buffer and ship asynchronously.

> [!TIP]
> Before adding a log line, ask: *"Which question will this answer during an incident?"* If none, skip it. If it answers one, make it a structured field on the request's main event rather than a new line.

## Discussion questions

1. Why is `user_id` a great log field and a terrible metric label? What would you do if you really needed per-customer latency?
2. Head-based vs tail-based sampling: what infrastructure does tail sampling need, and what can go wrong with it under load?
3. Your log bill doubled in a month. How would you find out which services and which fields are responsible?
4. Should business events (order placed, refund issued) go through the logging pipeline, an analytics pipeline, or both? What are the trade-offs?
5. How do you propagate trace context through a Kafka queue, where producer and consumer run at different times?
6. What would you need to see on a dashboard to decide within five minutes of a deploy whether to roll it back?

## FAQ

### Do I really need all three signals?

For anything beyond a small service, yes. Metrics alone tell you something is wrong but not why. Logs alone are too expensive to alert on and hard to aggregate quickly. Traces alone are sampled and lack business detail. They're complementary views of the same events. Some wide-event approaches derive metrics from events, but they still need the same three capabilities.

### JSON logs are harder to read in a terminal. Isn't that a step backwards?

Use a pretty-printer locally (most logging libraries have a dev mode, or pipe through `jq`). In production, nobody reads raw log lines at scale. They query them, and querying is where structure pays off.

### What's the difference between monitoring and observability?

Monitoring checks known failure modes against predefined dashboards and alerts. Observability is the property of a system that lets you investigate *unknown* failure modes from existing telemetry. You need both. Monitoring tells you to look, and observability lets you find the answer.

### How much should I log?

Enough that one request's journey can be reconstructed. That usually means one rich event per request per service, plus warnings and errors with context. Avoid logging inside tight loops, avoid per-line DEBUG in production, and make verbosity adjustable at runtime per tenant or per request for deep investigations.

### Is OpenTelemetry production-ready for logs too?

Traces and metrics have been stable for years. The logs signal is stable too, and the common pattern is to keep your existing logging library and use an OTel bridge or appender that adds trace context and exports over OTLP. Check the current status of your language's SDK, because maturity varies by language.

## Key takeaways

- Metrics are for **alerting**, traces for **locating**, logs for **explaining**. Use all three.
- Log **structured events** with stable keys and consistent field names, not sentences.
- Put **`trace_id` everywhere** and attach exemplars, so you can move from alert to trace to logs in clicks.
- Instrument with **OpenTelemetry** and route through a **collector** for sampling, redaction and vendor freedom.
- **Cardinality and cost** are design concerns: bounded metric labels, tail sampling, wide events, tiered retention.

## References

- [OpenTelemetry documentation](https://opentelemetry.io/docs/), CNCF
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
- Betsy Beyer et al., [*Site Reliability Engineering*](https://sre.google/sre-book/table-of-contents/), O'Reilly / Google, 2016, Chapter 6 "Monitoring Distributed Systems"
- Benjamin H. Sigelman et al., "Dapper, a Large-Scale Distributed Systems Tracing Infrastructure", Google Technical Report, 2010
- Charity Majors, Liz Fong-Jones and George Miranda, *Observability Engineering*, O'Reilly, 2022
- Brandur Leach, "Canonical Log Lines", Stripe Engineering Blog, 2019
- [Prometheus documentation: naming and label best practices](https://prometheus.io/docs/practices/naming/)

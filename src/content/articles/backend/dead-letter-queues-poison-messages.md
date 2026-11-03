---
summary: A dead-letter queue gives messages that keep failing a place to go, so one bad message can't block a queue forever or quietly disappear.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — A **poison message** is one that will never be processed successfully, however often it's retried: a malformed payload, a schema the consumer doesn't understand, a reference to data that doesn't exist, or input that triggers a bug. Without a limit it is retried forever, blocking ordered partitions and burning capacity; without a safety net it gets dropped silently. A **dead-letter queue (DLQ)** solves both: after a bounded number of attempts (with backoff), the message moves to a separate queue together with the reason it failed. There it raises an **alert**, waits for someone to **inspect** it, and is **redriven** once the problem is fixed.

## The problem: messages that can never succeed

Queues and logs promise at-least-once delivery: if a consumer doesn't acknowledge a message, it is delivered again. That's exactly right for **transient** failures — a database timeout, a throttled API, a deploy in progress. Try again shortly and it works.

It goes wrong for **permanent** failures:

- **Infinite retries.** The consumer throws, the message returns, the consumer throws again. Each cycle wastes CPU, log volume and downstream calls.
- **Head-of-line blocking.** In ordered systems — a Kafka partition, an SQS FIFO message group, a single-consumer queue — the stuck message holds back everything behind it. Consumer lag grows, and so does the impact.
- **Retry storms.** If thousands of messages hit the same bug, retries can overwhelm the downstream dependency the consumer calls.
- **Silent loss.** The opposite mistake: catching every exception and acknowledging anyway, or setting a short retention, so failed messages vanish with nothing but a log line.

You need a policy that gives real failures enough retries to recover and moves hopeless ones out of the way without losing them.

## How it works

### Bounded retries, then dead-letter

The core mechanism is a counter. Each delivery attempt increments it; when it passes a threshold, the message is moved to the DLQ instead of being delivered again.

![A consumer receives from the main queue, retries failures with backoff, and after the maximum receive count the message moves to a dead-letter queue that triggers an alert and can be redriven](/figures/dead-letter-queues/flow.svg "Retries absorb transient failures; the DLQ catches the rest, and redrive brings them back once fixed.")

How brokers implement it:

- **Amazon SQS.** A *redrive policy* on the source queue names a DLQ and a `maxReceiveCount`. Each time a message is received and not deleted before its visibility timeout, its receive count rises; past the limit, SQS moves it to the DLQ. SQS also supports *redrive* back to the source queue from the console or API.
- **RabbitMQ.** A queue's `x-dead-letter-exchange` argument routes messages that are rejected (`nack` without requeue), expire (TTL) or overflow a length limit. Quorum queues add a `delivery-limit`. Headers such as `x-death` record why and how often.
- **Azure Service Bus.** Every queue and subscription has a built-in dead-letter subqueue; `MaxDeliveryCount` (default 10) triggers it, and consumers can dead-letter explicitly with a reason and description.
- **Google Pub/Sub.** A dead-letter topic plus `max_delivery_attempts` (5–100) on the subscription.
- **Kafka.** There's no built-in DLQ — the log just holds records and consumers track offsets. Consumers (or frameworks like Spring Kafka and Kafka Connect's `errors.tolerance` with a DLQ topic) catch failures, publish the record to a `*-retry` or `*-dlt` topic with error headers, and commit the offset so the partition keeps moving.

### Poison messages and head-of-line blocking

Ordering is what turns one bad message into an outage.

![With no retry limit, poison message m3 blocks m4 to m6; with max attempts and a DLQ, m3 moves aside and the rest are processed](/figures/dead-letter-queues/poison.svg "In an ordered queue, the cost of a poison message is everything behind it.")

In an unordered queue with many consumers, a poison message mostly wastes capacity. In an ordered partition, the consumer can't move past it, so every subsequent message for that partition waits. Dead-lettering is what unblocks the partition — at the cost of processing that message out of order.

That cost matters. If m3 is "create account" and m4 is "update account", skipping m3 means m4 will fail too. Options include:

- Dead-letter **all later messages with the same key** until the poison one is resolved (some systems "park" a key).
- Make consumers tolerant of missing predecessors, e.g. by treating updates as upserts.
- Accept that a blocked key is better than corrupted state, and alert fast.

### Classify the failure before retrying

Not every exception deserves the same treatment. Retrying a validation error five times only delays the inevitable, and dead-lettering a timeout immediately sends recoverable work to humans.

![Failures are classified as transient (retry with backoff), permanent (dead-letter immediately) or expected no-ops (acknowledge and log)](/figures/dead-letter-queues/triage.svg "Retry what might succeed later; dead-letter what never will; acknowledge duplicates.")

- **Transient** — timeouts, connection resets, HTTP 429/503, lock contention. Retry with **exponential backoff and jitter**. Where the broker can't delay redelivery, use retry topics or queues with increasing delays (`orders-retry-1m`, `orders-retry-10m`) before the final DLQ.
- **Permanent** — deserialization errors, schema mismatches, failed validation, HTTP 4xx from a dependency. Dead-letter **immediately**; more attempts change nothing.
- **Expected no-ops** — duplicates, already-applied updates. Acknowledge and log. This requires **idempotent consumers**, which you need for at-least-once delivery anyway.

### What goes into the DLQ

A dead-lettered message is a bug report. Make it a good one:

- The **original payload and headers**, unchanged — don't re-serialize it.
- **Error class and message**, and a trace or correlation ID that links to logs.
- **Attempt count**, first and last failure time, the consumer version, and the **source queue/topic, partition and offset**.

Most brokers add some of this automatically (SQS receive count, RabbitMQ `x-death`, Service Bus `DeadLetterReason`); Kafka dead-letter topics need you to add headers yourself.

### Operating the DLQ

A DLQ that nobody watches is just slow data loss. Treat it as an operational surface:

- **Alert** on DLQ depth > 0 or on the rate of new entries, routed to the owning team.
- **Retain** messages long enough to fix and redrive (SQS allows up to 14 days; set the DLQ's retention longer than the source's, because SQS keeps the original enqueue timestamp).
- **Inspect** with tooling that shows payloads and errors and groups them by error type.
- **Redrive** after deploying a fix — ideally in throttled batches, and only after confirming the consumer is idempotent.
- **Discard deliberately**: for messages that are truly invalid, record the decision rather than letting them expire silently.

## Where it's used

| Setting | Example |
|---|---|
| Order and payment pipelines | SQS or Service Bus DLQs catching malformed orders for manual review |
| Event streaming | Kafka retry topics and dead-letter topics in Spring Kafka or Kafka Connect |
| Serverless | AWS Lambda async invocation failure destinations and SQS event source DLQs |
| Webhook delivery | Failed outbound webhooks parked after N attempts, with a "resend" button |
| Data ingestion | Rows that fail schema validation diverted to an error table or topic |
| Email and notifications | Undeliverable messages parked instead of retried forever |

## Use case walk-through: an order-events consumer

A fulfillment service consumes `order-placed` events from Kafka. One morning, consumer lag on partition 7 climbs steadily while the other partitions are fine.

1. **Find the poison message.** Logs show the same offset failing every few seconds: a new client sent `quantity: "two"`, and deserialization throws. Every retry fails, and partition 7 is stuck.
2. **Add classification.** The team wraps processing: deserialization and validation errors are permanent; database timeouts and 503s from the inventory API are transient.
3. **Retry transient errors with backoff.** Transient failures go to `order-placed-retry-30s` and then `order-placed-retry-5m` topics, each consumed after its delay; the main partition's offset is committed so it keeps moving.
4. **Dead-letter permanent ones.** Permanent failures — and anything that fails its last retry — go to `order-placed-dlt` with headers for error type, message, source partition and offset, and service version.
5. **Alert and inspect.** An alert fires when the DLT receives anything. A small tool lists dead-lettered records grouped by error type.
6. **Fix and redrive.** The producer team fixes the client; the fulfillment team adds tolerant parsing for the bad batch, then replays the DLT records into the main topic at a throttled rate. The consumer is idempotent on `orderId`, so replays are safe.

**Result:** a single bad message now costs one entry in a DLT and one alert, instead of hours of lag on a partition, and no orders are lost.

## Pitfalls

- **No DLQ at all.** Messages retry forever, or a catch-all handler acknowledges them and they disappear.
- **A DLQ nobody watches.** Messages expire from the DLQ after its retention, which is silent data loss with extra steps.
- **Retrying permanent errors.** Ten attempts at a schema error just delay the alert and waste capacity.
- **No backoff.** Immediate redelivery turns a downstream blip into a retry storm.
- **Losing context.** Dead-lettered messages without the error, attempt count or source offset are hard to debug and harder to redrive.
- **Unsafe redrive.** Replaying thousands of messages at full speed into a non-idempotent consumer creates duplicates and a second incident.
- **Ignoring ordering.** Skipping one message for a key can make all later messages for that key fail or corrupt state.
- **Visibility timeout too short.** In SQS, slow-but-successful processing can exceed the timeout, so healthy messages get redelivered and eventually dead-lettered.

> [!TIP]
> Make "DLQ depth > 0" a page-worthy or at least ticket-worthy alert for the team that owns the consumer, and include a runbook link that explains how to inspect and redrive. The DLQ only protects data if a human sees it.

## Discussion questions

1. Which errors in your consumers are transient and which are permanent? How does the code tell them apart today?
2. How many attempts and what backoff schedule fit your workload's latency requirements?
3. In an ordered stream, should a poison message block its key, be skipped, or park all later messages for that key?
4. Who owns a DLQ — the producing team, the consuming team, or a platform team?
5. What tooling would make inspecting and redriving dead-lettered messages safe for an on-call engineer at 3 a.m.?
6. When is it acceptable to discard a dead-lettered message, and how should that decision be recorded?

## FAQ

### How many retries should I allow before dead-lettering?

Enough to ride out typical transient incidents, which depends more on the retry *schedule* than the count. Three to five attempts spread over minutes is common for queue consumers; longer-running integrations (webhooks) often retry over hours. Permanent errors should skip retries entirely.

### Is a DLQ the same as a retry queue?

No. A retry queue (or topic) holds messages that will be retried automatically after a delay. A DLQ holds messages that automation has given up on and that need a human or a fix before they're processed again.

### Should I put dead-lettered messages back automatically?

Usually not blindly. Automatic redrive of a permanent failure just recreates the loop. Redrive after a fix is deployed, or automate it only for failure categories you know are transient (for example, a dependency that was down).

### Does Kafka have dead-letter queues?

Not in the broker. Kafka retains records regardless of processing; the consumer decides what to do on failure. Frameworks such as Spring Kafka (`DeadLetterPublishingRecoverer`, retry topics) and Kafka Connect (`errors.deadletterqueue.topic.name`) implement the pattern with extra topics.

### What about messages that fail because of a bug in my code?

That's the most common poison message. The DLQ buys time: fix the bug, deploy, then redrive. Because the original payloads are preserved, nothing is lost while you work on it.

## Key takeaways

- A **poison message** never succeeds; without limits it blocks ordered queues and wastes capacity.
- Use **bounded retries with backoff**, then move the message to a **dead-letter queue**.
- **Classify** errors: retry transient ones, dead-letter permanent ones immediately, acknowledge duplicates.
- Store **payload plus failure context** with each dead-lettered message.
- **Alert, inspect, fix and redrive** — and make consumers idempotent so redrive is safe.

## References

- [Amazon SQS — Using dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [RabbitMQ — Dead Letter Exchanges](https://www.rabbitmq.com/docs/dlx)
- [Azure Service Bus — Dead-letter queues](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues)
- [Google Cloud Pub/Sub — Handle message failures](https://cloud.google.com/pubsub/docs/handling-failures)
- [Enterprise Integration Patterns — Dead Letter Channel](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html)
- Gregor Hohpe and Bobby Woolf, *Enterprise Integration Patterns*, Addison-Wesley, 2003.
- Spring for Apache Kafka reference documentation, "Non-Blocking Retries" and "Publishing Dead-letter Records."
- Uber Engineering, "Building Reliable Reprocessing and Dead Letter Queues with Apache Kafka," 2018.

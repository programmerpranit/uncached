---
summary: RabbitMQ and Kafka both move messages between services, but one deletes messages once they're handled and the other keeps them as a replayable log. How that choice shapes ordering, scaling, replay and failure handling.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **message queue** (RabbitMQ, SQS, ActiveMQ) hands each message to **one** of several competing consumers, waits for an **ack**, then **deletes** it. It's built for distributing **tasks**: flexible routing, per-message retries and delays, and a slow message only holds up itself. An **event log** (Kafka, Kinesis, Pulsar, Redpanda) **appends** messages to partitioned, **retained** logs. Consumers track their own **offset**, so many independent groups read the same data, and any of them can **rewind and replay**. Logs give **strict order per partition** and very high throughput, but parallelism is capped by the number of partitions, and one slow message blocks its whole partition. Use a queue for **work to be done**, a log for **facts that happened**.

## The problem: decoupling services

Services talk asynchronously so that a producer doesn't wait for a consumer, so bursts are absorbed, and so a consumer outage doesn't lose data. Two very different designs grew up for this:

- **Message queues** come from enterprise messaging (JMS, AMQP, IBM MQ): a broker that **routes and delivers** messages and tracks which have been handled.
- **Event logs** come from database replication logs and LinkedIn's need to move huge volumes of activity data: Kafka (2011) treats messaging as an **append-only, replicated log** that consumers read like a file.

They look alike from a distance (producers, brokers, consumers, topics) but make opposite choices about what happens after a message is read.

## Message queues

![A producer sends messages to a queue; three consumers take messages from it; acked messages are deleted and unacked ones are redelivered.](/figures/queues-logs/queue.svg "The broker tracks every message's state. Once acked, it's gone.")

1. Producers publish messages (in RabbitMQ, to an **exchange** that routes them to queues by rules).
2. The broker delivers each message to **one consumer** among those subscribed to the queue. More consumers = more parallel work (**competing consumers**).
3. The consumer processes it and sends an **ack**. The broker **deletes** the message.
4. If the consumer crashes or doesn't ack within a timeout (SQS's **visibility timeout**), the message is **redelivered** to someone else.
5. After N failed attempts, it's moved to a **dead-letter queue (DLQ)** for inspection.

Strengths:

- **Per-message control:** individual acks, retries, delays, priorities, TTLs.
- **Flexible routing:** RabbitMQ's direct, topic, fanout and header exchanges route by key patterns or headers.
- **Elastic consumers:** add consumers any time to work through a backlog. There's no partition limit.
- **Isolation of slow messages:** a message that takes 10 minutes ties up one consumer, not everything behind it.

Weaknesses:

- **No replay:** once acked, a message is gone. A new service can't read last week's messages.
- **Weak ordering:** with several consumers, redeliveries and prefetching, messages are processed out of order. (SQS FIFO queues and RabbitMQ single-active-consumer exist, at the cost of parallelism.)
- **Broker state per message** limits throughput compared with sequential log appends, especially with large backlogs.

## Event logs

![A producer appends to a partition with offsets 0–9; three consumer groups (billing, search-indexer, analytics) read at different offsets.](/figures/queues-logs/log.svg "Nothing is deleted by reading. Each group just remembers where it is.")

1. Producers **append** records to a **topic**, which is split into **partitions**. Each partition is an ordered, immutable sequence, and each record gets an **offset**.
2. Records are **retained** by time or size (7 days, 1 TB, or forever), or **compacted** to keep the latest value per key, regardless of whether anyone has read them.
3. Each **consumer group** reads partitions sequentially and **commits its offset**. Different groups are completely independent.
4. Within a group, each partition is assigned to **exactly one consumer**, which gives in-order processing per partition.
5. A group can **reset its offset** to replay from any point: after a bug fix, to backfill a new system, or to rebuild a cache.

Strengths:

- **Replay and multiple readers:** the same stream feeds billing, search indexing, analytics and a data lake, each at its own pace. New consumers can start from the beginning.
- **Strict order per partition**, which matters for things like state changes to one entity.
- **High throughput:** sequential disk writes, batching, zero-copy reads. Kafka clusters handle millions of messages per second.
- **Durable history:** the log can be the system of record (event sourcing, change data capture).

Weaknesses:

- **Parallelism ≤ partitions** per group. To go from 12 to 48 consumers, you need 48 partitions, and repartitioning changes which partition each key maps to.
- **Head-of-line blocking:** a message that fails or is slow blocks all messages behind it in its partition. There's no per-message ack.
- **Retries are your problem:** the usual pattern is to publish failed messages to a separate retry topic and DLQ topic.
- **Coarser routing:** consumers subscribe to whole topics. Filtering happens in the consumer.

## Ordering and parallelism

![A producer hashes order IDs to three partitions; each partition is consumed by one consumer.](/figures/queues-logs/partitions.svg "The partition key decides both what's ordered and how the work is split.")

In a log, you choose a **partition key**, and everything with the same key stays in order:

- Key by `order_id`: all events for one order are processed in sequence, and different orders are processed in parallel.
- Key by `customer_id`: per-customer order, but a customer with huge volume makes one partition hot.
- No key: round-robin across partitions, maximum spread, no ordering.

Queues usually give up ordering for flexibility. Where ordering matters, they use **message groups** (SQS FIFO `MessageGroupId`, ActiveMQ message groups) or a single active consumer, which looks a lot like partitioning.

## Side by side

![A table comparing queue and log on what happens after consumption, consumer model, replay, ordering, routing, slow messages and scale unit.](/figures/queues-logs/compare.svg "Opposite defaults, though each has grown features of the other.")

| Aspect | Message queue | Event log |
| --- | --- | --- |
| Mental model | A to-do list of **tasks** | A journal of **facts** |
| After a message is read | Deleted (after ack) | Kept until retention expires |
| Multiple subscribers | Copy into one queue per subscriber (fanout exchange, SNS → SQS) | Natural: one group per subscriber |
| Delivery tracking | Per message, by the broker | One offset per partition, by the consumer |
| Replay | No | Yes |
| Failure of one message | Retry it alone, then DLQ | Blocks the partition unless moved to a retry topic |
| Delays, priorities, TTLs | Built in | Not really |
| Typical throughput | Tens of thousands of msgs/s per node | Hundreds of thousands to millions per node |

## The lines are blurring

- **RabbitMQ Streams** (3.9+) adds an append-only, replayable log type to RabbitMQ.
- **Kafka share groups** (KIP-932, "queues for Kafka", early access in Kafka 4.0) let several consumers share a partition with **per-record acknowledgement**, giving queue semantics on a log.
- **Apache Pulsar** offers both models over one storage layer: exclusive, failover, shared and key-shared subscriptions.
- **Amazon SQS FIFO** and **Azure Service Bus sessions** add ordering by group to queues.
- **NATS JetStream** and **Redis Streams** provide log-like storage with consumer groups and per-message acks.

So the practical question is less "which product" and more "**which semantics** does this flow need".

## Where it's used

| Use case | Better fit | Why |
| --- | --- | --- |
| Background jobs (send email, resize images, generate PDFs) | Queue | Independent tasks, per-task retries and delays, elastic workers |
| Order lifecycle events consumed by many services | Log | Many independent readers, per-order ordering, replay |
| Change data capture (Debezium) | Log | Ordered per row, replayable, feeds many sinks |
| Clickstream, metrics, logs at high volume | Log | Throughput, batching, retention for reprocessing |
| RPC-style request/reply between services | Queue | Reply queues, correlation IDs, TTLs |
| Event sourcing | Log | The log is the source of truth |
| Task distribution with priorities | Queue | Priorities and routing built in |

### Use case walk-through: an e-commerce order pipeline

1. The Order service writes `OrderPlaced`, `OrderPaid` and `OrderShipped` to a Kafka topic keyed by `order_id` (using the transactional outbox).
2. Billing, inventory, search indexing and the data warehouse each consume the topic in their **own group**, at their own pace.
3. The Notification service consumes `OrderShipped` and enqueues **tasks** into a RabbitMQ queue: "send email to X", "send push to Y". Workers process these with per-task retries, delays for quiet hours, and a DLQ.
4. When the search team fixes an indexing bug, they reset their group's offset by 3 days and **replay**. No other service notices.
5. The two systems complement each other: the **log carries facts**, the **queue carries jobs** derived from them.

## Pitfalls

- **Using Kafka as a job queue.** One poison message blocks a partition, and scaling workers beyond the partition count does nothing. Use retry topics, or a real queue for task-style work.
- **Using a queue as an event bus.** With many subscribers, you need a queue per subscriber, new subscribers can't see history, and ordering is lost.
- **Too few partitions.** You can't easily increase them later without changing key-to-partition mapping. Plan for future consumer parallelism.
- **Hot partitions** from skewed keys (one giant customer).
- **Committing offsets before processing**, which loses messages on a crash, or **after side effects without idempotency**, which duplicates them. Both models are **at-least-once** in practice. Make consumers idempotent.
- **Unbounded queue growth.** Queues are meant to be near-empty. A queue with millions of messages is a symptom (consumers too slow) and often hurts broker performance.

> [!WARNING]
> "Exactly-once" in Kafka means exactly-once **within Kafka** (read from a topic, write to a topic, commit offsets atomically using transactions). Side effects in external systems (a database write, an email) still need **idempotency**.

## Discussion questions

1. You need to send 10 million push notifications with retries and rate limits. Queue or log, and why?
2. Five teams want to react to `UserSignedUp` events, and two more will join next quarter. Queue or log?
3. How would you handle a message that always fails in a Kafka consumer without blocking its partition?
4. What partition key would you choose for payment events, and what are the risks?
5. Why can't you scale a Kafka consumer group beyond the number of partitions?
6. When would you use both a log and a queue in the same flow?

## FAQ

### Is Kafka a message queue?

Not in the classic sense. Kafka is a distributed, partitioned, replicated **log**. It can be used for messaging, but its model (retained records, consumer-managed offsets, per-partition ordering) differs from a queue's (per-message delivery and deletion). Share groups in recent Kafka versions add queue-like consumption.

### Can RabbitMQ replay messages?

Classic queues can't: acked messages are deleted. **RabbitMQ Streams** add a replayable, append-only log type, and you can always design flows that copy messages into an archive.

### Which is faster?

Logs generally reach much higher throughput because they write sequentially, batch heavily and don't track per-message state. Queues often have lower latency per message at modest volumes and do more work per message (routing, acks, redelivery). For most applications both are fast enough, and semantics should decide.

### How do retries work in Kafka?

A common pattern: on failure, publish the message to a `retry-1m` topic, consumed by a consumer that waits a minute before reprocessing, then `retry-10m`, then a DLQ topic. Commit the original offset so the main partition keeps moving. Ordering for that key is lost unless you also park later messages for the same key.

### What's a dead-letter queue?

A place for messages that failed processing too many times, so they stop blocking or looping. Someone (or an automated process) inspects, fixes and replays them. Every queue-based or log-based pipeline should have one, with alerts on its size.

### What about SNS, EventBridge, Pub/Sub?

They're **pub/sub** services: one message delivered to many subscribers, usually with limited or no long-term retention. Amazon SNS fanning out to SQS queues is a common way to get "many subscribers + queue semantics". Google Pub/Sub has retention and seek-to-timestamp replay, so it sits between the two models.

## Key takeaways

- **Queues** distribute **tasks**: delete on ack, competing consumers, per-message retries and routing, no replay.
- **Logs** record **facts**: retained, ordered per partition, many independent consumer groups, replayable.
- Logs scale parallelism by **partitions** and suffer **head-of-line blocking**. Queues scale by **consumers** and lose **ordering**.
- Pick by semantics: work to be done → queue, things that happened → log. Many systems use both.
- Both are **at-least-once** end to end. Consumers must be **idempotent**.

## References

1. J. Kreps. [The Log: What every software engineer should know about real-time data's unifying abstraction](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying). LinkedIn Engineering, 2013.
2. J. Kreps, N. Narkhede, J. Rao. [Kafka: a Distributed Messaging System for Log Processing](https://notes.stephenholiday.com/Kafka.pdf). *NetDB 2011*.
3. Apache Kafka. [Documentation: Design](https://kafka.apache.org/documentation/#design).
4. RabbitMQ. [AMQP 0-9-1 Model Explained](https://www.rabbitmq.com/tutorials/amqp-concepts) and [Streams](https://www.rabbitmq.com/docs/streams).
5. Apache Kafka. [KIP-932: Queues for Kafka](https://cwiki.apache.org/confluence/display/KAFKA/KIP-932%3A+Queues+for+Kafka).
6. AWS. [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) and [FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html).
7. M. Kleppmann. *Designing Data-Intensive Applications*, chapter 11: Stream Processing ("Partitioned Logs"). O'Reilly, 2017.
8. Uber Engineering. [Building Reliable Reprocessing and Dead Letter Queues with Apache Kafka](https://www.uber.com/blog/reliable-reprocessing/). 2018.
9. Apache Pulsar. [Messaging: subscription types](https://pulsar.apache.org/docs/next/concepts-messaging/#subscription-types).

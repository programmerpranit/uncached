---
summary: Why writing to a database and publishing to a message broker as two separate steps loses or invents events, how the transactional outbox makes the event commit atomically with the data, how polling and CDC relays deliver it at-least-once, and how idempotent consumers, ordering and cleanup make the pattern work in production.
updated: 2026-11-02
---

> [!KEY]
> When a service changes its database **and** needs to tell other services about it, two separate writes (DB, then broker) can't be made atomic. A crash between them silently loses the event, or announces a change that never committed. The **transactional outbox** fixes this:
> - in the **same local transaction** as the business change, insert a row describing the event into an `outbox` table,
> - a separate **relay** reads new outbox rows (by polling or by tailing the database log with **CDC**), publishes them to the broker, and marks them done.
>
> The event exists if and only if the data change committed. Delivery is **at-least-once**, so consumers must **deduplicate on event id**.

## The problem: the dual write

An order service handles `POST /orders`. It must save the order and publish `OrderPlaced` so shipping, email and analytics can react. The obvious code does two things in a row:

1. `INSERT INTO orders …` and commit.
2. `producer.send("orders", OrderPlaced{…})`.

Each line is correct on its own. Together they're a **dual write**: two independent systems, no shared transaction, and the process can die between them.

![Dual-write failure modes](/figures/outbox/dual-write.svg "Every ordering of two independent writes has a crash window that leaves them disagreeing")

- **Commit, then publish.** If the process crashes, is redeployed or the broker is briefly down after the commit, the order exists but no event goes out. Shipping never ships. Nothing errors, because the request already returned 201.
- **Publish, then commit.** The event goes out, then the commit fails (constraint violation, deadlock, failover). Downstream services act on an order that doesn't exist.
- **Publish inside the open transaction.** This is still not atomic: the broker accepted the message, and the commit can still fail. You've also held row locks across a network call, which hurts throughput.

Retrying doesn't save you. After a timeout you can't tell whether the broker got the message, and after a crash there's nobody left to retry. Distributed transactions (XA / two-phase commit) across the database and the broker could make it atomic, but most brokers (Kafka, SQS, SNS, most managed services) don't support XA, and where they do it's slow and operationally fragile.

The outbox takes a different route: **make it one write**, then propagate that write reliably.

## How it works

### One transaction, two rows

The service writes the business change and a description of the event into the **same database, in the same transaction**:

```sql
BEGIN;
INSERT INTO orders (id, customer_id, total) VALUES (42, 7, 99.00);
INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
VALUES (gen_random_uuid(), 'order', '42', 'OrderPlaced', '{"orderId":42,"total":99.00}');
COMMIT;
```

The database's own atomicity now does the hard part. Either both rows commit or neither does, so an event exists **if and only if** the state change it describes happened. No crash window is left between them.

![Outbox flow](/figures/outbox/flow.svg "The event row commits with the order; a relay moves it to the broker afterwards")

A typical outbox table:

| Column | Purpose |
| --- | --- |
| `id` (UUID) | Unique **event id**. Consumers use it to deduplicate. |
| `aggregate_type`, `aggregate_id` | What changed (`order`, `42`). Used for topic routing and as the partition key. |
| `event_type` | `OrderPlaced`, `OrderCancelled`, … |
| `payload` (JSON / bytes) | The event body, in its **published schema**, not a dump of internal columns. |
| `created_at` | For ordering, lag monitoring and cleanup. |
| `sent_at` (polling only) | Null until the relay has published it. |

The event is a **contract**. Build the payload deliberately, with a versioned schema, rather than serialising the ORM entity. Otherwise every internal column rename becomes a breaking change for consumers.

### The relay: polling publisher

The simplest relay is a loop that reads unsent rows and publishes them:

```sql
SELECT * FROM outbox WHERE sent_at IS NULL
ORDER BY created_at LIMIT 100
FOR UPDATE SKIP LOCKED;
-- publish each row, wait for broker acks
UPDATE outbox SET sent_at = now() WHERE id = ANY($1);
```

`FOR UPDATE SKIP LOCKED` lets several relay instances run without grabbing the same rows. If you need strict per-entity ordering, run a single active relay, or have each instance own a partition (for example by a hash of `aggregate_id`).

Polling is easy to understand and needs nothing but the database you already have. The costs:
- **latency** of up to one poll interval (typically 100 ms to 1 s),
- **query load** on the primary,
- **index churn** as rows are updated and deleted.

At moderate volumes these costs are negligible, and many production systems never outgrow polling.

### The relay: log tailing (CDC)

The alternative is **change data capture**. Every database already writes each committed change to a log (Postgres WAL, MySQL binlog, MongoDB oplog) for replication. A CDC connector such as **Debezium** reads that log as a replica would. Every insert into `outbox` shows up as a change event, which the connector routes to a topic (Debezium has a dedicated *outbox event router* for this).

![Relay options and idempotent consumer](/figures/outbox/relay.svg "Polling and CDC both deliver at-least-once; the consumer turns duplicates into no-ops")

CDC gives:
- low latency (milliseconds after commit),
- no polling queries,
- events in **commit order**.

Since nothing needs to "mark sent", rows can be deleted right after insert in the same transaction: the log still carries them. The cost is operational. You run Kafka Connect or a Debezium server, and you manage replication slots. An abandoned Postgres slot makes the server retain WAL indefinitely and can fill the disk.

### At-least-once, so consumers deduplicate

Both relays can publish a message **twice**. The relay sends, the broker acks, and the relay crashes before recording `sent_at` (or before committing its CDC offset). On restart it sends again. That's the price of never losing an event: the outbox gives **at-least-once**, not exactly-once.

So the consumer must be an **idempotent receiver**:

1. Read `event_id` from the message.
2. In one local transaction, check a `processed_events` table. If the id is already there, ack and skip. Otherwise apply the change **and** insert the id.
3. Commit, then ack the message.

This is the mirror image of the outbox: an **inbox** on the consumer side. Where possible, make the handler naturally idempotent instead (an upsert keyed by order id, or "set status = shipped" rather than "increment"). Then the dedup table is a safety net, not the whole mechanism.

### Ordering

Consumers usually care about order **per entity**: `OrderPlaced` must come before `OrderCancelled` for order 42. Two rules preserve it:
- relay rows in commit or creation order,
- publish with **`aggregate_id` as the partition / message-group key**, so all events for one order land in the same Kafka partition or SQS FIFO group.

Global ordering across all entities is rarely needed and expensive. Don't promise it.

Polling by `created_at` or by a sequence isn't strictly commit order under concurrency: a transaction that started earlier can commit later. For most systems that's harmless. If it isn't, use CDC, which sees commits in log order, or include a per-aggregate version number that consumers check.

### Housekeeping

The outbox is a queue table, and queue tables grow:
- delete or archive sent rows on a schedule (or immediately, with CDC),
- partition by day if volume is high, so cleanup is a cheap `DROP PARTITION`,
- alert on **outbox lag**: the age of the oldest unsent row. That number is your "events are stuck" alarm.

## Where it's used

| Context | How the outbox shows up |
| --- | --- |
| Microservices with Kafka | Debezium outbox event router publishing domain events from Postgres or MySQL |
| Event-driven .NET / Java apps | Built into frameworks such as MassTransit, NServiceBus, Axon and Eventuate Tram |
| Payments and ledgers | "Payment captured" events must never be lost or invented. Outbox plus idempotent consumers is the norm |
| Search and cache sync | Outbox events (or CDC directly) keep Elasticsearch indexes and caches in step with the source of truth |
| Webhooks to customers | The webhook delivery queue is fed from an outbox written with the business change |
| Sagas | Each saga step commits its local change and the next command or event through the outbox |

## Use case walk-through: lost shipments at an online store

An online store notices that about 1 in 5,000 orders never ships. Logs show the orders were saved, but the shipping service never received `OrderPlaced`. Every case lines up with a deploy or a brief Kafka leader election.

1. **Diagnose the dual write.** The handler commits the order, then calls `producer.send`. Deploys kill pods between the two. Elections make `send` time out after the commit, and the error is only logged.
2. **Add the outbox table** in the orders database, with `id`, `aggregate_id`, `event_type`, `payload` and `created_at`. Change the handler to insert the event row inside the existing transaction, and delete the direct `producer.send`.
3. **Choose a relay.** The team already runs Kafka Connect, so they deploy Debezium with the outbox event router. It routes by `aggregate_type` to the `orders` topic, keyed by `aggregate_id`. Rows are deleted by a nightly job.
4. **Make consumers idempotent.** Shipping adds a `processed_events` table and wraps "create shipment + insert event id" in one transaction. Creating the shipment was already an upsert keyed by order id, so duplicates were harmless anyway.
5. **Backfill.** A one-off script finds orders from the past 90 days with no shipment and inserts outbox rows for them. The idempotent consumer makes running it twice safe.
6. **Monitor.** Dashboards track replication-slot lag and the age of the oldest outbox row. An alert fires if events are more than 60 seconds behind.

**Result:** orders that never ship drop to zero. Deploys and broker elections now only delay events by seconds instead of losing them, and the backfill catches up the historical gap.

## Pitfalls

- **Outbox in a different database.** The table must share the transaction with the business data. An outbox in another schema on another server is just another dual write.
- **Publishing the entity, not an event.** Serialising the ORM row couples consumers to your internal schema. Design a versioned event payload.
- **No consumer dedup.** At-least-once means duplicates *will* happen, typically during exactly the incidents you least want extra surprises in.
- **Wrong partition key.** Random or round-robin keys destroy per-entity ordering. Key by aggregate id.
- **Unbounded table growth.** Millions of sent rows slow the polling query and bloat indexes. Clean up, and partition if needed.
- **Abandoned replication slots.** A stopped CDC connector makes Postgres retain WAL until the disk fills. Monitor slot lag and remove dead slots.
- **Large payloads.** Multi-megabyte events bloat the WAL and the broker. Publish identifiers plus key fields, and let consumers fetch details if needed.
- **Treating the outbox as exactly-once.** It isn't, and neither is the broker on its own end-to-end. Exactly-once *effects* come from idempotent consumers.

> [!TIP]
> Before reaching for CDC infrastructure, start with a polling relay on the same Postgres. It's maybe 50 lines, handles thousands of events per second with `SKIP LOCKED`, and the outbox table stays the same if you later switch the relay to Debezium.

## Discussion questions

1. Why can't you fix the dual write by catching the broker error and rolling back the database transaction?
2. A relay publishes an event, the broker acks, and the relay crashes before marking it sent. Walk through what each consumer sees and why it stays correct.
3. When would you choose a polling relay over CDC, and what would make you switch?
4. How would you guarantee that `OrderCancelled` is never processed before `OrderPlaced` for the same order?
5. Compare the outbox with event sourcing, where the event log *is* the source of truth. What does each give up?
6. Your consumer calls a third-party API that isn't idempotent. How do you make processing safe under duplicate delivery?

## FAQ

### Why not use two-phase commit (XA) between the database and the broker?
Most modern brokers (Kafka, SQS, SNS, Pub/Sub) don't take part in XA. Where it's available, 2PC adds round trips, holds locks while waiting on a coordinator, and needs careful recovery when the coordinator fails. The outbox gets the same correctness using only a local transaction.

### Is the outbox the same as change data capture?
No. CDC is one way to *relay* the outbox. You could also point CDC straight at the `orders` table, but then consumers see your internal row format and every schema change leaks out. The outbox gives you an explicit, versioned event contract, and CDC is just the transport.

### Can I get exactly-once delivery?
Not end to end across a database, a broker and another service. You get at-least-once delivery plus idempotent processing, which gives exactly-once *effects*. Kafka transactions give exactly-once within Kafka, not across your database.

### What's the inbox pattern?
The consumer-side mirror. Incoming messages are recorded by event id in the consumer's database in the same transaction as their effects. Duplicates are detected and skipped. Some frameworks also store the whole message and process it asynchronously from that table.

### Does the outbox add latency?
A little. A polling relay adds up to one poll interval, often 100 ms to 1 s. CDC adds milliseconds. In exchange, the request no longer waits for the broker at all, so the user-facing request usually gets *faster*.

## Key takeaways

- Writing to a database and a broker separately is a **dual write**: some crash will lose or invent events.
- The outbox turns it into **one local transaction**: the event row commits if and only if the business change does.
- A **relay** (polling with `SKIP LOCKED`, or CDC such as Debezium) publishes outbox rows and retries until the broker acks.
- Delivery is **at-least-once**, so consumers **deduplicate on event id** or are naturally idempotent.
- **Partition by aggregate id** for per-entity ordering, publish a **versioned event contract**, and monitor **outbox lag** and replication slots.

## References

- [Chris Richardson, microservices.io: Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [Debezium documentation: Outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- [Debezium blog: Reliable microservices data exchange with the outbox pattern](https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/)
- [AWS Prescriptive Guidance: Transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [PostgreSQL documentation: Logical decoding and replication slots](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html)
- [PostgreSQL documentation: SELECT … FOR UPDATE SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- Gregor Hohpe and Bobby Woolf, *Enterprise Integration Patterns*, Addison-Wesley, 2003 (Guaranteed Delivery, Idempotent Receiver).
- Martin Kleppmann, *Designing Data-Intensive Applications*, O'Reilly, 2017, chapter 11 (change data capture and event streams).

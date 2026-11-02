---
summary: Why every networked system eventually processes the same request twice, how idempotency keys and deduplication make that harmless, and what "exactly once" really means in Kafka, Flink and payment APIs.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** When a request times out, the sender can't tell whether it was processed, so it **retries**, and the receiver may process it **twice**. You can't prevent duplicate *delivery* over an unreliable network. You can make duplicate *processing* harmless. An operation is **idempotent** if doing it twice has the same effect as doing it once. Get there with **naturally idempotent operations** (`SET`, `PUT`), **idempotency keys** that the server remembers, or **deduplication** recorded in the same transaction as the side effect. "Exactly-once" in real systems means **at-least-once delivery + idempotent or transactional processing**: the *effect* happens once.

## The problem: retries are inevitable, and ambiguous

Any call over a network can end in three ways: success, failure, or **unknown**. A timeout is the unknown case. The request may never have arrived, may have failed, or may have **succeeded with the reply lost**.

![Sequence: client posts a charge, server charges the card, response is lost, client retries, server charges again.](/figures/idempotency/retry-dilemma.svg "From the client's side, \"the request was lost\" and \"the reply was lost\" look identical.")

The client has two options:

- **Don't retry** (*at-most-once*). Some requests are silently lost: a payment never made, an order never placed.
- **Retry until acknowledged** (*at-least-once*). Nothing is lost, but some requests are processed more than once: a double charge, a duplicate email, an order placed twice.

For anything that matters, losing it isn't acceptable, so real systems retry. HTTP clients, SDKs, load balancers, message brokers and mobile apps retrying on flaky connections all retry, often several layers at once. **Duplicates are not an edge case. They are guaranteed at scale.** The question is only whether they're harmless.

> [!NOTE]
> This is a version of the **Two Generals' Problem**: no finite exchange of messages over an unreliable channel can guarantee both sides know an action happened. So no protocol can deliver a message *exactly once*. What we can engineer is exactly-once **effects**.

## Idempotency

An operation `f` is **idempotent** if `f(f(x)) = f(x)`. Applying it again changes nothing.

| Naturally idempotent | Not idempotent |
| --- | --- |
| `SET balance = 100` | `balance = balance + 50` |
| `PUT /users/42 {…full doc…}` | `POST /orders` (creates a new order each time) |
| `DELETE /carts/7` | `INSERT INTO payments …` (no unique key) |
| "mark invoice 881 as paid" | "send welcome email" |
| upsert by natural key | append to a list |

HTTP defines `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS` as idempotent (RFC 9110), so intermediaries may retry them safely. `POST` and `PATCH` aren't, and they're exactly where the dangerous side effects usually live.

A useful design trick: **turn relative operations into absolute ones**. Instead of "add 50", send "set balance to 150 if the current version is 7" (a conditional write). Instead of "create an order", send "create order with id `ord_abc` (client-generated)". A duplicate then hits a unique constraint and is a no-op.

## Idempotency keys

When an operation can't be made naturally idempotent, like charging a card, have the **client** generate a unique key per logical operation (a UUID) and send it with the request and with every retry of it.

![Sequence: client sends POST with Idempotency-Key k1; server records k1, charges and stores the result; reply is lost; client retries with k1; server finds k1 and returns the stored response.](/figures/idempotency/idempotency-key.svg "The server stores the key with the result. Retries with the same key get the original response, and the side effect happens once.")

Server-side, per request:

1. **Atomically claim the key**: insert `(key, request_hash, status=in_progress)` with a unique constraint.
2. If the key **already exists**:
   - `completed` → return the **stored response** (same status code and body).
   - `in_progress` → return `409 Conflict` (or wait). Another attempt is running right now.
   - Different `request_hash` → reject. The client reused a key for a different operation, which is a bug.
3. Otherwise **perform the work**, store the response against the key, and mark it `completed`.
4. Expire keys after a window that comfortably exceeds the client's retry horizon. Stripe keeps keys for 24 hours.

### The hard part: a crash halfway through

What if the server crashes after charging the card but before saving the result? The retry sees `in_progress` and has no idea whether the charge happened. Solutions, in rough order of robustness:

- **Do the side effect and record the key in one database transaction.** This is possible when the side effect is a database write.
- **Pass the key downstream.** Call the payment network or provider with *its own* idempotency key derived from yours, so their deduplication covers the external effect.
- **Recovery points.** Brandur Leach describes splitting the request into atomic phases, recording which phase finished, and resuming from the last one on retry.

## Idempotent consumers in messaging

Message brokers (SQS, RabbitMQ, Kafka, Pub/Sub) deliver **at least once**. A consumer that crashes after processing but before acknowledging will get the message again. The standard fix is the **idempotent consumer** (also called the *inbox* pattern):

![A queue redelivers message 881; inside one database transaction the consumer inserts the message id into a processed table and updates balances; a duplicate id means skip.](/figures/idempotency/idempotent-consumer.svg "Record \"I processed message 881\" in the same transaction as the business change, so the two can never get out of step.")

- Give every message a stable **message ID** (or derive one from business data, like `order-881:payment-captured`).
- In one transaction, `INSERT INTO processed_messages(id)` **and** apply the change. A unique-key violation means "already done": ack and move on.
- Prune old IDs after the broker's maximum redelivery window.

If the side effect isn't in your database (sending an email, calling an API), you can't make it atomic with the dedupe record. Make the downstream call idempotent (pass a key), or accept a small chance of duplicates and make them tolerable.

## What "exactly once" means in practice

![Three bands: at most once, at least once, exactly once (effectively).](/figures/idempotency/delivery-guarantees.svg "Every exactly-once system is at-least-once delivery plus a mechanism that makes repeats invisible.")

- **Kafka:** the *idempotent producer* (on by default since Kafka 3.0) attaches a producer ID and sequence number to each batch, so a retried send isn't written twice to a partition. *Transactions* let a consume–transform–produce app atomically write its outputs **and** commit its input offsets. Consumers with `isolation.level=read_committed` never see aborted writes. This gives exactly-once **within Kafka**. Writes to an external database still need idempotency.
- **Flink and Spark Structured Streaming:** periodic **checkpoints** of operator state and source offsets. After a failure, they roll back to the last checkpoint and replay. Sinks must be **transactional** (two-phase commit tied to checkpoints) or **idempotent** (upserts) for end-to-end exactly-once.
- **SQS FIFO:** deduplicates messages with the same `MessageDeduplicationId` within a 5-minute window. That covers producer retries, but not a consumer that processes and then fails to delete.
- **Payment APIs (Stripe, Adyen, PayPal and others):** idempotency keys on mutating requests, and the same pattern applied again toward card networks and banks.

## Where it matters most

| Scenario | Idempotency technique |
| --- | --- |
| Payments, transfers, refunds | Idempotency keys end to end, unique payment IDs, ledger entries keyed by operation ID |
| Order placement / checkout | Client-generated order ID. The "Place order" button disables after click *and* the server dedupes. |
| Webhooks you receive | Providers retry on non-2xx. Store the event ID and skip repeats. |
| Event consumers / projections | Processed-ID table or version checks (`apply only if event.version = state.version + 1`) |
| Infrastructure automation | Declarative "ensure state" (`kubectl apply`, Terraform) instead of imperative "create" |
| Email and notifications | Dedupe on `(user, template, business_event_id)` before sending |

## Pitfalls

> [!WARNING]
> **Keys generated on the server don't help.** If the server makes up a new ID for every request, a retry gets a new ID too. The key has to be created **once by the caller** for the logical operation and reused on every retry.

- **Checking then acting non-atomically.** `SELECT key` → not found → do work → `INSERT key` lets two concurrent retries both do the work. Claim the key with a unique constraint *first*.
- **Retention shorter than the retry window.** If keys expire after 1 hour but a mobile app retries a queued request the next morning, the duplicate goes through.
- **Ignoring the request body.** A reused key with different parameters should be rejected, not silently replayed with the first request's response.
- **Treating "exactly-once" as end-to-end.** Kafka's guarantee stops at Kafka's boundary. The database write, email or HTTP call your consumer makes needs its own idempotency.
- **Non-deterministic handlers.** If processing depends on "now" or random values, a retry may compute something different. Derive values from the message, or store what was decided.

## Discussion questions

1. Which endpoints in your system would cause real damage if a request were processed twice? How are they protected today?
2. Design the storage schema and state machine for idempotency keys, including concurrent retries and crashes mid-request.
3. Why can't TCP's guarantees (no duplicates, in order) solve this at the application level?
4. Kafka offers "exactly-once semantics". What exactly is guaranteed, and where does it stop?
5. How would you make "send a welcome email" effectively exactly-once?
6. What's the trade-off in how long you keep idempotency keys or processed-message IDs?

## FAQ

### What's the difference between idempotent and safe?

A **safe** method doesn't change server state at all (`GET`, `HEAD`). An **idempotent** method may change state, but repeating it has no *additional* effect (`PUT`, `DELETE`). Every safe method is idempotent. Not every idempotent method is safe.

### Is `DELETE` really idempotent if the second call returns 404?

Yes. Idempotency is about the **effect on server state**, not the response. After one or two `DELETE`s the resource is gone either way. Many APIs return 404 (or 204) for the second call, and clients should treat both as success.

### Who should generate the idempotency key: client or server?

The **client** (or whoever initiates the logical operation and might retry it). It must be generated once per operation, before the first attempt, and reused across retries, usually a random UUID v4. If a server makes its own downstream calls, it generates keys for *those* calls the same way.

### Do I still need idempotency if I use database transactions?

Yes. Transactions make a request **atomic** (all or nothing), but they don't stop the **same** request being run twice as two separate transactions after a retry. You need both: atomicity within an attempt, and deduplication across attempts.

### How long should I keep idempotency keys?

Longer than the longest time a client might retry the same operation, plus a safety margin. 24 hours is common for APIs. Message deduplication tables are usually sized to the broker's redelivery and retention window. Storage is cheap compared with a double charge.

### Is there a standard header?

`Idempotency-Key` is widely used (Stripe, Adyen, PayPal and others), and the IETF HTTPAPI working group has an Internet-Draft standardising it. Its semantics match the pattern in this article.

## Key takeaways

- Over a network, **timeouts are ambiguous**, so retries, and therefore duplicates, are guaranteed.
- Make repeats harmless with **idempotency**: absolute operations, client-chosen IDs, **idempotency keys**, **dedupe tables**.
- **Claim keys atomically**, store the response, and reject reuse with a different body.
- **Exactly-once = at-least-once + idempotent or transactional processing.** It covers effects, not delivery, and only within the boundary that implements it.
- Apply it **end to end**: every hop that can retry needs its own protection.

## References

1. B. Leach. [Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency). Stripe Engineering, 2017.
2. B. Leach. [Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys). 2017.
3. Stripe API docs. [Idempotent requests](https://docs.stripe.com/api/idempotent_requests).
4. IETF HTTPAPI WG. [The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) (Internet-Draft).
5. R. Fielding, M. Nottingham, J. Reschke. [RFC 9110: HTTP Semantics, §9.2.2 Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110#name-idempotent-methods). 2022.
6. N. Narkhede. [Exactly-once Semantics are Possible: Here's How Kafka Does it](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/). Confluent, 2017.
7. Apache Flink docs. [An Overview of End-to-End Exactly-Once Processing in Apache Flink](https://flink.apache.org/2018/02/28/an-overview-of-end-to-end-exactly-once-processing-in-apache-flink-with-apache-kafka-too/). 2018.
8. AWS docs. [Exactly-once processing in Amazon SQS FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html).
9. C. Richardson. [Pattern: Idempotent Consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html). microservices.io.
10. P. Helland. [Idempotence Is Not a Medical Condition](https://queue.acm.org/detail.cfm?id=2187821). *ACM Queue*, 2012.

---
summary: How to keep data consistent across services when one ACID transaction can't span them. Sequence local transactions, undo with compensations, and design for the isolation you no longer get for free.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **saga** splits a business transaction that spans several services into a sequence of **local transactions** T1…Tn. Each one commits immediately in its own database. If step k fails, the saga runs **compensating transactions** C(k−1)…C1 that semantically undo the earlier steps: a refund, not a rollback. Sagas give you **atomicity eventually** without distributed locks, but they **don't give isolation**: other requests can see half-finished work. Coordinate them by **choreography** (services react to events) or **orchestration** (a central state machine). Make every step and compensation **idempotent** and **retryable**.

## The problem: one business action, many databases

Placing an order in a microservice system touches several services, each owning its own data:

1. **Order service:** create the order.
2. **Payment service:** charge the card.
3. **Inventory service:** reserve the items.
4. **Shipping service:** schedule a delivery.

In a monolith with one database, you'd wrap all four in `BEGIN … COMMIT`. If inventory fails, everything rolls back and no one ever sees a charged card for a cancelled order. Across services with separate databases, there's no shared transaction to wrap.

### Why not two-phase commit?

**Two-phase commit (2PC)** is the classic answer. A coordinator asks every participant to *prepare* (do the work, hold locks, promise to commit), then tells all of them to *commit* or *abort*.

![Top: a coordinator sends prepare then commit to three databases. Bottom: a saga commits T1, T2, T3 independently.](/figures/saga/2pc-vs-saga.svg "2PC keeps everyone locked until the outcome is known. A saga commits each step at once and handles failure afterwards.")

2PC is a poor fit for microservices:

- **Blocking.** Participants hold locks from *prepare* until *commit*. If the coordinator crashes in between, they stay locked until it recovers.
- **Availability.** Every participant has to be up for any transaction to commit. The more services, the worse it gets.
- **Technology.** Many datastores, queues and third-party APIs (Stripe, an airline's booking API) don't support XA or prepare/commit at all.
- **Latency and coupling.** Synchronous, cross-service locking is exactly what service boundaries are meant to avoid.

## Sagas

The idea comes from Hector Garcia-Molina and Kenneth Salem's 1987 paper, originally about **long-lived transactions** inside one database. Instead of one big transaction holding locks for minutes, split it into steps that each commit, and define how to compensate each one.

![T1 create order, T2 charge card, T3 reserve stock fails; then C2 refund card and C1 cancel order run.](/figures/saga/compensation.svg "When T3 fails, the saga walks back through the completed steps and runs their compensations in reverse order.")

For every step `Ti` you define a **compensation `Ci`** that undoes its business effect:

| Step | Compensation |
| --- | --- |
| Create order (`PENDING`) | Mark order `CANCELLED` |
| Charge card | Refund card |
| Reserve stock | Release reservation |
| Book a flight | Cancel booking (maybe with a fee) |
| Send confirmation email | Send "sorry, your order was cancelled" email |

Compensations are **semantic**, not physical rollbacks. The charge really happened, and the customer may have seen it on their banking app. The refund is a new, visible event. Some actions can't be compensated at all (you can't un-send an email or un-ship a parcel), which shapes how you order the steps.

### Ordering steps: compensatable, pivot, retriable

Chris Richardson's classification is a practical way to design the order:

1. **Compensatable steps** come first. They can be undone (create a pending order, reserve stock, authorize a card).
2. The **pivot step** is the go/no-go point (e.g. capture the payment). If it succeeds, the saga *will* complete.
3. **Retriable steps** come after the pivot. They must eventually succeed, retried as many times as needed (schedule shipping, send the confirmation).

Put the steps most likely to fail **early**, and make anything that's hard to undo happen **after** the pivot.

## Coordinating a saga

![Top: Order, Payment, Inventory and Shipping pass events along a chain. Bottom: an orchestrator calls each service.](/figures/saga/choreography-vs-orchestration.svg "Choreography distributes the flow across services. Orchestration puts it in one place.")

### Choreography

Each service listens for events and decides what to do next: Order publishes `OrderCreated`, Payment reacts and publishes `PaymentCaptured`, Inventory reacts, and so on. Failures publish events too (`StockUnavailable`), and earlier services react by compensating.

- ✅ No central component. Services stay loosely coupled. It's simple for 2–4 steps.
- ❌ The overall flow exists only implicitly, spread across services. It's hard to answer "what state is order 881 in?" and easy to create cyclic dependencies. Adding a step means changing several services.

### Orchestration

A **saga orchestrator**, a persisted state machine, sends commands to each service ("charge card for order 881") and decides the next step based on the replies, including when to compensate.

- ✅ The whole flow is in one place: easy to read, test, monitor and change. Timeouts and retries are explicit.
- ❌ The orchestrator is a component you must make durable and highly available. There's a risk of putting too much business logic in it.

Durable-execution engines are built for this: **Temporal** (and its predecessor **Cadence** from Uber), **AWS Step Functions**, **Camunda/Zeebe**, **Netflix Conductor**. You write the saga as ordinary-looking code or a state definition, and the engine persists every step so it survives crashes and resumes where it left off.

## The isolation problem

ACID gives you **A**tomicity, **C**onsistency, **I**solation and **D**urability. A saga gives you atomicity *eventually* (all steps or all compensations) and durability, but **no isolation**. Other transactions can see intermediate states:

- **Dirty reads:** a report counts revenue from an order that is about to be refunded.
- **Lost updates:** saga A reserves the last item, saga B overwrites the stock count, and A's compensation then "releases" an item that's no longer accurate.
- **Fuzzy reads:** a step reads data that an earlier step of another saga changes before it finishes.

Countermeasures (from Richardson and the saga literature):

- **Semantic locks.** Mark records as in-progress (`order.status = PENDING`, `stock.reserved += 1`). Other operations treat those records carefully, e.g. by not shipping a `PENDING` order.
- **Commutative updates.** Design operations so their order doesn't matter (`reserved += 1` / `reserved -= 1` instead of `SET stock = 4`).
- **Pessimistic ordering.** Reorder steps so the risky reads happen after the commits they depend on.
- **Reread value / version checks.** Before acting, verify that the record hasn't changed since the saga last read it.

> [!WARNING]
> **Compensations can fail too.** The refund API might be down. Compensations must be **retriable until they succeed**. If one is truly impossible (the money is gone), the saga needs a path to **human intervention**: a dead-letter queue, an alert, a support ticket. Design for it explicitly.

## Making sagas reliable

- **Idempotent steps.** Every command and compensation can be delivered more than once (at-least-once messaging), so key them by `saga_id + step`.
- **Transactional outbox.** When a service commits its local transaction, it must also publish the event or reply, atomically. Write the message to an `outbox` table in the same transaction and relay it to the broker afterwards. Otherwise a crash between "commit" and "publish" stalls the saga forever.
- **Timeouts.** A step that never replies must eventually be treated as failed (and compensated) or retried. Orchestrators make this explicit.
- **Observability.** Correlate all events and commands with the saga ID, and provide a view of "sagas stuck in step X for more than N minutes".

## Where it's used

| Domain | Example saga |
| --- | --- |
| E-commerce | Order → payment → inventory → shipping, with refunds and restocking as compensations |
| Travel booking | Flight + hotel + car. If the car fails, cancel the hotel and the flight (possibly with fees). |
| Banking | Transfer between banks: debit, send via network, credit. Reversal on failure. |
| Ride hailing / delivery | Match driver → authorize payment → start trip → capture payment |
| User onboarding | Create account → provision workspace → set up billing → send welcome email |
| Cloud provisioning | Create network → VM → DNS. Tear down in reverse on failure. |

## Pitfalls

- **Using sagas where one database would do.** If the data can live in one service, a local ACID transaction is far simpler. Sagas often signal service boundaries drawn too finely.
- **Forgetting the user's view.** Users will see `PENDING` states. Design UI for "processing", "partially failed" and "refunded".
- **Non-commutative compensations.** "Set stock back to 5" overwrites other sagas' changes. Use relative, idempotent operations.
- **Choreography sprawl.** Ten services reacting to each other's events with no single owner is very hard to debug. Move to orchestration once the flow gets non-trivial.
- **Missing outbox.** The most common reliability bug: committing locally but failing to publish, leaving the saga stuck.

## Discussion questions

1. Design the saga for booking a trip (flight, hotel, car). Which step should be the pivot and why?
2. How would you prevent a `PENDING` order from being shipped while its payment saga is still running?
3. A compensation (refund) fails repeatedly for three days. What should the system do?
4. When would you choose choreography over orchestration?
5. What anomalies could a finance report see while sagas are mid-flight? How would you avoid them?
6. Why is the transactional outbox pattern almost always needed alongside sagas?

## FAQ

### Is a saga a distributed transaction?

It's a way of getting **some** distributed-transaction properties without a distributed commit protocol. You get eventual all-or-nothing (with compensations) and durability. You don't get isolation, and you don't get atomic visibility. Users and other services can observe the steps.

### Can sagas guarantee consistency?

They guarantee **eventual business consistency** if every step and compensation eventually succeeds, and that includes compensations retried until they work. They can't guarantee that no one ever sees an intermediate state. Invariants have to be designed at the business level ("an order is shipped only when `PAID`").

### What's the difference between a saga and a workflow?

A saga is a kind of workflow with a specific rule: every completed step must be compensatable (or come after the pivot) so the whole thing can be unwound. Workflow engines like Temporal or Step Functions are common ways to implement sagas.

### Should the orchestrator be its own service?

Often it lives inside the service that owns the business process, such as the Order service orchestrating the order saga, using a library or workflow engine. A shared "saga service" for everything tends to become a bottleneck and a dumping ground for logic.

### How do I test sagas?

Unit-test the orchestrator's state machine for every failure point, including failures in compensations. Then run integration tests that inject failures (kill a service mid-step, duplicate messages, delay replies) and check that the system ends in a consistent final state.

### Do I need sagas if I use event sourcing?

They're complementary. Event-sourced services emit events that naturally drive choreographed sagas, and orchestrators can themselves be event-sourced. Event sourcing doesn't remove the need to coordinate across services.

## Key takeaways

- When one ACID transaction can't span your services, use a **saga**: local transactions plus **compensations**.
- Order steps as **compensatable → pivot → retriable**, with the riskiest and most reversible steps first.
- **Choreography** for short, simple flows. **Orchestration** (often with a durable workflow engine) for anything more complex.
- Sagas **lack isolation**. Use semantic locks, commutative updates and careful ordering.
- Reliability depends on **idempotency**, the **transactional outbox**, **timeouts** and a plan for compensations that fail.

## References

1. H. Garcia-Molina, K. Salem. [Sagas](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf). *SIGMOD 1987*.
2. C. Richardson. [Pattern: Saga](https://microservices.io/patterns/data/saga.html). microservices.io.
3. C. Richardson. *Microservices Patterns*, chapter 4: Managing transactions with sagas. Manning, 2018.
4. Microsoft Azure Architecture Center. [Saga distributed transactions pattern](https://learn.microsoft.com/en-us/azure/architecture/reference-architectures/saga/saga).
5. C. Richardson. [Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html). microservices.io.
6. Temporal docs. [Saga pattern with Temporal](https://temporal.io/blog/compensating-actions-part-of-a-complete-breakfast-with-sagas).
7. AWS. [Implement the serverless saga pattern by using AWS Step Functions](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/implement-the-serverless-saga-pattern-by-using-aws-step-functions.html).
8. C. McCaffrey. [Distributed Sagas: A Protocol for Coordinating Microservices](https://www.youtube.com/watch?v=0UTOLRTwOX0). J On The Beach, 2017.
9. P. Helland. [Life beyond Distributed Transactions: an Apostate's Opinion](https://queue.acm.org/detail.cfm?id=3025012). *ACM Queue*, 2016.

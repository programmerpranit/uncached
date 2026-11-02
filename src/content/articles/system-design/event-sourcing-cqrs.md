---
summary: Store what happened instead of what is, and serve reads from models built for them. Two patterns that give you audit trails, replay and flexible read models, along with eventual consistency, schema-versioning headaches and more moving parts.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** **Event sourcing** stores every change as an immutable **event** in an append-only log (`MoneyDeposited`, `OrderShipped`). Current state is just a **fold** over those events. **CQRS** (Command Query Responsibility Segregation) splits the **write model**, which validates commands and emits events, from one or more **read models** built for queries. They pair naturally: events from the write side feed **projections** that build the read side. You get a complete history, time travel, and the freedom to add new read models later by replaying. You pay with **eventual consistency**, **event schema evolution**, and a lot more infrastructure. Use them where the history *is* the domain, not by default.

## The problem with storing only current state

A typical CRUD app keeps one row per entity and overwrites it on every change:

![Left: a single accounts row with balance 100. Right: five events — opened, deposited 100, withdrew 30, deposited 50, withdrew 20 — folding to 100.](/figures/event-sourcing/state-vs-events.svg "Both store the same balance. Only one of them can answer how it got there.")

That loses information the business often cares about:

- **Why** is the balance 100? Which deposits, reversals and fees led here?
- **What did we believe last Tuesday?** That matters for disputes, audits and reproducing a bug.
- **New questions about old data.** "How often do users add then remove an item before checkout?" can't be answered if removals were simply deleted.

Teams usually patch this with audit tables, history triggers and change-data-capture. Event sourcing turns it around: the history is the primary data, and current state is derived from it.

## Event sourcing

### Events are facts

An event records something that **happened**, in the past tense and in domain language:

```json
{ "stream": "account-42", "version": 3, "type": "MoneyWithdrawn",
  "data": { "amount": 30, "atm": "LIS-0091" },
  "meta": { "at": "2026-11-02T10:14:03Z", "causedBy": "cmd-7f1e", "user": "ana" } }
```

- Events are **immutable**. You don't edit history. A mistake is corrected with a compensating event (`WithdrawalReversed`).
- They're grouped into **streams**, usually one per aggregate (`account-42`), with a **version** number per stream.
- The event store guarantees **ordering within a stream** and supports **optimistic concurrency**: "append this event *only if* the stream is still at version 3".

### State is a fold

To handle a command, load the aggregate's stream, replay it to rebuild the current state, check the business rules, then append new events:

```text
state  = events.reduce(apply, initial)
if command is valid for state:
    append(stream, newEvents, expectedVersion = state.version)
```

The `expectedVersion` check is how you keep invariants like "balance must not go negative" safe under concurrency. If another withdrawal landed first, the append fails, and you reload and retry.

### Snapshots

Replaying 50,000 events on every command is slow. A **snapshot** stores the folded state at some version, so you load the snapshot and replay only the events after it:

![A long strip of events with a snapshot marker near the end; only the tail after it is replayed.](/figures/event-sourcing/snapshots.svg "Snapshots are a cache. You can delete and rebuild them at any time, because the events remain the source of truth.")

Many aggregates never need snapshots. If a stream has hundreds of events, replay takes milliseconds. Long streams are often a sign the aggregate boundary is wrong. "Account" may really be "account per statement period".

## CQRS

**Command Query Separation** (Bertrand Meyer) says a method should either change state or return data, never both. **CQRS**, named by Greg Young, applies that idea to the architecture. Use **different models** for writing and reading.

![Commands go to a command handler that appends to the event store; projectors subscribe and build SQL, search and cache read models that a query handler serves.](/figures/event-sourcing/cqrs-architecture.svg "The write side enforces rules. The read side is shaped for screens and queries. Events connect them.")

- The **write model** is small, normalized around **invariants** (what must always be true) and optimized for correctness.
- **Read models** are denormalized and shaped for specific screens or queries: a SQL table for the account summary, a search index for full-text search, a key-value cache for balance lookups.
- **Projectors** subscribe to the event stream and keep the read models up to date. Each projector records which event it has processed up to, so it can resume after a crash or be **rebuilt from scratch** by replaying.

You can use CQRS without event sourcing (the write DB publishes changes through an outbox or CDC). You can also use event sourcing without full CQRS (rebuild state on read, for small systems). They're most often combined because events are such a convenient way to feed read models.

## What you gain

- **Complete audit trail.** Who did what, when and why, built in rather than bolted on. That's essential in finance, healthcare, logistics and compliance-heavy domains.
- **Time travel.** Rebuild state "as of" any point to debug an incident or answer a dispute.
- **New read models from old data.** A new dashboard or recommendation feature can be built by replaying years of events into a fresh projection.
- **Natural integration.** Other services subscribe to the same events. The events are a well-defined public interface: "an order was placed".
- **Independent scaling.** Reads usually outnumber writes 10–1000×. Read models can be replicated, cached and reshaped without touching the write path.

## What it costs

> [!WARNING]
> **Eventual consistency is visible to users.** After a command succeeds, the read model may lag by milliseconds or seconds. A user who changes their name and immediately reloads might see the old one. Plan for it: return the new state in the command response, read your own writes from the write model, or show "updating…" states.

- **Event schema evolution.** Events live forever, but your code changes. You need versioned event types, **upcasters** that transform old shapes into new ones at read time, and discipline: add fields, never change meanings.
- **Deleting data is hard.** Immutable logs clash with GDPR's right to erasure. Common answers: keep personal data out of events (store a reference), or **crypto-shredding** (encrypt per-user data with a per-user key and delete the key).
- **More infrastructure.** An event store, projectors, checkpointing, replay tooling, monitoring for projection lag, dead-letter handling for events a projector can't process.
- **Harder queries across aggregates.** "All accounts with balance > 1,000" isn't answerable from streams. You need a projection for it.
- **A learning curve.** Teams new to the pattern often model CRUD updates as events (`AccountUpdated { …all fields… }`), which gives them all of the cost and none of the benefit.

## Where it's used

| Domain | Why events fit |
| --- | --- |
| **Banking and payments ledgers** | Double-entry accounting has always been an append-only log of entries. Balances are derived. |
| **E-commerce orders** | Placed → paid → packed → shipped → returned. Each step triggers work in other services. |
| **Logistics and tracking** | Parcel scans are naturally a stream of events, and "where is it now" is a projection. |
| **Collaborative and versioned editing** | Operations logs let you undo, replay and audit changes, much as Git stores commits. |
| **Gaming and trading** | Deterministic replay of inputs to reproduce a state or a bug, as in LMAX's high-throughput exchange architecture. |

Databases already work this way internally. The write-ahead log is the source of truth, and tables are a cached projection of it. Kleppmann's "turning the database inside out" talk makes this case: make the log a first-class, shared part of the architecture.

### Use case walk-through: an order system

1. `PlaceOrder` arrives. The write model checks stock reservations and limits, then appends `OrderPlaced`.
2. A **payments** service subscribes, charges the card and emits `PaymentCaptured` (or `PaymentFailed`).
3. A **fulfilment** projector builds a warehouse pick list. An **email** projector sends a confirmation. An **analytics** projector updates hourly revenue.
4. Six months later, product asks for "time from order to shipment by region". You write a new projector, replay all `OrderPlaced` and `OrderShipped` events, and the report covers the full history from day one.

## Pitfalls

- **Event sourcing everything.** Use it in the parts of the system where history and auditability matter. A user-preferences screen probably doesn't need it.
- **Leaking internal events as public contracts.** Fine-grained internal events change often. Publish more stable **integration events** for other teams.
- **Using Kafka as the event store without thinking.** Kafka is a great **distribution** log. But it doesn't natively offer per-entity streams with optimistic concurrency checks (`expectedVersion`), and loading one entity's history means scanning a partition. Many teams use a dedicated store (EventStoreDB/Kurrent, Marten on Postgres, Axon) or a database table as the source of truth, and publish to Kafka from there.
- **Non-idempotent projectors.** Events will be redelivered after crashes. Projectors must handle duplicates by tracking positions or using idempotent upserts.
- **Side effects during replay.** Rebuilding a projection must not resend 2 million emails. Keep side-effecting handlers separate from replayable projections.

## Discussion questions

1. Which parts of your current system would benefit from event sourcing, and which would just get more complex?
2. How would you enforce "username must be unique" in an event-sourced system where each user is a separate stream?
3. A projector has a bug that has been producing wrong totals for a month. Walk through fixing it.
4. How do you handle a GDPR erasure request when events are immutable?
5. Is a database's write-ahead log "event sourcing"? What's the same and what's different?
6. When does CQRS without event sourcing make more sense?

## FAQ

### Is event sourcing the same as an event-driven architecture?

No. **Event-driven** means services communicate by publishing and reacting to events. **Event sourcing** means a service **stores its own state** as events. You can be event-driven with a normal CRUD database (publish events via an outbox), and you can event-source a single service that never publishes anything.

### Do I need CQRS to do event sourcing?

Not strictly, but in practice you need some read model. Querying across aggregates directly from event streams is impractical. Small systems may rebuild state on demand. Most real systems end up with projections, and that is CQRS.

### How do I query "current state" quickly?

From a projection: a table or document kept up to date by a projector. For the write side, load the aggregate's events (or snapshot + tail) and fold them. That's fast for reasonably sized streams.

### How do I change an event's schema?

Never rewrite stored events in place, except in rare, carefully controlled migrations. Add a new version (`OrderPlaced.v2`), keep the code that understands old versions, and **upcast** old events to the new shape when reading. Additive changes (new optional fields) are the cheapest.

### What happens if a projection gets corrupted?

Delete it and rebuild it by replaying events from the start, or from a snapshot of the projection itself. This is one of the pattern's biggest operational advantages: read models are disposable.

### Isn't storing every event expensive?

Events are usually small and compress well, and storage is cheap compared with the value of history. Very high-volume streams (IoT telemetry, clickstreams) may be better treated as time-series or analytics data with retention policies, not as the source of truth for business entities.

## Key takeaways

- **Event sourcing:** the log of facts is the source of truth, and state is a fold over it.
- **CQRS:** separate models for enforcing rules (writes) and answering questions (reads).
- Together you get audit, replay and new read models from old history, in exchange for **eventual consistency** and **schema evolution** work.
- Use **optimistic concurrency** on streams to protect invariants, and make projectors **idempotent and rebuildable**.
- Apply them **selectively**, where history is part of the domain.

## References

1. M. Fowler. [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html). 2005.
2. M. Fowler. [CQRS](https://martinfowler.com/bliki/CQRS.html). 2011.
3. G. Young. [CQRS Documents](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf). 2010.
4. Microsoft Azure Architecture Center. [Event Sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) and [CQRS pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs).
5. M. Kleppmann. [Turning the database inside-out with Apache Samza](https://martin.kleppmann.com/2015/03/04/turning-the-database-inside-out.html). 2015.
6. M. Fowler. [The LMAX Architecture](https://martinfowler.com/articles/lmax.html). 2011.
7. M. Overeem, M. Spoor, S. Jansen, S. Brinkkemper. [An Empirical Characterization of Event Sourced Systems and Their Schema Evolution — Lessons from Industry](https://arxiv.org/abs/2104.01146). *JSS*, 2021.
8. V. Vernon. *Implementing Domain-Driven Design*. Addison-Wesley, 2013. Chapter 8: Domain Events.
9. Kurrent (EventStoreDB) docs. [Event sourcing explained](https://www.kurrent.io/event-sourcing).

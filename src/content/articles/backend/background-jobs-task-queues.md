---
summary: Why slow or unreliable work belongs off the request path, how durable task queues lease jobs to workers, why delivery is at-least-once and jobs must be idempotent, and how retries with backoff, dead-letter queues, scheduling, priorities and concurrency limits keep background work reliable.
updated: 2026-11-02
---

> [!KEY]
> A background job system turns "do this now, while the user waits" into "record that this must be done, and do it soon, reliably". The parts:
> - the request handler **enqueues** a job (a small message naming the task and its arguments) and returns quickly, often `202 Accepted`,
> - a durable **queue** stores jobs,
> - **workers** pull jobs, **lease** them for a while, run them and **ack** on success.
>
> If a worker dies, the lease expires and the job runs again. That makes delivery **at-least-once**, so every job must be **idempotent**. Failures **retry with exponential backoff and jitter**. Jobs that keep failing go to a **dead-letter queue** for a human to inspect.
>
> Use jobs for anything slow, bursty or dependent on unreliable third parties: emails, PDFs, image processing, webhooks, imports, billing runs.

## The problem: slow work inside the request

A signup endpoint does six things before it responds:

1. writes the user,
2. sends a welcome email through a third-party provider,
3. resizes the uploaded avatar,
4. syncs the contact to a CRM,
5. posts to an analytics API,
6. returns.

On a good day, that takes 2.5 s. On a bad day, the CRM takes 30 s and then times out. The request fails, even though the user row was already written, and the user retries and hits "email already taken".

The underlying problems:

- **Latency coupling.** The user waits for every downstream call, including ones they don't care about.
- **Failure coupling.** One flaky dependency fails the whole request, even though the essential work (creating the user) succeeded.
- **No retries.** If the email provider is briefly down, that email is simply lost.
- **No buffering.** A marketing push sends 50× the usual signups. The web tier needs 50× the capacity for work that could easily happen over the next ten minutes.

## How it works

### Enqueue, return, process

![A request handler validates and enqueues, returning 202; workers pull jobs from a durable queue and call slow dependencies, with retries and a dead-letter queue](/figures/background-jobs/flow.svg "The queue is a buffer between the rate work arrives and the rate it can be done. Web servers and workers scale independently.")

The request handler does only the essential, synchronous part, such as writing the user row. Then it enqueues jobs:

```text
enqueue("send_welcome_email", { user_id: 7 })
enqueue("resize_avatar",      { user_id: 7, upload_key: "u/7/raw.png" })
```

It returns immediately. If the client needs to track progress, the handler returns `202 Accepted` and a job ID that it can poll, or it notifies the client later through a webhook or WebSocket.

Workers are separate processes, often on separate machines. They run a loop:

1. Take a job from the queue.
2. Run the task.
3. Acknowledge success.

Because workers scale on their own, a spike becomes a longer queue rather than an outage. The queue depth tells you how many workers to add.

**Job arguments should be small and reference data, not copy it.** Pass `user_id: 7`, not the whole user object. The job reads fresh state when it runs, and the queue doesn't fill with large blobs. For file processing, pass an object-storage key.

**Where the queue lives** is a trade-off:

- **A dedicated broker** (RabbitMQ, Amazon SQS, Redis-based queues such as Sidekiq, BullMQ or Celery with Redis) is fast and built for this job.
- **Your primary database** (a `jobs` table polled with `SELECT … FOR UPDATE SKIP LOCKED`, as in Postgres-based queues like Oban, GoodJob, Solid Queue or River) has a big advantage: the job is enqueued **in the same transaction** as the business write. If the transaction rolls back, the job never existed. That removes a whole class of "row written but job lost" and "job ran but row missing" bugs.
- **A log** (Kafka) suits high-volume event streams, but it's a poor fit for per-job retries and delays.

### Leases, acks and at-least-once delivery

![Job states: scheduled, queued, running, succeeded, retrying and dead, with lease expiry returning a running job to the queue](/figures/background-jobs/states.svg "A job leaves the queue only when it is acknowledged. Everything else, including a worker crash, eventually puts it back.")

A worker doesn't remove a job when it takes it. It **leases** it:

- SQS calls this a visibility timeout,
- other systems call it a reservation or a lock with an expiry.

The job becomes invisible to other workers for the lease duration. Then:

- **Success.** The worker acks, and the job is deleted or marked succeeded.
- **Error.** The worker reports failure, and the job is rescheduled for a retry.
- **Crash, OOM kill, deploy or network partition.** Nobody acks. The lease expires, and the job becomes visible again for another worker.

This design never loses a job, but it can run a job **more than once**. Worker A might complete the side effect and then die before acking. Worker B will repeat it. This is fundamental, not a bug in any particular queue. No system can know whether a crashed worker finished the external side effect before dying. That is why "exactly-once delivery" claims always come with caveats.

**Long jobs** need a lease longer than their runtime, or a **heartbeat** that extends the lease while they're still making progress. Otherwise a slow but healthy job is handed to a second worker while the first is still running it.

### Idempotency: running twice, affecting once

![Worker A charges a card and crashes before ack; the job is re-delivered to worker B; with an idempotency key the second run is skipped](/figures/background-jobs/idempotency.svg "Delivery is at-least-once. The effect can still be exactly once if each job checks or passes a stable key.")

An **idempotent** job produces the same result whether it runs once or five times. Techniques:

- **Natural idempotency.** "Set the status to `shipped`" is safe to repeat. "Increment the counter" is not. Prefer setting state over applying deltas.
- **Check-then-act with a unique key.** Record `charge:order-812` in a `completed_jobs` table, or rely on a unique constraint, in the **same transaction** as the database side effect. A second run sees the key and exits.
- **Pass the key downstream.** For external APIs, send an idempotency key such as `order-812:charge` and let the provider deduplicate. Payment providers support this for exactly this reason.
- **Make the job a state machine.** Multi-step jobs record which steps are done (for example `charged`, `emailed`), so a retry resumes at the next step instead of repeating earlier ones.

Emails are the classic hard case: most providers don't deduplicate. Record "sent" right after the provider accepts the message and accept a tiny window of rare duplicates, or use a provider that supports idempotency keys.

### Retries, backoff and dead letters

Failures fall into two groups:

- **Transient:** timeouts, `503`s, rate limits, deadlocks.
- **Permanent:** invalid input, a deleted user, a bug.

Retry the first group, and stop quickly on the second.

- **Exponential backoff with jitter.** Wait about 2ⁿ seconds (2, 4, 8, … capped) plus randomness, so a thousand jobs that failed together don't all retry at the same instant and knock the dependency over again.
- **A maximum attempt count.** Use a cap such as 10–25 attempts spread over hours, then move the job to the **dead-letter queue** (DLQ). The DLQ is an inbox, not a graveyard. Alert on its growth, show the error and arguments, and give operators a way to retry or discard a job once the cause is fixed.
- **Non-retryable errors.** Raise a specific "discard" error for permanent failures, so they don't use up 25 attempts.
- **Respect `Retry-After`.** When a dependency rate-limits you, schedule the retry for when it says.

### Scheduling, priorities and concurrency control

Real job systems need more than FIFO:

- **Delayed and scheduled jobs.** "Send a reminder in 24 hours" means a job with a `run_at`. Recurring jobs (cron-like) should be enqueued by a single scheduler, using a lock or leader election, or every scheduler replica will enqueue a copy.
- **Priorities and separate queues.** Password-reset emails shouldn't wait behind a 2-million-row CSV import. Use separate queues with dedicated worker pools or weighted polling, so bulk work can't starve latency-sensitive work.
- **Concurrency limits.**
  - Cap concurrency per dependency (at most 5 concurrent calls to the CRM).
  - Cap it per tenant, so one customer's import doesn't monopolize the workers.
  - Cap it per key ("only one `rebuild_search_index` per account at a time").
- **Uniqueness.** Deduplicate jobs at enqueue time with a uniqueness key, for example one pending `recalculate_invoice:42` at a time.
- **Batches and fan-out.** A parent job splits a large task into thousands of child jobs, and a callback fires when they're all done.
- **Graceful shutdown.** On deploy, workers stop taking new jobs, finish or checkpoint in-flight ones within a timeout, and leave the rest to lease expiry.

### Observability

Track these for each queue:

- depth,
- **age of the oldest job** (the best "are we falling behind?" signal),
- throughput,
- failure rate,
- DLQ size,
- per-job-type latency.

Propagate the trace ID from the request into the job, so a slow email can be traced back to the signup that caused it.

## Where it's used

| Context | Typical tools | Notes |
|---|---|---|
| Ruby/Rails apps | Sidekiq (Redis), Solid Queue / GoodJob (Postgres) | Rails' Active Job abstracts the backend |
| Python | Celery, RQ, Dramatiq, Arq | Celery supports RabbitMQ or Redis brokers |
| Node.js | BullMQ (Redis), pg-boss / Graphile Worker (Postgres) | Delays, priorities, rate limits, repeatable jobs |
| Elixir / Go | Oban (Postgres), River (Postgres), Asynq (Redis) | Transactional enqueue with the business write |
| Cloud-managed | Amazon SQS + Lambda, Google Cloud Tasks, Azure Queue Storage | Visibility timeouts, DLQs and scaling handled for you |
| Long-running workflows | Temporal, AWS Step Functions | Durable multi-step workflows with state, timers and compensation |

## Use case walk-through: making signup fast and reliable

The signup endpoint above has a p95 of 2.8 s and a 1.5% failure rate, caused by CRM timeouts.

1. **Split essential from deferrable.** Only creating the user and session must be synchronous. Email, avatar resize, CRM sync and analytics become jobs.
2. **Enqueue transactionally.** The app uses Postgres, so jobs go into a `jobs` table inside the same transaction that inserts the user. A rollback means no orphaned emails, and a commit means the jobs are guaranteed to exist.
3. **Make each job idempotent.**
   - `send_welcome_email` checks `users.welcome_sent_at` and sets it after sending.
   - `crm_sync` uses an upsert keyed by `user_id`.
   - `resize_avatar` writes to a deterministic object key, so repeats just overwrite.
4. **Configure retries.**
   - CRM sync: 20 attempts with exponential backoff and jitter, honouring `Retry-After`, and a concurrency limit of 5 to match the CRM's rate limit.
   - Email: 10 attempts.
   - Validation errors raise a discard error.
5. **Separate the queues.** `critical` (password resets, welcome emails) gets its own workers. `default` and `bulk` share the rest.
6. **Alert on the right signals.** Alert on the age of the oldest job in `critical` above 60 s, and on any DLQ growth. Each job carries the signup request's trace ID.

**Result:** signup p95 drops to 140 ms, and request failures from CRM outages drop to zero. During a two-hour CRM outage, sync jobs back off and drain automatically when the CRM recovers. No customer notices, and no data is lost.

## Pitfalls

- **Non-idempotent jobs.** At-least-once delivery will eventually run every job twice. Charging, emailing and incrementing must be guarded.
- **Enqueue outside the transaction.** If you enqueue before commit, the job may run before the row exists, or for a row that was rolled back. If you enqueue after commit, a crash in between loses the job. Use transactional enqueue or the outbox pattern.
- **Huge payloads.** Serializing full objects into jobs bloats the queue and runs on stale data. Pass IDs and keys.
- **Lease shorter than the job.** Long jobs get duplicated while still running. Use heartbeats or a lease longer than the worst-case runtime.
- **Retry storms.** Retries without jitter synchronize and hammer a recovering dependency. Always add jitter and cap concurrency per dependency.
- **One queue for everything.** Bulk imports starve password resets. Separate queues by latency class.
- **Ignoring the DLQ.** A DLQ nobody watches is silent data loss with extra steps.
- **Using jobs for things the user must see now.** If the next page depends on the result, either do it synchronously or design the UI around a pending state.
- **Duplicate cron.** Every replica running the scheduler enqueues the nightly job N times. Use a single scheduler with a lock, or uniqueness keys.

> [!WARNING]
> "Exactly-once processing" claims usually mean "exactly-once within this system's own storage". The moment a job calls an external API, sends an email or charges a card, only **idempotency keys and recorded state** prevent duplicates. Design every job to be safely retried, and test it by running it twice.

## Discussion questions

1. Why can no queue guarantee that an external side effect (an email, a payment) happens exactly once? What do you do instead?
2. Compare enqueuing jobs into your Postgres database versus a Redis-based broker. When does transactional enqueue matter more than raw throughput?
3. A job calls a third-party API with a 100 requests/minute limit, and 50,000 jobs arrive at once. How do you design concurrency, retries and backoff?
4. How should a worker behave during a deploy so in-flight jobs neither duplicate unnecessarily nor get lost?
5. Which metric would you alert on to detect "the queue is falling behind": depth, throughput, or the age of the oldest job? Why?
6. When does a simple job queue stop being enough, and what would push you to a workflow engine like Temporal?

## FAQ

### What's the difference between a task queue and a message broker like Kafka?

A task queue manages **individual units of work**: per-job leases, retries, delays, priorities and a DLQ, with each job consumed by one worker. Kafka is a **replicated log** of events that many consumers read independently, tracking offsets. It's great for streams and fan-out, but per-message retries and delays have to be built on top. Many systems use both: Kafka for events, a task queue for work triggered by them.

### Should I use my database as a queue?

For many apps, yes. Postgres with `SKIP LOCKED` handles thousands of jobs per second and gives you transactional enqueue, which is a significant correctness win. Move to a dedicated broker when job volume starts to compete with your primary workload, or when you need very high throughput or cross-system fan-out.

### How many retries should a job have?

It depends on the cost of giving up and how long dependencies stay down. A common pattern is exponential backoff up to a few hours of total retry time for third-party calls, and a small number (or zero) for errors that indicate bad input. Always classify errors so permanent failures don't burn every attempt.

### How do I return a job's result to the user?

Return `202 Accepted` with a job ID and a status URL. The client polls it, or you push completion over a WebSocket, server-sent events or a webhook. For files, the result is usually an object-storage URL written by the job.

### How do I handle jobs that take hours?

Break them into smaller chunks (batches of child jobs). Checkpoint progress so retries resume rather than restart. Extend the lease with heartbeats. For multi-step processes with long waits and compensation logic, consider a durable workflow engine.

## Key takeaways

- Put work that is **slow, bursty or dependent on unreliable services** into background jobs. Keep the request path to what the user must wait for.
- Queues **lease** jobs. A crash means a re-delivery, so delivery is **at-least-once** and **every job must be idempotent**.
- **Retry transient failures** with exponential backoff, jitter and concurrency limits. Send exhausted jobs to a **DLQ that someone watches**.
- **Enqueue transactionally** with the business write, or via an outbox, to avoid lost or phantom jobs.
- Separate queues by latency class, pass IDs rather than payloads, and alert on the **age of the oldest job**.

## References

- [Amazon SQS: Visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Amazon SQS: Dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Sidekiq wiki: Best practices](https://github.com/sidekiq/sidekiq/wiki/Best-Practices)
- [Celery documentation: Tasks](https://docs.celeryq.dev/en/stable/userguide/tasks.html)
- [BullMQ documentation](https://docs.bullmq.io/)
- [PostgreSQL documentation: SELECT … FOR UPDATE SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [AWS Architecture Blog: Exponential backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Stripe: Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
- Gregor Hohpe and Bobby Woolf, *Enterprise Integration Patterns*, Addison-Wesley, 2003 (Guaranteed Delivery, Dead Letter Channel, Idempotent Receiver).

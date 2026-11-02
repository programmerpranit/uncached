---
summary: A design walk-through for running millions of scheduled and delayed jobs on time across many machines, covering how to store timers, claim due runs without double-firing, survive crashed workers, and why "exactly once" really means "idempotent at least once".
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A distributed job scheduler has two halves: **deciding when** a job should run and **running** it. Store every job and every **run** durably, keyed by `(job_id, scheduled_time)` so creating a run is idempotent. **Schedulers** (partitioned, or one elected leader) find due runs with an indexed poll and **claim** them atomically (`FOR UPDATE SKIP LOCKED`, conditional updates, or leases), then push them to a **queue**. **Workers** execute under a renewable **lease**. If a worker dies, its lease expires and the run is retried. Because retries and partitions mean a run can execute **more than once**, the realistic guarantee is **at-least-once execution with idempotent jobs**, plus explicit policies for misfires, overlaps, timeouts and backfills.

## Requirements

A typical brief: "Build a service where teams can schedule jobs: run this every 5 minutes, run this at 09:00 Europe/Berlin each weekday, run this once in 30 days."

**Functional:**

- One-off delayed jobs and recurring jobs (cron expressions, fixed intervals), with time zones.
- Create, update, pause, cancel. View history and logs for each run.
- Retries with backoff, timeouts, and per-job concurrency limits.
- Priorities and quotas per team.

**Non-functional:**

- Millions of job definitions, with peaks of thousands of runs per second (everything scheduled "at the top of the hour").
- **On time:** runs start within a few seconds of their scheduled time.
- **No lost runs**, and **no unintended duplicates** under normal operation.
- Highly available: no single machine whose failure stops all scheduling.

## Architecture

![An API writes to a job store; partitioned schedulers poll it for due runs and push them to a queue; workers pull from the queue, execute, and report status back to the job store.](/figures/job-scheduler/architecture.svg "Separating 'when' from 'run' lets each side scale and fail independently.")

1. **API:** validates and stores job definitions (schedule, payload, retry policy, owner).
2. **Job store:** the source of truth. Two main tables:
   - `jobs(id, schedule, tz, payload, policy, next_run_at, paused)`
   - `runs(id, job_id, scheduled_time, state, attempt, owner, lease_until, …)` with a **unique key on (job_id, scheduled_time)**.
3. **Schedulers:** find runs that are due, claim them, and enqueue them. After a recurring job's run is created, compute and store its **next** run.
4. **Queue:** buffers ready runs and lets workers pull at their own pace (Kafka, SQS, RabbitMQ, or the database itself).
5. **Workers:** execute the job, heartbeat while running, and record the outcome.

### Run states

`scheduled → queued → running → succeeded`, with `failed → (retry) scheduled`, `timed_out`, `cancelled`, and `dead` after exhausting retries. Every transition is a **conditional update** (`UPDATE … WHERE id = ? AND state = 'queued'`), so two components can't both move a run forward.

## Storing timers

![Two cards: DB polling (due_at index, poll every 1–5 s, durable, simple, precision equals poll interval) and hierarchical timing wheel (in-memory buckets, O(1), millisecond precision, needs a durable log).](/figures/job-scheduler/timers.svg "Durable storage for correctness, in-memory structures for precision.")

- **Database polling.** An index on `(state, due_at)` and a poll every second or so: `WHERE state = 'scheduled' AND due_at <= now()`. Durable, debuggable and simple. Precision equals the poll interval, and a relational database comfortably handles thousands of claims per second if partitioned.
- **Sorted sets / delay queues.** Redis `ZADD` with score = due time, then `ZRANGEBYSCORE … LIMIT`. Fast, but needs care for durability and atomic claiming. SQS delay queues and RabbitMQ delayed-message plugins work for short delays (SQS allows up to 15 minutes).
- **Timing wheels.** A hierarchical timing wheel (Varghese and Lauck, 1987) puts timers into buckets by second, minute and hour, with O(1) insert and expiry. Kafka uses one for request timeouts, and Netty for its `HashedWheelTimer`. In-memory, so it must be rebuilt from durable storage after a restart.

A common hybrid: keep all runs in the database, and have each scheduler load the **next few minutes** of its due runs into an in-memory wheel for precise firing, re-polling periodically.

## Claiming due runs safely

With more than one scheduler, two of them must not both enqueue the same run.

![An SQL UPDATE that claims up to 100 due runs in the scheduler's partitions using FOR UPDATE SKIP LOCKED.](/figures/job-scheduler/claim.svg "Each scheduler claims different rows, and no one blocks on anyone else's lock.")

Options:

- **One leader.** Elect a single active scheduler (etcd/ZooKeeper lease) with standbys. Simple and good to quite high volumes, but it's a throughput ceiling, and failover takes a lease timeout. Use **fencing tokens** so a paused old leader's writes are rejected.
- **Partitioning.** Hash jobs into, say, 1,024 partitions, and assign partitions to schedulers via a coordination service or consistent hashing. Each scheduler polls only its partitions. Rebalance when schedulers join or leave.
- **Competing claims.** All schedulers poll the same table and claim with `SELECT … FOR UPDATE SKIP LOCKED` (PostgreSQL, MySQL 8) or a conditional update (`UPDATE runs SET owner = :me WHERE id = ? AND owner IS NULL`). Simplest to operate, and works well up to the database's write capacity.

**Idempotent run creation** handles the other race: when two schedulers (or a retry of one) both try to create the 09:00 run of job 42, the unique key `(job_id, scheduled_time)` ensures only one row exists. Use `INSERT … ON CONFLICT DO NOTHING`.

## Executing runs: leases and retries

![Worker 1 runs attempt 1 with heartbeats extending its lease, then crashes; the lease expires; worker 2 runs attempt 2.](/figures/job-scheduler/leases.svg "The lease is the only thing that says who owns a run. When it lapses, ownership is up for grabs.")

- A worker that takes a run sets `owner` and `lease_until = now() + 30s`, and **heartbeats** to extend it while running.
- A **reaper** (part of the scheduler) finds runs in `running` with an expired lease and moves them back to `scheduled` with `attempt + 1`, applying the retry policy (exponential backoff with jitter, max attempts).
- **Timeouts** are separate from leases: a job that runs too long is killed and marked `timed_out` even if its worker is healthy.
- The worker's final status update is conditional on still owning the run (`WHERE id = ? AND owner = :me AND attempt = :n`). A zombie worker that wakes after its lease expired can't overwrite the newer attempt's result.

### Exactly once?

You can't guarantee a job's **side effects** happen exactly once in the presence of crashes and partitions. Attempt 1 may have charged a card and crashed before recording success. Attempt 1 may still be running on a partitioned worker when attempt 2 starts. What you can do:

- **At-least-once execution** with **idempotent jobs**: pass a stable key (`run_id`) to every downstream call (`Idempotency-Key` headers, unique constraints, upserts).
- **Fencing:** include `attempt` (or a monotonically increasing token) with writes, so the resource rejects writes from older attempts.
- **At-most-once** for jobs where a duplicate is worse than a miss: mark the run `running` before starting and never retry. Rare, and it should be an explicit policy.

## Scheduling semantics you must decide

These are the questions that separate a toy from a production scheduler:

- **Misfires.** The scheduler was down from 08:55 to 09:10. Should the 09:00 run fire late, be skipped, or should every missed interval run ("catch up")? Quartz calls these misfire instructions. Kubernetes CronJobs have `startingDeadlineSeconds`.
- **Overlap.** The 09:00 run is still going at 09:05 when the next is due. Allow concurrent runs, skip the new one, or cancel the old one? (Kubernetes `concurrencyPolicy: Allow | Forbid | Replace`.)
- **Time zones and DST.** "02:30 daily in Europe/Berlin" doesn't exist on the spring-forward day and happens twice in autumn. Store schedules with an IANA time zone and compute next runs with a proper library.
- **Thundering herd at :00.** Many jobs scheduled at the top of the hour create a spike. Spread them with jitter where exact timing doesn't matter, and rate-limit dispatch per tenant.
- **Backfill.** Running a job for past dates (e.g. reprocessing last month's partitions), a common need in data pipelines (Airflow's `catchup` and backfill).
- **Dependencies.** "Run B after A succeeds" turns a scheduler into a workflow engine (DAGs). Consider Airflow, Temporal or Argo rather than growing your own.

## Where it's used

| System | Approach |
| --- | --- |
| **Kubernetes CronJob** | Controller creates Jobs from cron schedules. Concurrency policy, starting deadline, history limits. |
| **Quartz (Java)** | JDBC job store with row locks for clustering. Misfire instructions. |
| **Airflow** | Scheduler parses DAGs, creates task instances in a metadata DB. Multiple schedulers since 2.0 use `SKIP LOCKED`. |
| **Temporal / Cadence** | Durable timers and cron workflows. History sharded across nodes; timers stored per shard. |
| **Sidekiq, Celery beat, BullMQ** | Redis sorted sets for scheduled jobs, with leader election for the periodic scheduler |
| **AWS EventBridge Scheduler, Google Cloud Scheduler** | Managed schedulers that invoke targets at least once |
| **Dropbox ATF** | In-house async task framework with partitioned schedulers and at-least-once execution |

### Use case walk-through: 10 million reminder emails a day

A product sends reminders at a user-chosen local time, plus one-off reminders days or weeks ahead.

1. Each reminder is a `run` row with `due_at` in UTC (computed from the user's time zone), partitioned by `hash(user_id) % 256`.
2. 16 scheduler pods each own 16 partitions (assigned through etcd leases). Every second, each pod claims due runs with `SKIP LOCKED` and publishes them to Kafka.
3. Email workers consume, call the email provider with `Idempotency-Key = run_id`, and mark the run `succeeded`.
4. A reaper requeues runs whose worker lease expired. Retries use backoff with jitter, max 5 attempts, then `dead` with an alert.
5. Peaks at 09:00 local time in each zone are smoothed by adding up to 60 s of jitter (reminders don't need second precision) and per-provider rate limits.
6. Misfire policy: if a reminder is more than 2 hours late, skip it and record `missed`. A reminder at 3 a.m. is worse than none.

## Pitfalls

- **Single cron box.** One machine running crontab is a single point of failure and silently stops scheduling if it dies.
- **Non-idempotent jobs.** Retries will eventually duplicate side effects.
- **Unbounded catch-up** after an outage floods downstream systems with every missed run at once.
- **Ignoring DST.** Jobs that run twice or not at all, twice a year.
- **Polling without an index** or claiming without `SKIP LOCKED`, causing lock contention as the table grows. Archive old runs.
- **No observability.** You need "runs late by more than N seconds", "stuck in running", and "dead runs" dashboards and alerts.

> [!WARNING]
> A scheduler that relies on "only one instance is running" (a leader) must still **fence** its writes. A paused leader that wakes up after a new one took over will happily enqueue the same runs again unless the database rejects its stale token.

## Discussion questions

1. How would you guarantee that a run is created only once when two schedulers compute the same next run time?
2. The scheduler cluster was down for 45 minutes. What should happen to the runs that were due, and who decides?
3. How would you schedule a job at "09:00 every weekday in America/New_York" correctly across DST changes?
4. Compare a single elected scheduler with partitioned schedulers. At what scale would you switch?
5. A job charges customers. How do you make its retries safe?
6. How would you prevent 1 million jobs scheduled at midnight from overwhelming workers?

## FAQ

### Can a scheduler guarantee exactly-once execution?

It can guarantee that **at most one run record** exists per scheduled time and that only one attempt **owns** it at a time. It can't guarantee that a job's external side effects happen exactly once, because a worker can crash after acting but before reporting. Use idempotency keys and fencing to make repeated attempts harmless.

### Should I use a queue or the database to dispatch runs?

Small to medium scale: the database alone (claim rows, workers poll with `SKIP LOCKED`) is simple and transactional. Larger scale or many worker types: put claimed runs on a queue, keeping the database as the source of truth for state.

### How precise can scheduling be?

With polling, precision is roughly the poll interval (often 1 s). With an in-memory timing wheel loaded from the store, tens of milliseconds. Most business jobs don't need better than a few seconds, and adding jitter is often desirable.

### How do workflow engines like Temporal differ?

Temporal persists the entire execution history of a workflow, including timers, activities and retries, so long-running, multi-step processes resume exactly where they left off after crashes. A job scheduler fires individual runs. Use a workflow engine when jobs have multiple steps, dependencies or long waits.

### How do I handle very long-running jobs?

Use heartbeats with progress checkpoints, so a retry can resume rather than restart. Set timeouts generously but explicitly, and consider splitting work into smaller jobs.

## Key takeaways

- Separate **scheduling** (when) from **execution** (run), with a durable store as the source of truth.
- Make run creation idempotent with a unique `(job_id, scheduled_time)` key.
- Claim due runs atomically (`SKIP LOCKED`, conditional updates, partitions or a fenced leader).
- Execute under **leases** with heartbeats. Retry on expiry with backoff.
- Assume **at-least-once**, make jobs **idempotent**, and decide misfire, overlap, time-zone and backfill policies explicitly.

## References

1. Kubernetes docs. [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/).
2. Quartz Scheduler. [Job Stores and clustering](https://www.quartz-scheduler.org/documentation/quartz-2.3.0/tutorials/tutorial-lesson-09.html).
3. Apache Airflow docs. [Scheduler](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html).
4. G. Varghese, T. Lauck. [Hashed and Hierarchical Timing Wheels](http://www.cs.columbia.edu/~nahum/w6998/papers/sosp87-timing-wheels.pdf). *SOSP 1987*.
5. Dropbox Tech Blog. [ATF: Dropbox's asynchronous task framework](https://dropbox.tech/infrastructure/asynchronous-task-scheduling-at-dropbox). 2020.
6. PostgreSQL docs. [SELECT … FOR UPDATE SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE).
7. Temporal docs. [Durable timers and schedules](https://docs.temporal.io/workflows#schedule).
8. Confluent. [Apache Kafka, Purgatory, and Hierarchical Timing Wheels](https://www.confluent.io/blog/apache-kafka-purgatory-hierarchical-timing-wheels/). 2015.

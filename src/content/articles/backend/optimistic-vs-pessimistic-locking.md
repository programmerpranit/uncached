---
summary: Two ways to stop concurrent writers from clobbering each other — lock up front and make others wait, or proceed freely and detect conflicts at write time with a version check.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR** — **Pessimistic locking** takes a lock before reading data it plans to change (`SELECT … FOR UPDATE`), so competing writers wait. **Optimistic locking** takes no lock: it reads a version number, and the write succeeds only if the version is still the same (`UPDATE … WHERE version = 7`); otherwise the caller re-reads and retries. Use optimistic when conflicts are rare or when the "transaction" spans user think time or HTTP requests. Use pessimistic for hot rows with short transactions where retries would be wasteful.

## The problem: lost updates

Two requests read a product with `stock = 5`. Each sells one unit, computes `5 − 1 = 4` in application code, and writes `stock = 4`. Two units left the warehouse but the database says one did. This is the **lost update** anomaly: a read-modify-write cycle where a concurrent writer's change is silently overwritten.

The default isolation level of most databases (Read Committed) does not prevent it. The same problem appears at larger scale: two admins editing the same document in a web form, two microservices updating the same aggregate, two workers processing the same job. Every system with concurrent writers needs a policy for what happens when they collide.

## How it works

### Pessimistic: lock, then work

![Pessimistic locking](/figures/locking/pessimistic.svg "Transaction B waits on A's row lock, then sees A's committed value")

A pessimistic transaction assumes conflict is likely and acquires an exclusive lock before reading:

```sql
BEGIN;
SELECT stock FROM products WHERE id = 42 FOR UPDATE;  -- row locked
UPDATE products SET stock = stock - 1 WHERE id = 42;
COMMIT;                                                -- lock released
```

Any other transaction that tries `FOR UPDATE` on that row blocks until the first commits, then reads the fresh value. Correctness is simple to reason about. The costs:

- **Waiting.** Throughput on a hot row is bounded by one transaction at a time. Lock waits pile up connections.
- **Deadlocks.** Transaction A locks row 1 then wants row 2; B locks row 2 then wants row 1. The database detects the cycle and aborts one — so you need retry logic anyway. Locking rows in a consistent order (e.g. by ID) avoids most deadlocks.
- **Lock duration.** Holding a lock across a network call, a slow API, or user interaction is a recipe for outages. Keep pessimistic transactions short and entirely server-side.

Variants: `FOR SHARE` (others can read-lock but not write), `NOWAIT` (fail immediately instead of waiting), and `SKIP LOCKED` (ignore locked rows — the basis of database-backed job queues). Application-level pessimistic locks include advisory locks (`pg_advisory_lock`), Redis leases, and ZooKeeper/etcd locks with fencing tokens.

### Optimistic: check on write

![Optimistic locking](/figures/locking/optimistic.svg "Both read version 7; only the first conditional update matches")

An optimistic transaction assumes conflict is rare. It records a version (an integer, timestamp, or hash) when reading, and makes the write conditional on it:

```sql
UPDATE products SET stock = 4, version = 8
WHERE id = 42 AND version = 7;
-- rows affected: 1 → success, 0 → someone else won; re-read and retry
```

No locks are held between read and write, so the read can happen minutes earlier — in a different HTTP request, or while a user stares at an edit form. The check-and-set is atomic because the single `UPDATE` statement is atomic.

This is the same idea as compare-and-swap (CAS) in lock-free programming, and it appears everywhere:

- **ORMs:** JPA/Hibernate `@Version`, Rails `lock_version`, Entity Framework `[ConcurrencyCheck]`/`rowversion` throw a stale-object exception on 0 rows.
- **HTTP:** the server returns an `ETag`; the client sends `If-Match: "<etag>"` on `PUT`; a mismatch returns `412 Precondition Failed` (RFC 9110).
- **Key-value stores:** DynamoDB condition expressions, etcd/Consul `ModRevision` CAS, Redis `WATCH`/`MULTI`, Kubernetes `resourceVersion` on every object.

When the condition fails, the caller has options: retry automatically (re-read, re-apply the change — fine for "decrement stock"), merge (field-level diff), or surface a conflict to the user ("this record changed since you opened it").

### A third way: avoid the read-modify-write

Often the best fix is not a lock at all. `UPDATE products SET stock = stock - 1 WHERE id = 42 AND stock > 0` performs the read and write atomically inside the database; the row lock lasts microseconds. Atomic increments, `INSERT … ON CONFLICT`, and unique constraints eliminate whole classes of races without explicit locking. Stronger isolation (Serializable / SSI in PostgreSQL) also detects lost updates automatically — at the cost of serialization failures you must retry, which is optimistic concurrency done by the database.

### Choosing

![Choosing between them](/figures/locking/choose.svg "Optimistic wins at low conflict rates and collapses into retries as conflicts rise")

The deciding variable is **conflict probability × cost of a retry**:

- Low contention, cheap retries, long gaps between read and write → optimistic.
- Hot rows (a global counter, a popular flash-sale item), expensive work that you'd hate to redo, or side effects that can't be repeated → pessimistic, or redesign so the row isn't hot (sharded counters, queueing writes).

## Where it's used

| Context | Typical approach | Mechanism |
|---|---|---|
| Web form editing (CMS, admin panels) | Optimistic | Version column / `ETag` + `If-Match` |
| Kubernetes API objects | Optimistic | `resourceVersion`; 409 Conflict on stale update |
| Bank ledger transfer within one DB | Pessimistic (short) | `SELECT … FOR UPDATE` in consistent order |
| Postgres-backed job queues | Pessimistic, non-blocking | `FOR UPDATE SKIP LOCKED` |
| DynamoDB items | Optimistic | `ConditionExpression` on a version attribute |
| Distributed leader / cron singleton | Pessimistic lease | etcd/ZooKeeper lock + fencing token |
| Git push | Optimistic | Reject non-fast-forward; fetch, rebase, retry |

## Use case walk-through: concert ticket inventory

A ticketing service sells seats for a show. Most shows sell slowly; a few go on sale to 100k fans at once.

1. Normal shows use optimistic concurrency on the `sections` row: read `available = 120, version = 31`, write `available = 119, version = 32 WHERE version = 31`. Conflicts are rare and resolved by an immediate retry.
2. On a big on-sale, monitoring shows 70% of these updates returning 0 rows; each retry re-reads and collides again. CPU climbs while successful sales per second fall — a retry storm.
3. Switching to `SELECT … FOR UPDATE` serialises writers, ending wasted work, but now connections queue on one row lock and the pool saturates.
4. The team removes the hot spot instead: individual seats become rows, and a buyer claims one with `UPDATE seats SET holder = $1 WHERE id IN (SELECT id FROM seats WHERE show = $2 AND holder IS NULL LIMIT 1 FOR UPDATE SKIP LOCKED)`. Buyers lock different rows, so they don't contend.
5. The checkout step, which spans minutes of user think time, uses an optimistic version on the order so a stale browser tab can't double-submit.

**Result:** thousands of seats per second are allocated without retry storms or lock queues, and each phase uses the strategy matched to its conflict pattern.

## Pitfalls

- **Forgetting to check rows affected.** An optimistic `UPDATE … WHERE version = ?` that matches 0 rows is a silent no-op unless you check.
- **Reading outside the transaction, locking inside.** `FOR UPDATE` must cover the read you base decisions on.
- **Holding locks across I/O.** Network calls inside a pessimistic transaction turn latency spikes into lock pile-ups.
- **Unbounded optimistic retries.** Cap retries and add jitter; under heavy contention escalate to a lock or queue.
- **Distributed locks without fencing.** A paused process can believe it still holds an expired lease. Pass a monotonically increasing fencing token to the storage layer and reject stale tokens.
- **Timestamp versions with coarse clocks.** Two writes in the same millisecond share a version; prefer integers or hashes.

> [!TIP]
> Before choosing a lock, ask whether the change can be expressed as a single atomic statement (`SET x = x - 1 WHERE x > 0`) or protected by a unique constraint. Most race conditions in CRUD apps disappear that way.

## Discussion questions

1. Why doesn't Read Committed isolation prevent lost updates, and which isolation levels do?
2. In what circumstances does optimistic locking perform *worse* than pessimistic, and why?
3. How would you implement optimistic concurrency for a REST API whose clients are mobile apps that may be offline for hours?
4. Explain how `SKIP LOCKED` changes the semantics of a job queue compared with plain `FOR UPDATE`.
5. Why are fencing tokens necessary for distributed locks, and what component must enforce them?
6. How would you redesign a single global "likes" counter to avoid it being a hot row?

## FAQ

### Is optimistic locking really "lock-free"?
At the application level, yes — no lock is held between read and write. The database still takes a brief row lock while executing the conditional `UPDATE`, but only for the duration of that statement.

### Should I put a version column on every table?
On every table where entities are edited via read-modify-write, it's cheap insurance. Append-only or insert-only tables don't need it.

### What HTTP status should a version conflict return?
`412 Precondition Failed` when the client sent `If-Match`; many APIs (e.g. Kubernetes) use `409 Conflict` for version mismatches in the body. Use `428 Precondition Required` to force clients to send `If-Match`.

### Do NoSQL databases support pessimistic locking?
Few support long-lived row locks. Most offer conditional writes (optimistic) and some offer short transactions; pessimistic coordination is usually done with external leases.

### How do deadlocks relate to optimistic locking?
Optimistic writes don't wait on each other, so classic lock-wait deadlocks can't happen between them — but livelock (endless mutual retries) can, which jittered backoff prevents.

## Key takeaways

- Lost updates come from unprotected read-modify-write cycles.
- Pessimistic: lock first, others wait; simple correctness, but contention and deadlocks.
- Optimistic: version check at write; no waiting, but retries under contention.
- Optimistic fits long think times, HTTP (`ETag`/`If-Match`) and distributed stores.
- Prefer atomic statements and constraints when possible; redesign hot rows rather than fight over them.
- Always check rows-affected, cap retries, and use fencing tokens with distributed locks.

## References

- [PostgreSQL Documentation — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL Documentation — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [RFC 9110 — HTTP Semantics, conditional requests (If-Match, 412)](https://www.rfc-editor.org/rfc/rfc9110)
- Kung, H. T. & Robinson, J. T. — "On Optimistic Methods for Concurrency Control", ACM TODS, 1981
- Kleppmann, M. — *Designing Data-Intensive Applications*, O'Reilly, 2017, chapter 7
- [Martin Kleppmann — How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)

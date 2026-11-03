---
summary: Why opening a database connection per request caps throughput, how application-side pools and proxies like PgBouncer reuse connections, how to size a pool, and the failure modes (exhaustion, leaks, pool multiplication, transaction-mode surprises) that bite in production.
updated: 2026-11-02
---

> [!KEY]
> Opening a database connection is expensive: TCP and TLS round trips, authentication and, in PostgreSQL, a new backend process. A **connection pool** keeps a set of open connections and lends one to each request for as long as it needs it. Pools make short queries cheap. The catch is that the database can only do useful work on roughly as many connections as it has cores. Small pools beat big ones, and every app instance's pool multiplies against the database's limit. When you have many instances or serverless functions, put a **pooling proxy** (PgBouncer, RDS Proxy, pgcat) in front of the database to multiplex many clients onto a few server connections.

## The problem: the per-request connection tax

A web handler that connects, runs one query and disconnects looks harmless. Under load:

- **Most of the time goes on setup.** A 2 ms query pays several milliseconds of handshakes first, and more if the database is in another availability zone.
- **The database runs out of slots.** PostgreSQL's default `max_connections` is 100. MySQL's is 151. Past the limit, new connections are refused outright.
- **Each connection costs memory.** In PostgreSQL every connection is an operating-system process with its own memory for sorting and caching. Thousands of idle connections still consume RAM and slow down snapshot work.
- **Connection storms.** After a deploy or a database failover, every instance reconnects at once, which can knock over a database that was fine a moment ago.

## How it works

### Reuse instead of reconnect

![Connection cost vs pooled](/figures/conn-pool/cost.svg "Most of a short request is spent setting up the connection. A pool pays that cost once and lends the warm connection out.")

A pool holds open connections and hands them out:

1. **Borrow.** A request asks the pool for a connection. If one is idle it's returned immediately. If none is idle and the pool is below its maximum size, a new one is opened. Otherwise the request **waits** in a queue, up to a timeout.
2. **Use.** The request runs its queries, ideally inside one transaction.
3. **Return.** The connection goes back to the pool, after a reset so session state doesn't leak to the next borrower.

Pool libraries add housekeeping:

- **Validation:** checking a connection is alive before handing it out, or periodically.
- **Max lifetime:** retiring connections after, say, 30 minutes, so they rebalance after failovers and don't hit server-side idle timeouts.
- **Idle timeout and minimum idle:** shrinking the pool when it's quiet, while keeping a few warm.
- **Leak detection:** logging a stack trace when a connection has been borrowed for too long.

Common implementations are HikariCP (Java), `database/sql` (Go, built in), SQLAlchemy's pool (Python), and `pg.Pool` (Node).

### Pool size: smaller than you think

![Throughput vs pool size](/figures/conn-pool/sizing.svg "Throughput rises with pool size until the database's cores are busy, then falls as connections fight for locks, CPU and cache.")

A database can only execute as many things at once as it has CPU cores and I/O capacity. Extra connections don't add work capacity. They add:

- context switching between processes,
- contention on locks and shared buffers,
- cache misses.

Past the knee, throughput *drops*, and requests wait inside the database where you can't see them, instead of in the pool where waiting is cheap and measurable.

Two rules of thumb:

- **Database-side:** the PostgreSQL wiki suggests starting near `connections = (cores × 2) + effective_spindle_count` and measuring from there. On SSDs, the spindle count is small.
- **App-side, by Little's law:** connections needed ≈ queries per second × average time a connection is held. At 2,000 queries/s holding a connection for 5 ms, about 10 connections are busy on average. Add headroom for bursts.

If the pool is often exhausted, first find out *why connections are held so long*. Slow queries, transactions that wait on HTTP calls, and leaks are much more common causes than too small a pool.

### Pools multiply

![Pools multiply](/figures/conn-pool/multiply.svg "Forty app pods with a pool of 20 each open 800 connections against a limit of 100. A pooler multiplexes them onto 30 server connections.")

Every process has its own pool. The database sees the total:

- 40 pods × 20 connections = 800 connections.
- Autoscaling to 80 pods doubles that, at exactly the moment the database is busiest.
- Serverless functions are the extreme case: each concurrent invocation may open its own connection.

You can shrink the per-instance pool, but the real fix is a **pooling proxy** between the application and the database.

### Pooling proxies and their modes

A proxy such as **PgBouncer**, **pgcat**, **Odyssey**, **RDS Proxy** or **ProxySQL** (MySQL) accepts thousands of cheap client connections and multiplexes them onto a small set of real server connections. How long a client holds a server connection depends on the mode:

| Mode | Server connection held for | Trade-off |
|---|---|---|
| Session | The whole client connection | Fully compatible, but little multiplexing |
| Transaction | One transaction | The usual choice: high multiplexing |
| Statement | One statement | Highest multiplexing, but no multi-statement transactions |

Transaction mode breaks features that depend on **session state**, because the next transaction may run on a different server connection:

- `SET` without `LOCAL`, and session-level advisory locks,
- `LISTEN`/`NOTIFY`,
- temporary tables that live across transactions,
- protocol-level prepared statements. PgBouncer 1.21 and later can track these, if you enable `max_prepared_statements`.

### Where the pool lives

| Placement | Good for | Watch out for |
|---|---|---|
| In-process library | Long-lived servers with few instances | Multiplies with the instance count |
| Sidecar proxy per host | Many processes per machine (PHP-FPM, Python workers) | Still one pool per host |
| Central proxy | Many services, autoscaling, serverless | Another hop and another component to run with high availability |
| Managed proxy (RDS Proxy, Supabase Supavisor, Neon) | Serverless and edge functions | Pinning on session features and extra latency |

Many production setups use both: a small in-process pool talking to a central PgBouncer.

## Where it's used

| System | Pooling approach |
|---|---|
| Java services | HikariCP in-process, often in front of PgBouncer |
| Go services | `database/sql` built-in pool (`SetMaxOpenConns`, `SetConnMaxLifetime`) |
| Rails and Django | Per-process pools. Large fleets add PgBouncer |
| Serverless on AWS | RDS Proxy to absorb Lambda concurrency |
| Postgres platforms (Supabase, Neon, Heroku) | Built-in PgBouncer or Supavisor endpoints |
| HTTP clients | The same idea for outbound calls: keep-alive connection pools per host |

## Use case walk-through: the Black Friday connection wall

An e-commerce API runs on Kubernetes with 30 pods, each with a pool of 25. PostgreSQL has 16 cores and `max_connections = 500`. During a sale the autoscaler scales to 70 pods, and checkout starts failing with `FATAL: sorry, too many clients already`.

1. **Do the arithmetic.** 70 × 25 = 1,750 potential connections against a limit of 500. Even before the limit was hit, the database's CPU was saturated by 400 active backends contending for locks.
2. **Add PgBouncer in transaction mode**, with `default_pool_size = 40` per database and user pair, and `max_client_conn = 5000`. The pods connect to PgBouncer instead of the database.
3. **Shrink the app pools** to 10 per pod. With PgBouncer behind them, client connections are cheap.
4. **Fix the session-state breakages.**
   - A tenant-scoping `SET app.tenant_id` becomes `SET LOCAL` inside each transaction.
   - A `LISTEN`-based cache invalidator gets its own direct, session-mode connection.
5. **Shorten connection hold times.** Checkout had called the payment provider *inside* a database transaction. Moving the HTTP call outside the transaction cut the hold time from 400 ms to 15 ms.
6. **Add metrics and alerts.** Watch pool wait time, active vs idle connections, PgBouncer `cl_waiting`, and connection timeouts.

**Result:**
- The database holds a steady 40–60 server connections.
- p99 checkout latency falls from 2.1 s to 180 ms.
- Scaling to 120 pods the next year needs no database change.

## Pitfalls

- **Huge pools "for safety".** Hundreds of connections per instance just move the queue into the database and make performance worse.
- **Forgetting the multiplication.** Instances × pool size must stay under `max_connections`, including during deploys, when old and new pods overlap.
- **Holding a connection during slow work.** HTTP calls, file uploads or user think-time inside a transaction tie up a scarce connection. Borrow late and return early.
- **Connection leaks.** A code path that doesn't return a connection, usually on an error, slowly drains the pool. Use `try`/`finally` or `with` blocks, and turn on leak detection.
- **No acquire timeout.** Without one, requests queue forever when the pool is exhausted. Fail fast with a clear error instead.
- **Session state leaking between borrowers.** A `SET search_path` or an open transaction left on a returned connection affects the next request. Reset connections on return.
- **Stale connections after failover.** Without validation or a max lifetime, the pool keeps handing out connections to the old primary. Set a lifetime shorter than any firewall or load-balancer idle timeout.

> [!TIP]
> Alert on **pool wait time**, not just on errors. Rising wait time with a flat query time means connections are being held too long or the pool is too small. Rising query time means the database itself is the bottleneck, and a bigger pool will make it worse.

## Discussion questions

1. Why can increasing pool size reduce throughput? What resources are being contended?
2. Using Little's law, estimate the pool size for 3,000 queries per second at an average hold time of 8 ms. What would you check before trusting that number?
3. What features break under PgBouncer's transaction mode, and how would you migrate an application that uses them?
4. How do serverless functions change the connection-pooling problem, and what are the options?
5. A pool is exhausted but database CPU is at 20%. What are the likely causes, and how would you confirm them?
6. Where would you place pools in a system with 200 microservice pods and one PostgreSQL primary?

## FAQ

### Does every database need a pool?

Any database where connections are expensive and requests are short benefits. PostgreSQL benefits the most because of its process-per-connection model. MySQL uses threads, which are cheaper but still limited. Some HTTP-based databases, such as DynamoDB, don't have this problem, though the HTTP client should still reuse connections.

### What's the difference between PgBouncer and an in-app pool?

An in-app pool reuses connections within one process. PgBouncer sits between many processes and the database, multiplexing thousands of client connections onto a few server ones. It also protects the database from connection storms during deploys and autoscaling.

### Why do I get "prepared statement does not exist" errors behind PgBouncer?

In transaction mode, a statement prepared on one server connection may be executed on another. Enable PgBouncer's prepared-statement tracking (`max_prepared_statements`, version 1.21+), or disable server-side prepared statements in the driver.

### What should the pool's minimum idle size be?

For steady traffic, set it to the maximum (a fixed-size pool), which avoids the latency of opening connections during spikes. For bursty or serverless workloads, keep it low so idle instances don't hold connections.

### How do I know if my pool is too small?

Requests wait for connections, but the database has spare CPU and queries are fast. If queries are slow, or the database CPU is saturated, the pool is not the problem. Making it bigger will make things worse.

## Key takeaways

- Opening a connection costs far more than a typical short query. Pools amortise the cost by reusing warm connections.
- A database does useful work on roughly as many connections as it has cores. Small pools with queueing beat big pools.
- Pool size multiplies by instance count. Use a pooling proxy when there are many instances or serverless functions.
- PgBouncer's transaction mode multiplexes heavily but breaks session state. Audit for `SET`, `LISTEN`, advisory locks and prepared statements.
- Borrow late, return early, set acquire timeouts and max lifetimes, and monitor pool wait time.

## References

- PostgreSQL Wiki: [Number Of Database Connections](https://wiki.postgresql.org/wiki/Number_Of_Database_Connections)
- HikariCP: [About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- PgBouncer: [Features and pooling modes](https://www.pgbouncer.org/features.html) and [configuration](https://www.pgbouncer.org/config.html)
- AWS: [Amazon RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- Go: [Managing connections](https://go.dev/doc/database/manage-connections)
- John D. C. Little, "A Proof for the Queuing Formula: L = λW", *Operations Research*, 1961

---
summary: How SaaS systems serve many customers from one platform — shared tables, separate schemas or separate databases — and how to trade isolation against cost without leaking data.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — A multi-tenant system serves many customers (tenants) from one deployment. The core decision is **where the isolation boundary sits**: a **shared schema** with a `tenant_id` on every row (cheapest, densest, riskiest), a **schema per tenant** in one database (middle ground), or a **database per tenant** (strongest isolation, highest cost). Mature SaaS products mix them: pool the long tail of small tenants, give big or regulated customers their own silo. Whatever the model, resolve the tenant once from the authenticated identity, carry it through every layer, and let the database enforce it (e.g. row-level security) so one forgotten `WHERE` clause can't leak data.

## The problem: one product, thousands of customers

A SaaS app with 5,000 customers can't run 5,000 separate copies of itself — deploys, migrations and infrastructure would grow linearly with sales. But customers share nothing with each other: one customer must never see another's data, one customer's heavy report shouldn't slow everyone down, and an enterprise buyer may demand that their data lives in Frankfurt and can be deleted on request.

Multi-tenancy is the set of decisions about what tenants share (code, compute, database, tables) and how you keep them apart anyway.

## How it works

### The three data isolation models

![Isolation models](/figures/multi-tenancy/models.svg "Isolation, cost and operational effort rise together from left to right")

**Shared schema (pool).** All tenants live in the same tables; every row carries `tenant_id`, and every query filters on it. Indexes lead with `tenant_id` (`(tenant_id, created_at)`), and it's usually part of the primary or partition key.

- Cheapest per tenant; a free tier with 100k sign-ups is viable.
- One schema migration covers everyone.
- Risk: a single query missing `WHERE tenant_id = ?` leaks data across customers. Noisy neighbours compete for the same buffers, locks and I/O. Per-tenant backup/restore or deletion means surgical `DELETE`s.

**Schema per tenant (bridge).** One database, one schema (namespace) per tenant with identical tables; the connection sets `search_path` (PostgreSQL) or the app picks the schema name.

- Logical isolation without per-row filters; per-tenant dump/restore is easy.
- Migrations run N times and can partially fail. Catalog size grows with tenants × tables; tens of thousands of schemas strain tooling and the database itself.

**Database per tenant (silo).** Each tenant gets its own database, cluster, or even cloud account.

- Strongest blast-radius containment; per-tenant encryption keys, region, version pinning, and maintenance windows; easy deletion.
- Highest cost and operational load: you now run a fleet, so provisioning, migrations, monitoring and upgrades must be fully automated.

Isolation applies beyond the database too: shared vs per-tenant compute, queues, caches (namespace keys by tenant), search indexes, and object storage prefixes or buckets.

### Tenant context through the request

![Tenant context](/figures/multi-tenancy/request.svg "Resolve the tenant once at the edge; enforce it again at the data layer")

1. **Identify** the tenant from something trustworthy: the authenticated token's `tenant_id` claim, or the subdomain (`acme.app.com`) validated against the user's memberships — never a field in the request body.
2. **Load tenant metadata**: plan, feature flags, region, and which shard or database it lives on.
3. **Propagate** it in request-scoped context (and into async jobs, logs, metrics and traces).
4. **Route** to the correct pool, shard or database.
5. **Enforce** at the data layer. In PostgreSQL, row-level security does this declaratively:

```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- per request/transaction: SET LOCAL app.tenant_id = '…';
```

Now a query that forgets the filter returns nothing from other tenants instead of everything. ORM-level default scopes help too, but they're bypassed by raw SQL; RLS isn't (unless the role owns the table or has `BYPASSRLS` — so run the app as a non-owner role).

### Noisy neighbours and fairness

In pooled models, one tenant's bulk import can starve the rest. Common controls:

- **Per-tenant rate limits and quotas** at the API gateway, keyed by tenant rather than IP.
- **Fair queuing** for background work: per-tenant queues or weighted scheduling so one tenant's 1M jobs don't sit ahead of everyone else's 10.
- **Statement timeouts and resource groups** in the database; separate read replicas for heavy reporting.
- **Per-tenant metrics** (`tenant_id` as a label on request latency, DB time, queue depth) — you can't fix a neighbour you can't see. Beware cardinality: use top-N tenants or exemplars rather than a label on every metric if you have 100k tenants.

### Hybrid tiering and cells

![Hybrid tiering](/figures/multi-tenancy/hybrid.svg "Pool the long tail, silo the whales — the routing table decides")

Most large SaaS platforms end up hybrid: small tenants pooled into shards (shared schema), large or regulated tenants on dedicated databases — all running the same code and schema. A **tenant directory** maps `tenant_id → location`, so moving a tenant is a data copy plus a routing update. Taken further, **cell-based architecture** replicates the whole stack (app, DB, queues) into independent cells, each serving a subset of tenants, which caps the blast radius of any failure or bad deploy to one cell.

## Where it's used

| System | Model | Notes |
|---|---|---|
| Salesforce | Shared schema at massive scale | Metadata-driven; every row keyed by org ID |
| Slack | Sharded by workspace, enterprise grids isolated | Workspace ID routes to a shard |
| Shopify | Pods: groups of shops share a database shard | Shops move between pods; pods isolate failures |
| Citus / Azure Cosmos DB for PostgreSQL | Shared schema distributed by `tenant_id` | Co-locates a tenant's rows on one node |
| Atlassian Cloud, AWS (per-account) | Cell-based | Tenants assigned to independent cells |
| Enterprise-only B2B tools | Database or account per tenant | Compliance, data residency, customer-managed keys |

## Use case walk-through: a B2B invoicing SaaS

1. **Launch.** One PostgreSQL database, shared schema, `tenant_id` on every table, composite indexes leading with it. The tenant comes from the JWT; a middleware runs `SET LOCAL app.tenant_id` in each transaction and RLS policies guard every table.
2. **First incident.** A large customer's year-end export runs a 4-minute query that saturates I/O and slows every other tenant. The team adds per-tenant API quotas, moves exports to a background queue with per-tenant concurrency limits, and serves reports from a read replica.
3. **Growth.** At 20k tenants the single database is near its limits. They introduce a tenant directory and Citus-style sharding by `tenant_id`, so each tenant's data lives on one shard and joins stay local.
4. **Enterprise deal.** A bank requires EU-only storage and its own encryption keys. Because the directory already routes by tenant, the bank gets a dedicated database in an EU region running the same schema; provisioning and migrations are automated across all databases.
5. **Offboarding.** A churned tenant requests deletion. For silos, drop the database; for pooled tenants, a batched job deletes by `tenant_id` across every table, object-store prefix and search index, verified by a checklist generated from the schema.

**Result:** small tenants stay cheap, large ones get isolation they will pay for, and the same codebase serves both.

## Pitfalls

- **Trusting a client-supplied tenant ID.** Always derive it from authentication.
- **Global uniqueness surprises.** Unique constraints on `email` or `invoice_number` usually need to be `(tenant_id, …)`.
- **Caches and search without tenant scoping.** A cache key `user:42` collides across tenants; prefix everything.
- **Background jobs losing context.** Jobs must carry the tenant ID explicitly and re-establish it before touching data.
- **Cross-tenant admin tools** that bypass RLS with a superuser — audit and restrict them.
- **Schema-per-tenant at very large N.** Migration time, catalog bloat, and connection pool fragmentation grow with every tenant.
- **Unbounded per-tenant metrics labels** that explode your monitoring bill.

> [!WARNING]
> Data leaks between tenants are the worst class of SaaS bug — often a reportable breach. Put at least two independent safeguards in place (e.g. query scoping in the app *and* row-level security in the database) and add automated tests that try to read another tenant's data.

## Discussion questions

1. What are the trade-offs between identifying tenants by subdomain versus by a claim in the access token?
2. How would you move a tenant from a pooled shard to a dedicated database with minimal downtime?
3. Why should `tenant_id` lead composite indexes in a shared-schema design?
4. How do you run a schema migration safely across 3,000 tenant databases?
5. What metrics would reveal a noisy neighbour, and how would you attribute database load to tenants?
6. How does cell-based architecture change the blast radius of a bad deploy compared with a single pooled cluster?

## FAQ

### Which model should a new startup choose?
Almost always a shared schema with a `tenant_id` everywhere and row-level security from day one. It's the cheapest to run and easiest to evolve; add a tenant directory early so you can later move big tenants to their own shard or database.

### Does row-level security hurt performance?
The policy becomes an extra predicate in each query. With `tenant_id` leading your indexes the overhead is usually small; check plans for policies with complex functions or subqueries.

### How do I handle a user who belongs to several tenants?
Model memberships (`user_id, tenant_id, role`). The user picks or the URL indicates the active tenant, and the server verifies membership before issuing a tenant-scoped token or session.

### How is multi-tenancy different from multi-instance?
Multi-instance (single-tenant) runs a separate copy of the application per customer. It's maximally isolated but every deploy, upgrade and monitor multiplies by the number of customers.

### How do I bill or cap usage per tenant?
Meter at the edge (requests, API calls) and at resource layers (storage bytes, job minutes), tag everything with `tenant_id`, and aggregate into a usage pipeline that enforces quotas and feeds billing.

## Key takeaways

- The isolation boundary — rows, schemas, or databases — sets your cost, risk and operational load.
- Shared schema scales cheapest; database-per-tenant isolates best; hybrids give each tenant the tier it needs.
- Resolve tenant identity from authentication, propagate it everywhere, enforce it in the database.
- Control noisy neighbours with per-tenant quotas, fair queues and per-tenant observability.
- A tenant directory makes moving tenants between pools, silos and cells a routing change.

## References

- [AWS — SaaS Tenant Isolation Strategies (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/saas-tenant-isolation-strategies.html)
- [AWS Well-Architected — SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html)
- [PostgreSQL Documentation — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Microsoft Azure Architecture Center — Architectural approaches for multitenancy](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/overview)
- [Citus Documentation — Multi-tenant applications](https://docs.citusdata.com/en/stable/use_cases/multi_tenant.html)
- Golding, T. — *Building Multi-Tenant SaaS Architectures*, O'Reilly, 2024

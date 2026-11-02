---
summary: How splitting a service into many independent, full-stack cells, each serving a fixed slice of customers, caps the blast radius of bad deploys, poison requests and overload, and what it costs in routing, migration and operations.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** In a **cell-based architecture**, instead of one large deployment serving everyone, you run many **cells**: complete, independent copies of the service stack (load balancers, application servers, caches, databases), each serving a **fixed subset of customers** chosen by a **partition key** such as customer or tenant ID. A thin **cell router** sends each request to its cell. Failures, whether a bad deploy, a poison-pill request, a noisy tenant, or a database meltdown, stay inside one cell, so they affect a **fraction** of customers instead of all of them. Cells also give you a **fixed maximum size** you can load-test, and natural units for **progressive deployment**. The costs: a router that must be extremely reliable, cross-cell operations that get harder, customer migration between cells, and more infrastructure to manage. **Shuffle sharding** extends the idea so that two customers rarely share the same set of resources.

## The problem: shared fate

Most systems scale by making one deployment bigger: more servers behind the load balancer, a bigger database cluster, more cache nodes. Everything is shared, so every customer shares the fate of every failure:

- A **bad deploy** or configuration change reaches all servers and breaks everyone.
- A **poison-pill request** (a malformed input that crashes the process) is retried by clients and load balancers across every server until the whole fleet is crashing.
- A **noisy tenant** saturates a shared database or queue, slowing everyone.
- **Scale limits** appear only at full size: the largest deployment is the one you've never tested at that size.

Redundancy (multiple AZs, replicas) protects against **infrastructure** failures, but not against failures that arrive through the software or the workload itself, because every replica runs the same code and receives the same requests.

## Cells

![Left: a shared stack where one failure affects all customers. Right: eight cells, one failed, affecting 12.5% of customers.](/figures/cells/blast-radius.svg "Cells turn 'everyone is down' into 'some customers are down', which is a much smaller incident.")

A cell is:

- **Complete:** it contains everything needed to serve its customers' requests, without calling into other cells.
- **Independent:** cells share no databases, caches or queues. Ideally they share nothing at all except the router and some global control-plane services.
- **Bounded:** each cell has a maximum size (customers, traffic, data). You grow by adding **cells**, not by growing cells.
- **Identical:** every cell runs the same code and configuration (at steady state), so what you test on one applies to all.

The **blast radius** of any failure that's contained in a cell is `1 / number of cells` of customers. With 20 cells, a cell-wide outage affects 5%.

### The cell router

![A request with customer_id=8812 reaches the cell router, which looks up cell 3 in a replicated cell map and forwards the request to cell 3.](/figures/cells/router.svg "The router is the one component every request touches, so it should do almost nothing.")

The router (sometimes called the cell gateway or "thinnest possible layer") maps each request to its cell:

- Extract the **partition key** (account ID, tenant ID, from a header, the hostname, or a token).
- Look it up in a **cell map** (customer → cell), cached locally and refreshed from a highly available store.
- Forward the request.

The router is shared by every cell, so it's the main remaining single point of shared fate. Keep it **stateless**, **minimal** (no business logic), **heavily cached**, and changed rarely and carefully. Alternatives that avoid an explicit router: DNS (`tenant123.app.example.com` resolves to its cell), or clients that learn their cell once and connect directly.

### Choosing the partition key

- The key must route **almost every request** to a single cell. Customer, account, or tenant ID usually works for B2B SaaS. For consumer products, it might be user ID, with care for interactions between users in different cells.
- **Large customers** may need dedicated cells, or one customer may need to span several (which weakens isolation for them).
- **Cross-cell operations** (global search, a user messaging another user in a different cell, billing across all customers) need a separate path: asynchronous replication into a global store, or a fan-out query layer.

## Shuffle sharding

![Eight workers; customer A is assigned w1 and w4, B is assigned w4 and w6, C is assigned w2 and w7; when A's poison requests crash w1 and w4, B is degraded but still served by w6, and C is unaffected.](/figures/cells/shuffle-sharding.svg "Combinatorics does the isolation: the number of possible pairs grows much faster than the number of workers.")

Cells assign each customer to exactly one partition, so all customers in a cell share its fate. **Shuffle sharding** (popularized by AWS) assigns each customer a **random combination** of k workers out of n:

- With 8 workers and k = 2, there are C(8,2) = **28** distinct pairs. A poison-pill customer that crashes its 2 workers fully affects only customers with the exact same pair, about 1 in 28, while others that share one worker degrade but keep working (if clients retry on another worker).
- With 100 workers and k = 5, there are about **75 million** combinations. Practically every customer has a unique set.

Amazon Route 53 assigns each hosted zone a shuffle shard of 4 name servers out of thousands, so a DDoS against one customer's domain rarely affects others. Shuffle sharding and cells combine well: cells contain shared-fate failures, and shuffle sharding within cells (or across workers) reduces overlap further.

## Deploying cell by cell

![A change goes to a canary cell, then 2 cells, then 8 cells, then the rest, with bake time and health checks between waves.](/figures/cells/deploy-waves.svg "Cells make progressive delivery natural: each wave is a set of cells.")

Cells are a natural unit for **progressive delivery**:

1. Deploy to **one canary cell** (often one with internal or low-risk customers).
2. **Bake** for a while, watching error rates, latency and business metrics, with automated rollback.
3. Widen to a few cells, then more, then the rest, in waves.

Many large outages are caused by **configuration** and **feature flag** changes rather than code, so those should follow the same waves. AWS describes deploying to one Availability Zone and one cell at a time, with bake times measured in hours for critical services.

## Benefits and costs

| Benefit | Cost |
| --- | --- |
| Failures contained to one cell | More infrastructure, and some fixed overhead per cell |
| Known maximum scale per cell, which can be load-tested | Router and cell map are critical shared components |
| Natural deployment waves and canaries | Cross-cell features (search, analytics, social features) are harder |
| Noisy tenants affect only their cell | Rebalancing customers between cells requires data migration |
| Capacity added by stamping out new cells | Tooling to manage many cells (deploys, observability, upgrades) |
| Can place cells in specific regions for data residency | Very large customers may not fit one cell |

### Sizing cells

- **Too few, large cells:** each failure affects many customers, and cells may hit untested scale limits.
- **Too many, small cells:** high overhead, poor utilization, and more operational work.
- Typical practice: size cells so each is comfortably within tested limits, and so losing one is an acceptable fraction (often a few percent) of the business.

### Moving customers between cells

Cells fill up, and customers grow. Migration usually means: copy the customer's data to the new cell, replicate changes, briefly pause or dual-write, flip the cell map entry, and drain old connections. It needs to be routine and automated, because you'll do it often.

## Where it's used

| Organization | How |
| --- | --- |
| **AWS** | Many services are cellular internally (e.g. parts of EC2, Route 53 with shuffle sharding). AWS publishes guidance on cell-based architecture in the Well-Architected framework. |
| **Slack** | Moved to a cellular architecture aligned with availability zones, so it can drain traffic away from a failing AZ |
| **Salesforce** | "Pods" (instances such as NA44), each a full stack serving a set of orgs |
| **Shopify** | Pods: isolated sets of datastores serving a subset of shops, with a routing layer |
| **Roblox** | Has described moving its infrastructure to cells to limit blast radius |
| **Azure** | Deployment stamps pattern for multi-tenant SaaS |

### Use case walk-through: cellularizing a B2B SaaS

A SaaS product with 20,000 tenants runs one big deployment, and a single tenant's bulk import recently took the database down for everyone.

1. **Partition key:** `tenant_id`, already present in every request (subdomain + token).
2. **Cell design:** a cell = Kubernetes namespace + app deployment + Redis + PostgreSQL cluster + queue, sized for ~1,000 tenants and load-tested at 2× expected peak.
3. **Router:** an edge proxy that maps subdomain → cell from a replicated, cached table. No other logic.
4. **Migration:** move tenants in batches with logical replication, then flip the map. The biggest tenants get dedicated cells.
5. **Global services:** billing and analytics read from per-cell event streams, not from cell databases directly.
6. **Deploys:** an internal cell first, then waves of 1, 3, 10, then the rest, with automated rollback.
7. **Result:** the next runaway bulk import affects only one cell (~5% of tenants), and on-call has a clear lever: drain or throttle that cell.

## Pitfalls

- **Hidden shared dependencies.** A global auth service, configuration store, or shared database for "just this one table" reintroduces shared fate. Audit what cells call.
- **A smart router.** Business logic in the router makes it a frequent-change, high-risk shared component.
- **Cells that drift.** Manual changes to one cell make cells behave differently. Treat them as cattle, managed by automation.
- **Deploying to all cells at once,** which removes the main benefit.
- **No migration tooling,** so cells become unbalanced and the biggest customers outgrow their cells.

> [!WARNING]
> Cells don't help with failures **outside** the cells, such as the router, DNS, a shared identity provider, or a cloud region outage. Map every dependency on the request path and decide which are acceptable shared fate.

## Discussion questions

1. What partition key would you use to cellularize your product, and which features would need cross-cell access?
2. How would you size cells? What fraction of customers is it acceptable to lose at once?
3. Why should the cell router be as simple as possible?
4. How does shuffle sharding reduce the impact of a poison-pill customer compared with plain cells?
5. Design a process for moving a large tenant from one cell to another with minimal downtime.
6. Which global services in your architecture would still be shared fate after cellularization?

## FAQ

### How is a cell different from a shard?

A **shard** usually partitions one component, typically the database. A **cell** partitions the **whole stack**: application servers, caches, queues and databases. A shard failure can still be amplified by shared application servers (a slow shard exhausting a shared thread pool). A cell failure stays in the cell.

### How is a cell different from a region or availability zone?

Regions and AZs are **infrastructure** failure domains. Cells are **logical** failure domains for software and workload failures. A cell typically spans several AZs for infrastructure redundancy, and a region contains many cells.

### Do I need cells for a small system?

Usually not. Cells add operational overhead that pays off when the cost of a total outage is high, the customer base is large, and you've seen (or fear) failures that redundancy doesn't prevent: bad deploys, poison pills, noisy tenants.

### What about cross-cell communication?

Keep it **asynchronous** and **optional** for the request path where possible: replicate the data each cell needs, or use a global read-only index. If a request truly needs another cell, it calls through the router like any client, accepting that its availability now depends on both cells.

### Is shuffle sharding only for stateless services?

It's easiest for stateless workers, such as request handlers and name servers, where any assigned worker can serve the request. For stateful data, it applies to replica placement: each customer's data on a different combination of nodes, which reduces correlated failures.

## Key takeaways

- **Cells** are independent, full-stack copies of a service, each serving a fixed subset of customers.
- They limit **blast radius** to one cell, give a **tested maximum scale**, and enable **cell-by-cell deployment**.
- The **router** is the critical shared piece, so keep it stateless, cached and simple.
- **Shuffle sharding** assigns random combinations of resources, making full overlap between customers rare.
- Costs: cross-cell features, customer migration, more infrastructure, and the discipline to avoid hidden shared dependencies.

## References

1. AWS Well-Architected. [Reducing the Scope of Impact with Cell-Based Architecture](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/reducing-scope-of-impact-with-cell-based-architecture.html).
2. C. MacCárthaigh. [Workload isolation using shuffle-sharding](https://aws.amazon.com/builders-library/workload-isolation-using-shuffle-sharding/). Amazon Builders' Library.
3. P. Vosshall (AWS re:Invent 2018). [How AWS Minimizes the Blast Radius of Failures (ARC338)](https://www.youtube.com/watch?v=swQbA4zub20).
4. Slack Engineering. [Slack's Migration to a Cellular Architecture](https://slack.engineering/slacks-migration-to-a-cellular-architecture/). 2023.
5. Shopify Engineering. [A Pods Architecture To Allow Shopify To Scale](https://shopify.engineering/a-pods-architecture-to-allow-shopify-to-scale). 2018.
6. Microsoft Azure Architecture Center. [Deployment Stamps pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/deployment-stamp).
7. AWS Builders' Library. [Automating safe, hands-off deployments](https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/).

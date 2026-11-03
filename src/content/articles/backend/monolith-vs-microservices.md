---
summary: Microservices trade in-process simplicity for independent deployment and team autonomy — a good deal for large organizations, an expensive one for small teams.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — Microservices are primarily a solution to an **organizational** problem: many teams stepping on each other in one codebase and one release train. They buy independent deployment, scaling and technology choice, and they charge a **distributed-systems tax** — network latency, partial failure, eventual consistency, harder debugging and more operations. Most teams should start with a **modular monolith** with strong internal boundaries, and extract services only when a specific boundary has a specific reason to be separate.

## The problem: one codebase, many teams

A monolith is a single deployable unit: one codebase, one build, usually one database. For a small team, it's the fastest way to build software. Function calls are nanoseconds, transactions are ACID, refactoring is a find-and-replace, and there's one thing to deploy and monitor.

The pain arrives with growth, and it's mostly *people* pain:

- **Merge and release contention.** Fifty engineers share one release train; a bug in checkout blocks a payments fix from shipping.
- **Blurred ownership.** Any module can call any other module's internals, so nobody can change anything safely.
- **Build and test times.** A full CI run takes 45 minutes because everything is tested together.
- **One-size-fits-all scaling.** The image-resizing endpoint needs 64 GB of RAM, so every instance gets 64 GB.
- **Technology lock-in.** Everything must use the same language, framework version and libraries.

Microservices promise to fix these by giving each team its own independently deployable service. They do — at a price that is easy to underestimate.

## How it works

### Three points on a spectrum, not two

The debate is usually framed as monolith *versus* microservices, but there's a well-trodden middle ground.

![Three architectures: a monolith with tangled modules, a modular monolith with enforced boundaries, and microservices connected over the network](/figures/monolith-microservices/spectrum.svg "The modular monolith keeps one deployable but enforces boundaries between modules, so the coupling problem is solved without the network.")

- **Monolith (big ball of mud).** One deployable, one database, no enforced internal boundaries. Coupling grows silently.
- **Modular monolith.** Still one deployable, but split into modules aligned with bounded contexts. Each module owns its tables and exposes a narrow interface; dependency rules are enforced by tooling (Java modules, Packwerk for Rails, ArchUnit, import linters, Nx boundaries). Shopify famously runs one of the largest Rails apps this way.
- **Microservices.** Each bounded context is a separately deployed process with its own database, communicating via HTTP/gRPC or messaging.

Notice that most of the *design* benefits people attribute to microservices — clear boundaries, ownership, encapsulated data — come from **modularity**, not from the network. What the network adds is *independent deployment, scaling and failure isolation*.

### What microservices actually buy you

- **Independent deployability.** A team ships when its service is ready, not when the release train leaves. This is the core benefit; if your services must be deployed together, you have a *distributed monolith* — all of the costs and none of the benefits.
- **Team autonomy.** Small teams own a service end to end (code, data, on-call). Conway's law works for you instead of against you.
- **Independent scaling.** Scale the search service to 40 instances and the admin service to 2.
- **Fault isolation (if designed for it).** A crash in recommendations need not take down checkout — *if* callers have timeouts, circuit breakers and fallbacks.
- **Technology heterogeneity.** Use Python for the ML service and Go for the gateway. Useful, but often overrated; most companies standardize anyway.

### The distributed systems tax

Every boundary you move onto the network turns a function call into a remote call, and remote calls behave differently.

![Table comparing monolith and microservices across latency, failure, consistency, queries, debugging, change and operations](/figures/monolith-microservices/tax.svg "Every row has a known solution — and every solution is another system to build, run and debug.")

- **Latency.** An in-process call costs nanoseconds; a network hop costs a millisecond or more, plus serialization. A request that fans out through six services pays it six times, and tail latencies compound.
- **Partial failure.** The callee may be slow, down, or have processed your request but lost the response. You need timeouts, retries with backoff, idempotency keys and circuit breakers.
- **Consistency.** You can no longer wrap "create order and reserve stock" in one database transaction. You need sagas, the transactional outbox and tolerance for eventual consistency.
- **Queries.** A `JOIN` across two services' data becomes API composition or a replicated read model.
- **Debugging.** A stack trace becomes a distributed trace across many logs; you need correlation IDs and tracing from day one.
- **Change.** A refactor across a boundary becomes a versioned API contract change with ordered rollouts and backward compatibility.
- **Operations.** N services means N pipelines, N dashboards, N on-call rotations, service discovery, maybe a service mesh, and a platform team to make it all bearable.

None of these is unsolvable. But each is a new system, and small teams can end up spending more time on the platform than on the product.

### Where to draw service boundaries

Good service boundaries follow **bounded contexts** from domain-driven design: areas where a model and its language are consistent, owned by one team, and change for their own reasons. Signs of a bad boundary:

- Two services must always be deployed together (distributed monolith).
- One user action requires a synchronous chain of five services (chatty boundary).
- Services share a database, so a schema change needs both teams (hidden coupling).
- A "service" maps to a single entity (`UserService`, `ProductService`) that every other service calls.

The **database-per-service** rule is the acid test. If services can read each other's tables, the boundary exists only on the architecture diagram.

### Migrating: the strangler fig

Rewriting a monolith from scratch is the classic high-risk move. The **strangler fig** pattern (named by Martin Fowler after vines that slowly envelop a host tree) migrates incrementally.

![Strangler fig migration: put a proxy in front, extract one context at a time, and the monolith shrinks](/figures/monolith-microservices/strangler.svg "Route traffic through a facade, extract one bounded context at a time, and keep the ability to roll back by flipping a route.")

1. Put a proxy or API gateway in front of the monolith.
2. Pick one context with a clear boundary and its own change cadence; build it as a service (often after first modularizing it inside the monolith).
3. Move its data out, typically via change data capture or dual-writes with an outbox during the transition.
4. Route its traffic to the new service; keep the old path as a fallback.
5. Repeat — or stop. Many companies end with a few services around a healthy core monolith, and that's a fine outcome.

## Where it's used

| Organization / setting | Architecture | Why |
|---|---|---|
| Early-stage startups | Monolith | Speed of iteration; product is still being discovered |
| Shopify | Modular monolith (plus some services) | Enforced component boundaries without the network tax |
| Amazon, Netflix | Microservices | Thousands of engineers, need for team autonomy and independent scaling |
| Segment (2018) | Moved back from ~140 services to a monolith | Operational overhead outweighed benefits for a small team |
| Amazon Prime Video monitoring (2023) | Moved a serverless/microservice pipeline to a single process | Data transfer between components dominated cost |
| Regulated enterprises | Mix | Isolate high-compliance contexts (payments, PII) as separate services |

## Use case walk-through: a 60-engineer SaaS deciding what to do

A B2B SaaS has a six-year-old Django monolith, 60 engineers in 8 teams, deploys twice a week, and an incident rate that rises with every release.

1. **Diagnose the real pain.** Interviews show: release contention (teams wait days to ship), unclear ownership of shared models, and one heavy PDF-reporting workload that slows the API under load.
2. **Separate org problems from tech problems.** Release contention and ownership are organizational; the PDF workload is a scaling problem.
3. **Modularize first.** They map bounded contexts (Accounts, Billing, Projects, Reporting, Notifications), move code into modules with their own tables, and add an import-linter rule that fails CI on cross-module internal imports.
4. **Fix the release train.** Feature flags plus trunk-based development let them deploy daily from the monolith; contention drops without any new service.
5. **Extract where there's a specific reason.** Reporting moves out as a service consuming events, scaled on its own worker pool so PDF bursts no longer hurt API latency. Notifications follows because it integrates with many third parties and fails in different ways.
6. **Invest in the platform for the services that exist.** Tracing, a service template, and standard timeouts/retries — but only for two services, not thirty.

**Result:** deploys go from twice a week to several a day, API p99 latency stabilizes, and the team avoids a two-year "microservices rewrite" while keeping the option to extract more later.

## Pitfalls

- **Starting with microservices.** Boundaries drawn before you understand the domain are usually wrong, and they're expensive to move once they're network boundaries.
- **The distributed monolith.** Services that share a database, deploy together or call each other synchronously in long chains.
- **Nanoservices.** One service per function or entity; the overhead per service dwarfs the logic inside it.
- **Synchronous everything.** A chain of blocking calls multiplies latency and failure probability. Prefer async events where the business allows it.
- **Underinvesting in the platform.** Without CI/CD templates, observability and service discovery, every team reinvents them badly.
- **Ignoring data ownership.** Moving code into a service without moving its data just relocates the coupling.
- **Résumé-driven architecture.** Choosing microservices because big tech uses them, not because your org has their problem.

> [!WARNING]
> If you can't deploy one service without deploying another, you don't have microservices — you have a monolith with network calls in the middle. Fix the coupling (contracts, versioning, data ownership) before adding more services.

## Discussion questions

1. Which problems in your current system are organizational and which are technical? Which would microservices actually fix?
2. What would it take to enforce module boundaries in your codebase without splitting it into services?
3. How many services can your team realistically operate, given on-call and platform capacity?
4. Pick a cross-boundary workflow in your system. How would it handle partial failure if the boundary became a network call?
5. Why do companies like Segment move back to a monolith, and what signals should prompt that decision?
6. How should team structure change before, during and after a migration to services?

## FAQ

### How many engineers do you need before microservices make sense?

There's no magic number, but the benefits show up when multiple teams contend for the same codebase and release process — often somewhere past a few teams or a few dozen engineers. A single team rarely gains enough from independent deployment to pay the operational cost.

### Can microservices share a database?

They can, but they shouldn't share *tables*. Sharing a database server with separate schemas or credentials per service is a reasonable cost saving; letting services read each other's tables couples their schemas and defeats independent deployment.

### Is serverless the same as microservices?

No. Serverless is a deployment and billing model (functions or containers scaled by the platform). You can build a monolith on serverless or microservices on VMs. Serverless often pushes toward many small units, which brings the same distribution costs.

### What's the difference between SOA and microservices?

Service-oriented architecture (2000s) often centralized integration through an enterprise service bus with shared schemas and smart middleware. Microservices favor "smart endpoints, dumb pipes": decentralized data, lightweight protocols and independent teams. The ideas overlap heavily; the emphasis on team autonomy and independent deployment is the main difference.

### Should I ever merge services back together?

Yes, if two services always change together, chat constantly, or are owned by the same small team. Merging is a legitimate refactoring — boundaries should follow how the business and teams actually work, which changes over time.

## Key takeaways

- Microservices mainly solve **organizational scaling**: independent deployment and team autonomy.
- They charge a **distributed-systems tax** in latency, failure handling, consistency, debugging and operations.
- A **modular monolith** delivers most of the design benefits without the network; start there.
- Draw service boundaries around **bounded contexts** and give each service its own data.
- Migrate with the **strangler fig**, one context at a time, and stop when the remaining monolith is healthy.

## References

- [Martin Fowler — MonolithFirst](https://martinfowler.com/bliki/MonolithFirst.html)
- [Martin Fowler — StranglerFigApplication](https://martinfowler.com/bliki/StranglerFigApplication.html)
- [James Lewis and Martin Fowler — Microservices](https://martinfowler.com/articles/microservices.html)
- Sam Newman, *Building Microservices*, 2nd ed., O'Reilly, 2021.
- Sam Newman, *Monolith to Microservices*, O'Reilly, 2019.
- Shopify Engineering, "Deconstructing the Monolith: Designing Software that Maximizes Developer Productivity," 2019.
- Segment Engineering, "Goodbye Microservices: From 100s of problem children to 1 superstar," 2018.
- Amazon Prime Video Tech, "Scaling up the Prime Video audio/video monitoring service and reducing costs by 90%," 2023.

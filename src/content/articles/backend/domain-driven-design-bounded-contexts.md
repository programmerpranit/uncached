---
summary: Bounded contexts draw service boundaries around how the business talks and changes, not around database tables — so one word can safely mean different things in different places.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — Domain-driven design (DDD) says the hardest part of software is the *domain*, not the technology. Its most useful idea is the **bounded context**: an explicit boundary inside which every term has one precise meaning and one model. "Product" in Catalog, "stock item" in Inventory and "line item" in Billing are different models that share only an ID. Draw services around those boundaries, connect them with deliberate relationships (a **context map**), and protect business rules inside small consistency units called **aggregates**.

## The problem: one model to rule them all

Most systems start with a single database schema and a single `Product` or `Customer` class that every feature touches. It feels efficient: one source of truth, no duplication. Then it rots.

- **Marketing** wants products to have rich descriptions, images, SEO slugs and variants.
- **The warehouse** cares about bin locations, weight, reorder thresholds and lot numbers.
- **Finance** cares about tax codes, revenue recognition and the price *at the time of sale*.
- **Shipping** cares about dimensions, hazardous-material flags and which carrier accepts it.

Cram all of that into one `products` table and every team edits the same class, every migration needs four teams to agree, and "product" stops meaning anything specific. A change for the warehouse breaks an invoice. The same thing happens to `User` (an account? a customer? a shopper? a payer?) and `Order`.

Splitting that system into microservices *by table* — a "product service", a "customer service" — doesn't help. You've just put the god-object behind a network call. DDD offers a different cut: split by **meaning**.

## How it works

### Ubiquitous language

DDD starts with language. Developers and domain experts agree on a shared vocabulary and use it *everywhere* — in conversation, in tickets, in class names, in table names and in events. If the business says a customer "places" an order that is later "fulfilled", the code says `placeOrder` and `OrderFulfilled`, not `createOrderRecord` and `status = 3`.

The catch, and the key insight, is that a language is only ubiquitous **within a boundary**. Warehouse staff and accountants genuinely use the same word differently, and forcing one definition on both just produces a definition nobody uses.

### Bounded contexts

A **bounded context** is the boundary inside which a particular model and its language apply consistently. Outside it, the same word may mean something else — and that's fine, because the boundary makes the translation explicit.

![Four bounded contexts each with their own model of a product: Catalog Product, Inventory Stock item, Billing Line item and Shipping Parcel, sharing only the product ID](/figures/ddd-contexts/contexts.svg "The same real-world thing, four models. Each context keeps only the attributes and rules it needs; they share an identifier, not a class.")

Each context owns its model and its data. Catalog never reads Inventory's tables; if it needs to show "in stock", it asks Inventory or listens to Inventory's events. A bounded context is a *linguistic and model* boundary first. It is often — but not necessarily — also a deployment boundary (one service, one team, one database).

How do you find the boundaries? Some reliable signals:

- **Language shifts.** When the same word starts needing qualifiers ("the shipping address vs the billing address", "the order as placed vs the order as shipped"), you may be crossing a boundary.
- **Different experts.** If different people answer questions about different parts, those parts likely belong to different contexts.
- **Different rates of change.** Pricing rules change weekly; tax rules change yearly; identity rarely changes. Things that change together belong together.
- **Different consistency needs.** Inventory reservations must be strongly consistent; recommendation data can be hours stale.

### Subdomains: where to invest

DDD separates the *problem space* (subdomains of the business) from the *solution space* (bounded contexts in the software). Subdomains come in three kinds:

| Kind | What it is | Strategy |
|---|---|---|
| **Core** | What differentiates the business — pricing engine for an airline, matching for a marketplace | Build in-house, put your best people on it, model it richly |
| **Supporting** | Necessary and specific to you, but not a differentiator — internal back-office workflows | Build simply, or outsource |
| **Generic** | Solved problems every company has — identity, payments, email | Buy or use open source |

This classification is DDD's most underrated tool. It tells you where elaborate modeling pays off (core) and where it is waste (generic). Building your own auth system with aggregates and domain events is a classic DDD mistake.

### Context maps: how contexts relate

Contexts don't live in isolation; orders need billing, billing needs customer data. A **context map** draws the contexts and names the *relationship* between each pair — which is as much about team politics and power as about integration technology.

![Context map: Ordering core context publishes events to Billing, has a customer/supplier relationship with Shipping, Legacy ERP connects to Billing through an anti-corruption layer, and Identity is an open host service that Shipping conforms to](/figures/ddd-contexts/context-map.svg "A context map names each relationship. The pattern tells you who adapts to whom and where translation lives.")

The common patterns:

- **Customer–supplier.** The downstream (customer) team's needs feed into the upstream (supplier) team's planning. Works when the teams cooperate and share priorities.
- **Conformist.** The downstream simply adopts the upstream model as-is, because it has no leverage (a big platform team, an external vendor). Cheap, but you inherit their language.
- **Anti-corruption layer (ACL).** The downstream builds a translation layer so the upstream's model — typically a legacy system or a messy third-party API — can't leak in. The ACL converts `ERP_CUST_MSTR.CUST_STAT_CD = 'A'` into `Customer.isActive`.
- **Open host service (OHS) + published language.** The upstream offers a well-documented, stable protocol for many consumers (a public API, a versioned event schema) rather than custom integrations for each.
- **Shared kernel.** Two contexts deliberately share a small piece of model (say, a `Money` type) and agree to change it together. Use sparingly — it's coupling by design.
- **Separate ways.** Integration costs more than it's worth; each context solves the problem independently.
- **Partnership.** Two teams succeed or fail together and coordinate releases closely.

Drawing an honest context map of an existing system is often the single most clarifying exercise a team can do: it shows where models are leaking, which team is silently conforming, and where an ACL is missing.

### Inside a context: entities, value objects and aggregates

Within a context, DDD's *tactical* patterns give the model structure:

- **Entity** — has identity that persists over time; two orders with the same contents are still different orders.
- **Value object** — defined entirely by its attributes, immutable, interchangeable: `Money(42.00, "EUR")`, `Address`, `DateRange`. Replacing primitives with value objects removes whole classes of bugs (adding euros to dollars, a negative quantity).
- **Aggregate** — a cluster of entities and value objects treated as **one unit of consistency**, with a single **root** that all outside access goes through.

![Order aggregate: Order root owning two OrderLines and a ShippingAddress, enforcing invariants, referencing the Customer aggregate by ID only, and emitting an OrderPlaced event consumed by Billing, Shipping and Inventory](/figures/ddd-contexts/aggregate.svg "An aggregate is a consistency boundary. The root enforces invariants in one transaction; other aggregates are referenced by ID; other contexts learn about changes through events.")

Aggregate rules of thumb (from Vaughn Vernon's guidance):

1. **Protect true invariants inside the boundary.** "Order total equals the sum of its lines" and "a paid order can't be modified" are enforced by the `Order` root, so no code path can bypass them.
2. **Design small aggregates.** Big aggregates mean big locks and contention. `Customer` should not contain all their `Order`s.
3. **Reference other aggregates by ID.** `Order` holds a `customerId`, not a `Customer` object.
4. **One aggregate per transaction; eventual consistency between them.** If placing an order should reserve stock, the `Order` aggregate emits `OrderPlaced` and Inventory reacts — rather than one transaction spanning both.

### Domain events

A **domain event** records something that happened that the business cares about, in past tense and in the ubiquitous language: `OrderPlaced`, `PaymentCaptured`, `ParcelDelivered`. Events are the natural glue between aggregates and between bounded contexts: the publisher doesn't need to know who listens, and each consumer translates the event into its own model. They pair naturally with the outbox pattern (to publish reliably) and with sagas (to coordinate multi-step processes).

### Event storming: discovering the model

**Event storming**, created by Alberto Brandolini, is a workshop technique for discovering the domain fast. Developers and domain experts put orange sticky notes for domain events on a long wall in time order, then add commands (blue), actors, policies ("whenever X, then Y"), external systems and read models. Clusters of events and the places where the language shifts reveal candidate aggregates and bounded contexts. A day of event storming routinely surfaces misunderstandings that would otherwise cost months.

### Conway's law and team topology

Conway's law says systems mirror the communication structure of the organizations that build them. DDD embraces this: the cleanest bounded context is one owned by **one team**. If two teams share a context, the boundary will blur; if one context is split across teams, coordination costs explode. The "inverse Conway maneuver" is to design the team structure you want the architecture to have.

## Where it's used

| Setting | How DDD shows up |
|---|---|
| Microservice decomposition | Bounded contexts are the most widely recommended heuristic for service boundaries |
| Modular monoliths | Contexts become modules with enforced boundaries inside one deployable (e.g., Shopify's componentized monolith) |
| Legacy migration | Anti-corruption layers wrap old systems during a strangler-fig migration |
| Event-driven systems | Domain events form the published language between services |
| Complex business software | Insurance, banking, logistics, healthcare — domains with dense, changing rules |
| Platform/API design | Open host services and published languages for many consumers |

## Use case walk-through: untangling an e-commerce monolith

An online retailer has a Rails monolith with a 140-column `products` table and an `orders` table touched by 30 controllers. Every release breaks something unrelated.

1. **Event storm the order lifecycle.** Engineers, a merchandiser, a warehouse lead and someone from finance spend a day on the wall. Events like `ProductPublished`, `OrderPlaced`, `StockReserved`, `InvoiceIssued`, `ParcelShipped` emerge.
2. **Spot the language shifts.** The merchandiser's "product" has variants and photos; the warehouse lead's "product" has bins and lot numbers; finance's "product" is a line on an invoice with a tax code frozen at sale time. Four contexts appear: Catalog, Inventory, Billing, Shipping — plus Ordering at the center.
3. **Classify subdomains.** Ordering and pricing are core (their promotions engine is a differentiator). Shipping is supporting. Identity and payments are generic — use the existing auth provider and a payment processor.
4. **Draw the context map.** Ordering publishes events consumed by Billing and Shipping. The old ERP used by finance gets an ACL so its codes never leak into Billing. Shipping conforms to Identity's API.
5. **Modularize before distributing.** They first split the monolith into modules per context with enforced dependency rules, giving each module its own tables. Cross-module calls go through explicit interfaces or in-process events.
6. **Design the Order aggregate.** `Order` owns its lines and shipping address, enforces "max 50 lines" and "frozen once paid", and references the customer by ID. Placing an order emits `OrderPlaced` via an outbox.
7. **Extract one service.** Shipping has the most different release cadence, so it's extracted first, consuming `OrderPlaced` from the event bus.

**Result:** the 140-column table becomes four focused models, teams own their contexts end to end, and unrelated releases stop breaking each other — without a big-bang rewrite.

## Pitfalls

- **Splitting by entity instead of by context.** A "customer service" every other service calls synchronously is a distributed god-object.
- **Tactical patterns everywhere.** Aggregates, repositories and factories in a CRUD admin screen are ceremony. Spend modeling effort on the core subdomain.
- **The anemic domain model.** Entities that are just getters/setters with all rules in "service" classes. Invariants get duplicated and bypassed; put behavior on the model.
- **Giant aggregates.** Loading a customer with ten thousand orders to change an email address causes contention and slow transactions.
- **Shared databases across contexts.** If two contexts read each other's tables, the boundary exists only in diagrams.
- **Skipping the domain experts.** DDD done only by engineers produces a technical model with business-sounding names.
- **Boundaries set too early.** Contexts discovered in week one are often wrong. Modular monoliths make it cheap to move a boundary; network boundaries don't.

> [!TIP]
> If you're unsure where a boundary goes, draw it inside a monolith first as a module with its own tables and a narrow interface. Run it like that for a few months. If the boundary holds up, extracting a service is mechanical; if it doesn't, moving it is a refactor instead of a migration.

## Discussion questions

1. In your current system, which word means the most different things to different teams? What contexts does that suggest?
2. Why is "one service per database table" a poor decomposition strategy, even though it feels clean?
3. When would you choose a conformist relationship over building an anti-corruption layer?
4. How do you decide whether an invariant belongs inside one aggregate or should be eventually consistent across two?
5. Which parts of your product are core subdomains, and are your strongest engineers actually working on them?
6. How does Conway's law constrain the bounded contexts you can realistically maintain?

## FAQ

### Is a bounded context the same as a microservice?

Not necessarily. A bounded context is a model boundary; a microservice is a deployment boundary. A good default is one context per service, but a context can be a module in a monolith, and one context can be implemented by several services (say, an API and a worker). What you should avoid is one service spanning multiple contexts with tangled models.

### Do I need the tactical patterns (aggregates, repositories) to do DDD?

No. The strategic side — ubiquitous language, bounded contexts, subdomains, context maps — delivers most of the value and applies to any architecture. Tactical patterns are worth it where business rules are dense, usually the core subdomain.

### How big should a bounded context be?

Big enough to hold a coherent model with a consistent language, small enough for one team to own and understand. If a context needs more than one team, or the language inside it starts needing qualifiers, it's probably too big.

### Isn't duplicating "product" data across contexts bad?

It's not duplication of the same thing — each context stores a different model with different attributes and rules. They share an identifier, and changes propagate through events. The duplication you should avoid is two contexts owning and editing the same facts.

### How does DDD relate to hexagonal or clean architecture?

They're complementary. DDD tells you what the domain model is and where its boundaries are; hexagonal architecture tells you how to keep that model independent of databases, frameworks and transports inside each context.

## Key takeaways

- Split by **meaning**, not by table: a bounded context is where one model and one language hold consistently.
- Classify subdomains so you invest modeling effort in the **core** and buy the generic.
- Make relationships between contexts explicit with a **context map** — ACL, open host service, customer–supplier, conformist, shared kernel.
- **Aggregates** are small consistency boundaries; reference others by ID and integrate through **domain events**.
- Align contexts with teams, and prove boundaries in a modular monolith before paying for network boundaries.

## References

- Eric Evans, *Domain-Driven Design: Tackling Complexity in the Heart of Software*, Addison-Wesley, 2003.
- Vaughn Vernon, *Implementing Domain-Driven Design*, Addison-Wesley, 2013.
- Vaughn Vernon, "Effective Aggregate Design" (three-part essay), 2011.
- [Martin Fowler — BoundedContext](https://martinfowler.com/bliki/BoundedContext.html)
- Alberto Brandolini, *Introducing EventStorming*, Leanpub.
- DDD Crew, "Context Mapping" and "Bounded Context Canvas" (GitHub: ddd-crew).
- Matthew Skelton and Manuel Pais, *Team Topologies*, IT Revolution, 2019.

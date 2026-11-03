---
summary: Put business rules in a core that knows nothing about HTTP, SQL or queues, and plug the outside world in through interfaces the core owns.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — **Hexagonal architecture** (Alistair Cockburn's *ports and adapters*) puts the domain logic and use cases at the center and treats every piece of technology — web framework, database, message broker, payment provider, even the test runner — as an interchangeable **adapter** at the edge. The core defines **ports**: interfaces for what it offers (*driving* ports, like `PlaceOrder`) and what it needs (*driven* ports, like `OrderRepository`). Dependencies point **inward**, so the core compiles and is tested without a database, and swapping Postgres for DynamoDB or REST for gRPC touches only adapters.

## The problem: business logic welded to infrastructure

In many backends the rule "an order over $10,000 needs manual review" lives in a service method that also builds ORM queries, reads HTTP headers, publishes to Kafka and calls the Stripe SDK. That works until:

- **Tests are slow and brittle.** Checking a pricing rule requires a running database, a mocked HTTP context and a fake Kafka — so people write fewer tests.
- **Frameworks leak everywhere.** ORM entities with lazy-loading proxies travel through the code; a framework upgrade becomes a rewrite.
- **The same logic has multiple entry points.** The rule must run from the REST API, a nightly batch job and a queue consumer — and gets copy-pasted into each.
- **Infrastructure changes are risky.** Moving from one payment provider or datastore to another means editing the code that encodes the business rules.

Cockburn's original observation (2005) was that applications should be equally drivable by users, programs, automated tests or batch scripts, and developable in isolation from their eventual runtime devices and databases. The hexagon is just a drawing that has no "top" or "bottom" — no privileged UI layer and database layer, only *inside* and *outside*.

## How it works

### Ports and adapters

![The domain sits at the center of a hexagon; driving adapters on the left call driving ports, driven adapters on the right implement driven ports](/figures/hexagonal-architecture/shape.svg "Six sides is arbitrary — the point is that every external actor is an adapter plugged into a port.")

- **Core (the inside).** Domain entities, value objects and business rules, plus **application services / use cases** that orchestrate them (`PlaceOrder`, `CancelSubscription`). Plain language constructs only — no framework annotations, no SQL, no HTTP types.
- **Driving (primary) ports.** The API the application offers: use-case interfaces or command handlers. Something outside *calls* them.
- **Driving adapters.** Translate an external stimulus into a port call: an HTTP controller parses JSON and calls `placeOrder(cmd)`; a Kafka consumer deserializes an event and calls the same port; a CLI does too; so does a test.
- **Driven (secondary) ports.** What the application needs from the world, expressed in domain terms: `OrderRepository.save(order)`, `PaymentGateway.charge(amount, card)`, `Clock.now()`, `EventPublisher.publish(OrderPlaced)`.
- **Driven adapters.** Implement those interfaces with real technology: `PostgresOrderRepository`, `StripePaymentGateway`, `KafkaEventPublisher` — and for tests, `InMemoryOrderRepository` and `FakePaymentGateway`.
- **Composition root.** At startup, one place (`main`, a DI container module) wires concrete adapters to ports. This is the only code that knows everything.

### Dependencies point inward

The mechanical trick is the **dependency inversion principle**: the core declares an interface it needs, and infrastructure implements it.

![Layered architecture where the service imports the ORM, compared with hexagonal architecture where the core declares a repository interface and the Postgres adapter implements it](/figures/hexagonal-architecture/deps.svg "In a classic layered app, source-code dependencies follow the call direction all the way down to the database. Hexagonal flips the last arrow.")

Consequences:

- The core module has **no import** of the ORM, web framework or SDKs. You can enforce this with build modules or architecture tests (ArchUnit, import-linter, dependency-cruiser).
- Port signatures use **domain types**, not infrastructure types — `findById(OrderId): Order`, not `ResultSet` or a Mongo document.
- Adapters do the **translation**: mapping rows to entities, domain errors to HTTP status codes, retries and timeouts around external calls.

This is the same core idea behind Jeffrey Palermo's *Onion Architecture* and Robert C. Martin's *Clean Architecture*. They add more named rings (entities, use cases, interface adapters, frameworks), but the rule is identical: **source-code dependencies point toward the business rules**.

### Testing at the seams

The payoff most teams notice first is testability.

![Many fast core unit tests with fakes, fewer adapter contract tests, a handful of end-to-end tests](/figures/hexagonal-architecture/tests.svg "A shared contract suite keeps fakes honest: if the fake passes the same tests as the Postgres adapter, core tests using the fake are trustworthy.")

- **Core tests** drive use cases through driving ports with in-memory driven adapters. They run in milliseconds and cover business rules exhaustively.
- **Adapter contract tests** run one suite against every implementation of a port — the in-memory fake *and* the real Postgres adapter (with Testcontainers or a real instance). This is what stops the fake from drifting into fiction.
- **Driving adapter tests** check translation: does the controller map a validation error to 422?
- **A few end-to-end tests** prove the wiring works.

### How big should the hexagon be?

Ports and adapters is a boundary pattern, not a mandate for ceremony. Practical guidance:

- **Apply it where the domain is rich.** Pricing, billing, scheduling, policy engines. A CRUD admin screen over a table gains little from a repository interface with one method per column.
- **One hexagon per bounded context / service**, not one per class.
- **Don't abstract what you'll never swap *and* don't need to fake.** The clock, randomness, external APIs and the datastore are worth porting; the JSON library usually isn't.
- **Use-case-shaped ports beat generic ones.** `OrderRepository.findOpenOrdersFor(customer)` expresses intent; a generic `Repository<T>` that exposes query builders leaks the database back in.

## Where it's used

| Setting | How it shows up |
|---|---|
| Domain-driven design projects | Bounded contexts implemented as hexagons; repositories as driven ports |
| Java / Kotlin (Spring) | Core modules without Spring annotations; adapters in separate Gradle modules; ArchUnit rules |
| .NET | "Clean Architecture" solution templates with Domain, Application, Infrastructure and Web projects |
| Go | Small interfaces declared by the consuming package; adapters in `internal/adapters/...` |
| Serverless | The same use case invoked by a Lambda handler, an HTTP adapter and a local CLI |
| Migrations between vendors | Swapping a payment, email or storage provider by writing one new adapter |

## Use case walk-through: a subscription billing service

A billing service's renewal logic lives in a Spring `@Service` that uses JPA entities, calls the Stripe SDK directly and is triggered only by an HTTP endpoint. A test of proration rules takes 40 seconds and needs a database container; the company now wants to add a second payment provider and a nightly batch renewal.

1. **Find the use cases.** `RenewSubscription`, `ChangePlan`, `CancelSubscription` become driving ports with plain command objects.
2. **Extract the domain.** `Subscription`, `Plan`, `Money` and the proration logic move into a core module with no Spring or JPA imports. JPA entities stay in the persistence adapter and are mapped to domain objects.
3. **Declare driven ports.** `SubscriptionRepository`, `PaymentGateway`, `Clock` and `BillingEvents` are interfaces in the core.
4. **Write adapters.** `JpaSubscriptionRepository`, `StripePaymentGateway` and `KafkaBillingEvents` implement them; the REST controller and a new scheduled batch job both call `RenewSubscription`.
5. **Test the core in isolation.** Proration and renewal tests use in-memory fakes and a fixed `Clock`; 300 tests run in under 2 seconds.
6. **Add contract tests.** One `PaymentGatewayContract` suite runs against the fake and against Stripe's test mode; a second provider adapter must pass the same suite.
7. **Enforce the boundary.** An architecture test fails the build if the core imports `org.springframework` or `jakarta.persistence`.

**Result:** the second payment provider ships as a single new adapter plus configuration, the batch job reuses the exact renewal logic, and business-rule tests run on every save instead of in a nightly CI stage.

## Pitfalls

- **Ceremony without a domain.** Interfaces, DTOs and mappers for a thin CRUD service add files and indirection with little payoff.
- **Leaky ports.** A port that returns ORM entities, accepts `HttpServletRequest` or exposes SQL fragments has defeated the purpose.
- **Anemic core.** If all the logic is in adapters (controllers doing validation, repositories doing calculations), the hexagon is an empty box.
- **Fakes that lie.** In-memory adapters that don't enforce uniqueness or ordering like the real database make core tests pass while production fails — hence contract tests.
- **Mapping fatigue.** Every boundary needs translation code. Keep it boring and colocated with the adapter; consider sharing types where the boundary is not meaningful.
- **Transactions across ports.** Use cases often need atomicity across several repository calls. Model it explicitly (a unit-of-work port, or the use case runs inside a transaction opened by the driving adapter) rather than letting it leak implicitly.
- **Treating it as a folder structure.** Renaming packages to `ports/` and `adapters/` without fixing dependency direction changes nothing.

> [!TIP]
> Start by enforcing a single rule with an automated test: *the core module may not import framework, database or SDK packages.* Most of the architecture's benefits follow from that one constraint.

## Discussion questions

1. Which parts of your current service contain business rules, and what infrastructure do they import today?
2. What would a contract test for your repository port check that a unit test with a mock wouldn't?
3. Where should transactions begin and end in a hexagonal design?
4. How do you decide whether a dependency (logger, clock, JSON library, feature-flag SDK) deserves a port?
5. How do hexagonal boundaries relate to microservice boundaries? Can one service contain several hexagons?
6. What would convince you that a service is too simple to benefit from ports and adapters?

## FAQ

### Is hexagonal architecture the same as Clean Architecture or Onion Architecture?

They share the core rule — dependencies point inward toward business logic — and differ mainly in vocabulary and how many rings they name. Hexagonal emphasizes the symmetric inside/outside split and the port/adapter terminology; Clean Architecture prescribes specific layers like entities, use cases and interface adapters.

### Why a hexagon?

No technical reason. Cockburn wanted a shape with enough sides to draw several ports and adapters, and one that broke the habit of drawing layered diagrams with the UI on top and the database at the bottom.

### Does every class need an interface?

No. Ports are needed at the boundary where the core talks to the outside world. Domain classes inside the core can call each other directly.

### Isn't this just dependency injection?

DI is the wiring mechanism; hexagonal architecture is the decision about *where the boundaries are* and *who owns the interfaces*. You can use a DI container and still have business logic that depends on the ORM.

### How do I migrate an existing codebase?

Incrementally. Pick one valuable use case, extract its rules into a framework-free module behind a driving port, introduce driven ports for what it needs, and wrap existing infrastructure code as the first adapters. Add an architecture test to keep new code honest, then repeat.

## Key takeaways

- The **core** holds domain rules and use cases and depends on nothing technical.
- **Ports** are interfaces owned by the core: driving ports for what it offers, driven ports for what it needs.
- **Adapters** translate between ports and real technology — HTTP, SQL, queues, SDKs, tests.
- **Dependencies point inward**; the composition root wires adapters at startup.
- The biggest wins are **fast, thorough tests** and **cheap infrastructure swaps** — worth it where the domain is rich, overkill for thin CRUD.

## References

- [Alistair Cockburn — Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
- [Robert C. Martin — The Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- [Jeffrey Palermo — The Onion Architecture, part 1](https://jeffreypalermo.com/2008/07/the-onion-architecture-part-1/)
- [Martin Fowler — Inversion of Control Containers and the Dependency Injection pattern](https://martinfowler.com/articles/injection.html)
- Alistair Cockburn and Juan Manuel Garrido de Paz, *Hexagonal Architecture Explained*, 2024.
- Eric Evans, *Domain-Driven Design: Tackling Complexity in the Heart of Software*, Addison-Wesley, 2003.
- Steve Freeman and Nat Pryce, *Growing Object-Oriented Software, Guided by Tests*, Addison-Wesley, 2009.

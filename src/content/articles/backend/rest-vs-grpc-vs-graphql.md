---
summary: How REST, GraphQL and gRPC model an API differently (resources, a typed graph, remote procedures), what each one gives up in caching, flexibility, performance and tooling, and how most real systems combine all three behind different boundaries.
updated: 2026-11-02
---

> [!KEY]
> The three styles answer different questions:
> - **REST** exposes **resources** over plain HTTP. It is the easiest to cache, debug and publish, but clients often need several round trips or get more fields than they use.
> - **GraphQL** exposes a **typed graph** behind a single endpoint. The client asks for exactly the shape it needs in one request, but you pay for it with harder caching, query-cost control and a smarter server.
> - **gRPC** exposes **typed procedures**, using Protobuf over HTTP/2. It is compact, fast, streaming-capable and contract-first, which makes it ideal between services, but awkward for browsers and public consumers.
>
> Pick per **consumer**, not per company. A common, healthy shape is REST for partners, GraphQL (or a BFF) for your own UIs, and gRPC between internal services.

## The problem: one API, very different consumers

An order page needs the order, the customer's name and the stock status of each line item. The same backend is also called by:

- a partner's nightly script that syncs orders,
- the web app and the mobile app, each wanting slightly different fields,
- a dozen internal services calling each other thousands of times per second.

A single API style rarely serves all of them well:

- **Plain REST endpoints** make the mobile app do three sequential round trips over a slow network, and ship fields it never shows.
- **A GraphQL-only API** forces the partner to learn GraphQL and makes the CDN useless for them.
- **gRPC everywhere** leaves the browser needing a proxy, and makes `curl` debugging painful.

The mistake isn't picking the "wrong" technology. It's picking one style for consumers with different needs, then living with the friction for years, because an API, once published, is very hard to take back.

## How it works

### Three ways to model the same data

![The same order page fetched three ways: REST with three round trips, GraphQL with one query, gRPC with one typed call](/figures/api-styles/shapes.svg "The same order page: REST needs one request per resource, GraphQL asks for the exact shape in one query, gRPC makes one typed call to a purpose-built procedure.")

**REST** models nouns. Each resource has a URL (`/orders/42`, `/users/7`) and you act on it with HTTP methods: `GET` reads, `POST` creates, `PUT`/`PATCH` update, `DELETE` removes. HTTP itself carries the semantics:

- status codes say what happened (`404`, `409`, `429`),
- `Cache-Control` and `ETag` let browsers, CDNs and proxies cache responses,
- `GET` is safe and `PUT`/`DELETE` are idempotent, so intermediaries and clients can retry them.

The cost is shape rigidity. The server decides what `/orders/42` returns. Clients either **under-fetch** (they need several calls to build one screen) or **over-fetch** (they get a 4 KB payload for three fields). Teams patch this with `?include=customer`, `?fields=id,total` or purpose-built endpoints, which work but slowly erode the clean resource model.

**GraphQL** models a graph of types. The server publishes a schema (`Order`, `User`, `LineItem` and the edges between them), and the client sends a query naming exactly the fields and relationships it wants:

```graphql
query { order(id: 42) { total customer { name } items { sku inStock } } }
```

One request returns exactly that shape. Every field has a **resolver**, a function that fetches it, so the server becomes a query engine that fans out to databases and services. Mutations handle writes and subscriptions handle live updates.

**gRPC** models verbs. You define services and messages in a `.proto` file, generate client and server code in any supported language, and call remote methods as if they were local:

```protobuf
service Orders { rpc GetOrderPage(OrderPageRequest) returns (OrderPage); }
```

It runs over HTTP/2. Messages are binary Protobuf, which is smaller and faster to parse than JSON. Every call carries a **deadline**. It supports four call shapes: unary, server streaming, client streaming and bidirectional streaming.

### What each one gives up

![Comparison matrix of REST, GraphQL and gRPC across caching, browser support, flexibility, contracts, speed, streaming, public APIs and debugging](/figures/api-styles/matrix.svg "No style wins every row. The matrix is the reason hybrid architectures are so common.")

**Caching.** REST gets HTTP caching for free: a `GET` with `Cache-Control: max-age=60` can be served by a CDN without touching your servers. GraphQL queries usually go out as `POST` to one URL, so HTTP caches can't see what is being asked for. Caching moves into the client (normalized caches such as Apollo's or Relay's) and into the server (per-resolver caches, DataLoader batching). **Persisted queries** help: the client sends a hash of a pre-registered query, often via `GET`, so a CDN can cache it again. gRPC has no standard HTTP caching story. You cache inside services instead.

**Over- and under-fetching.** This is GraphQL's core win. It's especially valuable on mobile, where round trips are expensive, and when many UI teams need different slices of the same data. REST closes the gap with sparse fieldsets and compound documents, and gRPC closes it with purpose-built methods, but neither lets the client decide the shape.

**Cost control.** In REST and gRPC, every endpoint has a known, bounded cost. In GraphQL, a client can write a deeply nested query (`users { friends { friends { friends … } } }`) that fans out to millions of resolver calls. Production GraphQL servers need:

- depth and complexity limits,
- query cost analysis with per-client budgets,
- pagination enforced on list fields,
- DataLoader-style batching to avoid N+1 queries in resolvers,
- ideally, **persisted queries only** for first-party clients, so arbitrary queries are rejected.

**Contracts and evolution.** gRPC and GraphQL are schema-first: the `.proto` or GraphQL SDL is the contract, and code generation keeps clients honest. Protobuf evolves by field numbers: add new fields, never reuse or renumber old ones. GraphQL evolves by adding fields and marking old ones `@deprecated`, and field-level usage tracking tells you when nobody reads them any more. REST relies on OpenAPI if you write one. Without it, the contract is whatever the code happens to return. REST also tends to version through the URL (`/v2/`) or headers.

**Errors.** REST uses HTTP status codes plus a body, ideally RFC 9457 Problem Details. GraphQL normally returns `200 OK` with an `errors` array next to partial `data`, which confuses monitoring that only looks at status codes. gRPC has its own status codes (`NOT_FOUND`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`, …) and rich error details.

**Browsers.** Browsers can't use gRPC's HTTP/2 trailers directly, so browser clients need **gRPC-Web** behind a proxy (such as Envoy), or the **Connect** protocol, which serves the same Protobuf services as gRPC, gRPC-Web and plain JSON-over-HTTP. REST and GraphQL work natively with `fetch`.

**Performance.** For internal hot paths, gRPC usually wins on payload size, serialization CPU and connection reuse, because it multiplexes many calls over one HTTP/2 connection. Deadlines propagate across hops, so a request that has already timed out upstream stops consuming resources downstream. For most user-facing APIs, network latency and the database dominate, so the serialization format matters much less than the number of round trips.

### The hybrid that most teams end up with

![Topology: partners call a public REST API, web and mobile apps call a GraphQL BFF, and internal services communicate over gRPC](/figures/api-styles/topology.svg "Each boundary uses the style that suits its consumer. The GraphQL layer and the REST gateway both translate into internal gRPC calls.")

Mature systems usually draw lines by consumer:

- **Public/partner edge: REST.** It's universally understood, cacheable, easy to document with OpenAPI, and easy to call from any language or `curl`. Stability matters more than flexibility here.
- **First-party UIs: GraphQL or a BFF.** Product teams iterate on screens weekly. Letting the client choose the shape, or giving each app its own backend-for-frontend, decouples UI changes from backend deploys.
- **Service to service: gRPC.** Typed contracts across many teams and languages, low overhead, deadlines and streaming.

The GraphQL server's resolvers and the REST gateway's handlers both become thin translators onto internal gRPC calls. Each layer has a single job.

## Where it's used

| Context | Typical choice | Why |
|---|---|---|
| Public developer APIs (payments, messaging, cloud) | REST + OpenAPI | Lowest barrier for unknown consumers; HTTP caching; easy to try in a terminal |
| GitHub, Shopify, others | GraphQL alongside REST | Integrators need many different slices of a large domain model |
| Product UIs with many screens | GraphQL or per-app BFF | One round trip per screen; frontend teams own their data needs |
| Microservice meshes | gRPC | Typed contracts, code generation, deadlines, low overhead |
| Kubernetes, etcd, many cloud SDKs | gRPC | Streaming watches and high-volume control-plane traffic |
| Real-time feeds | gRPC streaming, GraphQL subscriptions, or SSE/WebSockets | Push updates without polling |
| Simple internal CRUD tools | REST | Least machinery; nothing else is worth the cost |

## Use case walk-through: redesigning an order page API

A retailer's mobile order page is slow on cellular networks. The page makes three REST calls in sequence: order, then customer, then stock for each item. Partners also use the same REST API.

1. **Measure first.** Traces show around 600 ms per page on 4G, almost all of it in three sequential round trips. Payloads are 18 KB, of which the screen uses about 2 KB.
2. **Leave the partner API alone.** Partners depend on `/v1/orders`. It stays REST, with its OpenAPI spec and CDN caching for catalogue data, unchanged.
3. **Add a GraphQL layer for first-party apps.** The schema exposes `Order`, `Customer`, `LineItem` and `stock`. The mobile app sends one query for exactly the fields on screen.
4. **Back resolvers with gRPC.** Resolvers call the internal `Orders`, `Users` and `Inventory` services over gRPC. DataLoader batches all `inStock` lookups for a page into a single `BatchGetStock` call, avoiding N+1 calls.
5. **Lock it down.** The app ships with persisted queries only. The server rejects unknown queries, enforces a depth limit of 6 and a cost budget, and propagates a 300 ms deadline into every gRPC call.
6. **Watch the right signals.** Dashboards track per-operation latency and the `errors` array rate, not only HTTP status codes, since GraphQL failures return `200`.

**Result:** the page loads in one round trip of about 2 KB, around 180 ms on 4G. Partners notice nothing. Backend teams keep their gRPC contracts, and the frontend team can add a field to the screen without waiting for a new REST endpoint.

## Pitfalls

- **Choosing by hype.** GraphQL for a three-endpoint internal tool, or gRPC for a public API used by hobbyists, adds machinery without benefit.
- **Unbounded GraphQL queries.** Without depth limits, cost analysis and pagination, a single query can take down your database. Treat a public GraphQL endpoint as a query language you expose to strangers.
- **N+1 in resolvers.** A naive `LineItem.product` resolver issues one query per item. Batch with DataLoader or equivalent.
- **Monitoring by status code alone.** GraphQL returns `200` with errors, and gRPC errors sit in trailers. Alert on the protocol's own error signal.
- **Breaking Protobuf compatibility.** Renumbering a field, reusing a removed tag or changing a type silently corrupts data between old and new binaries. Mark removed fields `reserved`.
- **Missing gRPC deadlines.** A call without a deadline can wait forever and hold resources the whole time. Set one at the edge and propagate it.
- **Tunnelling RPC through REST.** `POST /doThing` endpoints that always return `200` lose all of REST's benefits. If you want RPC, use an RPC framework honestly.
- **Forgetting HTTP caching when leaving REST.** Moving a cacheable catalogue to GraphQL `POST`s can multiply origin traffic. Use persisted `GET` queries or keep that data on REST.

> [!TIP]
> Choose per boundary with three questions: **Who is the consumer** (unknown public developers, your own UI team, or another service)? **What dominates cost** (round trips, payload CPU, or developer onboarding)? **Can intermediaries help** (CDNs and proxies need HTTP semantics)? The answers usually point clearly to one style for that boundary.

## Discussion questions

1. Your public API has 5,000 integrators. A product manager wants to replace it with GraphQL. What would you keep, what would you add, and why?
2. How would you make a GraphQL endpoint cacheable at a CDN without giving up per-screen queries?
3. A gRPC call chain spans five services and the edge has a 1 s budget. How should deadlines be set and propagated, and what should each service do when little time remains?
4. When does a per-app BFF beat a shared GraphQL layer, and when is it the other way round?
5. How do the three styles differ in how they let you safely remove a field that you think nobody uses?
6. Where does streaming (gRPC streams, GraphQL subscriptions, SSE) really earn its complexity, and where would polling be good enough?

## FAQ

### Is gRPC always faster than REST?

On the wire and in serialization, usually yes: binary Protobuf is smaller and cheaper to parse than JSON, and HTTP/2 multiplexes calls over one connection. But for most user-facing requests, network latency, database time and round-trip count dominate. A REST API returning a well-designed payload in one call can beat a chatty gRPC design. Measure the whole request, not just the encoding.

### Does GraphQL replace REST?

No. It solves a specific problem, client-shaped reads over a large, connected domain, very well. REST remains better for simple CRUD, public APIs, file transfers and anything that benefits from HTTP caching. Many companies run both, often over the same backend services.

### Can I call gRPC from a browser?

Not directly with standard gRPC, because browsers don't expose the HTTP/2 trailers it relies on. Use gRPC-Web with a proxy such as Envoy, or the Connect protocol, which lets the same Protobuf service speak gRPC, gRPC-Web and JSON over plain HTTP.

### How do I version a GraphQL API?

Usually you don't version the endpoint. You evolve the schema additively: add new fields and types, mark old fields `@deprecated` with a reason, track field usage per client, and remove fields only once usage reaches zero. Breaking changes are rare, deliberate events.

### Do I need an API gateway for this hybrid?

Not necessarily, but it helps. A gateway or edge proxy usually handles authentication, rate limiting and protocol translation (REST→gRPC, gRPC-Web→gRPC) in one place. The GraphQL layer can be a separate service or part of a BFF. What matters is that each boundary has a clear owner and a contract.

## Key takeaways

- REST models **resources**, GraphQL models a **typed graph**, gRPC models **procedures**. Each fits a different consumer.
- REST wins on **HTTP caching, universality and debuggability**; GraphQL wins on **client-shaped, single-round-trip reads**; gRPC wins on **typed contracts, speed, deadlines and streaming**.
- GraphQL needs **cost control**: depth limits, complexity budgets, pagination, batching and persisted queries.
- gRPC needs **deadlines and compatibility discipline**: never reuse field numbers, and use gRPC-Web or Connect for browsers.
- Most mature systems are **hybrids**: REST at the public edge, GraphQL or BFFs for first-party UIs, gRPC between services.

## References

- Roy T. Fielding, *Architectural Styles and the Design of Network-based Software Architectures*, PhD dissertation, UC Irvine, 2000 (Chapter 5: REST).
- [GraphQL specification](https://spec.graphql.org/)
- [GraphQL: Best practices](https://graphql.org/learn/best-practices/)
- [gRPC: Core concepts, architecture and lifecycle](https://grpc.io/docs/what-is-grpc/core-concepts/)
- [gRPC: Deadlines](https://grpc.io/docs/guides/deadlines/)
- [Protocol Buffers: Language guide (proto3)](https://protobuf.dev/programming-guides/proto3/)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [Connect protocol documentation](https://connectrpc.com/docs/introduction)
- [DataLoader (GraphQL batching utility)](https://github.com/graphql/dataloader)

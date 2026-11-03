---
summary: An API gateway is the single front door that handles auth, rate limits and routing once; a backend-for-frontend shapes responses for one specific client.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — An **API gateway** sits between clients and your services and handles the cross-cutting work every request needs — TLS, authentication, rate limiting, routing, request/response transformation and observability — so services don't each reimplement it. A **backend for frontend (BFF)** is a client-specific layer (one for web, one for mobile, one for partners) that aggregates calls to several services and returns exactly the shape that client's screens need. Keep both thin: gateways enforce policy, BFFs compose data, and business rules stay in the domain services.

## The problem: clients talking to many services

Once a backend is split into services, clients face an awkward situation. Rendering a single product page might need data from catalog, pricing, inventory, reviews and recommendations. If the mobile app calls each service directly:

- It makes **five round trips** over a high-latency cellular network.
- Every service has to **authenticate** the user, enforce **rate limits**, handle **CORS**, emit **access logs** — the same code in fifteen languages and frameworks.
- Internal service topology **leaks** to the client. Splitting `users` into `accounts` and `profiles` now requires an app-store release.
- Each service's response is shaped for *every* consumer, so mobile downloads 40 KB of fields it never shows.
- Internal services are **exposed to the internet**, multiplying the attack surface.

The answer is to put something in the middle: a single, well-defended entry point, and — where client needs diverge — a layer that speaks each client's language.

## How it works

### The gateway request pipeline

An API gateway is a reverse proxy with a programmable pipeline. Each request passes through a sequence of filters (also called plugins or policies) before it's routed to an upstream service.

![A request flows through TLS termination, authentication, rate limiting, routing, transformation and observability stages in the gateway before reaching backend services](/figures/api-gateway/pipeline.svg "Requests that fail auth, exceed a quota or match no route are rejected at the edge and never cost a backend anything.")

Typical stages:

- **TLS termination.** Decrypt HTTPS once at the edge; manage certificates centrally.
- **Authentication.** Validate a JWT's signature and expiry, introspect an OAuth token, or check an API key. The gateway then forwards a trusted identity (e.g., `X-User-Id` or a re-signed internal token) so services don't parse credentials themselves.
- **Coarse authorization.** "Is this key allowed to call `/admin/*`?" Fine-grained rules ("can this user edit *this* document?") belong in the service that owns the data.
- **Rate limiting and quotas.** Per API key, per user or per IP, often with a token bucket backed by Redis. Monetized APIs enforce plan quotas here.
- **Routing.** Map `/v2/orders/*` to the orders service, do canary splits ("5% to orders-v2"), and apply retries and timeouts.
- **Transformation.** Add or strip headers, rewrite paths, convert REST to gRPC, compress responses.
- **Observability.** Access logs, metrics per route, and starting a distributed trace with a trace ID that flows downstream.
- **Protection.** Request size limits, WAF rules, bot detection, IP allow-lists.

Popular gateways include Kong, Envoy-based gateways (Envoy Gateway, Gloo, Emissary), NGINX, Traefik, Apache APISIX, and managed offerings like AWS API Gateway, Google Apigee and Azure API Management. Kubernetes standardizes the configuration through the **Gateway API** (the successor to Ingress).

### Backends for frontends

A single general-purpose API serving every client tends to become a compromise: too chatty for mobile, too limited for web, too unstable for partners. The **BFF pattern**, described by Sam Newman (originating at SoundCloud), gives each type of client its own backend.

![Web, mobile and partner clients each call their own BFF, which composes data from shared domain services](/figures/api-gateway/bff.svg "Each BFF is owned by the team building that client, so it can change at the client's pace.")

A BFF:

- **Aggregates.** One call from the mobile app fans out to users, orders and catalog in parallel inside the data center (sub-millisecond hops) and returns one response.
- **Shapes.** Returns exactly the fields a screen renders, formatted for that client — thumbnails sized for mobile, rich nested data for web.
- **Adapts protocols.** Serves GraphQL or REST to the client while calling gRPC services behind it.
- **Evolves with its client.** Because the mobile team owns the mobile BFF, they can change it in the same sprint as the app — no negotiation with a central API team.
- **Handles client-specific concerns** like session cookies for web versus token refresh for mobile.

A GraphQL server is often used as a kind of universal BFF: the client asks for exactly the fields it wants, and resolvers aggregate across services. That trades multiple BFFs for one flexible schema plus query-cost controls.

### Gateway, BFF and service mesh: who does what

These layers overlap, which causes confusion. A useful split is by **traffic direction**.

![The API gateway handles north-south traffic from the internet into the cluster, while a service mesh handles east-west traffic between services](/figures/api-gateway/edge.svg "North–south traffic enters the system through the gateway; east–west traffic between services is the mesh's job.")

| Layer | Traffic | Responsibilities |
|---|---|---|
| **API gateway** | North–south (clients → system) | Client auth, API keys, quotas, public routing, TLS, WAF |
| **BFF** | Per client, behind the gateway | Aggregation, response shaping, client-specific session logic |
| **Service mesh** (Istio, Linkerd) | East–west (service → service) | mTLS, retries, timeouts, traffic splitting, telemetry |
| **Domain services** | — | Business rules and data ownership |

Small systems often collapse layers: a single gateway with a couple of aggregation endpoints, and no mesh. That's fine — the split matters once you have multiple clients and teams.

### Keeping the gateway healthy

Because every request crosses it, the gateway is both critical infrastructure and a tempting place to put logic. Guidelines:

- **Run it highly available and horizontally scaled**, stateless except for shared rate-limit counters.
- **Configuration as code** — routes and policies in Git, reviewed and deployed through CI, not clicked into a console.
- **Self-service routing** so teams can expose endpoints without filing a ticket with the gateway team.
- **No business logic.** Once the gateway knows that "premium users get free shipping," it becomes a shared monolith every team must change.

## Where it's used

| Setting | Example |
|---|---|
| Public APIs | Stripe- or Twilio-style APIs with API keys, quotas and versioning at the edge |
| Microservice backends | Kong, Envoy or cloud gateways routing to dozens of services |
| Mobile apps | BFFs that collapse many calls into one screen-shaped payload |
| Serverless | AWS API Gateway in front of Lambda functions |
| Kubernetes | Gateway API implementations managing ingress traffic |
| GraphQL federation | A router (e.g., Apollo Router) composing subgraphs owned by different teams |

## Use case walk-through: a retailer's mobile app

A retailer's app home screen makes 9 calls to 6 services over cellular networks; p75 load time is 3.8 s, and every service validates JWTs with slightly different libraries.

1. **Introduce a gateway.** All public traffic goes through it. It terminates TLS, validates JWTs against the identity provider's JWKS, and forwards a signed internal identity header. Services drop their own JWT parsing.
2. **Add rate limits.** Per-user and per-IP token buckets stop a scraping bot that was hammering search, with 429 responses at the edge.
3. **Hide the topology.** Public routes like `/api/home` map to internal services; the app no longer knows service names.
4. **Build a mobile BFF.** A `GET /mobile/home` endpoint fans out in parallel to profile, recommendations, promotions, cart and inventory, applies per-call timeouts (300 ms) and returns partial results if recommendations is slow.
5. **Shape the payload.** The BFF returns only what the home screen renders — 6 KB instead of 70 KB.
6. **Observe.** The gateway starts a trace for each request; the team can see which downstream call dominates BFF latency.

**Result:** the home screen makes 1 call instead of 9, p75 load time drops below 1.5 s, auth logic lives in one place, and the backend team can split services without shipping a new app.

## Pitfalls

- **The gateway as a new monolith.** Business rules, orchestration and data transformations accumulate until every change needs the gateway team.
- **Single point of failure.** One gateway deployment, one region, one bad config push — and everything is down. Use redundancy and staged config rollouts.
- **BFF sprawl and duplication.** Five BFFs each reimplementing "compute order total" will disagree. Keep logic in the domain service and let BFFs call it.
- **Too many hops.** Client → CDN → gateway → BFF → service → service adds latency; measure it and collapse layers that don't earn their keep.
- **Trusting headers blindly.** If services trust `X-User-Id`, make sure only the gateway can set it — strip it from incoming requests and lock down network access to services.
- **Coarse timeouts.** A BFF waiting 30 s for one slow dependency makes the whole screen slow; use per-dependency timeouts and graceful degradation.

> [!TIP]
> Strip any incoming identity headers (`X-User-Id`, `X-Roles`) at the gateway before adding your own. Otherwise a client can simply send `X-User-Id: admin` and walk straight past your auth.

## Discussion questions

1. Which cross-cutting concerns in your services could move to a gateway, and which must stay in the service?
2. When does a single GraphQL layer serve better than multiple BFFs, and vice versa?
3. How would you prevent business logic from creeping into the gateway over time?
4. What happens to your system if the gateway is down? How would you design around that?
5. Who should own a BFF — the client team or a backend team — and why?
6. Where should authorization decisions live: gateway, BFF or service?

## FAQ

### Is an API gateway the same as a load balancer?

No. A load balancer distributes traffic across instances of a service, usually at layer 4 or simple layer 7. A gateway adds API-specific policy — auth, quotas, routing across many services, transformations. Gateways usually sit behind or include a load balancer.

### Do I need a BFF if I only have one client?

Usually not. A BFF earns its keep when clients have meaningfully different needs or release cadences. With one web app, aggregation endpoints in a gateway or a single API layer are simpler.

### Can the gateway do authorization?

Coarse-grained authorization, yes — scopes, roles, which keys can call which routes. Fine-grained, data-dependent authorization belongs in the service that owns the data, because the gateway doesn't know who owns document 42.

### Gateway or service mesh — do I need both?

They solve different directions of traffic. A gateway is almost always useful once you expose multiple services. A mesh pays off when you have many services that need mTLS, uniform retries and telemetry between them; small systems can skip it.

### How does a BFF handle a failing downstream service?

With per-call timeouts, circuit breakers and partial responses: return the screen without recommendations rather than failing the whole request. The client should be designed to render gracefully when optional sections are missing.

## Key takeaways

- A gateway centralizes **cross-cutting edge concerns**: TLS, auth, rate limiting, routing, observability.
- A BFF gives each client type an API **shaped for its screens**, owned by the team that builds that client.
- Gateways handle **north–south** traffic; service meshes handle **east–west**.
- Keep both layers **thin** — business rules belong in domain services.
- Treat the gateway as critical infrastructure: redundant, configured as code, and protected against header spoofing.

## References

- [Sam Newman — Backends For Frontends](https://samnewman.io/patterns/architectural/bff/)
- [Microsoft Azure Architecture Center — Backends for Frontends pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends)
- [Microsoft Azure Architecture Center — Gateway Routing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-routing)
- [Kubernetes Gateway API](https://gateway-api.sigs.k8s.io/)
- Chris Richardson, "Pattern: API Gateway / Backends for Frontends," microservices.io.
- Phil Calçado, "The Back-end for Front-end Pattern (BFF)," 2015.
- Envoy Proxy documentation, "What is Envoy."

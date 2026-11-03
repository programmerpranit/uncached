---
summary: Where to verify identity in a backend, how sessions, JWTs and token introspection differ, how authorization layers on top, and how a per-request context carries the principal, tenant and trace ID safely through handlers, services, data access and outbound calls.
updated: 2026-11-02
---

> [!KEY]
> Authentication middleware runs **before** your handlers. It reads a credential (a cookie, a bearer token or a client certificate), verifies it, and either rejects the request with `401` or attaches a **principal** (who is calling) to a per-request **context**. Authorization then decides whether this principal may do this action, and returns `403` if not. Everything after that reads identity from the context, never from raw headers. The context must be:
> - created once per request,
> - read-only once auth has run,
> - passed explicitly or through async-local storage, never through a global variable,
> - forwarded across service calls, so logs, traces and data access agree on who is acting.

## The problem: identity checks scattered everywhere

A young API often checks identity inside each handler:

- one handler parses the `Authorization` header itself,
- another trusts a `user_id` query parameter "because the frontend sends it",
- a third forgets to check at all,
- the background job that calls the same service code has no user, so the code grows `if user is None` branches.

The results are predictable. Some endpoint ships without auth. Tokens are verified three different ways, one of which ignores expiry. Logs can't say which user caused an error. And in multi-tenant systems, a query missing its `tenant_id` filter leaks another customer's data. Centralising authentication in middleware, and identity in a request context, fixes the structure rather than each bug.

## How it works

### The middleware chain

![Middleware chain](/figures/auth-middleware/pipeline.svg "Each layer can reject the request early or add to the request context. Authentication can return 401; authorization returns 403.")

A typical order:

1. **Request ID and logging.** Assign or accept a trace ID first, so even rejected requests can be correlated.
2. **Authenticate.** Extract the credential and verify it. Missing or invalid credentials get `401 Unauthorized` with a `WWW-Authenticate` header. Public routes are explicitly marked as such, rather than being the default.
3. **Load the principal.** Turn the verified claims into a principal object: user or service ID, tenant, roles or scopes, and how they authenticated (password, MFA, API key).
4. **Authorize.** Coarse checks (does this token have `orders:write`?) fit in middleware or route decorators. Fine-grained checks (does this user own order 812?) need the resource, so they happen in the service layer, using the principal from the context. Failures get `403 Forbidden`, or `404` when even revealing that the resource exists is a leak.
5. **Handler.** Business logic reads `ctx.principal` and never re-parses headers.

Two status codes, two meanings: **401** means "I don't know who you are", and **403** means "I know who you are and the answer is no".

### Verifying the credential

![Credential verification](/figures/auth-middleware/tokens.svg "Session cookies and opaque tokens need a lookup but revoke instantly; JWTs verify locally but stay valid until they expire.")

| Credential | Verification | Strength | Weakness |
|---|---|---|---|
| Session cookie | Look up the session ID in Redis or the database | Instant revocation, small cookie | A store lookup per request, needs CSRF protection |
| JWT (signed) | Check the signature, `exp`, `iss`, `aud` locally with a cached public key (JWKS) | No network call, works across services | Can't be revoked before expiry without a denylist |
| Opaque token + introspection | Ask the authorization server (RFC 7662) | Instant revocation, no claims exposed | A network call per request, unless cached |
| mTLS client certificate | The TLS handshake proves the client's identity | Strong service-to-service identity | Certificate issuance and rotation |
| API key | Hash it and look it up | Simple for machine clients | Long-lived, often leaked, usually needs scoping |

When verifying JWTs, the middleware must:

- **pin the algorithm** to what you expect (for example RS256 or EdDSA), and reject `none` or an unexpected HMAC algorithm,
- check `exp` and `nbf` with a small clock-skew allowance, plus `iss` and `aud`, so a token minted for another service isn't accepted here,
- fetch signing keys from the issuer's JWKS endpoint, cache them, and refresh on an unknown `kid` to handle key rotation.

A common production mix is short-lived access tokens (5–15 minutes) verified locally, plus a refresh token or session that can be revoked centrally.

### Request context

The context is a small, per-request object. Typical fields:

| Field | Used for |
|---|---|
| `request_id` / trace context | Log correlation, distributed tracing |
| `principal` (user or service ID, display name) | Authorization, auditing |
| `tenant_id` | Data isolation in multi-tenant systems |
| `scopes` / `roles` | Coarse authorization |
| `auth_method`, `auth_time` | Step-up checks ("re-enter password for this action") |
| `deadline` | Cancelling downstream work when the client gives up |
| `actor` vs `subject` | Impersonation: the support engineer acting *as* a customer |

Make it **immutable** after authentication. If a later layer can overwrite `principal`, a bug anywhere becomes a privilege escalation.

### Passing context through the call stack

![Passing context](/figures/auth-middleware/context.svg "Context flows from handler to service to repository to outbound calls, explicitly or via async-local storage. A global current-user variable lets concurrent requests collide.")

There are two safe ways to get the context to code deep in the stack:

- **Explicit parameter.** Go's `context.Context` is the model: every function that does I/O takes `ctx` as its first argument. It's verbose, but the dependency is visible and works the same in background jobs and tests.
- **Async-local storage.** Node's `AsyncLocalStorage`, Python's `contextvars`, Java's `ThreadLocal` or `ScopedValue`, and .NET's `AsyncLocal` give each request its own slot that follows it across `await`. Frameworks such as Spring Security (`SecurityContextHolder`) and ASP.NET (`HttpContext.User`) use this.

The unsafe way is a **mutable module-level variable** like `currentUser`. In a server handling requests concurrently, request B overwrites it while request A is still running, and A reads B's identity. With thread-locals the same bug appears when thread pools reuse threads and the value isn't cleared, or when work hops to another thread or executor without the context.

### Using the context downstream

- **Data access.** The repository layer adds `tenant_id` filters automatically, or sets a database session variable for PostgreSQL row-level security (`SET LOCAL app.tenant_id`, inside the transaction).
- **Logging.** A logging processor adds `request_id`, `user_id` and `tenant_id` to every line, so nobody has to remember to.
- **Outbound calls.** Propagate the W3C `traceparent` header and a deadline. For identity, either forward the user's token (if the downstream service is an intended audience) or exchange it for a narrower token (OAuth token exchange, RFC 8693). Don't invent an unsigned `X-User-Id` header that any internal caller could forge.
- **Background jobs.** Serialise the minimum needed (user ID, tenant, trace ID) into the job, and rebuild a context in the worker. A job runs *as* someone, and that should be explicit.

## Where it's used

| Framework | Authentication hook | Context mechanism |
|---|---|---|
| Express / Fastify (Node) | Middleware / `preHandler` hooks | `req.user`, `AsyncLocalStorage` |
| Django / DRF | Authentication middleware and classes | `request.user`, `contextvars` for logging |
| Spring Security | Filter chain | `SecurityContextHolder` (thread-local) |
| ASP.NET Core | Authentication middleware, `[Authorize]` | `HttpContext.User`, `AsyncLocal` |
| Go `net/http` | Handler wrappers | `context.Context` values |
| gRPC | Server interceptors | Call metadata and `context` |
| API gateways (Envoy, Kong) | `ext_authz`, JWT plugins | Verified claims passed as signed headers |

## Use case walk-through: centralising auth in a multi-tenant API

A B2B API has 140 endpoints. A security review finds two endpoints with no authentication, one that reads `tenant_id` from the request body, and logs with no user information.

1. **Deny by default.** Install authentication middleware on the whole router. Routes that must be public (health checks, login, webhooks with their own signatures) are marked with an explicit `@public` decorator, and a test fails if a new route has neither auth nor that marker.
2. **One verifier.** Replace three token parsers with one JWT verifier: pinned algorithm, `iss` and `aud` checks, cached JWKS with refresh on unknown `kid`, 60 seconds of clock skew.
3. **Build the context.** The middleware creates an immutable context with `principal`, `tenant_id` from the token (never from the request), scopes and `request_id`, stored in async-local storage.
4. **Enforce tenancy in data access.** The repository base class adds `tenant_id` to every query, and PostgreSQL row-level security is enabled as a second line of defence.
5. **Wire up observability.** The logger and the tracing exporter read user and tenant from the context.
6. **Propagate to workers.** Jobs carry `{user_id, tenant_id, trace_id}`. The worker rebuilds the context before running.

**Result:**
- Every endpoint is authenticated, or deliberately public.
- Cross-tenant reads become impossible at two layers.
- Every log line and trace span names the user and tenant.
- Handler code shrinks, because none of it parses headers any more.

## Pitfalls

- **Allow by default.** Opt-in auth means one forgotten decorator is a breach. Make protection the default and public routes the exception.
- **Trusting client-supplied identity.** User IDs or tenant IDs from the body, query string or an unsigned header can be forged. Take identity only from the verified credential.
- **Weak JWT validation.** Accepting `alg: none`, not checking `aud`, or decoding without verifying. Use a well-maintained library and configure it strictly.
- **Global or leaked context.** Mutable globals, or thread-locals not cleared after the request, mix up users under load.
- **Authorization only in middleware.** Scope checks can't tell whether user 42 owns order 812. Object-level checks belong next to the data (broken object-level authorization is #1 in the OWASP API Security Top 10).
- **Not propagating context to async work.** Spawning a task or a thread pool job without the context loses the identity and trace, or worse, inherits a stale one.
- **Logging credentials.** Request logging middleware that dumps headers writes bearer tokens and cookies to your log store. Redact them.

> [!WARNING]
> Never derive `tenant_id` or `user_id` from anything the client controls directly. Put them in the context only from a verified token or session, and make data access read them from the context. Cross-tenant leaks almost always start with an ID taken from the request.

## Discussion questions

1. Why should authentication be deny-by-default, and how would you enforce that in CI?
2. When would you return `404` instead of `403` for an authorization failure?
3. Compare session cookies and JWTs for a single web app and for a fleet of 50 microservices. What changes?
4. How would you revoke a compromised JWT before it expires, and what does that cost?
5. What goes wrong with thread-local context when a request handler hands work to a thread pool or an `async` executor?
6. How should identity be passed from an API service to an internal service it calls, and why is a plain `X-User-Id` header risky?

## FAQ

### Should authorization live in middleware or in the business logic?

Both. Middleware is good for coarse checks: authenticated at all, has a scope, has a role. Object-level checks (does this user own this order, is this document shared with them) need the resource, so they belong in the service layer, reading the principal from the context. Policy engines such as OPA or Cedar can centralise the rules while still being called from that layer.

### Is it safe to store user info in JWT claims?

Signed JWTs are tamper-evident but **not encrypted**. Anyone holding the token can read the claims. Keep them to identifiers, scopes and expiry, not personal data. And remember that claims are a snapshot: a role removed after issuance stays in the token until it expires.

### Should the API gateway do authentication instead?

Gateways are a good place to verify tokens once and reject bad traffic early. But services should still verify something, such as the token itself or a gateway-signed header with mTLS between them, so that anything reaching a service from inside the network can't skip the check. This is the zero-trust principle.

### How do I handle service-to-service calls with no user?

Give services their own identities: mTLS certificates (for example SPIFFE IDs from a service mesh) or OAuth client-credentials tokens. The context then has a service principal instead of a user. When a service acts on behalf of a user, keep both: the user as subject and the service as actor.

### What's the cost of verifying a JWT on every request?

Small. Signature verification takes microseconds to tens of microseconds, and the JWKS is cached. Session lookups in Redis cost a network round trip, usually well under a millisecond in the same data centre. Either is cheap compared with doing auth inconsistently.

## Key takeaways

- Authenticate in middleware, deny by default, and mark public routes explicitly.
- 401 means unknown identity, 403 means known identity and not allowed. Object-level authorization belongs next to the data.
- Sessions revoke instantly; JWTs verify without a network call. Short-lived JWTs plus revocable refresh tokens combine both.
- Put the principal, tenant, scopes and trace ID in an immutable per-request context, passed explicitly or via async-local storage.
- Propagate context to logs, data access, outbound calls and background jobs. Take identity only from verified credentials.

## References

- IETF: [RFC 7519, JSON Web Token (JWT)](https://datatracker.ietf.org/doc/html/rfc7519) and [RFC 8725, JWT Best Current Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- IETF: [RFC 7662, OAuth 2.0 Token Introspection](https://datatracker.ietf.org/doc/html/rfc7662)
- IETF: [RFC 8693, OAuth 2.0 Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
- OWASP: [API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
- OWASP Cheat Sheet Series: [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- Go: [package context](https://pkg.go.dev/context)
- Node.js: [Asynchronous context tracking (AsyncLocalStorage)](https://nodejs.org/api/async_context.html)
- W3C: [Trace Context](https://www.w3.org/TR/trace-context/)

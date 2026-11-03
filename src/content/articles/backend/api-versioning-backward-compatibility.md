---
summary: What counts as a breaking API change, how to evolve a contract additively so old clients keep working, the trade-offs between URL, header and date-pinned versioning, how version-transform chains keep one codebase serving many shapes, and how to retire old versions with data instead of guesswork.
updated: 2026-11-02
---

> [!KEY]
> Once a client you don't control depends on your API, **every response shape is a promise**. The safest strategy has three parts:
> 1. **Evolve additively.** Add optional fields, new endpoints and new values. Never remove, rename or change the meaning of something already shipped.
> 2. **Version only for real breaks, and rarely.** Put the version somewhere explicit (URL, header or a date pin). Implement older versions as thin adapters over one current codebase, not as forked code.
> 3. **Retire with data.** Announce the change, send `Deprecation` and `Sunset` headers, measure usage per client, run brownouts, and remove the old version only when usage says nobody is left behind.
>
> Clients have a share of the work too. They must **ignore unknown fields** and **tolerate unknown enum values**, or even additive changes will break them.

## The problem: you can't redeploy your clients

Inside one codebase, renaming a field is a refactor: the compiler finds every use and you fix them all in one commit. Across an API boundary, you can't:

- mobile apps installed a year ago are still on people's phones and still calling you,
- partners deployed integrations against your docs and don't plan to touch them again,
- other teams' services pin to a contract and release on their own schedule.

So the mobile team renames `customer` to `buyer` in a response "because it's clearer," and three things happen:

- old app versions crash on a `null`,
- a partner's nightly sync silently drops orders,
- support tickets arrive for a week.

Nobody broke the code. They broke the **contract**.

API versioning is the discipline of changing a contract without breaking the clients who depend on it. Most of that discipline is about not needing a new version at all.

## How it works

### Safe vs breaking changes

![Two lists: backward compatible changes such as adding optional fields and endpoints, versus breaking changes such as removing or renaming fields and changing types](/figures/api-versioning/changes.svg "The test for a breaking change: could a correct client written against the old contract now fail?")

A change is **backward compatible** if every correct client written against the old contract keeps working unchanged. Usually safe:

- adding a new endpoint, method or resource,
- adding a field to a response,
- adding an **optional** request parameter with a default that preserves the old behaviour,
- relaxing validation (accepting longer strings, more formats).

Usually **breaking**:

- removing or renaming a field, endpoint or parameter,
- changing a type (`"id": 42` → `"id": "42"`), a unit (cents → dollars) or a format (date → timestamp),
- making an optional input required, or tightening validation and limits,
- changing status codes, error shapes, default sort order or pagination behaviour,
- changing semantics while keeping the shape (`status: "complete"` now means something different).

Some changes are breaking or not depending on what clients were promised:

- **New enum values** are safe only if clients were told to handle unknown values, for example by falling back to "other".
- **New response fields** are safe only if clients don't use strict deserializers that reject unknown keys.

This is the **robustness principle** applied to contracts: be conservative in what you send, liberal in what you accept. Say so explicitly in your docs and SDKs.

Then there is **Hyrum's Law**: with enough users, every observable behaviour will be depended on by somebody. That includes field order, error message text, response time and undocumented fields. You can't prevent all of it, but you can limit it:

- document what *is* the contract,
- keep error codes stable and machine-readable,
- avoid exposing incidental behaviour.

### Additive evolution first

Most API change should never need a new version. The patterns that make that possible:

- **Expand, then contract.** To rename `customer` to `buyer`, add `buyer` alongside `customer` and return both. Migrate clients. Stop returning `customer` only when usage shows nobody reads it, and only in a new version if anyone still might.
- **New fields, not changed fields.** Need amounts as objects instead of integers? Add `amount_details` and keep `amount`.
- **New endpoints for new semantics.** If `POST /refunds` should behave differently, consider `POST /refunds` with an explicit opt-in parameter, or a new resource, rather than silently changing it.
- **Defaults that preserve old behaviour.** A new optional `include_archived` parameter defaults to `false`, which is what the endpoint already did.
- **Schema-level tooling.**
  - Protobuf evolves by field numbers: never reuse or renumber them, and mark removed ones `reserved`.
  - GraphQL evolves by `@deprecated` fields and per-field usage tracking.
  - OpenAPI diff tools in CI catch accidental breaking changes before merge.

### Where the version lives

![Three versioning schemes compared: URL path, header or media type, and date-pinned version header](/figures/api-versioning/strategies.svg "All three work. The difference is how visible the version is, how coarse it is, and how much the server has to do.")

When you do need a breaking change, the client has to say which contract it wants.

**URL path** (`/v1/orders`, `/v2/orders`) is the most common scheme:

- it's visible in logs, docs and `curl`,
- it's trivially cacheable and routable at a gateway,
- but the whole API usually moves at once, so `v2` becomes a big-bang migration,
- and links and stored URLs embed the version.

**Header or media type** (`Accept: application/vnd.shop.v2+json`, or a custom `Api-Version: 2` header):

- keeps URLs stable and lets resources version independently,
- but it's easy to forget in `curl`,
- and caches must `Vary` on the header or they'll serve the wrong shape.

**Date-pinned versions** (`Api-Version: 2026-03-01`), popularized by Stripe:

- every breaking change is a small, dated step,
- each account is pinned to the version current when it integrated,
- clients upgrade one dated step at a time, on their own schedule,
- it scales to many small changes without "v7",
- but it needs the server-side machinery described next.

Whatever the scheme, decide what happens when the client sends **no** version. Pick one rule, document it and apply it consistently:

- the account's pinned version (safest for date-pinned APIs),
- the oldest supported version,
- or a `400` asking the client to choose.

Never silently default to "latest".

### One codebase, many shapes: version transforms

![A handler producing the latest shape, followed by a chain of adapters that transform the response back to older pinned versions](/figures/api-versioning/chain.svg "Handlers only know the newest contract. Each breaking change ships with one adapter that converts newer shapes back to the shape just before the change.")

The naive way to support `v1` and `v2` is to copy the handlers. That doubles every bug fix and security patch, and the copies drift apart.

The scalable way:

1. Write handlers against the **latest** contract only.
2. For each breaking change, write one small **version adapter**. It converts a response from the new shape to the old one (and a request from old to new).
3. At request time, look up the client's pinned version. Run the adapters for every change newer than that pin, newest first.

A client pinned to the latest runs no adapters. A client pinned two changes back runs two.

Adapters are small, independently testable and documented by their own existence. Each one is effectively a changelog entry. When no account is pinned before an adapter's date, delete it.

Adapters can't fix everything. Some changes are semantic: a new rate limit, a different side effect, a removed capability. For those, the handler itself must branch on the version, or you keep the old behaviour behind a flag until the version retires. Keep that branching rare and centralized.

### Retiring old versions

![Deprecation lifecycle: announce, measure usage, nudge with headers and outreach, brownout, remove](/figures/api-versioning/lifecycle.svg "Retirement is a project, not a date. The calendar sets expectations; usage data decides when it is safe.")

Every supported version has a running cost. Retire versions deliberately:

1. **Announce.** Changelog, email and docs. Mark responses with a `Deprecation` header (RFC 9745) and add a `Link` to the migration guide.
2. **Measure.** Log the API version and client identity (API key, OAuth client, app version) on every request. Without per-client usage, you can't tell whether retiring a version breaks 0 clients or 500.
3. **Nudge.** Add a `Sunset` header (RFC 8594) with the removal date. Contact the remaining top callers directly. Offer SDK upgrades.
4. **Brownout.** Briefly fail old-version requests on a published schedule: first minutes, then hours. Dormant integrations surface while the old version can still be restored instantly.
5. **Remove.** Return `410 Gone` with a clear error pointing to the migration guide. Don't return a confusing `404` or, worse, quietly serve the new shape.

For mobile apps, add a **minimum supported app version** check, so very old builds show an "update required" screen instead of failing in strange ways.

## Where it's used

| Context | Typical approach | Why |
|---|---|---|
| Stripe API | Date-pinned versions per account, with server-side transforms | Many small breaking changes without forcing big-bang migrations |
| GitHub REST API | Date-based version header, plus a separate GraphQL API that evolves through deprecations | Long-lived integrations; schema evolution for GraphQL |
| Google APIs (AIP guidance) | Major version in the path (`v1`, `v2`); additive changes within a version | Large public surface; clear compatibility rules per major version |
| Protobuf/gRPC services | Package versions (`orders.v1`), field-number discipline, `reserved` tags | Binary compatibility across independently deployed services |
| GraphQL APIs | Mostly versionless; `@deprecated` fields with usage tracking | Clients choose fields, so unused fields can be measured and removed |
| Mobile backends | Additive changes plus a minimum app version gate | Old app versions stay installed for years |

## Use case walk-through: changing money from integers to objects

A payments API returns `"amount": 1999` (cents, implicitly USD). Multi-currency support needs `{ "value": 1999, "currency": "EUR" }`.

1. **Try additive first.** Add `amount_details: { value, currency }` and keep `amount` as-is for USD. That works for reads, but `amount` becomes ambiguous for non-USD charges, so a clean contract still needs a breaking change.
2. **Ship a dated version.** Version `2026-03-01` changes `amount` to an object. The handler is rewritten to produce only the new shape.
3. **Write one adapter.** For clients pinned before `2026-03-01`, the adapter converts `amount` back to an integer in USD charges. For non-USD charges it also includes `amount_details`, so older clients still have a correct path. Requests are adapted the other way: an integer `amount` is converted to `{ value, currency: "usd" }`.
4. **Test both directions.** Contract tests replay recorded requests and responses for each supported version. The OpenAPI diff in CI flags any unintended changes to old versions.
5. **Let clients upgrade on their own schedule.** New accounts get the new version. Existing accounts can test the upgrade with a per-request `Api-Version` header, then switch their account pin in the dashboard.
6. **Track and retire.** Usage per pinned version is on a dashboard. A year later, 97% of traffic uses the new version. The remaining accounts are contacted and given a sunset date, and the adapter is eventually deleted.

**Result:** multi-currency launches without breaking a single existing integration. The codebase contains one handler and one 40-line adapter, not two forked payment flows.

## Pitfalls

- **Breaking without noticing.** Changing an error message that clients parse, adding a required field or changing default sort order are all breaking. Run contract tests and schema diffs in CI.
- **Versioning too often.** `v1` through `v9` in three years means clients never catch up and you maintain nine contracts. Prefer additive change. Batch genuinely breaking ones.
- **Forking code per version.** Copy-pasted `v1/` and `v2/` handlers drift apart, and security fixes get applied to only one. Use adapters over a single implementation.
- **Strict clients.** SDKs that reject unknown fields or enum values turn every additive change into a breaking one. Ship tolerant SDKs and document the expectation.
- **Defaulting to latest.** Unversioned requests that silently get the newest contract break every client on each release.
- **Retiring blind.** Removing a version without per-client usage data means learning about dependents from outages. Measure first, then brown out.
- **Forgetting caches.** Header-based versions without `Vary` let a CDN serve a `v2` shape to a `v1` client.
- **Silent semantic changes.** Same field, same type, different meaning is the hardest break to detect. Treat it as breaking and version it.

> [!TIP]
> Make breaking changes expensive to write and cheap to detect. Put a schema diff (OpenAPI, Protobuf `buf breaking`, GraphQL schema checks) in CI that fails on any incompatible change, unless the PR explicitly adds a new version and an adapter. Most accidental breaks are caught before review.

## Discussion questions

1. Is adding a new enum value a breaking change? What would you put in your API guidelines and SDKs so it isn't?
2. Compare URL-path and date-pinned versioning for an API with 50 endpoints and about four breaking changes per year. Which hurts more in year three?
3. How would you design the adapter chain so that it also handles request bodies and webhooks, not just responses?
4. A partner hasn't called the old version in 60 days but has a contract guaranteeing support. How does that change your retirement plan?
5. What should happen when a client sends no version header at all? Defend your choice.
6. How do Hyrum's Law and "undocumented but observable" behaviour affect what you consider your contract?

## FAQ

### Should I put the version in the URL or a header?

Both work. URL versions are easier to see, route and cache, which makes them a good default for public APIs with infrequent major versions. Headers, especially date-pinned versions, suit APIs that make many small breaking changes and want clients to upgrade step by step. Consistency and clear compatibility rules matter more than the choice.

### Do I need versioning for internal APIs?

You need **compatibility** for internal APIs, because services deploy independently. But you rarely need formal versions. Additive changes, expand-and-contract migrations and schema checks in CI usually suffice. Reserve explicit versions for breaks you can't coordinate.

### How long should I support an old version?

It depends on your consumers. Public APIs commonly promise 12–24 months after deprecation, while internal ones may need only weeks. Publish a policy, honour it, and let usage data rather than the calendar alone decide the final removal.

### Is GraphQL really "versionless"?

Mostly. Because clients request specific fields, you can add freely, and you can see exactly who still reads a deprecated field. Breaking changes still happen (changing a field's type or nullability, for example). They're handled with new fields and deprecations rather than a new endpoint version.

### What's the difference between semantic versioning and API versioning?

SemVer (major.minor.patch) labels **libraries**, where consumers choose when to upgrade by changing a dependency. A web API is a running service that all clients share, so it usually exposes only the "major" part (or a date). Minor and patch changes must be backward compatible and are applied to everyone. SDKs for the API should still follow SemVer.

## Key takeaways

- A breaking change is anything that could make a **correct old client** fail, including changes in semantics, validation, errors and defaults.
- **Evolve additively** and use expand-then-contract. Most changes should never need a new version.
- When you must break, make the version **explicit** (URL, header or date pin) and **never default unversioned requests to latest**.
- Serve old versions with **adapters over one current codebase**, not forked handlers.
- Retire with **Deprecation/Sunset headers, per-client usage data, brownouts and `410 Gone`**.
- Clients share responsibility: **ignore unknown fields and tolerate unknown enum values**.

## References

- [Stripe: APIs as infrastructure: future-proofing Stripe with versioning](https://stripe.com/blog/api-versioning)
- [Google AIP-180: Backwards compatibility](https://google.aip.dev/180)
- [Google AIP-185: API versioning](https://google.aip.dev/185)
- [GitHub REST API: API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [RFC 8594: The Sunset HTTP Header Field](https://www.rfc-editor.org/rfc/rfc8594)
- [RFC 9745: The Deprecation HTTP Response Header Field](https://www.rfc-editor.org/rfc/rfc9745)
- [Protocol Buffers: Updating a message type](https://protobuf.dev/programming-guides/proto3/#updating)
- [Hyrum's Law](https://www.hyrumslaw.com/)
- [Semantic Versioning 2.0.0](https://semver.org/)

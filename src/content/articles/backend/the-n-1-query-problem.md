---
summary: How lazy-loading ORMs and naive GraphQL resolvers turn one page into hundreds of queries, how to detect N+1 in development and production, and the fixes (eager loading, batching with IN, joins, DataLoader) with their trade-offs.
updated: 2026-11-02
---

> [!KEY]
> The N+1 problem happens when code loads a list with one query, then runs **one more query per item** to fetch related data. 50 posts means 51 queries. Each query is cheap. The round trips are not, and their number grows with the data. ORMs hide it behind lazy-loaded attributes like `post.author`, and GraphQL resolvers create it naturally. The fix is to fetch related data in a fixed number of queries:
> - eager loading (`includes`, `select_related`, `joinedload`),
> - a batched `WHERE id IN (…)`,
> - a join,
> - DataLoader-style batching.
>
> Catch it with query counting in tests and per-request query metrics in production.

## The problem: a fast query, run 200 times

A blog index renders posts with author names:

```python
posts = Post.objects.order_by('-created')[:50]
for post in posts:
    print(post.title, post.author.name)   # one query per post
```

`post.author` looks like an attribute, but on first access the ORM runs `SELECT * FROM authors WHERE id = ?`. In development this is invisible:

- three posts in the seed data,
- the database on localhost,
- 0.1 ms per query.

In production the page shows 50 or 200 posts, the database is a network hop away, and each round trip costs 0.5–2 ms plus connection-pool contention. Add comments, tags and like counts, each with its own lazy relation, and one page issues 600 queries. Nothing in the code *looks* like a loop of queries.

## How it works

### Three shapes of the same page

![Query shapes](/figures/n-plus-one/trips.svg "Lazy loading needs one round trip per post. A batched IN query needs two, and a join needs one, whatever the page size.")

| Shape | Queries | How it works | Trade-off |
|---|---|---|---|
| N+1 (lazy) | 1 + N | Fetch related rows on first access | Simple code, latency grows with N |
| Batched (`IN`) | 1 + 1 per relation | Collect foreign keys, fetch all related rows at once | Two queries, no row duplication |
| Join | 1 | `JOIN` in the database | One round trip, but parent rows repeat for to-many relations |

### Why it hurts more than it seems

![Latency vs N](/figures/n-plus-one/scale.svg "N+1 latency grows linearly with the number of rows; batched and joined queries stay nearly flat.")

- **Round-trip latency dominates.** Network time, protocol overhead and parsing cost more than the indexed lookup itself.
- **It's linear in data.** The page gets slower as users create more content, so the regression shows up weeks after the code shipped.
- **It amplifies other limits.** Hundreds of queries per request hold pool connections longer and swamp the database's per-query CPU.
- **It nests.** Posts → comments → comment authors becomes N × M queries.

### Fix 1: eager loading in the ORM

Every major ORM can load relations up front:

| ORM | To-one (join) | To-many (separate IN query) |
|---|---|---|
| Django | `select_related('author')` | `prefetch_related('comments')` |
| Rails (Active Record) | `includes` / `eager_load` | `includes` / `preload` |
| SQLAlchemy | `joinedload(Post.author)` | `selectinload(Post.comments)` |
| Hibernate / JPA | `JOIN FETCH`, entity graphs | `@BatchSize`, `SUBSELECT` fetch |
| Prisma | `include: { author: true }` | `include` (batched queries) |
| Laravel Eloquent | `with('author')` | `with('comments')` |

A rule of thumb:

- **To-one relations** (post → author): join them. Each row gains a few columns.
- **To-many relations** (post → comments): use a separate `IN` query. Joining multiplies rows. 50 posts × 30 comments returns 1,500 rows with the post columns repeated, and two to-many joins together create a cartesian explosion.

### Fix 2: batching across code you don't control (DataLoader)

![DataLoader batching](/figures/n-plus-one/dataloader.svg "Resolvers each ask for one key; the loader waits a tick, removes duplicates and sends one batched query.")

GraphQL resolvers run per field, per object. A `Post.author` resolver has no idea that 49 sibling resolvers are about to ask for authors too. **DataLoader** (originally from Facebook, now ported to most languages) solves this:

1. Each resolver calls `authorLoader.load(post.authorId)` and gets a promise.
2. The loader collects keys until the current event-loop tick ends.
3. It removes duplicates and calls a batch function once: `SELECT … WHERE id IN (3, 5, 7, 12)`.
4. It resolves each promise from the result, in key order, and caches the values **for this request**.

The same idea works outside GraphQL. Anywhere code naturally asks for one item at a time, put a batching layer underneath.

### Fix 3: reshape the query

Sometimes the right fix is a different query:

- **Aggregates in SQL:** `COUNT(*) … GROUP BY post_id` instead of loading every comment to count them.
- **Window functions or `LATERAL` joins:** "latest 3 comments per post" in one query.
- **Denormalised columns:** store `comment_count` on the post when it's read far more often than it's written.
- **Purpose-built read models:** for complex screens, a view or a materialised projection.

### Detecting it

- **In development:**
  - query logs per request,
  - Bullet (Rails), `nplusone` and django-debug-toolbar (Django), Hibernate statistics,
  - Prisma query logging.
- **In tests:** assert query counts, for example with `assertNumQueries` in Django or `expect { }.to make_database_queries(count: 3)` in Rails. A test that renders 2 and then 20 items should issue the same number of queries.
- **In production:** APM traces (Datadog, New Relic, Sentry, OpenTelemetry) show a request with 300 identical `SELECT` spans. Alert on queries per request, not just on latency.
- **Strict mode:** some ORMs can *raise* on lazy loading, such as Rails `strict_loading`, Laravel `preventLazyLoading`, and SQLAlchemy `raiseload`.

## Where it's used

| Context | Where N+1 appears | Usual fix |
|---|---|---|
| Server-rendered pages | Templates touching `post.author` in a loop | Eager loading in the controller |
| REST serializers | Nested serializers for related objects | `select_related` / `prefetch_related` on the queryset |
| GraphQL APIs | Field resolvers per object | DataLoader per request |
| Microservices | Calling another service per item | A batch endpoint (`GET /users?ids=…`) |
| Background jobs | Processing records one at a time, loading relations | Process in chunks with eager loading |

## Use case walk-through: a slow order history page

An order history API returns 100 orders, each with line items, products and a shipping address. p95 latency is 1.8 s. The database CPU looks healthy.

1. **Trace a request.** The APM trace shows 1 query for orders, 100 for addresses, 100 for line items, and 640 for products: 841 queries in total.
2. **Add eager loading.**
   - Addresses (to-one) get a join.
   - Line items (to-many) get a separate `IN` query.
   - Products get a nested `IN` query keyed by line items.
   - The total is now 3 queries.
3. **Trim the columns.** The serializer only needs `product.name` and `product.image_url`, so load only those columns. Leave out the large `description` column.
4. **Add a guard test.** Render 5 orders, then 50, and assert the same query count in both cases.
5. **Turn on strict loading in development**, so a new lazy relation raises an error instead of quietly adding queries.

**Result:**
- 841 queries became 3.
- p95 latency fell from 1.8 s to 95 ms.
- Connection-pool wait time disappeared from the database dashboard.

## Pitfalls

- **Over-eager loading.** Preloading every relation "just in case" fetches large amounts of unused data. Load what the view actually uses.
- **Joining to-many relations.** Joining two to-many relations multiplies rows (posts × comments × tags). Use separate `IN` queries.
- **Huge `IN` lists.** Thousands of IDs can exceed parameter limits or produce poor plans. Chunk the list, or use `= ANY($1::int[])` in PostgreSQL.
- **Hidden N+1 in methods.** A model method like `post.is_liked_by(user)` runs a query. Calling it in a loop is N+1 even with eager loading.
- **DataLoader cached across requests.** A loader cache shared between users leaks data and serves stale results. Create loaders per request.
- **N+1 over HTTP.** Calling a user service once per item is the same bug with worse latency. Add batch endpoints.

> [!TIP]
> Make N+1 fail loudly: enable strict or lazy-load-raising mode in development and tests, and add one "constant query count" test per list endpoint. It's cheaper than finding the problem in an APM trace after a traffic spike.

## Discussion questions

1. Why is N+1 usually invisible in development? What would you change in your dev setup to expose it?
2. When should a relation be joined and when should it be loaded with a separate `IN` query?
3. How does DataLoader know when to send its batch, and what would go wrong if it waited too long or too briefly?
4. A page lists posts with "liked by you". How would you load that flag without N+1?
5. How would you detect N+1 regressions automatically in CI?
6. How does N+1 between microservices differ from N+1 against a database, and how would you design APIs to avoid it?

## FAQ

### Is N+1 always bad?

Not if N is tiny and bounded, say 3 items on a settings page. It's a problem when N grows with data or user input. Avoiding it by default is cheap, so most teams treat it as a bug.

### Isn't one big join always the best?

No. Joins across to-many relations repeat parent rows and can create cartesian products. Two or three focused `IN` queries often transfer less data and are easier for the planner.

### Does caching fix N+1?

It hides it. A cache in front of each lookup turns database round trips into cache round trips, which are cheaper but still one per item. And cold caches bring the original problem back. Batch first, then cache.

### How do I fix N+1 in GraphQL?

Use DataLoader (or your framework's equivalent) for every relation resolver, created per request. Some frameworks, such as Hasura and PostGraphile, compile the whole GraphQL query into SQL, which avoids the problem altogether.

### What about NoSQL databases?

The same pattern applies. Fetching documents one at a time by reference should be replaced with batch gets (`BatchGetItem`, `$in`, `mget`), or by embedding data that's always read together.

## Key takeaways

- N+1 is one query for a list plus one per item. Round trips, not query cost, make it slow, and it grows with the data.
- Fetch relations in a constant number of queries: join to-one relations and use `IN` queries for to-many ones.
- Use DataLoader-style batching where per-item code is unavoidable, as in GraphQL resolvers. Keep caches per request.
- Detect it with query-count tests, strict lazy-loading modes and per-request query metrics.
- The same bug exists between services. Design batch endpoints.

## References

- Django documentation: [`select_related` and `prefetch_related`](https://docs.djangoproject.com/en/stable/ref/models/querysets/#select-related)
- Rails Guides: [Eager Loading Associations](https://guides.rubyonrails.org/active_record_querying.html#eager-loading-associations)
- SQLAlchemy: [Relationship Loading Techniques](https://docs.sqlalchemy.org/en/20/orm/queryguide/relationships.html)
- GraphQL: [DataLoader](https://github.com/graphql/dataloader) repository and README
- Bullet gem: [flyerhzm/bullet](https://github.com/flyerhzm/bullet)
- Vlad Mihalcea, *High-Performance Java Persistence*, 2016

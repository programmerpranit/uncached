---
summary: How offset/limit pagination works and why it gets slower and less correct as data grows, how cursor (keyset) pagination seeks past the last row with a tie-broken index, how to design opaque cursors and page responses, and when offsets are still the right choice.
updated: 2026-11-02
---

> [!KEY]
> **Offset pagination** (`LIMIT 20 OFFSET 980`) asks for "rows at positions 981–1000". It's simple and lets users jump to page 50, but:
> - the database must **read and discard** every skipped row, so deep pages get linearly slower,
> - inserts and deletes between requests **shift positions**, so users see duplicates or miss rows.
>
> **Cursor (keyset) pagination** asks for "the next 20 rows after the last one I saw": `WHERE (created_at, id) < ($ts, $id) ORDER BY created_at DESC, id DESC LIMIT 20`. With a matching index it **seeks** straight there, so every page costs the same and concurrent writes don't shift results. The trade: no random "jump to page N", and the sort order must be **total** (add a unique tie-breaker).

## The problem: lists that keep growing

Every API eventually returns a list too big to send at once: orders, comments, log lines, search hits. You split it into pages. The first version is nearly always:

```
GET /posts?page=3&per_page=20
→ SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 40;
```

It works perfectly in development with 200 rows. In production with 50 million rows, three things go wrong:

1. **Deep pages are slow.** A crawler or export job walking to page 10,000 makes the database scan 200,000 rows to return 20.
2. **Pages are inconsistent.** On a busy feed, new posts arrive while a user scrolls. Items repeat or vanish between pages.
3. **`COUNT(*)` for "page 3 of 2,481,337" is expensive** on large tables, and often the slowest query on the page.

## How it works

### Offset pagination and its cost

`OFFSET n` has no shortcut. A B-tree index can find "the first row ordered by `created_at` DESC" instantly, but it can't find "the 99,981st row" without walking 99,980 entries. Without a usable index it's worse: the engine sorts the matching rows, then skips n of them.

![Cost of OFFSET by page depth](/figures/pagination/offset-cost.svg "Every skipped row is read and thrown away, so cost grows with page depth")

Shallow pages are fine, and most users never go past page 3. The danger is the long tail: bots, scrapers, "export everything" scripts and infinite scroll that ran for an hour. They hit the deep pages and turn a 2 ms query into a 2 s one. Many sites cap offset depth for exactly this reason. Search engines like Elasticsearch refuse deep `from + size` beyond 10,000 by default.

### Offset drift

Positions are relative to the data **at query time**. If a row is inserted before the user's current position between two requests, everything shifts down by one:

![Offset drift](/figures/pagination/drift.svg "An insert between requests makes page 2 repeat a row; a delete would make it skip one")

- An **insert** above the cursor position means the next page repeats the last item.
- A **delete** above it means the next page skips an item the user never saw.

For a social feed this is merely annoying. For a sync job ("fetch all changed invoices, page by page") a skipped row is a **data loss bug**.

### Cursor (keyset) pagination

Instead of "skip n rows", remember **the sort key of the last row returned** and ask for rows past it:

```sql
SELECT * FROM posts
WHERE (created_at, id) < ($last_created_at, $last_id)
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

![Keyset pagination](/figures/pagination/keyset.svg "With an index on (created_at, id), the database seeks to the cursor and reads only the page")

Three details make it correct and fast:
- **Total order.** `created_at` alone isn't unique, since two posts can share a timestamp. If the page boundary falls between them, a plain `created_at < x` skips the second one. Adding the primary key as a **tie-breaker** makes every row's position unique.
- **Row-value comparison.** `(a, b) < (x, y)` means `a < x OR (a = x AND b < y)`. Postgres and MySQL support the tuple syntax. Postgres can use a composite index for it directly. On engines that can't, write the expanded `OR` form, and check the plan.
- **Matching index.** `CREATE INDEX ON posts (created_at DESC, id DESC)`. With it, the query is an index seek plus a 21-row range scan, so page 1 and page 100,000 cost the same.

Ask for **one extra row** (`LIMIT 21` for a page of 20). If you get 21, there's a next page: return 20 and build the cursor from the 20th. That gives `has_more` without a `COUNT`.

Filters work the same way, as long as the index leads with the equality columns: `WHERE author_id = 7 AND (created_at, id) < (…)` wants an index on `(author_id, created_at, id)`.

### Designing the cursor

Don't expose `?after_id=81723&after_ts=…` as raw parameters. Return an **opaque token**:

```json
{
  "data": [ … 20 items … ],
  "page_info": { "next_cursor": "eyJ0cyI6IjIwMjYtMTEtMDJUMTA6MTU6MDNaIiwiaWQiOjgxNzIzfQ", "has_more": true }
}
```

- **Opaque** (for example base64 JSON, optionally signed or encrypted) so clients don't parse it, and you can change sort keys or add a version field without breaking them.
- **Bound to the query.** Include the sort and filter in the cursor (or a hash of them), and reject a cursor used with different parameters.
- **Stable sort keys only.** If the sort column can change (`updated_at`, `score`), a row can move across the cursor while someone pages. For sync use cases that's intended: sort by `updated_at, id` and a changed row reappears later. For a ranked list it's a source of duplicates.
- **Previous pages.** Return a `prev_cursor` too, and run the query with the comparison and order flipped, then reverse the results.

GraphQL's Relay connection spec standardises this shape (`edges`, `node`, `cursor`, `pageInfo { hasNextPage, endCursor }`). Stripe uses `starting_after` / `ending_before` with object ids. Slack and many others return `next_cursor`.

### When offsets are still right

Keyset pagination can't jump to "page 37 of 120". Offset is a reasonable choice when:
- the dataset is **small or bounded** (an admin table with a few thousand rows),
- users really need **numbered pages** and random access (search results, report tables),
- the data rarely changes while being browsed.

You can **cap depth** (refuse offsets over 10,000 and nudge users to filter), or use a **hybrid**: offset within a small window, keyset to fetch the window. For total counts, show an estimate ("about 2.4M results"), using `pg_class.reltuples` or `EXPLAIN` row estimates, rather than an exact `COUNT(*)`.

## Where it's used

| System | Style |
| --- | --- |
| Stripe API | Cursor via object id: `limit`, `starting_after`, `ending_before`, `has_more` |
| GitHub REST / GraphQL | `Link` headers with page URLs (REST). Relay-style cursors (`after`, `endCursor`) in GraphQL |
| Slack Web API | `cursor` and `response_metadata.next_cursor` |
| Twitter/X, Instagram, Facebook feeds | Opaque cursors for infinite scroll |
| Elasticsearch / OpenSearch | `from`/`size` capped at 10,000. `search_after` plus point-in-time for deep pages |
| Admin dashboards, e-commerce category pages | Offset with numbered pages, usually depth-capped |
| Change-sync APIs (CRMs, accounting) | Keyset on `(updated_at, id)` so clients can resume after a checkpoint |

## Use case walk-through: fixing an export that times out

A B2B SaaS lets customers export all their invoices through `GET /invoices?page=N`. Large customers (3M invoices) report that exports time out around page 8,000 and sometimes contain duplicate invoices.

1. **Measure.** `EXPLAIN ANALYZE` on page 8,000 shows an index scan reading 160,020 rows and discarding 160,000: 1.8 s. Page 1 takes 1 ms.
2. **Explain the duplicates.** New invoices are created during the hour-long export, and they sort first by `created_at DESC`. Each insert shifts all later pages by one, so the last row of a page reappears on the next.
3. **Pick a stable, total order.** Export oldest first: `ORDER BY created_at ASC, id ASC`. New invoices land at the *end*, so they don't disturb pages already fetched.
4. **Add the index:** `CREATE INDEX CONCURRENTLY ON invoices (tenant_id, created_at, id)`.
5. **Switch the endpoint to cursors.** Accept `?cursor=…`, decode `{ts, id, v:1}`, and query `WHERE tenant_id = $t AND (created_at, id) > ($ts, $id) ORDER BY created_at, id LIMIT 501`. Return 500 rows plus `next_cursor` and `has_more`.
6. **Keep the old API working.** `?page=` still works but is capped at page 100, with a `Deprecation` header pointing to the cursor API.

**Result:** every page takes about 3 ms regardless of depth. The 3M-invoice export finishes in under two minutes with no duplicates, and the client can resume from its last cursor after a network failure.

## Pitfalls

- **Non-unique sort key.** Paging on `created_at` alone silently skips rows that share the boundary timestamp. Always add a unique tie-breaker.
- **Index doesn't match the order.** Keyset without a matching composite index is still a sort plus a scan. Check `EXPLAIN`.
- **Mixed sort directions.** `ORDER BY score DESC, id ASC` can't use a simple tuple comparison. Write the expanded `OR` predicate or flip the tie-breaker direction to match.
- **Leaky cursors.** Raw ids or timestamps in the URL become an API contract. Make cursors opaque and versioned.
- **Cursor reused with different filters.** A cursor from `status=open` applied to `status=all` gives nonsense. Bind cursors to their query.
- **Exact totals on huge tables.** `COUNT(*)` on every page request can cost more than the page itself. Use estimates or drop the total.
- **Nullable sort columns.** NULLs sort first or last depending on the engine and break tuple comparisons. Use `COALESCE` or exclude them.

> [!TIP]
> Use the "fetch one more than you need" trick everywhere: `LIMIT page_size + 1` tells you whether there's a next page for free, so you never need a separate count query just to show a "Next" button.

## Discussion questions

1. Why can't a B-tree index make `OFFSET 100000` fast, when it can make `WHERE id > 100000` fast?
2. You page by `(created_at, id)`. A row's `created_at` is edited while a client is mid-pagination. What can the client see?
3. How would you implement a "previous page" link with keyset pagination?
4. When is it acceptable to give users duplicates or gaps between pages, and when is it a correctness bug?
5. Design pagination for a feed sorted by a ranking score that changes every minute.
6. How would you let a user jump to "page 50" while still avoiding deep offset scans?

## FAQ

### Is cursor pagination always better?
No. It's better for large, changing, or sequentially consumed data (feeds, sync, exports, APIs). Offset is fine, and simpler, for small bounded lists and UIs that need numbered pages.

### What's the difference between "cursor" and "keyset" pagination?
Keyset is the technique: filter on the last row's sort key. "Cursor" usually means the API exposes that position as an opaque token. Most cursor APIs are keyset underneath, though some encode an offset or a server-side snapshot id instead.

### Do database server-side cursors (`DECLARE CURSOR`) solve this?
Only within one connection and transaction. They hold resources open between requests and don't fit stateless HTTP APIs. They're useful for one-shot batch jobs inside a single session.

### How do I page through search results?
Search engines rank by relevance, which isn't a stable key. Elasticsearch's `search_after` with a point-in-time snapshot plus a tie-breaker gives consistent deep paging. Use `from`/`size` only for the first few pages.

### How big should a page be?
Large enough to amortise per-request overhead, small enough for fast responses: often 20–100 for UIs and 500–1,000 for bulk APIs. Enforce a server-side maximum whatever the client asks for.

## Key takeaways

- `OFFSET n` reads and discards n rows, so **cost grows with depth**, and concurrent writes cause **duplicates and gaps**.
- **Keyset** pagination filters on the last row's sort key, so it **seeks via an index** and costs the same on every page.
- Make the order **total** with a unique tie-breaker, and back it with a **matching composite index**.
- Expose positions as **opaque, versioned cursors** bound to the query, and use `LIMIT n+1` for `has_more`.
- Keep offsets for **small, bounded, numbered-page UIs**, and cap their depth.

## References

- [Markus Winand, Use The Index, Luke: Paging through results](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)
- [Markus Winand: We need tool support for keyset pagination (no-offset)](https://use-the-index-luke.com/no-offset)
- [PostgreSQL documentation: LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html)
- [PostgreSQL documentation: Row constructor comparison](https://www.postgresql.org/docs/current/functions-comparisons.html#ROW-WISE-COMPARISON)
- [Stripe API reference: Pagination](https://docs.stripe.com/api/pagination)
- [GraphQL Cursor Connections Specification (Relay)](https://relay.dev/graphql/connections.htm)
- [Slack API: Pagination](https://api.slack.com/docs/pagination)
- [Elasticsearch documentation: Paginate search results (search_after)](https://www.elastic.co/guide/en/elasticsearch/reference/current/paginate-search-results.html)

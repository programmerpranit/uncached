---
summary: Relevance tuning, reindexing and cluster sizing are where search gets hard — here's how Elasticsearch works underneath and how teams run it well.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — Elasticsearch (and its fork OpenSearch) stores each index as a set of **shards**, each a Lucene index built around an **inverted index** that maps analyzed terms to documents. Queries fan out to one copy of every shard and are scored with **BM25**. Getting a demo working is easy; production is about three things: **relevance** (analyzers, mappings, field boosts, measuring with judgment lists), **reindexing** (mappings and primary shard counts can't change in place, so apps go through an **alias** you swap atomically) and **cluster sizing** (shard counts, heap, disk watermarks, and keeping it a *secondary* index fed from your real database).

## The problem: search is a different kind of database

A relational database answers "which rows have `status = 'shipped'`?" well. It answers "which products best match *running shoes for trails*, ranked by relevance, with counts per brand, in 50 ms over 20 million items?" badly. Full-text search needs:

- **Text analysis** — matching "Running" to "run", ignoring "for", handling plurals, synonyms, accents and typos.
- **Ranking**, not just filtering — the best ten results out of 40,000 matches.
- **Facets and aggregations** computed over the matching set.
- **Horizontal scale** for both data size and query throughput.

Elasticsearch provides all of that, which is why it shows up behind product search, log analytics, autocomplete and in-app search. It also brings new operational problems: a schema you can't easily change, a cluster whose shard layout you have to plan up front, near-real-time (not immediate) visibility of writes, and relevance quality that nobody notices until it's bad.

## How it works

### Shards, replicas and scatter-gather

![An index with three primary shards and one replica each spread over three nodes; a coordinating node scatters the query to one copy of every shard and gathers results](/figures/elasticsearch/cluster.svg "Primaries partition the data; replicas provide failover and extra read capacity.")

- An **index** is split into a fixed number of **primary shards**. A document is routed to a shard by hashing its `_id` (or a custom routing key).
- Each primary has zero or more **replica** shards on *other* nodes. Writes go to the primary, then are replicated; reads can go to any copy.
- A **search** arrives at a coordinating node, which sends it to one copy of every shard (*query phase*: each returns its top-k IDs and scores), merges the results, then fetches the winning documents (*fetch phase*).
- Each shard is a **Lucene index** made of immutable **segments**. New documents land in an in-memory buffer and become searchable on **refresh** (default every 1 s) — hence *near-real-time*. Segments are periodically **merged** in the background.
- Durability comes from the **translog** (a write-ahead log) and replication, not from refresh.

Because the primary shard count is baked into the routing formula, you can't change it without reindexing (the `_split` and `_shrink` APIs help only in limited cases). Replica counts can change at any time.

### Analysis, the inverted index and scoring

![A text field is tokenized, lowercased, stripped of stop words and stemmed into terms; the inverted index maps each term to the documents containing it, and BM25 scores matches](/figures/elasticsearch/analysis.svg "Most relevance bugs are analysis bugs: the indexed terms and the query terms don't line up.")

The **mapping** defines each field's type. The key distinction:

- **`text` fields** are run through an **analyzer** — a tokenizer plus filters (lowercase, stop words, stemming, synonyms, ASCII folding) — and the resulting terms go into the inverted index. Used for full-text matching.
- **`keyword` fields** are stored as a single exact value. Used for filters, sorting, aggregations and IDs.

It's common to index one source field both ways (multi-fields), e.g. `title` as `text` with an English analyzer and `title.raw` as `keyword`.

Scoring uses **BM25** by default: a term counts more when it's rare across the corpus (inverse document frequency), repeated occurrences give diminishing returns, and matches in short fields count more than matches in long ones. On top of that you shape relevance with:

- **Field boosts** — a title match beats a description match (`multi_match` with `title^3`).
- **Query structure** — `bool` queries with `must` (scored), `filter` (unscored, cacheable), `should` (bonus) and `must_not`.
- **Phrase and proximity** — `match_phrase` with `slop`, or `should` clauses that reward phrase matches.
- **Business signals** — `function_score` or `rank_feature` fields for popularity, recency, margin or stock.
- **Synonyms and typo tolerance** — synonym filters (ideally at query time so they can change without reindexing) and `fuzziness`.
- **Semantic search** — dense vector fields with approximate kNN, often combined with BM25 in a hybrid query.

### Zero-downtime reindexing with aliases

![Applications use an alias; a new index is created with the new mapping, filled with reindex, caught up with recent writes, and then the alias is atomically switched](/figures/elasticsearch/reindex.svg "Treat every index as disposable and every mapping change as a rebuild.")

You *can* add new fields to a mapping, but you can't change a field's type or analyzer, or the primary shard count, in place. So the standard pattern is:

1. Applications never use an index name directly — they use an **alias** (`products` → `products_v1`).
2. Create `products_v2` with the new settings and mapping.
3. Fill it with the `_reindex` API, or — better — rebuild it from the **source of truth** (your primary database or event log), which also tests your rebuild path.
4. Catch up writes that happened during the copy: dual-write to both indices, or replay changes since the start timestamp.
5. Swap the alias atomically with one `_aliases` call. Keep v1 around until you're confident, then delete it.

During bulk loads, set `refresh_interval` to `-1` and replicas to 0, then restore them — this can make the load several times faster.

### Keeping it in sync with the database

Elasticsearch should almost always be a **derived index**, not your system of record. Common sync designs:

- **Change data capture** (Debezium → Kafka → an indexer) — reliable, ordered per key, and decoupled from application code.
- **Transactional outbox** — the app writes an event row in the same DB transaction; a relay publishes it for indexing.
- **Dual writes from the app** — simple, but a failure between the two writes leaves them inconsistent; needs periodic reconciliation.

Use document versions (`version_type: external` with a source timestamp or sequence number) so an out-of-order older update can't overwrite a newer one.

### Sizing and operating the cluster

- **Shard size.** Aim for shards of roughly 10–50 GB and avoid thousands of tiny shards — each one costs heap, file handles and cluster-state overhead. Over-sharding is the most common self-inflicted problem.
- **Heap.** Give the JVM about half the machine's RAM, below ~31 GB so compressed object pointers stay on; the rest is the OS page cache that Lucene relies on.
- **Disk watermarks.** At the high watermark (90% by default) shards are moved away; at the flood stage (95%) indices become read-only. Alert well before.
- **Dedicated masters.** Three small master-eligible nodes keep cluster coordination stable on larger clusters.
- **Time-series data.** Logs and events use rollover with **index lifecycle management** and hot/warm/cold tiers, so old data moves to cheaper nodes and is eventually deleted.
- **Snapshots.** Regular snapshots to object storage are your backup; replicas are not backups.
- **Query hygiene.** Deep pagination with `from`/`size` is expensive — use `search_after`. Leading wildcards, huge `terms` aggregations and scripts in hot paths are common causes of latency spikes.

## Where it's used

| Setting | How it shows up |
|---|---|
| E-commerce product search | Analyzers per language, boosts for title/brand, facets, popularity and stock in scoring |
| Log and observability platforms | The ELK/OpenSearch stack: time-based indices, rollover, ILM, hot/warm tiers |
| In-app and site search | Autocomplete with edge n-grams or `search_as_you_type`, typo tolerance |
| Security analytics (SIEM) | High-volume ingest, aggregations and alerting over events |
| Semantic / hybrid search | Dense vector fields with kNN combined with BM25 scores |
| Managed services | Elastic Cloud, Amazon OpenSearch Service; alternatives include Solr, Vespa, Typesense, Meilisearch |

## Use case walk-through: fixing product search for a marketplace

A marketplace with 8 million listings uses one Elasticsearch index with 60 primary shards on 6 nodes, created years ago with default dynamic mapping. Searches for "iphone case" return phones, "tshirt" misses "t-shirt", p99 latency is 900 ms, and adding a field once broke indexing for a day.

1. **Measure relevance first.** Build a judgment list of 300 real queries with graded results, track NDCG@10 and zero-result rate, and run new configurations against it before shipping.
2. **Design an explicit mapping.** Disable dynamic mapping for unknown fields; define `title` with an English analyzer plus a `keyword` sub-field, `brand` and `category` as `keyword`, and `popularity` as a `rank_feature`.
3. **Fix analysis.** Add a word-delimiter filter so "t-shirt" and "tshirt" meet, query-time synonyms ("tee" → "t-shirt"), and ASCII folding for accents.
4. **Restructure the query.** `multi_match` across `title^3`, `brand^2`, `description`; filters for category and availability in `filter` clauses; a `should` clause boosting exact phrase matches; a modest popularity boost. Category intent ("case") is detected and boosted.
5. **Right-size shards.** At 80 GB total, 60 shards averaged ~1.3 GB each. The new index uses 6 primaries (~13 GB each) and 1 replica.
6. **Reindex through an alias.** Build `listings_v2` from the database via the CDC pipeline, catch up from Kafka offsets, compare relevance metrics, then swap the alias.
7. **Clean up queries.** Replace deep `from` pagination with `search_after` and cap facets to the top 50 values.

**Result:** NDCG@10 on the judgment list rose from 0.61 to 0.78, zero-result queries fell by 40%, p99 latency dropped to 180 ms, and later mapping changes became routine alias swaps instead of incidents.

## Pitfalls

- **Treating it as the primary database.** Without a rebuildable source of truth, every mapping change and every corruption becomes a crisis.
- **Dynamic mapping in production.** One unexpected field type ("123" vs 123) can make documents fail to index or explode the field count.
- **Over-sharding.** Many small shards waste heap and slow searches; you can't easily reduce the count later.
- **Expecting read-after-write.** A newly indexed document isn't searchable until the next refresh. Don't force `refresh=true` on every write to hide it.
- **Tuning relevance by anecdote.** Fixing one query by hand often breaks ten others. Use a judgment list and offline metrics, then A/B test.
- **Index-time synonyms.** Changing them requires a reindex; query-time synonyms with updatable synonym sets are easier to evolve.
- **Deep pagination and heavy aggregations.** `from: 100000` and high-cardinality `terms` aggregations can take down nodes.
- **Ignoring disk watermarks.** Hitting flood stage silently turns indices read-only and indexing fails.

> [!TIP]
> Make "rebuild the index from scratch" a routine, scripted operation you run regularly — not an emergency procedure. If you can rebuild at will, mapping changes, shard resizing, version upgrades and recovering from bad data all become the same boring alias swap.

## Discussion questions

1. Which fields in your data should be `text`, which `keyword`, and which both?
2. How would you build a judgment list for your search, and who would grade it?
3. How does your index stay in sync with the database, and what happens if an update is lost?
4. How many primary shards would you choose for an index of 200 GB expected to triple in two years?
5. When is it acceptable for search results to lag writes by a second or more, and when isn't it?
6. When would you choose a hybrid (BM25 + vector) approach over pure keyword search?

## FAQ

### Elasticsearch or OpenSearch?

OpenSearch is a fork of Elasticsearch 7.10 maintained under the Linux Foundation, and the default on AWS. Core concepts — shards, mappings, analyzers, query DSL — are largely the same; they've diverged in newer features, licensing and plugins. Pick based on hosting, licensing and the specific features you need.

### Can I use Postgres full-text search instead?

For modest data and simple ranking, yes — `tsvector` with GIN indexes (and extensions like `pg_trgm`) avoids running a second system and keeps search transactionally consistent. Elasticsearch wins on advanced relevance tuning, faceting at scale, language analysis, and scaling search independently from the database.

### How many shards should an index have?

Enough that each shard stays roughly in the 10–50 GB range at its expected size, and not so many that you have hundreds of tiny shards per node. For time-series data, use rollover by size or age so each index ends up near the target.

### Why don't my new documents show up in search immediately?

Indexed documents become visible at the next refresh (1 s by default, longer if configured). If a user must see their own write, use `refresh=wait_for` on that specific request, or show the result from the write response rather than re-querying.

### Is a replica a backup?

No. Replicas protect against node failure, but a bad delete or corrupt mapping is replicated instantly. Use snapshots to object storage for backups, and keep a rebuild path from the source of truth.

## Key takeaways

- An index is **primary shards + replicas**; each shard is a Lucene index; queries **scatter to every shard and gather** the top results.
- Relevance starts with **analysis and mappings**; tune with field boosts, query structure and business signals — and **measure** with judgment lists.
- Mappings and primary shard counts are **effectively immutable**: use **aliases** and make reindexing routine.
- Keep Elasticsearch a **derived index** synced via CDC or an outbox, with versioning to handle out-of-order updates.
- Size shards deliberately, watch heap and disk watermarks, and back up with **snapshots**.

## References

- [Elastic — Elasticsearch Guide: scalability and resilience (clusters, nodes and shards)](https://www.elastic.co/guide/en/elasticsearch/reference/current/scalability.html)
- [Elastic — Size your shards](https://www.elastic.co/guide/en/elasticsearch/reference/current/size-your-shards.html)
- [Elastic — Aliases](https://www.elastic.co/guide/en/elasticsearch/reference/current/aliases.html)
- [Elastic — Reindex API](https://www.elastic.co/guide/en/elasticsearch/reference/current/docs-reindex.html)
- [OpenSearch documentation](https://opensearch.org/docs/latest/)
- Doug Turnbull and John Berryman, *Relevant Search*, Manning, 2016.
- Stephen Robertson and Hugo Zaragoza, "The Probabilistic Relevance Framework: BM25 and Beyond," *Foundations and Trends in Information Retrieval*, 2009.
- Clinton Gormley and Zachary Tong, *Elasticsearch: The Definitive Guide*, O'Reilly, 2015.

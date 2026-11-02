---
summary: The core trade-off behind feeds, inboxes and notifications. Do the work when something is posted (push) or when someone looks (pull), and why large systems end up doing both.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A feed shows each user recent items from everyone they follow. You can build it two ways. **Fan-out on write (push):** when someone posts, copy the post's ID into every follower's precomputed timeline. Reads become one cheap lookup, but writes cost one operation per follower. **Fan-out on read (pull):** store each post once, and assemble a timeline at read time by querying everyone the reader follows and merging. Writes are cheap, reads are expensive. Because feeds are read far more than written, push usually wins, until a single account has **millions of followers**. Real systems use a **hybrid**: push for ordinary accounts, pull for celebrities, merged at read time.

## The problem: a feed is a giant join

A home timeline answers: "the newest N posts from the accounts I follow". In SQL:

`SELECT * FROM posts WHERE author_id IN (SELECT followee FROM follows WHERE follower = :me) ORDER BY created_at DESC LIMIT 50`

On one database with a few thousand users, this works. At social-network scale it doesn't:

- A user may follow **hundreds or thousands** of accounts, and the posts are spread across many shards.
- Hundreds of millions of users open their feeds many times a day. Twitter reported around **300,000 timeline reads per second** against about **4,600 tweets per second** on average (12,000 at peak) in 2012.
- Users expect the feed in **well under a second**.

So you have to precompute something. The question is **when** to do the work: when a post is written, or when a timeline is read.

## Fan-out on write (push)

![Alice posts; fan-out workers insert the post ID into each follower's timeline cache; Bob's read is a single lookup.](/figures/fan-out/push.svg "Push moves the work to write time, so reads are trivially cheap.")

1. A user posts. The post is stored once in the posts store.
2. A message goes to a queue. **Fan-out workers** look up the author's followers and **insert the post ID** into each follower's **timeline**, usually a capped list in an in-memory store such as Redis (keep the newest ~800 IDs).
3. When a follower opens the app, the timeline service reads their list (one key) and **hydrates** the IDs into full posts, from a cache, in a batch.

Strengths:

- **Reads are fast and predictable**: one key lookup plus a batch fetch, regardless of how many accounts the reader follows.
- Read load, which dominates, is cheap.

Weaknesses:

- **Write amplification.** A post by someone with 50 million followers means 50 million list inserts. Even at a million inserts per second, that takes close to a minute, so followers see the post at very different times.
- **Wasted work** for followers who never log in. Many systems skip inactive users and rebuild their timeline on demand when they return.
- **Memory.** Every active user's timeline is stored, much of it duplicated.
- **Deletes and edits** have to fan out too (or be filtered at read time).
- **Follow and unfollow** don't take effect retroactively unless you backfill or filter.

## Fan-out on read (pull)

![Bob opens the app; the timeline service queries recent posts from each account Bob follows, then merges and ranks them.](/figures/fan-out/pull.svg "Pull keeps writes trivial and pays at read time, on every read.")

1. A user posts. It's stored once, indexed by author and time.
2. When a reader opens the app, the timeline service fetches the reader's followee list, queries **recent posts from each followee** (in parallel, across shards), **merges** them by time or rank, and returns the top N.

Strengths:

- **Writes are cheap**, and celebrity posts cost the same as anyone else's.
- **No wasted work** for inactive users. No duplicated storage.
- Always **fresh**, and follows, unfollows, deletes and privacy changes take effect immediately.

Weaknesses:

- **Reads are expensive**: hundreds of queries and a merge per timeline open, multiplied by the number of reads.
- **Tail latency.** Each read fans out to many shards, and the slowest one decides how long the read takes.
- Read cost grows with how many accounts a user follows.

## Comparing the costs

![A table: a post by a user with 200 followers costs 200 writes with push and 1 with pull; a 50M-follower post costs 50M writes with push; opening a timeline costs 1 read with push and 300 reads with pull.](/figures/fan-out/cost.svg "Push pays per follower at write time. Pull pays per followee at read time.")

The deciding factors:

| Factor | Favours push | Favours pull |
| --- | --- | --- |
| Read:write ratio | High (most feeds) | Low |
| Follower distribution | Even, modest counts | Heavy tail of huge accounts |
| Read latency target | Strict | Relaxed |
| Share of inactive users | Low | High |
| Freshness and consistency needs | Some delay acceptable | Must reflect changes instantly |
| Ranking | Simple chronological | Heavy per-read ranking anyway |

## The hybrid

![Normal users' posts are pushed into follower caches; celebrity posts are stored once; the timeline read merges the cached list with posts from followed celebrities.](/figures/fan-out/hybrid.svg "Each user follows only a handful of celebrities, so pulling them at read time is cheap.")

Most large systems combine both:

- Accounts below a follower threshold are **pushed** into followers' timelines.
- Accounts above it (celebrities, brands, news outlets) are **not fanned out**. Their posts are stored once.
- At read time, the service takes the user's precomputed timeline and **merges in** recent posts from the few high-follower accounts they follow.

This works because of the shape of the follow graph. A user follows few celebrities, so the pull part of each read is small. Most posts come from ordinary accounts, so the push part is affordable. Twitter described exactly this design in 2013, and Instagram, Facebook and LinkedIn use variations.

Other refinements:

- **Active-user filtering:** only push to users who have logged in recently. Rebuild a returning user's timeline with a pull.
- **Priority fan-out:** push to the most engaged followers first so they see posts sooner.
- **Store IDs, not posts:** timelines hold post IDs (8–16 bytes each), and posts are hydrated from a separate cache.
- **Cap the list:** keep a few hundred IDs. Older history is fetched with a pull if a user scrolls that far.

## Ranking changes the picture

Modern feeds are mostly **ranked**, not chronological. Ranking needs candidates, features, and a model that scores them per user, which is a read-time computation anyway. The common structure:

1. **Candidate generation:** gather a few thousand candidate posts from several sources: the pushed timeline, pulled celebrity posts, recommended content from accounts the user doesn't follow, ads.
2. **Ranking:** score candidates with a model using features about the user, the post and the author.
3. **Filtering and mixing:** remove blocked or seen items, enforce diversity, insert ads.

Fan-out on write still matters here: it's one of the cheapest candidate sources. But the final feed is assembled at read time.

## Beyond social feeds

The same trade-off appears whenever one event affects many readers:

- **Notifications:** precompute per-user inboxes (push) or query subscriptions at read time (pull).
- **Group chat:** write each message to every member's inbox (push, as WhatsApp effectively does for small groups), or store per conversation and read from there (pull, typical for large channels).
- **Activity streams** in collaboration tools: "what happened in projects I watch".
- **Email mailing lists:** deliver a copy to each mailbox, or keep one archive that subscribers read.
- **Materialized views in databases:** precompute on write (a view that's updated incrementally) or compute on query.

## Where it's used

| System | Approach |
| --- | --- |
| **Twitter / X (2012–2013 design)** | Push into Redis timelines (~800 tweet IDs per user), celebrities pulled and merged at read time. Later layered with ranked candidate generation. |
| **Facebook News Feed** | Mostly pull: candidates gathered and ranked at read time by aggregator services over sharded data (Multifeed) |
| **Instagram** | Push for feeds, with special handling for high-follower accounts. Ranking since 2016. |
| **LinkedIn** | Hybrid candidate generation from push and pull sources, then ranking (FollowFeed) |
| **Mastodon** | Push: each post is inserted into followers' home timelines in Redis, and delivered to other servers |
| **Discord / Slack** | Pull per channel: messages stored per channel, read when you open it |

### Use case walk-through: a developer community feed

You're building a feed for a community with 2 million users. Most follow ~150 accounts, and a few hundred accounts have more than 100,000 followers.

1. Store posts in a sharded database keyed by `(author_id, post_id)`, using time-sortable IDs.
2. Fan-out workers consume `PostCreated` events and `LPUSH` + `LTRIM` the post ID into `timeline:<user>` for each follower **active in the last 30 days**, skipping authors with more than 50,000 followers.
3. On read: fetch `timeline:<me>` (up to 500 IDs), fetch the latest 20 posts from each high-follower account the user follows, merge by ID (time order), filter blocked or deleted posts, hydrate the top 50 from the post cache.
4. A user who returns after 6 months has no timeline: rebuild it with a full pull, then resume pushing.
5. Deletes are handled at read time: hydration skips posts marked deleted, so no un-fan-out is needed.

## Pitfalls

- **Celebrity storms.** Without a threshold, one post from a huge account can back up the fan-out queue for minutes and delay everyone else's posts. Use separate queues and limits.
- **Hot keys on read.** A celebrity's post object is read by millions of followers within seconds. Cache it aggressively and replicate it (see hot keys).
- **Unbounded timelines.** Cap them. Nobody scrolls back 10,000 items through a cache.
- **Forgetting privacy changes.** If an account goes private or blocks someone, pushed copies must be filtered at read time.
- **Ordering assumptions.** Fan-out is asynchronous, so a follower may briefly see a reply before the post it replies to. Order by post ID, not by arrival.

> [!WARNING]
> Measure your **follower distribution** before choosing. A threshold of "10,000 followers" means something very different on a platform where the largest accounts have 50,000 than on one where they have 100 million.

## Discussion questions

1. Twitter's timeline read:write ratio was about 65:1. At what ratio would pull become the better default?
2. How would you pick the follower threshold above which accounts are not fanned out?
3. A user unfollows someone. What needs to happen in a push system, and when?
4. How does ranking change where the work happens?
5. For a group chat with 100,000 members, would you push or pull? What about a group of 8?
6. How would you handle a user who follows 5,000 accounts in a pull system?

## FAQ

### Which is better, push or pull?

Neither in general. Push suits read-heavy workloads with modest follower counts and strict read latency. Pull suits write-heavy workloads, highly skewed follower counts, or feeds that are ranked from a large candidate pool anyway. At scale, the answer is almost always a hybrid.

### How big is a precomputed timeline?

Typically a few hundred post IDs per user. Twitter kept about 800. At 8 bytes per ID, that's under 7 KB per user, or a few terabytes of RAM for hundreds of millions of users before replication. Storing IDs rather than full posts is what makes push affordable.

### What happens when someone with 50 million followers posts in a push system?

Without special handling, 50 million inserts go through the fan-out workers. Followers see the post minutes apart, and the queue backs up for other users. That's why large systems skip fan-out for such accounts and merge their posts at read time.

### Isn't pull just "no caching"?

Not quite. Pull systems cache heavily: each author's recent posts, the follow graph, hydrated post objects. The difference is that the **per-reader result** isn't precomputed. It's assembled from cached pieces on demand.

### How do I make new follows show up immediately?

In a push system, either backfill: insert the new followee's recent posts into the follower's timeline when they follow. Or merge at read time for a short period. Pull systems get it for free.

### Does fan-out have to be asynchronous?

In practice, yes. The author's request returns once the post is stored, and fan-out happens through a queue. Doing it synchronously would make posting latency depend on follower count.

## Key takeaways

- A feed is a **join between the follow graph and posts**. You precompute it at **write** time (push) or compute it at **read** time (pull).
- **Push:** cheap, fast reads, expensive writes proportional to followers.
- **Pull:** cheap writes, expensive reads proportional to followees, always fresh.
- The skewed follower graph makes a **hybrid** the standard answer: push for most accounts, pull for celebrities.
- Ranked feeds add a read-time **candidate generation + ranking** stage, where fan-out on write is one candidate source.

## References

1. R. Krikorian. [Timelines at Scale](https://www.infoq.com/presentations/Twitter-Timeline-Scalability/). QCon San Francisco, 2012.
2. Twitter Engineering. [New Tweets per second record, and how!](https://blog.x.com/engineering/en_us/a/2013/new-tweets-per-second-record-and-how) 2013.
3. M. Kleppmann. *Designing Data-Intensive Applications*, chapter 1: "Describing Load" (the Twitter example). O'Reilly, 2017.
4. A. Silberstein et al. [Feeding Frenzy: Selectively Materializing Users' Event Feeds](https://dl.acm.org/doi/10.1145/1807167.1807257). *SIGMOD 2010*.
5. Facebook Engineering. [Serving Facebook Multifeed: Efficiency, performance gains through redesign](https://engineering.fb.com/2015/03/10/production-engineering/serving-facebook-multifeed-efficiency-performance-gains-through-redesign/). 2015.
6. LinkedIn Engineering. [FollowFeed: LinkedIn's Feed Made Faster and Smarter](https://www.linkedin.com/blog/engineering/feed/followfeed-linkedin-s-feed-made-faster-and-smarter). 2016.
7. Instagram Engineering. [What Powers Instagram: Hundreds of Instances, Dozens of Technologies](https://instagram-engineering.com/what-powers-instagram-hundreds-of-instances-dozens-of-technologies-adf2e22da2ad). 2011.
8. Mastodon docs. [Scaling up your server](https://docs.joinmastodon.org/admin/scaling/) (home feed generation in Redis).

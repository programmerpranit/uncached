---
summary: How browsers and CDNs decide whether to reuse a response, revalidate it or download it again, and the two-policy setup (revalidated HTML, immutable hashed assets) that makes repeat visits nearly free without ever serving stale code.
updated: 2026-11-02
---

> [!KEY]
> The HTTP cache keeps responses and reuses them while they are **fresh** (younger than `max-age`). Once **stale**, it **revalidates** with a conditional request (`If-None-Match` with an ETag) and gets either a cheap `304 Not Modified` or a new `200`. The standard setup for web apps:
>
> - HTML is `no-cache` (always revalidated).
> - Content-hashed JS, CSS and images are `max-age=31536000, immutable`.
>
> With that, a deploy never needs a purge, because changed files get new URLs.

## The problem: slow repeat visits, or stale deploys

Caching mistakes fail in two opposite directions:

- **Too little caching.** Every page view re-downloads a 400 kB bundle, or at best sends a conditional request for every asset. On a 300 ms mobile round trip, 30 revalidations add up even when every answer is `304`.
- **Too much caching.** You deploy a fix, but users keep running yesterday's JavaScript for hours. Worse, new HTML references an API shape the old cached bundle doesn't understand, and the page breaks until someone hard-refreshes.

Both come from treating "cache" as one switch. HTTP caching is a set of precise rules. Once you know what each header means, the correct setup is short.

## How it works

### Freshness, staleness and revalidation

![Cache decision](/figures/http-cache/flow.svg "Fresh responses are reused with no request; stale ones are revalidated and either confirmed with a 304 or replaced with a 200.")

When the browser needs a URL, it checks its cache:

1. **Missing.** It sends a normal request and stores the response if the headers allow.
2. **Fresh.** The response's age is below its freshness lifetime (`max-age`, or `Expires` in older setups). The browser uses it directly, with no network and no round trip.
3. **Stale.** It sends a *conditional* request with the validators it stored:
   - `If-None-Match: "<etag>"` (preferred), or
   - `If-Modified-Since: <date>`.

   If nothing changed, the server answers **`304 Not Modified`** with no body, and the cached copy becomes fresh again. Otherwise it returns a full `200`.

A `304` saves bandwidth but still costs a round trip. Only fresh hits are free.

If a response has no explicit freshness information but has `Last-Modified`, caches may apply **heuristic freshness**: commonly 10% of the time since it was last modified. This is a frequent source of "why is this stale?" surprises. Always set `Cache-Control` explicitly.

### The Cache-Control directives that matter

| Directive | Meaning |
|---|---|
| `max-age=N` | Fresh for N seconds after the response was generated |
| `s-maxage=N` | Like `max-age`, but only for shared caches (CDNs, proxies); overrides `max-age` there |
| `no-cache` | May be stored, but **must be revalidated before every use**. Not "don't cache". |
| `no-store` | Must not be stored anywhere. Use for genuinely sensitive responses. |
| `private` | Only the user's browser may store it; shared caches must not |
| `public` | Shared caches may store it, even for authenticated requests |
| `immutable` | The body will never change while fresh, so don't revalidate even on reload |
| `must-revalidate` | Once stale, never serve it without successful revalidation, even if the origin is down |
| `stale-while-revalidate=N` | For N seconds after going stale, serve the stale copy immediately and revalidate in the background |
| `stale-if-error=N` | Serve stale for up to N seconds if the origin returns errors |

The two most common mistakes: `no-cache` doesn't mean "don't cache", and `max-age=0` without `must-revalidate` lets some caches serve stale content if the origin is down.

### Validators: ETag and Last-Modified

- An **ETag** is an opaque version identifier, often a hash of the body. Strong ETags mean byte-identical. Weak ETags (`W/"…"`) mean semantically equivalent, for example the same content compressed differently.
- **Last-Modified** has one-second resolution and depends on file timestamps. That's fine for static files, but unreliable when servers or builds touch timestamps.

Make ETags consistent across the servers behind a load balancer. If each node computes its own (some servers include inode numbers), revalidation fails at random.

### The two-policy strategy

![Cache policy by URL](/figures/http-cache/strategy.svg "Revalidate the HTML on every load; cache content-hashed assets for a year as immutable.")

Modern bundlers emit filenames with a **content hash**, such as `app.3f9c1e.js`. If the content changes, the URL changes. That splits caching into two easy cases:

- **Hashed assets:** `Cache-Control: public, max-age=31536000, immutable`. They can be cached forever because that URL will only ever hold those bytes. `immutable` stops browsers revalidating them when the user reloads.
- **HTML and other entry points** (and non-hashed files like `/manifest.json`, `/sw.js` and `/robots.txt`): `Cache-Control: no-cache` plus an ETag. Every navigation checks with the server, which usually costs one tiny `304`, and the HTML always points at the current asset URLs.

Deploy order matters:

1. Upload new hashed assets first and keep old ones for a while.
2. Then switch the HTML.

Users mid-session on the old HTML can still fetch old chunks. Users on the new HTML get new ones. Nothing has to be purged, because nothing that changed kept its URL.

For APIs and personalised pages, choose per endpoint:

- `private, no-cache` for per-user data you want revalidated,
- short `max-age` with `stale-while-revalidate` for public, slowly-changing data,
- `no-store` for things like banking pages.

### Cache layers and scope

![Cache layers](/figures/http-cache/layers.svg "Memory cache, HTTP disk cache, service worker and CDN all sit in front of the origin; directives decide which may store a response.")

Between the user and your origin there may be:

- the browser's **memory cache** (per page load),
- the **HTTP disk cache** (private to that browser),
- a **service worker** with its Cache Storage, which follows *your* code rather than the headers,
- a **CDN or reverse proxy** (shared between many users).

`private`, `public` and `s-maxage` target these scopes. CDNs often add their own controls, such as surrogate keys and `CDN-Cache-Control`.

`Vary` tells caches that the response depends on certain request headers:

- `Vary: Accept-Encoding` is normal.
- `Vary: Cookie` or `Vary: User-Agent` fragments the cache so badly that it rarely hits.

Two more facts:

- **Cache partitioning.** Browsers now key their HTTP cache by top-level site as well as URL. A popular library on a public CDN is no longer shared between different websites, which removes the old argument for loading common libraries from shared CDNs.
- **Back/forward cache (bfcache).** This is a separate, whole-page snapshot used for back and forward navigation. It is independent of HTTP caching, though `Cache-Control: no-store` on the HTML has historically made pages ineligible for it.

## Where it's used

| Resource | Typical policy |
|---|---|
| `index.html`, SSR pages | `no-cache` + ETag (or short `s-maxage` + `stale-while-revalidate` at the CDN) |
| Hashed JS, CSS, fonts, images | `public, max-age=31536000, immutable` |
| Unhashed images and uploads | `max-age` of hours to days, plus an ETag |
| Public JSON (product catalog) | `public, max-age=60, stale-while-revalidate=600` |
| Per-user API responses | `private, no-cache` (or `no-store` if sensitive) |
| Service worker script `/sw.js` | `no-cache`; browsers also cap its HTTP cache use for update checks |
| Login, banking, health pages | `no-store` |

## Use case walk-through: "users keep getting the old version"

After each deploy, support tickets report broken pages that a hard refresh fixes. The response headers show `index.html` with `Cache-Control: max-age=3600`, and the bundles served as unhashed `/static/app.js` with `max-age=86400`.

1. **Diagnose.** For up to an hour, browsers reuse the cached HTML without asking. Separately, `app.js` can be up to a day old. A user can get *new* HTML with an *old* bundle, or the other way round. That mismatch is the breakage.
2. **Hash the assets.** Turn on content-hashed filenames in the bundler (`app.[hash].js`). Every change produces a new URL.
3. **Split the policies.**
   - Assets: `public, max-age=31536000, immutable`.
   - HTML: `no-cache`, with ETags enabled and consistent across nodes.
4. **Fix the deploy order.** Upload assets to the CDN first and keep the previous release's assets for a week. Then publish the HTML. Lazy-loaded chunks requested by open tabs on the old version still resolve.
5. **Use the CDN for HTML.** Set `s-maxage=30, stale-while-revalidate=300` on HTML for the CDN only, so the origin sees at most one request every 30 seconds per page. Purge HTML at the CDN on deploy.
6. **Clean up the old URL.** Serve `/static/app.js` with `no-cache` for a transition period, so browsers with the old long-lived copy revalidate and pick up a redirect stub.

**Result:**

- Repeat visits make one small HTML revalidation. Everything else is a fresh cache hit with zero requests.
- Deploys are visible on the next navigation.
- The version-mismatch tickets stop.

## Pitfalls

- **Treating `no-cache` as "don't cache".** It means "revalidate first". If you truly mean "never store", use `no-store`.
- **Long `max-age` on unhashed URLs.** You can't recall a response once it's in browser caches. Purging a CDN doesn't touch them.
- **Deleting old assets on deploy.** Open tabs lazy-load chunks from the previous build and get 404s. Keep at least one previous release around.
- **Inconsistent ETags across servers.** Revalidation randomly returns `200` instead of `304`, wasting bandwidth.
- **`Vary: Cookie` or `Vary: *`.** These effectively disable shared caching.
- **Authenticated responses marked `public`.** Shared caches may serve one user's data to another. Use `private` for anything personalised.
- **Forgetting the service worker.** A cache-first service worker can pin old HTML forever, whatever the HTTP headers say. Version its caches and handle updates explicitly.

> [!WARNING]
> Never give a long `max-age` to a URL whose content can change. Browsers will keep serving it until it expires, and there's no remote way to evict it. If you need to change it, the only fix is to change the URL.

## Discussion questions

1. What is the practical difference between `no-cache`, `max-age=0` and `no-store`?
2. Why does content hashing let you set a one-year `max-age` safely, and what deploy step is still required?
3. When does `stale-while-revalidate` make sense for HTML, and when would it cause visible problems?
4. How does cache partitioning by top-level site change the value of shared public CDNs for libraries?
5. A CDN caches a page for logged-out users but must never cache it for logged-in ones. How would you express that?
6. How could a service worker undermine a correct HTTP caching setup?

## FAQ

### What's the difference between `no-cache` and `no-store`?

`no-cache` lets the response be stored but requires revalidation before each use. Usually that's a cheap `304`. `no-store` forbids storing it at all, so every request downloads the full response.

### Do I still need ETags if my assets are hashed and immutable?

Not for the hashed assets, which are never revalidated while fresh. You do want ETags, or `Last-Modified`, on HTML and anything else served with `no-cache`, so revalidations can return `304` instead of the full body.

### What does a hard refresh do?

It bypasses the cache for the page and its subresources, sending requests with `Cache-Control: no-cache` (and `Pragma: no-cache`). A normal reload revalidates the main document. With `immutable`, browsers skip revalidating subresources on a normal reload.

### Should APIs be cached?

Many public, read-heavy endpoints benefit from short `max-age` plus `stale-while-revalidate`, especially at a CDN. Per-user endpoints should be `private`, and sensitive ones `no-store`. Pick per endpoint, not per API.

### How do I check what's being cached?

Open the browser DevTools Network panel:

- The Size column shows "(disk cache)" or "(memory cache)" for fresh hits, and the status code shows `304`.
- The response headers show `Cache-Control`, `ETag` and `Age`.
- CDNs usually add a hit or miss header.

## Key takeaways

- Fresh responses are reused with no request. Stale ones are revalidated with ETags for a cheap `304`.
- `no-cache` means revalidate, and `no-store` means never store. Learn the difference.
- Use two policies: HTML `no-cache`, and content-hashed assets `max-age=31536000, immutable`.
- Deploy assets before HTML, and keep old assets around for open tabs.
- Use `private`, `public` and `s-maxage` to control the browser and CDN scopes separately, and use `Vary` sparingly.
- Responses you've already sent can't be recalled from browsers. If content changes, change the URL.

## References

- RFC 9111, *HTTP Caching*, IETF, 2022
- RFC 5861, *HTTP Cache-Control Extensions for Stale Content*, IETF, 2010
- RFC 8246, *HTTP Immutable Responses*, IETF, 2017
- MDN: [HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching)
- MDN: [Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control)
- web.dev: [Prevent unnecessary network requests with the HTTP Cache](https://web.dev/articles/http-cache)
- Jake Archibald, [Caching best practices & max-age gotchas](https://jakearchibald.com/2016/caching-best-practices/), 2016

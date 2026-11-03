---
summary: How a script running between your page and the network makes web apps load instantly and work offline. Covers registration and scope, the install-waiting-activate lifecycle, the fetch event, Cache Storage, caching strategies, precaching, updates, background sync and push, and the bugs that make service workers notorious.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **service worker** is a JavaScript worker that the browser runs **between your pages and the network**. Once installed, it receives a `fetch` event for every request made by the pages it controls, and decides how to answer: from **Cache Storage**, from the network, from a mix of both, or with a response it builds itself.
>
> - It has a strict **lifecycle**: `install` (precache files), `waiting` (until no tab uses the old version), `activate` (clean up old caches), then it controls pages.
> - You choose a **caching strategy** per kind of request: cache-first for versioned assets, network-first for HTML and fresh data, stale-while-revalidate for things that can be slightly old.
> - It also enables **push notifications** and **background sync**, because the browser can start it when no page is open.
>
> It's powerful and persistent, which is why bugs are painful: a broken service worker can keep serving an old site to users until it's replaced.

## The problem: the web assumes a network

A normal web page depends on the network for every visit. On a slow train connection, the browser waits for HTML, then CSS and JS. Offline, it shows the dinosaur. The HTTP cache helps, but you can't program it: you can't say "show the cached shell immediately, then fetch fresh data", or "if the network takes more than 3 seconds, use what we have".

Native apps install their code once and only fetch data. Service workers give web apps the same model: the app's code and shell live on the device, and the network becomes an enhancement rather than a requirement.

## How it works

### A programmable network proxy

![A service worker intercepts fetches from the page and answers from Cache Storage or the network](/figures/service-workers/proxy.svg "Every request from a controlled page passes through the service worker's fetch handler.")

A page registers a service worker:

```js
navigator.serviceWorker.register('/sw.js', { scope: '/' });
```

Key properties:

- **Scope.** A service worker controls pages whose URL is under its scope. By default that's the directory of the script, so `/sw.js` can control the whole origin and `/app/sw.js` only `/app/`.
- **Secure contexts only.** It requires HTTPS (localhost is allowed for development), because a script that intercepts all traffic must not be injectable by a network attacker.
- **Its own thread, no DOM.** It's a worker: it communicates with pages via `postMessage` and the `Clients` API.
- **Event-driven and short-lived.** The browser starts it when an event arrives (a fetch, a push message) and stops it when idle, often after about 30 seconds. Global variables don't survive; state goes in Cache Storage or IndexedDB.

In the worker, the `fetch` event is where the work happens:

```js
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
```

If the handler doesn't call `respondWith`, the request goes to the network as normal.

**Cache Storage** (`caches`) is a store of `Request` → `Response` pairs, organized into named caches. Unlike the HTTP cache, it's fully under your control: nothing expires or is evicted per entry unless you delete it (the browser can still evict a whole origin under storage pressure).

### The lifecycle

![Service worker lifecycle: register, install, waiting, activate, controlling, with skipWaiting as a shortcut](/figures/service-workers/lifecycle.svg "A new version installs alongside the old one and takes over only when it's safe.")

1. **Install.** The first event a new worker receives. It typically **precaches** the app shell: HTML, CSS, JS and icons. `event.waitUntil(promise)` keeps the worker in this phase until the promise settles; if it rejects (one asset 404s), the install fails and the new version is discarded.
2. **Waiting.** If an older version controls any open tab, the new one waits. Two versions controlling different tabs at the same time could corrupt shared caches, so by default the new version takes over only when every tab using the old one is closed. Reloading a single tab isn't enough, because the old page stays alive until the new navigation commits.
3. **Activate.** The new version becomes active. This is where it deletes caches from old versions. Pages that were open before still aren't controlled until they reload, unless the worker calls `clients.claim()`.
4. **Controlling.** It receives `fetch` events from its pages, plus `push`, `sync`, `message` and others.

`self.skipWaiting()` moves a waiting worker straight to activate. It's convenient, but it means pages loaded with version 1's HTML and JS can suddenly be served version 2's assets. Many apps instead show an "Update available, reload" banner when a new worker is waiting, and call `skipWaiting` when the user agrees.

The browser checks for an update to `sw.js` on navigation (at most every 24 hours, bypassing the HTTP cache for the script by default) and when `registration.update()` is called. A byte-for-byte change in the script, or in scripts it imports, starts a new install.

### Caching strategies

![Four caching strategies: cache first, network first, stale-while-revalidate, and network or cache only](/figures/service-workers/strategies.svg "Choose a strategy for each kind of request.")

There's no single right strategy; a good service worker routes requests by type:

- **Cache first.** Use the cache if there's a match; otherwise fetch and store. Ideal for content-hashed assets (`app.3f9a1c.js`), fonts and images, which never change at a given URL.
- **Network first.** Try the network, fall back to the cache when offline or after a timeout. Good for HTML pages and API data that should be fresh but must still work offline.
- **Stale-while-revalidate.** Answer from the cache immediately and fetch an update in the background for next time. Fast, and fine for data that can be one visit old: avatars, a settings payload, a product catalogue.
- **Network only** for things that must never be cached (analytics pings, POST requests), and **cache only** for precached files.

An **offline fallback** catches what's left: if a navigation fails and nothing is cached, return a precached `/offline.html`.

### Precaching and the app shell

The **app shell** pattern precaches the minimal HTML, CSS and JS needed to render the UI frame, and fetches content into it. After the first visit, opening the app paints the shell instantly from the cache, even offline, and shows cached or fresh content inside it.

Build tools generate a **precache manifest**: the list of files with their content hashes. A new deploy changes the manifest, which changes `sw.js`, which triggers an update; the new worker downloads only the files whose hashes changed.

### Beyond caching

Because the browser can start a service worker without an open page, it enables:

- **Push notifications.** A server sends a message through the browser vendor's push service; the worker receives a `push` event and shows a notification.
- **Background Sync.** A request made offline (a sent message) is queued; the `sync` event fires when connectivity returns. Chromium-based browsers support it; elsewhere apps retry on the next visit.
- **Navigation preload.** Starting a worker takes time. With navigation preload enabled, the browser starts the navigation request in parallel with booting the worker, and the handler can use that response.
- **Synthetic responses.** Streaming a page assembled from cached header and footer plus fresh content, or serving generated files.

Browsers are also adding **static routing** (`event.addRoutes()` in the install event), which lets the browser handle simple routes, such as "always network for this path", without starting the worker at all.

## Where it's used

| Product / tool | What the service worker does |
|---|---|
| Workbox | Google's libraries for routing, strategies, precache manifests and expiration |
| vite-plugin-pwa, `@angular/service-worker`, Next.js PWA plugins | generate the worker and precache manifest from the build |
| Progressive Web Apps (Twitter/X Lite, Starbucks, Spotify web) | app shell, offline mode, installability |
| Google Docs, Gmail offline | cache app code; local data in IndexedDB |
| News and documentation sites | offline reading of saved or recently viewed pages |
| Web push | notifications for chat, email and social apps |
| Mock Service Worker (MSW) | intercepts requests in development and tests to return mock responses |

## Use case walk-through: a field inspection app

Inspectors fill in reports on building sites with poor or no signal. The current single-page app shows a blank screen when offline and loses reports submitted without a connection.

1. **App shell.** A service worker precaches the HTML, hashed JS and CSS bundles, icons and an offline page. On repeat visits the app starts from the cache in under a second, with or without a network.
2. **Route by type.** Hashed assets: cache first. The inspection list API: network first with a 3-second timeout, falling back to the last cached response. Floor plan images: stale-while-revalidate, limited to 200 entries.
3. **Store drafts locally.** Reports are written to IndexedDB as the inspector types, so nothing is lost if the tab is closed.
4. **Queue submissions.** Submitting while offline stores the report in an outbox in IndexedDB and registers a background sync. When the connection returns, the `sync` event posts each report; browsers without Background Sync flush the outbox on the next app start.
5. **Ship updates safely.** When a new version installs, the app shows "New version available, reload". Only on that click does it call `skipWaiting`, so a half-filled form is never reloaded unexpectedly. The new worker deletes the old version's caches on activate.
6. **Result.** The app opens instantly on site, works for a full day offline, and syncs reports when the inspector gets back into coverage. Support tickets about lost reports drop to zero.

## Pitfalls

- **Caching `sw.js` itself.** If a CDN caches the worker script for a long time, users can't get updates until it expires. Serve `sw.js` with `Cache-Control: no-cache`, and never use a hashed name for it.
- **Cache first for HTML.** Users keep seeing the old site, which references old assets, until the worker updates. Use network first for navigations, or make sure updates take effect.
- **Unbounded caches.** Runtime caches grow until the browser evicts the whole origin. Add expiration (max entries, max age) and clean up old caches on activate.
- **Caching opaque or error responses.** Cross-origin responses without CORS are **opaque**: status 0, unreadable, and counted as large against quota. A cache-first rule can store a 500 or an opaque failure and serve it forever. Check `response.ok` before storing.
- **No kill switch.** A buggy worker can break the site for everyone who installed it. Keep a way to deploy a worker that unregisters itself (or simply passes all requests through) and clears caches; the `Clear-Site-Data` header can also remove storage and workers.
- **Worker startup cost.** Booting the worker can add tens of milliseconds to every navigation. Use navigation preload, and don't register a worker that only passes requests through.

> [!WARNING]
> A service worker outlives your deploys. Before shipping your first one, plan how you'll update it, how you'll roll back a bad version, and how to remove it completely. Test the update flow with two tabs open, not just a single reload.

## Discussion questions

1. Why does a new service worker wait instead of taking over immediately, and when is `skipWaiting` safe?
2. Which caching strategy would you choose for HTML, hashed JS bundles, user avatars and a stock price API, and why?
3. How is Cache Storage different from the browser's HTTP cache?
4. How would you design an offline write path (outbox) so that requests aren't duplicated when the connection returns?
5. What could cause users to be stuck on an old version of your site, and how would you recover?
6. When would adding a service worker make a site slower rather than faster?

## FAQ

### Do I need a service worker to make a PWA installable?

Not any more in Chromium-based browsers, which only require a web app manifest with the right fields (Chrome dropped the offline-capable worker requirement in 2023). A service worker is still what makes the installed app work offline and load instantly.

### What's the difference between a service worker and a Web Worker?

Both run off the main thread without DOM access. A Web Worker belongs to one page and lives as long as that page creates it, and is used for computation. A service worker belongs to an origin and scope, is shared by all controlled pages, is started and stopped by the browser, and can intercept network requests and receive push events.

### How much can I store?

It depends on the browser and the device's free disk space; modern browsers allow an origin a large share of free space (often gigabytes). Storage is "best effort" by default and can be evicted under pressure; `navigator.storage.persist()` asks for persistent storage, and `navigator.storage.estimate()` reports usage and quota.

### Does the service worker run on the first visit?

The first page load isn't controlled: the worker is registered and installed during that visit, and controls pages from the next navigation (or immediately, if it calls `clients.claim()`). Don't rely on it to intercept requests made during the first load.

### How do I remove a service worker?

Deploy a new `sw.js` that, on activate, deletes all caches, calls `self.registration.unregister()`, and optionally reloads its clients. Alternatively, send the `Clear-Site-Data: "storage"` header. Simply deleting the file doesn't work well: a 404 on update leaves the old worker in place.

## Key takeaways

- A service worker is an event-driven worker that intercepts fetches from the pages in its scope and answers them with code.
- Lifecycle: install (precache), waiting (old version still in use), activate (clean up), controlling.
- Choose a caching strategy per request type: cache first for hashed assets, network first for HTML and fresh data, stale-while-revalidate for tolerant data.
- Push, background sync and navigation preload extend it beyond caching.
- Plan updates, cache limits and a kill switch from day one; a bad worker persists on users' devices.

## References

- MDN: [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- MDN: [Using Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- MDN: [CacheStorage](https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage)
- W3C: [Service Workers](https://www.w3.org/TR/service-workers/)
- web.dev: [The service worker lifecycle](https://web.dev/articles/service-worker-lifecycle)
- Chrome for Developers: Workbox documentation (developer.chrome.com/docs/workbox)
- Jake Archibald, "The Offline Cookbook" (web.dev, 2014, updated)

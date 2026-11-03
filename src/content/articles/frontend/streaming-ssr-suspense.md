---
summary: How servers send HTML in pieces so the slowest query no longer blocks the whole page. Covers why classic SSR is all-or-nothing, chunked transfer and how the browser renders partial HTML, Suspense boundaries as streaming units, the placeholder-and-swap trick, selective hydration, status codes and headers after the first byte, and how Next.js, Remix and other frameworks use it.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Classic server-side rendering (SSR) waits for *every* data fetch, renders the whole page to a string, then sends it. One slow query delays everything. **Streaming SSR** sends the page's **shell** (layout, navigation, loading skeletons) straight away. It then writes more HTML into the same response as each piece of data resolves.
>
> In React, the unit of streaming is a **`<Suspense>` boundary**. Its fallback goes out first. When its content is ready, the server sends that content as a hidden chunk, plus a tiny inline script that swaps it into place. On the client, each boundary can also **hydrate independently**, and a user's click moves the boundary they touched to the front of the queue.

## The problem: the slowest query sets the pace

Picture a product page. The product details come from a fast cache in 80 ms. Pricing takes 150 ms. Personalized recommendations and reviews come from slower services and take 700 ms.

With classic SSR the server can't send a single byte of HTML until the reviews arrive, because it renders the page as one string. The user stares at a blank tab for most of a second. The **time to first byte (TTFB)** and **first contentful paint (FCP)** are both set by the slowest dependency, even though most of the page was ready almost immediately.

Then a second wait begins. The browser downloads all the JavaScript for the page and **hydrates** the whole tree in one go, attaching event handlers to the existing HTML. Until that long task finishes, buttons that look ready don't respond.

![Timeline comparing classic SSR with streaming SSR: classic waits about 760 ms before first paint, streaming shows a shell at about 40 ms and fills in sections as data resolves](/figures/streaming-ssr/timeline.svg "Same server work, very different experience: streaming paints early and becomes interactive in pieces.")

The usual workarounds each give something up. You can render a skeleton on the server and fetch on the client, but then you lose SSR's SEO and first-load benefits for that content and add a waterfall. Or you can drop the slow section from SSR entirely. Streaming keeps server rendering *and* removes the all-or-nothing wait.

## How it works

### HTTP already supports sending a response in pieces

An HTTP response body doesn't have to arrive all at once. With HTTP/1.1 **chunked transfer encoding**, or the frames of HTTP/2 and HTTP/3, the server can send part of the body, keep the connection open and send more later.

Browsers are built for this. The HTML parser is **incremental**: it builds the DOM as bytes arrive and can paint whatever it already has. Old-school PHP pages that called `flush()` used the same property. Streaming SSR just makes it practical for component-based apps.

### Suspense boundaries are the streaming units

In React 18 and later, `renderToPipeableStream` (Node) and `renderToReadableStream` (web streams, used by edge runtimes) render to a stream instead of a string. You mark the slow parts with `<Suspense>`:

```jsx
<Layout>
  <ProductDetails />
  <Suspense fallback={<ReviewsSkeleton />}>
    <Reviews />   {/* awaits a slow fetch */}
  </Suspense>
</Layout>
```

When rendering reaches a component that is still waiting for data, React looks for the nearest `<Suspense>` above it. It writes that boundary's **fallback** into the HTML and carries on with the rest of the page. Everything outside unresolved boundaries becomes the **shell**, and it is flushed as soon as it is ready.

If no boundary wraps a suspended component, the whole shell waits for it. Where you put the boundaries decides what streams.

### The placeholder-and-swap trick

How does content that arrives *later* in the byte stream end up *earlier* in the page? React marks each boundary in the shell with HTML comments and a placeholder element. When a boundary resolves, it writes:

1. the real content inside a `<div hidden>` at the end of the document so far;
2. a small inline `<script>` that moves that content into the placeholder and removes the fallback.

![A streamed HTML response in three chunks: a shell with a placeholder and skeleton, a later chunk with hidden content and a swap script, and the closing tags](/figures/streaming-ssr/chunks.svg "Out-of-order streaming: content arrives at the end of the stream and an inline script moves it into place.")

The swap runs as soon as that chunk is parsed, before React's main bundle has downloaded. So users see real content even on a slow connection where JavaScript takes seconds. The exact markers (`<!--$?-->`, `B:0`, `$RC`) are React internals and may change, but the idea is stable. Other frameworks, such as Marko, SolidStart and Qwik, use similar out-of-order techniques.

### Selective hydration

Streaming the HTML solves the first wait. **Selective hydration** solves the second. Because each Suspense boundary is a separate unit, React can:

- start hydrating the parts whose code and HTML have arrived without waiting for the rest;
- hydrate boundaries in separate tasks, **yielding to the browser** in between so scrolling and typing stay smooth;
- **prioritize** a boundary the user interacts with. If someone clicks inside a boundary that hasn't hydrated yet, React records the event, hydrates that boundary first, then replays the click.

![Suspense boundaries in a page: the navigation hydrates first, a clicked BuyBox boundary jumps ahead of the Comments and Sidebar boundary, and its click is replayed](/figures/streaming-ssr/selective-hydration.svg "Boundaries hydrate independently and in priority order; interaction moves a boundary to the front.")

Combined with code splitting (`React.lazy` inside a boundary), a heavy widget's JavaScript no longer blocks the interactivity of the rest of the page.

### What you can no longer change after the first byte

Once the shell has been sent, the **status code and headers are already on the wire**. This has practical consequences:

- **Redirects and 404s** must be decided before the shell flushes. Do auth checks and "does this product exist?" lookups outside Suspense, or in a route loader or middleware, so they block the shell.
- **Cookies** can't be set by a component deep inside a streamed boundary.
- **Errors** inside a boundary after the shell is sent can't change the status to 500. React renders the nearest error boundary on the client instead. An error in the shell itself is caught by `onShellError`, where you can still send a proper error page.
- **`<head>` content** such as the title and meta tags must be known in the shell. Frameworks hoist metadata for this reason.

### Bots, buffering and proxies

Crawlers that don't run JavaScript still receive all the content, because the server only finishes the response once every boundary has resolved. React offers `onAllReady` to buffer everything for clients that need a complete document, for example to serve bots a fully-rendered page.

Streaming only helps if nothing between server and browser **buffers** the response. Compression middleware, some reverse proxies (nginx's `proxy_buffering`), and certain serverless platforms can hold the response back until it's complete. That silently turns streaming back into classic SSR. Test with a real slow boundary and watch the network waterfall.

## Where it's used

| Framework or platform | How streaming shows up |
|---|---|
| **Next.js App Router** | Every route streams by default; `loading.js` files create Suspense boundaries automatically |
| **Remix / React Router** | Loaders can return unresolved promises; `<Await>` inside `<Suspense>` streams them in |
| **React Server Components** | The RSC payload itself is streamed, and server components can `await` data directly |
| **SolidStart, Qwik, Marko** | Out-of-order streaming with their own resumability or hydration models |
| **SvelteKit, Nuxt** | Streaming of promises returned from load functions |
| **E-commerce and media sites** | Product info streams first; recommendations, reviews and ads stream later |

## Use case walk-through: speeding up a product page

An online store's product page server-renders everything with a single `Promise.all`. Median TTFB is 900 ms, driven by the recommendations service.

1. **Measure.** Server timing shows product data at 60 ms, inventory at 120 ms, reviews at 400 ms and recommendations at 850 ms. Above the fold only needs product data and inventory.
2. **Switch the render API** from `renderToString` to `renderToPipeableStream`, flushing in `onShellReady`.
3. **Keep critical data in the shell.** Product lookup stays outside any boundary, so a missing product still returns a real 404 and the `<title>` is correct.
4. **Wrap the slow parts.** Reviews and recommendations each get a `<Suspense>` with a skeleton that has the same height, so nothing jumps when they arrive.
5. **Start fetches early.** All four requests start at the top of the request handler. Components await promises that are already in flight, which avoids a request waterfall through the tree.
6. **Check the infrastructure.** The CDN was buffering HTML responses; streaming is enabled for that route, and compression is set to flush per chunk.
7. **Split heavy code.** The reviews widget's rich-text renderer is lazy-loaded inside its boundary, so it doesn't delay hydration of the buy button.

**Result:** TTFB drops to about 80 ms and the product and price paint almost at once. The buy button is interactive well before recommendations arrive, and the page no longer shifts when slow sections appear.

## Pitfalls

- **One boundary around everything.** A single top-level Suspense gives you a loading spinner, not streaming. Place boundaries around independent, slow regions.
- **Too many boundaries.** Dozens of tiny skeletons popping in one by one looks chaotic. Group content that belongs together visually.
- **Waterfalls inside the tree.** If a child only starts fetching after its parent's data resolves, streaming hides some latency but not all of it. Start fetches early, in loaders or at the top of the request.
- **Layout shift.** Fallbacks that are a different size from the real content hurt Cumulative Layout Shift. Reserve space.
- **Deciding status too late.** A "not found" discovered inside a streamed boundary can't produce a 404. Keep that check in the shell.
- **Buffering middleware.** Compression, proxies or logging middleware that collect the full body defeat streaming without any error.
- **Hydration mismatches.** Content that renders differently on server and client, such as dates and random IDs, still causes errors and re-rendering, now per boundary.

> [!WARNING]
> Streaming changes *when* bytes arrive, not *how much* work is done. If the slow query is slow because of a missing database index, streaming hides the symptom from users, but your servers still pay for it. Fix the query too.

## Discussion questions

1. Which parts of a page you know would you put in the shell, and which behind Suspense boundaries? Why?
2. How does streaming change the usefulness of TTFB as a metric?
3. Why does the inline swap script matter for users on slow networks, given that React hydrates later anyway?
4. What would go wrong if an authorization check ran inside a streamed boundary?
5. How would you serve a complete, non-streamed page to search-engine crawlers, and is it necessary?
6. How do streaming SSR and a client-side query cache work together on a page that also updates live?

## FAQ

### Is streaming SSR bad for SEO?

No. The response still contains all the content by the time it finishes, so crawlers that read the whole HTML see everything. Metadata like the title must be in the shell, which frameworks handle for you. If in doubt, buffer the full response for known bots with `onAllReady`.

### What's the difference between Suspense on the client and on the server?

On the client, Suspense shows a fallback while lazy code or data loads, then replaces it. On the server, the same boundary becomes a streaming point: the fallback is sent in the shell and the content is streamed later. It also defines a unit for selective hydration.

### Does streaming require React Server Components?

No. Streaming SSR with Suspense works with ordinary client components since React 18. Server Components build on top of it: their output is also streamed, and they make it easier to await data directly where it's used.

### Why do I still see the whole page arrive at once?

Usually something is buffering the response: compression middleware, a proxy, a CDN or a hosting platform that doesn't support streaming. It can also happen if your shell itself awaits the slow data, or if you used `onAllReady` instead of `onShellReady`.

### Can I stream without a framework?

Yes. Call `renderToPipeableStream` in a Node server, pipe it to the response in `onShellReady`, and hydrate with `hydrateRoot` on the client. Frameworks add routing, data loading conventions and metadata handling, which is why most teams use one.

## Key takeaways

- Classic SSR waits for the slowest query and then hydrates everything at once; streaming removes both all-or-nothing waits.
- The shell is sent immediately; each Suspense boundary streams in when its data resolves, using a hidden chunk and an inline swap script.
- Selective hydration lets boundaries hydrate independently, yield to the browser and prioritize what the user touches.
- Status codes, redirects, cookies and `<head>` must be settled before the shell flushes.
- Put boundaries around independent slow regions, start fetches early and reserve space for fallbacks.
- Check that no proxy, CDN or middleware buffers the response, or streaming quietly stops working.

## References

- React docs: [renderToPipeableStream](https://react.dev/reference/react-dom/server/renderToPipeableStream)
- React docs: [Suspense](https://react.dev/reference/react/Suspense)
- React Working Group: [New Suspense SSR Architecture in React 18](https://github.com/reactwg/react-18/discussions/37)
- Next.js docs: [Loading UI and Streaming](https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming)
- MDN: [Transfer-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Transfer-Encoding)
- web.dev: [Rendering on the Web](https://web.dev/articles/rendering-on-the-web)
- Remix docs: Streaming with defer and Await (remix.run/docs/en/main/guides/streaming)

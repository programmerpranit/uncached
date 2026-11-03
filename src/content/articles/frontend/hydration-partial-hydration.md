---
summary: How server-rendered HTML becomes an interactive app, and why that costs so much. Covers what hydration actually does, the gap between "visible" and "interactive", hydration mismatches, and the strategies that do less of it - progressive and selective hydration, islands, and resumability.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Server-side rendering (SSR) sends HTML, so content appears fast. But that HTML is inert: no click handlers, no state. **Hydration** makes it interactive. The client downloads the app's JavaScript, **re-runs the components** to rebuild the component tree, matches that tree against the DOM already on the page, and attaches event listeners. Until that finishes, the page looks ready but doesn't respond.
>
> Hydration costs roughly as much as rendering the app on the client, because the work is the same, minus creating DOM nodes. **Partial hydration** reduces it:
>
> - **Progressive** hydration delays parts of the page until they're visible or the browser is idle.
> - **Selective** hydration (React 18) hydrates Suspense boundaries independently and prioritises the one the user touches.
> - **Islands** ship JavaScript only for the interactive widgets and leave the rest as static HTML.
> - **Resumability** (Qwik) avoids re-executing components at all.

## The problem: the page is painted but not alive

A client-rendered single-page app shows nothing until its bundle has downloaded and run. SSR fixes the blank screen: the server renders the components to HTML and the browser paints it immediately. First Contentful Paint and Largest Contentful Paint improve, and crawlers see real content.

But the HTML is a picture of the app, not the app. The `onClick` on a button lives in JavaScript, and so does the state behind a dropdown. To make the page work, the client still needs the full bundle, and then has to reconstruct everything the server knew. On a mid-range phone, a large page can take seconds to hydrate, and during that time taps are ignored or queued. The page appears ready but isn't, sometimes called the **uncanny valley**.

## How it works

### What hydration does

![Timeline: HTML arrives and paints, then JavaScript downloads, executes and hydrates before the page becomes interactive](/figures/hydration/timeline.svg "Content is visible after the HTML step; interactivity arrives only after hydration.")

On the server, the framework renders the component tree to HTML, streams it out, and embeds the data the components used, usually as serialized JSON in a `<script>` tag. Without that data, the client would have to fetch it again before it could render the same output.

On the client, a call such as React's `hydrateRoot(container, <App />)` then:

1. **Re-runs the components** with the same props and data, building the in-memory tree (in React, the fiber tree).
2. **Walks the existing DOM** alongside it. For each host element it expects, it claims the node already on the page instead of creating a new one.
3. **Attaches event listeners.** React uses one delegated listener per event type on the root, so this part is cheap; the expensive part is step 1.
4. **Runs effects** (`useEffect`, `useLayoutEffect`), so subscriptions, timers and measurements start.

After that, the app behaves exactly as if it had been client-rendered. The DOM wasn't recreated, but **all the component code was downloaded, parsed and executed**. That's why hydration is often described as "doing the work twice": once on the server to produce HTML, and again on the client to make it interactive.

### Hydration mismatches

![Server HTML and the client first render differ, causing a hydration mismatch, with common causes and fixes](/figures/hydration/mismatch.svg "Hydration assumes the client's first render produces exactly the server's HTML.")

Hydration assumes the client's first render matches the server's output. If it doesn't, the framework can't safely adopt the existing DOM. In React 18 and later, a mismatch is reported as a recoverable error, and React throws away the server HTML up to the nearest Suspense boundary (or the whole root) and renders that part on the client instead. Users may see a flash of changed content, and you lose the benefit of SSR for that region.

Typical causes:

- values that differ between environments: `Date.now()`, `Math.random()`, time zones and locale formatting;
- reading `window`, `localStorage`, cookies or `matchMedia` during render;
- invalid HTML nesting, such as `<div>` inside `<p>`, which the browser's parser silently restructures;
- browser extensions that inject nodes into the page.

The fix is to make the first render deterministic: pass server-chosen values down in the serialized data, show client-only values in an effect after mount, and generate IDs with `useId()`.

### Doing less hydration

![Five hydration strategies compared by which page regions run JavaScript: full, progressive, selective, islands and resumability](/figures/hydration/strategies.svg "Each strategy trades simplicity for less client-side work.")

**Full hydration** hydrates the whole page in one pass. Simple, but the page isn't interactive until the slowest component is done, and every component ships JavaScript even if it never changes.

**Progressive (lazy) hydration** hydrates regions on a trigger: when they scroll into view (`IntersectionObserver`), when the browser is idle (`requestIdleCallback`), or on first interaction. Vue/Nuxt offer this through lazy hydration strategies, Angular through `@defer` with incremental hydration. The JavaScript for a deferred region can also be split out and loaded later.

**Selective hydration** is React 18's version, built into Suspense and streaming SSR. Each `<Suspense>` boundary hydrates independently, so a slow comment section doesn't block the header. Hydration is interruptible: if the user clicks inside a boundary that hasn't hydrated yet, React records the event, hydrates that boundary first, and then replays the click.

**Islands architecture**, a form of **partial hydration**, inverts the default. The page is static HTML, and only the components marked as interactive, the islands, ship and hydrate their JavaScript. In Astro, a component renders to HTML only, unless you add a directive such as `client:load`, `client:idle` or `client:visible`. A blog page with a search box and a newsletter form ships JavaScript for those two widgets, not for the article.

**React Server Components** reach a similar result inside one React tree. Server components never ship to the client, and only `'use client'` components hydrate.

**Resumability** (Qwik) aims for zero hydration. The server serializes not only data but also where listeners are and what state they close over. On the client, a tiny global loader waits for events; when the user clicks, it fetches just that handler's code and runs it. The components aren't re-executed on load at all.

## Where it's used

| Framework | Approach |
|---|---|
| Next.js (pages router), Remix, Nuxt, SvelteKit | full hydration of SSR pages, with code splitting per route |
| React 18+ (`hydrateRoot`, Suspense, streaming) | selective, interruptible hydration per Suspense boundary |
| Next.js App Router | React Server Components: only client components hydrate |
| Astro, Fresh (Deno), Eleventy `<is-land>` | islands: static HTML by default, opt-in hydration per component |
| Nuxt / Vue 3.5, Angular 17+ | lazy and incremental hydration triggers (visible, idle, interaction) |
| Qwik | resumability: no hydration pass; handlers load on demand |

## Use case walk-through: a slow product page

An e-commerce product page is server-rendered with Next.js. LCP is good at 1.4 s, but Interaction to Next Paint is poor, and analytics show many "rage clicks" on **Add to cart** in the first few seconds.

1. **Profile on a throttled phone.** The Performance panel shows a 1.8 s long task named `hydrateRoot` that starts after a 420 KB bundle is downloaded. The Add to cart button doesn't respond until it ends.
2. **Find what is actually interactive.** Most of the page is static: description, specs, reviews and footer. The interactive parts are the image gallery, the variant picker, Add to cart and the review filter.
3. **Stop shipping static parts.** Move the static sections into server components (or, in an islands framework, leave them as plain components). Their code drops out of the bundle, which shrinks to 140 KB.
4. **Split the rest into boundaries.** Wrap the reviews and the recommendations carousel in `<Suspense>`. They stream in later and hydrate independently. The buy box hydrates first.
5. **Fix the mismatch.** The console shows a hydration error from a "Delivery by" date computed with the client's time zone. Compute it on the server, pass it in the data, and only refine it in an effect.
6. **Result.** The long task drops to about 250 ms, the buy box is interactive within a second of paint, and INP moves into the "good" range.

## Pitfalls

- **Assuming SSR means fast interactivity.** SSR improves paint, not responsiveness. Measure INP and Total Blocking Time, not just LCP.
- **Non-deterministic first renders.** Dates, randomness and `window` checks in render cause mismatches and throw away the server HTML.
- **Serializing too much data.** Embedding a huge JSON payload duplicates the content (once as HTML, once as data) and slows parsing. Send only what the client components need.
- **Islands that need to talk.** Islands are separate roots. Shared state between them needs a store outside the component tree, custom events or URL state.
- **Lazy hydration on critical controls.** Deferring the hydration of a button the user needs immediately makes the first tap slow. Hydrate above-the-fold controls eagerly.
- **Hiding mismatches.** `suppressHydrationWarning` only silences one element's text or attributes. Using it widely hides real bugs.

> [!WARNING]
> Events that happen before hydration aren't always replayed. React replays clicks inside not-yet-hydrated Suspense boundaries, but a plain form submit or a link handled by client-side routing may fall back to the browser's default behaviour, or be lost. Use real `<a href>` and `<form action>` elements so the page still works before the JavaScript arrives.

## Discussion questions

1. Why is hydration described as doing the rendering work twice, and which part of it does the client actually skip?
2. What exactly goes wrong when the server and client produce different HTML, and why can't the framework just patch the difference?
3. How does selective hydration decide what to hydrate first, and what happens to a click on a part that isn't hydrated yet?
4. When are islands a good fit, and when does an app have so much shared interactive state that they become awkward?
5. How does resumability avoid re-running components, and what does it have to serialize to make that possible?
6. Which metrics would you use to show that a change to hydration actually helped users?

## FAQ

### Is hydration the same as client-side rendering?

Almost. Hydration runs the same component code as client-side rendering, but instead of creating DOM nodes it adopts the ones the server already sent. That saves DOM creation and gives fast first paint, but it doesn't save downloading, parsing or executing the components.

### What is the difference between partial and progressive hydration?

Partial hydration means **some components never hydrate**; they stay static HTML and ship no JavaScript (islands, server components). Progressive hydration means **every component eventually hydrates, but not all at once**; regions hydrate on visibility, idle time or interaction. They're often combined.

### Do static-site generators avoid hydration?

No. A statically generated page built with a React or Vue framework is still hydrated on load; it just has its HTML built ahead of time instead of per request. Only frameworks that default to zero JavaScript, like Astro, skip hydration for static content.

### Why does React need the serialized data if the HTML is already there?

To re-run the components and get exactly the same output. The HTML shows the result, but the components need the inputs (props, loader data, query cache) to rebuild their state and handlers. Without the data, the client would have to refetch it, and the first render would mismatch.

### Is resumability strictly better than hydration?

It removes the startup cost, but it moves work elsewhere. It needs a compiler that splits code at every handler boundary, the serialized state can be large, and the first interaction with each feature may wait for a small network fetch. Whether it's a net win depends on how interactive the page is.

## Key takeaways

- SSR makes content visible early; hydration makes it interactive by re-running components on the client and adopting the existing DOM.
- The cost of hydration is downloading and executing the component code. That cost is what partial hydration strategies attack.
- The first client render must match the server HTML. Keep it deterministic and move client-only values into effects.
- Progressive and selective hydration change **when** code runs; islands and server components change **whether** it runs; resumability skips the startup pass entirely.
- Measure INP and long tasks on real devices, not just LCP, to see whether hydration is hurting users.

## References

- React documentation: [hydrateRoot](https://react.dev/reference/react-dom/client/hydrateRoot)
- React working group: "New Suspense SSR architecture in React 18" (reactwg/react-18 discussion #37, 2021)
- Astro documentation: [Islands architecture](https://docs.astro.build/en/concepts/islands/)
- web.dev: [Rendering on the web](https://web.dev/articles/rendering-on-the-web)
- Jason Miller, "Islands Architecture" (jasonformat.com, 2020)
- Qwik documentation: [Resumable vs. hydration](https://qwik.dev/docs/concepts/resumable/)
- Angular documentation: [Incremental hydration](https://angular.dev/guide/incremental-hydration)

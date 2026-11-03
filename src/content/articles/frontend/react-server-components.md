---
summary: Components that run only on the server and send a serialized UI tree instead of JavaScript. Covers server vs client components, the 'use client' boundary, the RSC payload and how it streams, what can be passed across the boundary, server functions, caching, and when RSC is or isn't a good fit.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** **React Server Components** (RSC) split one React tree across two environments:
>
> - **Server components** (the default in RSC frameworks) run only on the server, at build time or per request. They can be `async`, read databases and files directly, and **ship no JavaScript** to the browser.
> - **Client components**, marked by a `'use client'` module directive, are the familiar kind. They're rendered to HTML on the server, then **hydrated** in the browser, and they can use state, effects and event handlers.
>
> The server renders server components into an **RSC payload**: a streamed, serialized description of the UI, with references to the client components it uses. The client turns that payload into DOM, loads only the referenced client code, and on later navigations fetches new payloads and merges them without losing client state.
>
> The result: less JavaScript, and data fetching next to the component that needs it, without client-server waterfalls. The cost: a new mental model, with serialization rules at the boundary.

## The problem: every component ships, every component fetches

In a classic React app, even a server-rendered one, every component's code is in the client bundle, because hydration has to re-run all of them. A product description rendered from Markdown pulls the Markdown parser into the bundle. A date formatter brings its locale data. None of it is ever interactive.

Data fetching has a similar problem. Components fetch data in effects, so a parent renders, fetches, renders its children, and they fetch: a **waterfall** of round trips from the browser. Frameworks moved fetching into route-level loaders (`getServerSideProps`, Remix `loader`), which fixes the waterfall but separates the data from the component that uses it.

RSC addresses both problems. Components that don't need interactivity run where the data is and send only their output. Components that do need it ship as before.

## How it works

### Two kinds of components

![Component tree mixing server components and client components, with only client components shipped to the browser](/figures/react-server-components/tree.svg "The 'use client' directive marks where the client bundle starts.")

A **server component** is an ordinary function, which may be `async`:

```jsx
// ProductDetails.jsx (server component: the default)
import { db } from './db';
import AddToCart from './AddToCart';

export default async function ProductDetails({ id }) {
  const product = await db.products.find(id);
  return (
    <section>
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      <AddToCart productId={id} />
    </section>
  );
}
```

It can't use `useState`, `useEffect` or event handlers, because it never runs in the browser. Its imports (the database client, a Markdown library) stay on the server.

A **client component** starts with `'use client'`. That directive marks a **module boundary**: the file, and everything it imports, become part of the client bundle. You don't mark every client component, only the entry points where the server tree hands over to the client. Components imported from inside a client module are client components automatically.

The two kinds can be nested in either direction, with one rule: a client module can't **import** a server component, because that would pull server-only code into the bundle. It can still **render** one that a server component passes in, as `children` or another prop.

### The RSC payload

![Request flow: server components render to an RSC payload, which is turned into HTML on the server and merged into the DOM on the client](/figures/react-server-components/flow.svg "On the first load the payload becomes HTML; on navigations it is merged into the live tree.")

When a request comes in, the framework renders the server component tree. Server components run, data is fetched, and the output is serialized into the **RSC payload** (sometimes called the "Flight" format). It's a line-based stream of:

- **rendered elements**: host elements like `<section>` with their props and text;
- **client references**: in place of a client component, a pointer to the module ID and the bundle chunk to load, plus the props to pass it;
- **holes for pending data**: a part still waiting on an `await` inside a `<Suspense>` boundary is filled in by a later chunk of the stream.

For the **initial page load**, the server also runs SSR. It feeds the payload to a renderer that executes the client components and produces HTML, so the user sees content immediately. The payload is inlined into the HTML, and the client uses it to hydrate the client components. Server components are never hydrated; there's nothing to hydrate.

On **client-side navigation**, the router requests the RSC payload for the new route, not HTML, and React reconciles it into the existing tree. Client components that are still on the page keep their state, so a search box keeps its text and a scroll position stays where it was.

### What crosses the boundary

![What can and cannot be passed as props from server components to client components](/figures/react-server-components/rules.svg "Props passed to client components must be serializable.")

Props from a server component to a client component travel over the network, so they must be **serializable**:

- **Allowed:** primitives, plain objects and arrays, `Date`, `Map`, `Set`, typed arrays, JSX (including rendered server components), Promises, and server functions.
- **Not allowed:** ordinary functions (such as an `onClick` defined on the server), class instances and closures.

Passing a **Promise** lets the server start a fetch without awaiting it. The client component calls `use(promise)` and suspends until the data streams in.

Composition gets around the import rule:

```jsx
// Page.jsx (server)
<Tabs>                       {/* client component */}
  <ProductList />            {/* server component, rendered on the server */}
</Tabs>
```

`Tabs` receives `ProductList` as already-rendered output in `children`, so it can show or hide it without its code ever reaching the client.

### Server functions

A function marked `'use server'` (a **server function**, also called a Server Action when it's used for a form) can be passed to client components or imported by them. The bundler replaces it on the client with a stub that, when called, sends a POST request to the server with the serialized arguments. The server runs it and can return data or an updated RSC payload. Used as `<form action={createOrder}>`, the form works even before JavaScript loads.

Server functions are public HTTP endpoints. Anyone can call them with any arguments, so they need the same authentication, authorization and input validation as any API route.

### Streaming and caching

Server components fit with **streaming SSR**: a slow `await` inside a `<Suspense>` boundary doesn't block the rest. The shell streams first, and the boundary's content arrives later in the same response.

Because server components are pure functions of their inputs, their output can be cached. Frameworks cache RSC payloads for static routes at build time, and some cache individual fetches or components with explicit invalidation (for example Next.js's `'use cache'` and `revalidateTag`). How much is cached, and for how long, is a framework decision, and a common source of "why is my data stale?" questions.

## Where it's used

| Framework / tool | Notes |
|---|---|
| Next.js App Router | the main production implementation; server components by default, server actions, layered caching |
| React Router (framework mode) | RSC support built on its loaders and routing |
| Waku | minimal RSC framework from the Jotai author |
| Parcel, Vite (via plugins) | bundler support for `'use client'` / `'use server'` module graphs |
| Expo Router | experimental server components for React Native |
| React 19 | stable RSC APIs (`use`, server functions, form actions) for frameworks and bundlers |

## Use case walk-through: a documentation site

A docs site renders pages from MDX, with syntax highlighting, a table of contents, a search box and a "Was this helpful?" widget. The client bundle is 380 KB, mostly the MDX runtime and the highlighter with its language grammars.

1. **Classify components.** The page, the MDX content, code blocks and the table of contents are static: server components. Search, the theme toggle and the feedback widget are interactive: client components with `'use client'`.
2. **Move heavy work to the server.** The highlighter runs inside a server component `CodeBlock`. Only the highlighted HTML, as elements, goes into the payload; the highlighter's code never ships.
3. **Read content directly.** The page component reads the MDX file from disk with `await fs.readFile` and compiles it on the server. No API route, no client fetch.
4. **Wire the interactive pieces.** `FeedbackWidget` gets `pageId` (a string) and a `submitFeedback` server function. The form posts to the server and works before hydration.
5. **Measure.** The client bundle drops to about 60 KB (React, the router and three small widgets). Navigation between pages fetches small payloads, and the search box keeps its query across navigations.

## Pitfalls

- **`'use client'` too high in the tree.** Marking a layout as a client component makes everything it imports client code, which brings back the bundle you were trying to remove. Push the directive down to the leaves that need interactivity.
- **Passing non-serializable props.** Passing a function, or a class instance like an ORM model, from a server to a client component fails. Pass plain data and server functions.
- **Leaking secrets.** Anything passed to a client component is serialized into the page, so don't pass whole database rows with internal fields. Use the `server-only` package, or taint APIs, to make importing server modules into client code a build error.
- **Unprotected server functions.** They're reachable by direct HTTP requests. Check the session and validate inputs inside every one.
- **Accidental waterfalls on the server.** Sequential `await`s in nested server components still run one after another. They're cheaper than client waterfalls, but start independent fetches in parallel (`Promise.all`, or pass promises down).
- **Confusing caching.** Framework caches can serve stale data. Know which routes are static, which are dynamic, and how each cache is invalidated.

> [!TIP]
> When unsure where to put the boundary, start with everything as a server component, and add `'use client'` only when the compiler complains that you used state, an effect, a browser API or an event handler. Then check whether that component can be split so that only a small interactive leaf is a client component.

## Discussion questions

1. Why can a client module render a server component passed as `children` but not import one?
2. What exactly is in the RSC payload, and how is it different from the HTML produced by SSR?
3. How does RSC remove client-server data-fetching waterfalls, and can waterfalls still happen on the server?
4. What security risks do server functions and serialized props introduce, and how would you mitigate them?
5. Compare RSC with an islands framework like Astro. What does each make easy, and what does each make hard?
6. When would RSC add complexity without much benefit, for example in a highly interactive dashboard?

## FAQ

### Are server components the same as server-side rendering?

No. SSR renders **any** component (including client components) to HTML for the first load, and then the client hydrates all of them. Server components run **only** on the server and never hydrate. RSC frameworks use both: server components produce the payload, and SSR turns the payload plus client components into the initial HTML.

### Does 'use client' mean the component only runs in the browser?

No. Client components are still rendered on the server during SSR to produce HTML, and then hydrated. "Client" means "also runs on the client, and its code ships there". Code that must only run in the browser goes in effects, or behind a check that the component has mounted.

### Can I use server components without a framework?

In principle, yes: the APIs are in React. In practice RSC needs bundler integration (to split modules at `'use client'` and `'use server'` boundaries and produce client references), a server that streams payloads, and a router that requests and merges them. That's why it's mostly used through frameworks.

### Do server components replace state management libraries?

Partly. Server data that was fetched into a client cache (React Query, SWR or Redux) can often be fetched directly in server components instead. Client state, such as UI toggles, form drafts and optimistic updates, still lives in client components and client stores.

### What happens to server components when the user navigates?

The router fetches the new route's RSC payload and React reconciles it into the current tree. Server components re-render on the server (or come from a cache). Shared layouts that didn't change can be skipped, and client components in them keep their state.

## Key takeaways

- RSC splits one React tree across server and client. Server components run only on the server and ship no JavaScript.
- `'use client'` marks a module boundary; everything below it in the import graph goes to the client.
- The server streams an RSC payload of rendered elements and client references; SSR turns it into HTML for the first load, and navigations merge new payloads.
- Props crossing the boundary must be serializable. Use children composition to put server content inside client components.
- Server functions are public endpoints: authenticate and validate in each one.

## References

- React documentation: [Server Components](https://react.dev/reference/rsc/server-components)
- React documentation: ['use client'](https://react.dev/reference/rsc/use-client) and ['use server'](https://react.dev/reference/rsc/use-server)
- React documentation: [Server Functions](https://react.dev/reference/rsc/server-functions)
- Next.js documentation: [Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- React RFC #188: "Server Components" (reactjs/rfcs, 2020)
- Dan Abramov and Lauren Tan, "Introducing Zero-Bundle-Size React Server Components" (React blog, December 2020)
- Josh W. Comeau, "Making Sense of React Server Components" (joshwcomeau.com, 2023)

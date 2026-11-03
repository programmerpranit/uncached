---
summary: How large organizations split one web app across many teams that build and deploy independently. Covers why micro-frontends exist, splitting by business domain, the four ways to compose them (build time, server/edge, runtime in the browser, iframes), how Module Federation loads remote code and shares singletons like React, communication and styling between apps, and the costs that make many teams regret the move.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **micro-frontend** architecture splits one user-facing app into pieces that separate teams own end to end, from repo and CI to deploys. A thin **app shell** stitches them together at **build time**, on the **server or edge**, **at runtime in the browser**, or with **iframes**.
>
> **Module Federation** is the most popular runtime approach. Each app publishes a small manifest (`remoteEntry.js`) listing the modules it **exposes**. The host loads those modules on demand, and all apps negotiate a **shared scope** so a library like React is loaded once. The payoff is independent deploys. The price is a lot of extra complexity: version drift, duplicated code, harder debugging and slower pages if you're careless. Use it to fix an *organizational* bottleneck, not a technical one.

## The problem: one frontend, too many teams

A single-page app usually starts as one repo with one build and one deploy pipeline. That works well for one team, or even three. At fifty engineers the cracks show:

- Every change goes through the same build, test suite and release train. A broken test in Checkout blocks a fix in Search.
- Teams step on each other in shared folders, and a dependency upgrade becomes a cross-team project.
- CI times grow with the codebase, so feedback slows for everyone.
- Nobody truly owns the whole thing, so cross-cutting quality drifts.

The backend went through the same pain and answered it with microservices: split by business capability, let each team ship on its own schedule. Micro-frontends apply that idea to the UI. Each team owns a **vertical slice**, from the database through the API to the pixels on screen.

![An app shell composes three vertical slices owned by Search, Product and Checkout teams, each with its own repo, pipeline and deploys](/figures/micro-frontends/slices.svg "Split by business domain, not by technical layer: each team ships its slice of the page independently.")

Note what this is *not*. It isn't a component library, which is shared code that every app installs. It isn't splitting a codebase into folders either. The defining feature is **independent deployment**: the Checkout team can release at 3 pm on a Tuesday without anyone else rebuilding.

## How it works

### Splitting by domain

The first decision is where to cut. Good boundaries follow the business, not the technology:

- **By page or route.** `/search/*` belongs to Search, `/product/*` to Product, `/checkout/*` to Checkout. This is the simplest split, because each team owns whole screens and the shell only routes.
- **By region of a page.** The product page shows the gallery from Product, the "Add to cart" button and mini-cart from Checkout, and recommendations from Discovery. This is more flexible, but it creates more integration points.

A useful test: could this piece be described to a non-engineer as a feature of the business? "The cart" passes. "The buttons" or "the API layer" do not; those are shared libraries, not micro-frontends.

### Four ways to compose the page

Once the pieces exist, something must assemble them into one page. The options trade coupling for independence.

![Four composition approaches from most coupled to most independent: build-time npm packages, server or edge includes, runtime composition in the browser, and iframes, with pros and cons of each](/figures/micro-frontends/compose.svg "The further right, the more independent the deploys, and the more you pay in runtime cost and complexity.")

**Build time.** Each team publishes its part as an npm package and the shell installs them. You get type safety, one optimized bundle and deduplicated dependencies. But the shell must rebuild and redeploy for every change, so you lose independent releases. Many teams are happy here and should stay here.

**Server or edge.** The server assembles HTML fragments from different services before sending the page. Older systems used **Server Side Includes (SSI)** or **Edge Side Includes (ESI)** tags at a CDN. Modern versions stream fragments from multiple origins, or use framework features like Vercel's or Netlify's micro-frontend routing. First paint is fast and SEO-friendly, but sharing client-side state and interactivity between fragments is harder.

**Runtime in the browser.** The shell downloads each team's JavaScript when it's needed and mounts it. Tools include **Module Federation**, native **import maps** pointing bare specifiers at versioned URLs, and orchestrators like **single-spa** that mount and unmount apps by route. Teams deploy independently and the page still feels like one SPA.

**iframes.** Each piece runs in its own document. Isolation is perfect: separate JavaScript globals, CSS and even crash domains. But sizing, deep linking, focus management, accessibility and performance (every iframe loads its own framework) are all painful. iframes remain a good fit for truly untrusted or third-party content, like payment widgets.

### Module Federation: sharing code at runtime

Module Federation started in webpack 5 and now exists as a standalone runtime, **Module Federation 2.0**, with plugins for webpack, Rspack, Vite and others. Each build declares two things.

A **remote** says which modules it **exposes**, for example `./Cart` and `./MiniCart`. Its build emits an extra file, `remoteEntry.js` (or a JSON manifest in 2.0), that maps those names to chunks.

A **host** says which remotes it may consume and where to find their entry files. In code, importing from a remote looks almost normal:

```js
const MiniCart = React.lazy(() => import('checkout/MiniCart'));
```

At runtime the host fetches the remote's entry, asks it for `./MiniCart`, and the remote loads just the chunks that module needs.

![Host app with a shared scope where React is a singleton and two versions of date-fns are loaded, fetching remoteEntry.js from checkout and product remotes that expose Cart, MiniCart, Gallery and Reviews](/figures/micro-frontends/federation.svg "Remotes expose modules; the shared scope decides which dependency copies everyone actually uses.")

### The shared scope and version negotiation

The clever part is **shared dependencies**. Each build lists libraries it's willing to share, with a semver range:

```js
shared: {
  react:     { singleton: true, requiredVersion: '^18.2.0' },
  'react-dom': { singleton: true, requiredVersion: '^18.2.0' },
  'date-fns':  { requiredVersion: '^3.0.0' },
}
```

When the apps initialize, each one registers the versions it bundled into a shared scope. When code asks for `react`, the runtime picks the highest registered version that satisfies the request.

- **`singleton: true`** means only one copy may ever load. That's essential for React, whose hooks break if two copies run, and for anything holding global state such as a router or store. If versions don't match, you get a console warning, or an error with `strictVersion`.
- **Non-singletons** can load side by side. If Product needs date-fns 2 and Checkout needs date-fns 3, both are downloaded. That works, but the user pays twice.

So each remote still *bundles* its dependencies as a fallback, but at runtime they're usually deduplicated.

### How the pieces talk to each other

Micro-frontends should be loosely coupled, so communication should be minimal and explicit:

- **The URL** is the best shared state. A product ID, a search query or a filter lives in the route, and every app reads it.
- **Browser events.** One app dispatches `window.dispatchEvent(new CustomEvent('cart:add', { detail: { sku } }))` and another listens. This is a public contract, so version it like an API.
- **Props from the shell.** The host passes a small, documented set of values (user, locale, feature flags) when it mounts a remote.
- **Backend for each slice.** Each team calls its own API, so data doesn't need to flow through the frontend at all.

Avoid a shared global store that every app reads and writes. It recreates the coupling you split up to escape.

### Styles, routing and the design system

Since all runtime micro-frontends share one document, their CSS can collide. Common defences are **CSS Modules** or CSS-in-JS with generated class names, a per-app prefix, and **Shadow DOM** for strong isolation (at the cost of harder global theming). A shared **design system**, delivered as versioned components plus design tokens, keeps the slices looking like one product.

The shell normally owns top-level routing and lazy-loads the right micro-frontend per route. Each app can own nested routes beneath its prefix.

## Where it's used

| Organization or tool | How micro-frontends appear |
|---|---|
| IKEA, Zalando, DAZN | Early, public adopters; fragments composed on the server or at runtime by domain teams |
| Spotify desktop (historically) | One iframe per feature area; later moved back toward a single app for performance |
| Webpack / Rspack / Vite | Module Federation plugins for runtime sharing |
| single-spa | Framework-agnostic orchestrator that mounts apps by route |
| Vercel, Netlify, Cloudflare | Routing different paths to separately deployed apps under one domain |
| Large enterprise dashboards | Separate teams ship admin modules into a common shell |

## Use case walk-through: splitting a shop's checkout

A retail site has one React app owned by 40 engineers. Checkout releases are blocked weekly by unrelated failures, and the business wants Checkout to ship several times a day.

1. **Pick the seam.** Checkout is a clear business domain with its own backend team. Start with only this one split; don't carve up the whole site.
2. **Create the remote.** The Checkout team moves its code into its own repo and build, exposing `./CheckoutPage` and `./MiniCart` through Module Federation.
3. **Share the essentials.** Both host and remote mark `react`, `react-dom` and the router as singletons and agree on the same major versions. The design system is a shared, versioned package.
4. **Define the contract.** The shell passes `user` and `locale` as props. Adding to the cart fires a `cart:add` custom event, and the mini-cart listens. Both are documented and typed in a small shared package.
5. **Deploy independently.** Checkout publishes `remoteEntry.js` to a stable URL on each release. The host loads it at runtime, so no host rebuild is needed.
6. **Guard against failure.** The host wraps each remote in an error boundary with a fallback ("Cart unavailable, retry"). It monitors remote load errors and can roll back by pointing at the previous manifest.
7. **Measure the cost.** The team checks bundle size and Core Web Vitals before and after, so they know the split didn't add duplicate libraries or extra waterfalls.

**Result:** Checkout ships on its own schedule, with fewer blocked releases, while the rest of the site stays a single app.

## Pitfalls

- **Splitting for the wrong reason.** Micro-frontends solve team-scaling problems. For a team of eight, they add cost with no benefit; a well-structured monolith or monorepo is faster.
- **Duplicate frameworks.** Without singletons, two copies of React load. That wastes bandwidth and breaks hooks and context in confusing ways.
- **Version drift.** Over time, teams fall behind on shared libraries. Eventually a singleton can't satisfy everyone and an upgrade turns into a coordinated, all-team migration.
- **The distributed monolith.** If every release still needs other teams to deploy in lockstep, you've kept the coupling and added network calls.
- **Runtime failures.** A remote that's down or misconfigured can break the page. Every remote load needs a fallback and monitoring.
- **Performance.** Extra manifests, more requests and request waterfalls ("load host, then entry, then chunk") can hurt load time. Preload critical remotes.
- **Inconsistent UX.** Different teams drift into different loading states, spacing and error messages unless the design system is strong and actively owned.

> [!WARNING]
> Micro-frontends are an organizational tool with a real runtime cost. If the main pain is slow builds, try a monorepo with caching (Nx, Turborepo) and code ownership rules first. Split only when teams genuinely need to release independently.

## Discussion questions

1. Your company has three frontend teams in one repo. What signals would tell you it's time to consider micro-frontends, and what would you try first?
2. When would you choose build-time composition over Module Federation, even with several teams?
3. Why must React be a singleton, but a date utility library doesn't have to be?
4. How would you design the contract between a product page and a cart micro-frontend so either team can change its internals freely?
5. What's the user-visible risk of loading a remote's code at runtime, and how would you mitigate it?
6. Why did some early adopters move away from iframe-based composition?

## FAQ

### Do micro-frontends require Module Federation?

No. Module Federation is one runtime technique. Plenty of successful setups use separate apps behind one domain, routed by path, with a shared design system and no runtime code sharing at all. Server-side composition and import maps are other options.

### Can different micro-frontends use different frameworks?

Technically yes. single-spa and Module Federation both support mixing React, Vue and Angular. In practice it's rarely wise: users download several frameworks, and engineers can't move easily between teams. It's most useful during a gradual migration from an old framework to a new one.

### How is this different from a monorepo?

A monorepo is about where code lives; micro-frontends are about how it's deployed. You can have micro-frontends in a monorepo, with each app deployed separately, or a monolith split across many repos via packages. Many teams get most of the benefit they wanted from a monorepo with good tooling.

### What about SEO and server rendering?

Runtime-only composition in the browser means content appears late, which can hurt SEO and first paint. Module Federation 2.0 and frameworks such as Next.js and Modern.js support server-side federation, and server/edge composition handles this natively.

### How do you test the whole system?

Each team tests its slice in isolation against the published contracts. Then a smaller set of end-to-end tests runs against the composed app in a staging environment, ideally against the latest deployed versions of each remote, to catch integration breaks early.

## Key takeaways

- Micro-frontends let teams own vertical slices of a UI and deploy them independently.
- Split by business domain, ideally by route first, and only as far as the organization needs.
- Composition ranges from build time (coupled, simple) to iframes (isolated, costly).
- Module Federation loads exposed modules from remotes at runtime and shares dependencies through a negotiated scope.
- Make React and other stateful libraries singletons, keep communication to URLs, events and props, and guard every remote with fallbacks.
- The main costs are complexity, version drift and performance. Use the pattern when team autonomy is the real bottleneck.

## References

- Martin Fowler / Cam Jackson: [Micro Frontends](https://martinfowler.com/articles/micro-frontends.html)
- webpack docs: [Module Federation](https://webpack.js.org/concepts/module-federation/)
- Module Federation 2.0 docs (module-federation.io)
- single-spa docs: [Getting started](https://single-spa.js.org/docs/getting-started-overview)
- MDN: [Import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
- Michael Geers: *Micro Frontends in Action* (Manning, 2020)
- micro-frontends.org: Techniques, strategies and recipes for building a modern web app with multiple teams

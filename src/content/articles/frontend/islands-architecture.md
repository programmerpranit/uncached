---
summary: Render the whole page to HTML on the server, then hydrate only the few interactive components, each independently and on its own trigger, so content-heavy sites ship a fraction of the JavaScript.
updated: 2026-11-02
---

> [!KEY]
> Islands architecture treats a page as a sea of static, server-rendered HTML with a few interactive "islands". Each island is its own small component root, with its own JavaScript chunk, serialized props and hydration trigger (on load, when idle, when visible). Hydration cost grows with the interactive parts only, not the whole page. That's ideal for content sites such as docs, blogs, marketing pages and e-commerce product pages. The trade-off: islands are isolated, so shared state and app-like navigation take deliberate design.

## The problem: hydrating things that never change

With classic server-side rendering (SSR) plus hydration, the server renders HTML so the page appears quickly. Then the browser downloads the framework and *every* component's code and re-executes the whole component tree to attach event handlers. A 3,000-word article with a search box and a "subscribe" button hydrates the article text, headings, footer and every link. All of that is JavaScript work to produce DOM that already exists and will never change.

On a mid-range phone, that hydration pass can block the main thread for hundreds of milliseconds. The page *looks* ready, but taps don't respond. It hurts Interaction to Next Paint (INP) and Total Blocking Time, and the download costs bandwidth for no user benefit.

## How it works

### Static by default, interactive by opt-in

![Islands on a page](/figures/islands/page.svg "Static HTML everywhere; three islands each hydrate on their own trigger.")

At build or request time, the server renders every component to HTML, including the interactive ones, so their initial state is visible immediately. Components are static by default and ship zero JavaScript. You mark the interactive ones explicitly, for example in Astro:

```astro
<Search client:load />
<Gallery client:visible images={imgs} />
<AddToCart client:idle sku="A12" />
```

Each marked component becomes an independent root. Nothing in between is hydrated.

### Hydration triggers

| Directive (Astro naming) | Hydrates when | Good for |
|---|---|---|
| `client:load` | Immediately on page load | Above-the-fold controls needed right away (search, nav menu) |
| `client:idle` | The browser is idle (`requestIdleCallback`) | Important but not urgent (cart button, newsletter form) |
| `client:visible` | The element enters the viewport (`IntersectionObserver`) | Below-the-fold widgets (comments, carousels, charts) |
| `client:media` | A media query matches | Mobile-only menus, desktop-only sidebars |
| `client:only` | Load only, with no server render | Components that can't run on the server (browser-only APIs) |

Because each island waits for its own trigger, a long page with ten widgets might only hydrate two of them in a typical visit.

### From build to interaction

![Island lifecycle](/figures/islands/lifecycle.svg "Server renders HTML with serialized props; each island fetches and hydrates its own chunk when its trigger fires.")

1. **Build.** The bundler emits a separate chunk per island component, plus shared framework code.
2. **Server render.** All components render to HTML. Each island is wrapped in a marker element that records its component URL, serialized props and trigger.
3. **Paint.** The browser shows full content with no JavaScript executed.
4. **Trigger.** A tiny loader script watches for each island's condition.
5. **Hydrate.** The loader fetches that island's chunk and hydrates it *in place* against the existing DOM.
6. **Interactive.** Only that island is live. The rest of the page stays plain HTML.

Props cross the server-to-client boundary as serialized data. They must be JSON-like: strings, numbers, arrays, plain objects and dates. Functions and class instances can't be passed, because there is no parent component on the client to pass them from.

### Why the JavaScript cost drops

![Startup JS comparison](/figures/islands/compare.svg "Client-rendered SPAs and full SSR hydration boot the whole tree; islands boot only the interactive parts.")

Hydration cost tracks the *size of the hydrated tree*, not how much of it is interactive. Islands shrink the hydrated tree to just the interactive parts. A content page that's 90% static goes from hydrating everything to hydrating a few small widgets. You can mix frameworks per island (React for one, Svelte for another), though that ships two runtimes.

### Related ideas

- **Partial hydration** is the general technique. Islands is the architecture built on it.
- **Server islands** (Astro's `server:defer`) flip the idea: the page is cached static HTML, and a personalised fragment, such as an avatar or cart count, is rendered by the server *later* and swapped in.
- **React Server Components** also send non-interactive components as server output with no client JavaScript. But they keep a single React tree with client components nested inside, rather than isolated roots.
- **Resumability** (Qwik) skips hydration entirely by serializing enough state to resume on interaction.
- **Progressive enhancement**, where HTML forms and links work before JavaScript loads, pairs naturally with islands.

## Where it's used

| Framework or site type | How islands appear |
|---|---|
| Astro | The canonical implementation: `client:*` directives, framework-agnostic islands, `server:defer` server islands |
| Fresh (Deno) | Components in an `islands/` folder hydrate; everything else is server-only Preact |
| Eleventy with WebC / `is-land` | Opt-in islands on top of a static site generator |
| Docs and blogs | Static content with search, theme toggle and code-copy buttons as islands |
| E-commerce product pages | Static description and specs; cart, variant picker and reviews as islands |
| Marketing sites | Mostly static; forms, pricing toggles and demos as islands |

## Use case walk-through: moving a docs site off a full SPA

A documentation site is built as a client-rendered single-page app. Lighthouse on a mid-range phone shows 480 kB of JavaScript, 1.9 s of Total Blocking Time, and pages that stay blank until the bundle runs.

1. **Inventory interactivity.** The interactive parts are the search modal, theme toggle, code-block copy buttons, a version picker and an embedded API playground on some pages. Everything else is prose, headings, tables and links.
2. **Render content statically.** Move the pages to an islands framework and render the Markdown at build time. Navigation becomes plain `<a>` links, with the browser's View Transitions API for smooth page changes.
3. **Choose triggers.**
   - Search: `client:idle`. The modal opens with a keyboard shortcut, so it doesn't need to be live at first paint.
   - Theme toggle: an inline script in `<head>` to avoid a flash, plus a tiny `client:load` island.
   - Copy buttons: one small vanilla script, not one island per code block.
   - API playground: `client:visible`.
4. **Share state deliberately.** The version picker and search both need "current version". It lives in the URL and in a tiny shared store, not in a React context that would have to span islands.
5. **Measure.** Initial JavaScript drops to 38 kB on a typical page. Total Blocking Time falls to under 100 ms. Pages are readable before any script runs, and the playground loads only for readers who scroll to it.

**Result:** about 92% less startup JavaScript, pages readable without JavaScript, and better Core Web Vitals. The same components were reused for the interactive parts.

## Pitfalls

- **Islands can't share context.** Each island is a separate root, so a React `Context` doesn't span them. Use the URL, a small framework-agnostic store, custom DOM events, or merge tightly-coupled widgets into one island.
- **Too many tiny islands.** Each island has loader and framework overhead. Twenty islands of the same framework may cost more than one larger island. Group related interactivity.
- **Hydrating too eagerly.** Marking everything `client:load` recreates full hydration with extra steps. Default to `idle` or `visible`, and justify each `load`.
- **Non-serializable props.** Passing functions or class instances to an island fails or silently drops data. Pass plain data, and keep callbacks inside the island.
- **App-like experiences.** Highly interactive apps (dashboards, editors, chat) are mostly interactive, so islands save little. An SPA or React Server Components often fit better.
- **Layout shift on hydration.** If an island's client render differs from its server HTML, for example because it depends on `window` or the time, hydration mismatches or jumps. Keep the first client render identical to the server's.
- **Mixing frameworks casually.** It's possible, but each framework adds its own runtime to the page.

> [!TIP]
> Start by listing what's interactive on each page type. If it's a small fraction, islands will pay off. If it's most of the page, they won't.

## Discussion questions

1. Why does full hydration cost so much on a mostly-static page, given the HTML is already in the DOM?
2. How would you share a shopping cart count between a header island and an add-to-cart island?
3. When would you choose `client:visible` over `client:idle`, and what's the risk of `visible` for a control the user reaches quickly?
4. How do server islands differ from client islands, and what kind of content suits each?
5. Compare islands with React Server Components. What does each give up, and what does each keep?
6. At what point does a site have too many islands, and how would you detect it?

## FAQ

### Is islands architecture the same as micro-frontends?

No. Micro-frontends split an application by *team ownership*, often with separate deployments. Islands split a page by *interactivity*, to cut JavaScript. Both produce independent component roots, so they can be combined, but they solve different problems.

### Do islands work without JavaScript?

The content does: everything is server-rendered HTML, and the islands show their initial state. Interactivity inside an island needs its JavaScript, unless you build it with progressive enhancement, such as a real `<form>` that also works as a plain post.

### Can I use React with islands?

Yes. Astro, for instance, renders React components to HTML on the server and hydrates only the ones marked with a `client:*` directive, each as its own root. The limitation is that islands don't share React context or a single component tree.

### How is this different from lazy-loading components in an SPA?

Lazy-loading in an SPA still renders the page in the browser and hydrates or mounts the whole app shell. It only defers some code. With islands, the default is no JavaScript at all, and the server has already rendered the content.

### Are islands bad for SEO?

They're good for it. The full content is in the initial HTML, so crawlers don't need to execute JavaScript to see it, and the faster loads help Core Web Vitals.

## Key takeaways

- Islands render everything to HTML and hydrate only the interactive components, each independently.
- Hydration triggers (load, idle, visible, media) let rarely-used widgets cost nothing until they're needed.
- JavaScript cost grows with interactivity, not page size, which suits content-heavy sites.
- Islands are isolated: share state through the URL, stores or events, and pass only serializable props.
- For mostly-interactive apps the savings vanish. Pick the architecture based on what share of the page is interactive.

## References

- Jason Miller, [Islands Architecture](https://jasonformat.com/islands-architecture/), jasonformat.com, 2020
- Astro docs: [Islands architecture](https://docs.astro.build/en/concepts/islands/)
- Astro docs: [Template directives reference (client:*)](https://docs.astro.build/en/reference/directives-reference/)
- Fresh docs: [Islands](https://fresh.deno.dev/docs/concepts/islands)
- Addy Osmani and Lydia Hallie, *Islands Architecture*, patterns.dev
- web.dev: [Rendering on the Web](https://web.dev/articles/rendering-on-the-web)

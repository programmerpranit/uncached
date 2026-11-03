---
summary: How bundlers ship less JavaScript. Covers tree shaking (dead-code elimination over the ES module graph), the sideEffects flag and why CommonJS defeats it, code splitting at entries and dynamic import(), vendor and shared chunks, route- and interaction-based splitting, preloading, and how to measure what actually ships.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Two techniques reduce the JavaScript a page has to download and run:
>
> - **Tree shaking** removes code that is never used. The bundler starts at the entry points, follows static `import` statements, marks the exports that are actually referenced, and drops the rest. It relies on ES modules being **static**, and on modules being free of **side effects** (or saying so with `"sideEffects": false`).
> - **Code splitting** breaks the remaining code into several **chunks** that load when they're needed. Every entry and every dynamic `import()` is a split point. Typical results are an entry chunk, a long-cached vendor chunk, one chunk per route, and on-demand chunks for heavy features.
>
> Tree shaking makes the total smaller; code splitting makes the **first load** smaller. Both matter because JavaScript costs twice: network bytes, then parse, compile and execute time on the main thread.

## The problem: everything ships to everyone

A single-page app grows by accretion. A charting library for one admin screen, a rich-text editor for one form, date-formatting locales, a utility library imported for one function. With a naive bundle, every visitor downloads all of it before the first screen works, even though most visitors use a fraction of the features.

That hurts more than the transfer size suggests. Compressed bytes are decompressed, parsed, compiled and executed on the main thread, and on a mid-range phone 1 MB of JavaScript can mean a second or more of blocking work. That shows up as slow Largest Contentful Paint for client-rendered pages and poor Interaction to Next Paint during startup.

## How it works

### Tree shaking

![Module graph where only exports reachable from the entry are kept and unused exports are removed](/figures/code-splitting/tree-shaking.svg "The bundler follows static imports from the entry and keeps only what it reaches.")

The term comes from Rollup: shake the dependency tree and the dead leaves fall off. More precisely, it's **dead-code elimination over the module graph**, in two steps:

1. **Mark used exports.** The bundler parses every module and records its `import` and `export` statements. ES module syntax is static: imports sit at the top level, with string-literal specifiers and named bindings. So the bundler can tell, without running anything, that `main.js` uses `formatDate` and `formatMoney` from `utils.js` and `debounce` from `lodash-es`.
2. **Drop the rest.** Unused exports are left out of the output (Rollup, esbuild), or marked unused and then deleted by the minifier (webpack with Terser). Whole modules that contribute nothing are skipped.

It only works when the bundler can prove that removing code changes nothing. Three things get in the way:

- **CommonJS.** `require()` is a function call that can be computed at runtime, and `module.exports` is a mutable object. Bundlers can't safely tell which properties are used, so a CommonJS dependency is usually included whole. Prefer packages that publish ES modules (`lodash-es` instead of `lodash`).
- **Side effects.** A module whose top level does something (patches a prototype, registers a custom element, imports CSS) must run even if none of its exports is used. If the bundler can't prove a module is pure, it keeps it.
- **Dynamic access.** `import * as utils` followed by `utils[name]` defeats the analysis, because any export might be used.

The `"sideEffects"` field in a package's `package.json` is the escape hatch for the second problem. `"sideEffects": false` tells the bundler that any module of the package whose exports go unused can be dropped entirely, without inspecting it. A list such as `["*.css", "./polyfills.js"]` marks the exceptions. Getting it wrong is dangerous: a module with real side effects silently disappears from the build.

Inside a module, the minifier does the finer work: removing unreachable branches (`if (process.env.NODE_ENV !== 'production')` becomes `if (false)` after replacement), and calls annotated `/*#__PURE__*/` whose results are unused.

### Code splitting

![A single 1.2 MB bundle split into entry, vendor, per-route, on-demand and shared chunks](/figures/code-splitting/chunks.svg "Each dynamic import() starts a new chunk; shared modules are pulled into common chunks.")

After tree shaking, the bundler decides how to divide the code into files. Two things create **split points**:

- **Entries.** Each configured entry (or each HTML page in a multi-page app) gets its own chunk.
- **Dynamic imports.** `import('./editor')` returns a Promise and tells the bundler that `editor` and everything it uses, beyond what's already loaded, can go into a separate chunk. At runtime the call fetches that chunk.

```js
button.addEventListener('click', async () => {
  const { openEditor } = await import('./editor.js');
  openEditor(doc);
});
```

Frameworks build on this. `React.lazy(() => import('./Dashboard'))` with `<Suspense>`, Vue's `defineAsyncComponent`, and file-based routers in Next.js, Nuxt, SvelteKit and React Router all generate one chunk per route automatically.

The bundler then optimizes the chunk graph:

- **Shared chunks.** A module used by several chunks is moved into a common chunk so it downloads once. webpack's `SplitChunksPlugin` and Rollup's chunking do this automatically, with thresholds on size and number of requests.
- **Vendor chunks.** Third-party code changes less often than app code. A separate `vendor` chunk with a content-hashed filename stays in the browser cache across deploys that only touch app code.
- **Content hashing.** Filenames such as `dashboard.3f9a1c.js` change only when the content changes, so chunks can be cached with `Cache-Control: immutable` for a year.

### Loading chunks efficiently

![Loading timeline comparing a single large bundle with split chunks, showing earlier interactivity](/figures/code-splitting/load.svg "Splitting reduces both download and execution before the first screen is usable.")

Splitting creates a new risk: **request waterfalls**. If the entry chunk must download and run before the browser learns that it needs the route chunk, which then imports a lazy component, the chunks load one after another. Remedies:

- **Preload what you know you'll need.** Build tools emit `<link rel="modulepreload">` (Vite) or `<link rel="preload">` for chunks the current route needs, so they download in parallel with the entry.
- **Prefetch likely next steps.** `<link rel="prefetch">` downloads at low priority during idle time; routers often prefetch a link's chunk on hover or when it scrolls into view.
- **Don't split too finely.** Every chunk costs a request, a module-map entry and some runtime glue. HTTP/2 makes many requests cheaper, not free. A handful of meaningful chunks usually beats hundreds of tiny ones.
- **Split at interaction boundaries.** Modals, editors, charts, maps and admin screens that most users never open are the best candidates. Splitting something every user needs immediately only adds latency.

## Where it's used

| Tool / framework | Tree shaking | Code splitting |
|---|---|---|
| Rollup (and Vite's production build) | the origin of the term; export-level, honours `sideEffects` and `/*#__PURE__*/` | dynamic `import()`, `manualChunks` |
| webpack | `usedExports` + Terser, `sideEffects` | `SplitChunksPlugin`, magic comments like `webpackChunkName` |
| esbuild | export-level for ES modules | `splitting: true` (ESM output only) |
| Rolldown, Rspack, Turbopack | Rust bundlers with Rollup- or webpack-compatible semantics | automatic shared chunks |
| Next.js, Nuxt, SvelteKit, React Router | via their bundler | per-route chunks, `next/dynamic`, prefetching on links |
| Angular | via its esbuild-based builder | lazy routes, `@defer` blocks |

## Use case walk-through: a 1.2 MB SaaS dashboard

A dashboard app ships a single 1.2 MB bundle (380 KB gzipped). On a mid-range Android phone the login screen takes 4 seconds to become usable.

1. **Look at the bundle.** `rollup-plugin-visualizer` (or `webpack-bundle-analyzer`) shows a treemap. The biggest blocks: a charting library (280 KB), Monaco editor (400 KB), `moment` with all locales (230 KB) and the full `lodash` (70 KB).
2. **Fix tree shaking first.** Replace `lodash` with `lodash-es` and named imports: 70 KB becomes 4 KB. Replace `moment` with `Intl.DateTimeFormat` plus a small date library: 230 KB becomes 12 KB.
3. **Split by route.** Wrap each route in `React.lazy`. The login and home routes no longer contain the charts.
4. **Split by interaction.** Monaco is only used in the "Edit query" modal. Load it with `import()` when the modal opens, and prefetch it when the user hovers the button.
5. **Check for waterfalls.** The network panel shows the route chunk waiting on the entry. Adding `modulepreload` for the current route's chunk makes them load in parallel.
6. **Result.** The initial JavaScript drops to 160 KB (55 KB gzipped). The login screen is usable in about 1.2 seconds, and Total Blocking Time during startup falls by over 70%.

## Pitfalls

- **Barrel files.** An `index.js` that re-exports everything (`export * from './Button'`, ...) forces the bundler to parse every module, and if any of them has side effects, they all stay. Import from the specific file, or make sure the package declares `sideEffects`.
- **Wrong `sideEffects: false`.** A CSS import or polyfill silently vanishes from production. List the files that must be kept.
- **Importing a CommonJS build.** A package whose `main` points at CommonJS is included whole. Check its `module` or `exports` fields for an ESM build.
- **Splitting what everyone needs.** Lazy-loading the header or the main route adds a round trip to every page view. Split what's large and rarely used.
- **Chunk waterfalls.** Nested lazy components load one after another. Preload what the current route will certainly need.
- **Cache-busting the vendor chunk.** If module IDs or chunk hashes change on every build, users re-download unchanged code. Use deterministic IDs and content hashes.
- **Development vs production.** Tree shaking and minification usually run only in production builds. Measure the production output.

> [!TIP]
> Set a **performance budget** in CI: fail the build if the initial JavaScript for the main route grows past a threshold (for example with `size-limit` or bundler size hints). Bundles grow one harmless-looking dependency at a time, and a budget catches it in the pull request that adds it.

## Discussion questions

1. Why does tree shaking need ES modules, and what exactly about `require()` prevents it?
2. What does `"sideEffects": false` promise, and what breaks if the promise is wrong?
3. How do you decide where to put split points in an app? What makes a good candidate and a bad one?
4. How can code splitting make a page slower, and what tools prevent that?
5. Why is a separate vendor chunk useful for caching, and when does it stop helping?
6. Barrel files make imports convenient. What do they cost at build time and in the output?

## FAQ

### Is tree shaking the same as minification?

No. Tree shaking works at the level of the module graph: which modules and exports are used at all. Minification works inside the code that's left: shortening names, removing whitespace and dead branches. They complement each other, and in webpack the minifier performs the final removal of exports that tree shaking marked unused.

### Does code splitting reduce the total amount of JavaScript?

Not by itself. The same code is divided into more files, and the total may even grow slightly because of the loading runtime. What shrinks is the code needed for the **first** screen. Tree shaking and replacing heavy dependencies reduce the total.

### Why is my library not tree-shaken even though I use named imports?

Usually one of three reasons: the package resolves to a CommonJS build, its modules have (or might have) side effects and it doesn't declare `sideEffects`, or you import through a barrel file that pulls in other modules. Bundle analyzers and webpack's `stats` output with `usedExports` can show why a module was kept.

### Should I put every dependency in a vendor chunk?

Not all of them. A single huge vendor chunk loaded on every page reintroduces the problem you were solving. Keep the core framework (React, the router) in a stable vendor chunk, and let large libraries used by one feature live in that feature's chunk.

### Does HTTP/2 make bundling unnecessary?

No. HTTP/2 multiplexing makes many requests cheaper, but each module still needs to be discovered, and unbundled module graphs create deep import waterfalls. Compression also works better on larger files. Modern tools bundle for production and serve unbundled ES modules only in development.

## Key takeaways

- JavaScript costs network bytes and main-thread time; ship less of it on the first load.
- Tree shaking keeps only the exports reachable from the entries. It needs static ES modules and side-effect-free code.
- Code splitting divides the output into chunks at entries and dynamic `import()` calls; route- and interaction-based splits give the biggest wins.
- Shared and vendor chunks, content hashes and long cache lifetimes make repeat visits cheap.
- Preload what the current route needs, prefetch what comes next, and enforce a size budget in CI.

## References

- MDN: [Tree shaking](https://developer.mozilla.org/en-US/docs/Glossary/Tree_shaking)
- MDN: [import()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import)
- webpack documentation: [Tree Shaking](https://webpack.js.org/guides/tree-shaking/) and [Code Splitting](https://webpack.js.org/guides/code-splitting/)
- Rollup documentation: [Tree-shaking](https://rollupjs.org/introduction/#tree-shaking)
- Vite documentation: [Building for production](https://vite.dev/guide/build)
- web.dev: [Reduce JavaScript payloads with code splitting](https://web.dev/articles/reduce-javascript-payloads-with-code-splitting)
- React documentation: [lazy](https://react.dev/reference/react/lazy)

---
summary: What a JavaScript bundler actually does, and why the newer tools are so much faster than the old ones. Covers the resolve-parse-transform-link-chunk-emit pipeline, tree shaking and code splitting, the engineering choices behind esbuild's speed, how Vite's native-ESM dev server avoids bundling during development, dependency pre-bundling and HMR, and the Rust generation of tools (SWC, Oxc, Rolldown, Rspack, Turbopack).
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A bundler turns hundreds or thousands of source modules into a few optimized files. It resolves imports, parses every file, transforms TypeScript and JSX, links the module graph (dropping unused code), splits it into chunks and minifies the output.
>
> **esbuild** does this 10–100× faster than older JavaScript-based toolchains. It doesn't use a clever algorithm. It's native code (Go), it runs in parallel on every core, it walks the syntax tree only a few times, and it avoids converting data back and forth between tools.
>
> **Vite** goes further in development by **not bundling your code at all**. It pre-bundles dependencies once with a fast native tool, then serves your source files as native ES modules, transforming each one only when the browser asks for it. Startup no longer depends on app size, and hot updates touch a single module. For production, Vite still bundles, now with **Rolldown**, a Rust bundler.

## The problem: big apps made builds slow

Browsers didn't support modules until around 2017–2018, and for years an app with 2,000 files meant 2,000 separate requests. So tools like **webpack**, Browserify and later **Rollup** combined everything into a few bundles ahead of time. That worked, but it had a cost that grew with the app:

- A cold start of the development server meant **building the whole app first**. Large projects waited 30 seconds to a few minutes.
- Every save rebuilt the affected chunk, so **hot module replacement (HMR)** slowed as the app grew.
- Production builds stacked several tools: Babel for syntax, the TypeScript compiler, the bundler, then Terser for minification. Each one parsed the code again into its own syntax tree, transformed it and printed it back to a string.

All of these tools were written in JavaScript, running mostly on one thread in Node.js. Around 2020, two ideas changed the picture. **esbuild** showed that a bundler written in a compiled language with parallelism designed in could be orders of magnitude faster. **Vite** showed that during development, now that browsers support `import` natively, you can skip bundling your own code entirely.

## How it works

### The bundler pipeline

Every bundler, old or new, does roughly the same six steps.

![Six stages from left to right: resolve, load and parse, transform, link, chunk, minify and emit, turning 842 source modules into 6 output files](/figures/bundlers/pipeline.svg "Speed comes from how fast each step runs, how much work is repeated, and how much runs in parallel.")

1. **Resolve.** Start at the entry point and turn every import specifier into a file path. `./Button` might mean `Button.tsx`, `Button/index.ts` or something remapped by `tsconfig` paths. `react` means a lookup in `node_modules` and its `package.json` `exports` field. Resolution means lots of file system calls, so caching matters.
2. **Load and parse.** Read each file and parse it into an **abstract syntax tree (AST)**. Parsing is one of the most expensive steps, and with thousands of files it adds up fast.
3. **Transform.** Strip TypeScript types, compile JSX to function calls, lower modern syntax for older browsers, process CSS, inline small assets. Plugins hook in here.
4. **Link.** Connect imports to exports across the whole **module graph**. This is where **tree shaking** happens: code that nothing imports is dropped. It works best with ES modules, because `import` and `export` are static and the bundler can see exactly what's used. CommonJS `require()` is dynamic, so it's much harder to shake.
5. **Chunk.** Decide which modules go in which output file. Each entry point gets a chunk, and every **dynamic `import()`** becomes a split point loaded on demand. Code shared by several chunks can be moved into a common chunk so it downloads once.
6. **Minify and emit.** Shorten names, remove whitespace and dead branches, generate source maps, add content hashes to file names (`index-3f9a.js`) so they can be cached forever, and write everything to disk.

Tree shaking needs one more piece of information: whether importing a module has **side effects**. If a module patches a global when it loads, dropping it changes behaviour, even if nothing uses its exports. Packages declare `"sideEffects": false` in `package.json` to promise they're safe to drop, and code can mark individual calls with `/*#__PURE__*/` comments.

### Why esbuild is fast

esbuild's author, Evan Wallace, wrote down the reasons in the project's FAQ. None of them is a single trick. They are a set of engineering choices that each remove a multiple of the work.

![Comparison rows: JavaScript on Node versus Go compiled to native code, mostly one thread versus all cores, many AST passes versus three, string to AST to string per tool versus one shared AST, many small objects versus compact structures](/figures/bundlers/esbuild.svg "Same job, different engineering choices. The Rust tools follow the same recipe.")

- **Native code.** JavaScript tools start in an interpreter and wait for the JIT to warm up on every run. esbuild is compiled ahead of time from Go, so it runs at full speed immediately.
- **Parallelism everywhere.** Parsing and code generation are split across all CPU cores, and Go's shared-memory threads make this cheap. A JavaScript tool in Node is mostly single-threaded, and worker threads must copy data between them.
- **Few passes over the AST.** esbuild touches the full AST only about three times: parsing (which also does scoping and lowering), linking, and printing (which also minifies). A Babel-plus-Terser pipeline walks the tree once per plugin and reparses it per tool.
- **One data format.** In a traditional chain, each tool takes a string, parses it, transforms it and prints a string for the next tool. esbuild keeps a single internal representation from start to finish.
- **Memory-friendly data.** Compact data structures are cache friendly and put less pressure on the garbage collector than millions of small JavaScript objects.
- **Written from scratch for speed.** The parser, linker and minifier were designed together, without depending on a generic third-party library.

There are trade-offs. esbuild **doesn't type-check** (you run `tsc --noEmit` separately), its plugin API is deliberately narrower than webpack's or Rollup's, and its chunk splitting is simpler. That's why it became an engine inside other tools more often than a full replacement for them.

### Vite: don't bundle in development

Vite (French for "quick") flips the dev-server model. Instead of building everything up front, it starts a server almost instantly and lets the browser drive.

![A: a bundle-based dev server processes all 842 modules into a bundle before the server is ready after about 20 seconds. B: Vite pre-bundles node_modules once and is ready in about 300 ms, then serves modules as the browser requests them](/figures/bundlers/vite-dev.svg "With native ES modules, the browser becomes the module loader, and the server only transforms what the current page imports.")

**Dependency pre-bundling.** Your dependencies rarely change, but they're the awkward part: many are CommonJS, and some (like `lodash-es`) are split into hundreds of tiny files that would cause hundreds of requests. On the first run, Vite scans your imports, bundles each dependency into a single ES module with a fast native bundler, and caches the result in `node_modules/.vite`. The browser receives these files with long-lived cache headers, so later reloads don't even ask for them again.

**Source served on demand.** Your own code is served as native ES modules. When the browser loads `main.tsx` and sees `import App from './App'`, it requests `/src/App.tsx`. Only then does Vite transform that one file (TypeScript and JSX to JavaScript) and send it back. Files that the current page never imports are never processed, so startup time stays roughly constant whether the app has 50 modules or 5,000.

**Fast HMR.** When you save a file, Vite invalidates just that module and walks up the import graph to the nearest **HMR boundary**, usually the component file that accepts hot updates (React Fast Refresh does this for components). The browser re-imports that one module with a cache-busting query string. The cost depends on the size of the edit, not the size of the app.

The approach has a limit: a page that imports thousands of unbundled source modules causes a request waterfall, because the browser only discovers each import after loading its parent. Vite mitigates this with HTTP caching and warm-up options, but very large apps can still feel it on a cold reload.

**Production is still bundled.** Shipping hundreds of separate modules to users would mean too many requests, deep import waterfalls and no cross-module optimization. So `vite build` runs a real bundler. Historically that was Rollup for production and esbuild for dev pre-bundling, two tools that occasionally disagreed. **Rolldown**, a Rust bundler with a Rollup-compatible plugin API, was built to replace both, and became Vite's default bundler in Vite 8.

### The Rust generation

esbuild proved the recipe, and a wave of Rust tools applied it to each piece of the toolchain:

- **SWC.** A Rust compiler for TypeScript and JSX, used by Next.js and by many projects as a faster Babel replacement.
- **Oxc.** A Rust parser, linter (oxlint), resolver, transformer and minifier. Rolldown is built on it.
- **Rolldown.** A Rust bundler with Rollup's API, made for Vite.
- **Rspack.** A Rust bundler that implements webpack's configuration and most of its plugin and loader API, for teams that can't leave webpack's ecosystem.
- **Turbopack.** A Rust bundler built into Next.js with incremental, function-level caching. It became the Next.js default.

The pattern repeats: native code, parallel work, one shared AST and aggressive caching. Plugin compatibility is often the hardest part, because a JavaScript plugin called from Rust brings back some of the cost of crossing between languages.

## Where it's used

| Tool | Language | Role | Notable users |
|---|---|---|---|
| webpack | JavaScript | Full bundler with a huge plugin and loader ecosystem | Older Create React App and Angular projects, many enterprise apps |
| Rollup | JavaScript | ESM-first bundler, excellent tree shaking | Libraries, Vite production builds before Rolldown |
| esbuild | Go | Transformer, bundler, minifier | Vite dev pre-bundling, tsx, Angular CLI's builder |
| Vite | JavaScript and Rust engines | Dev server plus build pipeline | Vue, SvelteKit, Astro, Remix/React Router, Nuxt, many React apps |
| Rolldown | Rust | Rollup-compatible bundler | Vite's default bundler |
| Rspack | Rust | webpack-compatible bundler | Teams migrating large webpack setups |
| Turbopack | Rust | Incremental bundler | Next.js |
| SWC and Oxc | Rust | Parse, transform, lint, minify | Next.js, Rolldown, many linting and test setups |

## Use case walk-through: moving a large app from webpack to Vite

A team has a React app with 3,000 modules. The webpack dev server takes 45 seconds to start, and saving a file takes 2–4 seconds to show up.

1. **Measure first.** Record cold start, HMR time and production build time, plus the bundle sizes that users actually download. The goal is faster feedback without shipping more code.
2. **Install Vite and its React plugin**, and move `index.html` to the project root. In Vite, the HTML file is the entry point and references `/src/main.tsx` with a `<script type="module">` tag.
3. **Replace webpack-specific features.** `require.context` becomes `import.meta.glob`, `process.env.X` becomes `import.meta.env.VITE_X`, and webpack loaders become Vite or Rollup plugins (most common ones have equivalents).
4. **Fix CommonJS leftovers.** Source files that use `require()` or `module.exports` need converting to ES modules, because Vite serves source as native ESM. Dependencies are handled by pre-bundling.
5. **Run the dev server.** It starts in under a second. The first page load takes longer as Vite transforms that page's modules, then reloads are fast. Edits now update in about 50 ms.
6. **Check the production build** with a bundle analyzer. Compare chunk sizes with the webpack output, and add `manualChunks` or adjust dynamic imports if a vendor chunk grew.
7. **Move type checking to its own step.** Vite strips types without checking them, so add `tsc --noEmit` to CI and run it in the editor.

**Result:** dev server start drops from 45 seconds to under a second, HMR from seconds to tens of milliseconds, and the production build gets faster too, while the shipped bundles stay about the same size.

## Pitfalls

- **Assuming fast builds mean small bundles.** Build speed and output size are separate problems. A fast tool can still ship a 2 MB vendor chunk.
- **Forgetting type checking.** esbuild, SWC and Vite strip types without checking them. Without a separate `tsc` step, type errors reach production.
- **Breaking tree shaking.** CommonJS dependencies, barrel files (`index.ts` that re-exports everything), and modules with top-level side effects can pull in far more code than you use.
- **Dev and production differences.** In Vite's older setup, dev used esbuild and native ESM while production used Rollup, so a bug could appear in only one. Always test the production build (`vite preview`) before release.
- **Too many unbundled modules in dev.** A page importing thousands of source files causes a slow cold load. Avoid huge barrel files, and use Vite's warm-up option for hot paths.
- **Slow plugins.** One JavaScript plugin that runs a regex over every file can erase much of a Rust bundler's advantage. Profile plugins and narrow their `include` filters.

> [!TIP]
> When a build is slow, profile before switching tools. Vite has `--profile` and `--debug`, webpack has `--profile` with a stats file, and Rolldown and esbuild print timings. Very often one plugin, one huge dependency or type checking in the hot path accounts for most of the time.

## Discussion questions

1. Why does tree shaking work well with ES modules but poorly with CommonJS?
2. Vite's dev server startup doesn't depend much on app size. What does still grow with app size, and when does it start to hurt?
3. esbuild doesn't type-check TypeScript. Why is that a reasonable design choice, and how should a project compensate?
4. Why does Vite pre-bundle dependencies but not your own source files?
5. If browsers support ES modules natively, why bundle for production at all?
6. What makes plugin compatibility hard for a bundler written in Rust?

## FAQ

### Is Vite a bundler?

Vite is a build tool that wraps bundlers. In development it's mostly a fast file server and transformer that doesn't bundle your code. For production it hands off to a real bundler, which is now Rolldown.

### Should I still use webpack?

If you have a large, working webpack setup with custom loaders, there's no urgent need to rewrite it. Rspack offers a mostly drop-in faster path. For new projects, Vite or a framework's built-in tooling (like Next.js with Turbopack) is the common default.

### Why not skip bundling in production too, with HTTP/2?

HTTP/2 makes many requests cheaper, but not free. The browser only discovers nested imports after downloading each parent, which creates round-trip waterfalls, and unbundled code misses cross-module minification and tree shaking. Bundling into a sensible number of chunks is still faster for most apps.

### What is the difference between a transpiler and a bundler?

A transpiler (Babel, SWC, the TypeScript compiler, esbuild's transform mode) converts one file at a time, such as TypeScript into JavaScript. A bundler understands the whole module graph: it resolves imports, links modules together, removes unused code and splits output into chunks. Bundlers usually include or call a transpiler.

### Does a faster bundler make my site faster for users?

Not directly. Users only see what's shipped: bundle size, chunking and caching. Faster tools help indirectly, because short feedback loops make it practical to measure and optimize more often.

## Key takeaways

- Bundlers resolve, parse, transform, link, chunk and minify. Tree shaking and code splitting happen in the link and chunk steps.
- esbuild's speed comes from native code, parallelism, few AST passes and a single shared data format, not a magic algorithm.
- Vite skips bundling in development: dependencies are pre-bundled once, and source files are transformed only when the browser requests them.
- HMR in Vite updates one module up to its boundary, so it stays fast as the app grows.
- Production builds are still bundled, and the Rust tools (Rolldown, Rspack, Turbopack, SWC, Oxc) now power most of the ecosystem.
- Build speed and bundle size are separate problems. Measure both.

## References

- esbuild: [FAQ, "Why is esbuild fast?"](https://esbuild.github.io/faq/#why-is-esbuild-fast)
- Vite docs: [Why Vite](https://vite.dev/guide/why)
- Vite docs: [Dependency pre-bundling](https://vite.dev/guide/dep-pre-bundling)
- Vite docs: [Features (HMR, import.meta.glob)](https://vite.dev/guide/features)
- Rolldown: [rolldown.rs](https://rolldown.rs/)
- Rspack: [rspack.rs](https://rspack.rs/)
- MDN: [JavaScript modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
- MDN: [Tree shaking](https://developer.mozilla.org/en-US/docs/Glossary/Tree_shaking)
- webpack docs: [Tree Shaking and sideEffects](https://webpack.js.org/guides/tree-shaking/)

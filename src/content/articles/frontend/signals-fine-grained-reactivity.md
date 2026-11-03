---
summary: How signals track exactly which code depends on which state, so an update touches only the DOM nodes that need it. Covers signals, computeds and effects, automatic dependency tracking, push-pull propagation and glitch-freedom, how Solid, Vue, Preact, Angular and Svelte use them, and how this differs from virtual DOM re-rendering.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **signal** is a value that knows who reads it. Fine-grained reactivity is built from three primitives:
>
> - **signals** hold state (`count`);
> - **computeds** derive values from other signals and cache the result (`isEven = count % 2 === 0`);
> - **effects** run side effects, such as updating one DOM text node, whenever what they read changes.
>
> Reading a signal inside a computed or effect **subscribes automatically**, so the framework builds a dependency graph at runtime. When a signal changes, only its dependents re-run. There's no component re-render and no tree diff: the work is proportional to **what depends on the change**, not to the size of the component tree. Modern implementations use **push-pull** propagation: a write marks dependents stale, and values are recomputed lazily, once each, so no one sees an inconsistent "glitch" state.

## The problem: re-rendering to find one change

In a virtual DOM framework, a state change re-runs the component that owns the state and, by default, all of its children. Each produces a new element tree, the framework diffs it against the previous one, and finally patches the few DOM nodes that actually changed. For a counter in the corner of a large page, that's a lot of work to find one text node.

Developers fight this with memoization (`memo`, `useMemo`, `useCallback`), splitting components, and moving state down the tree. It works, but the default is "redo everything and compare", and keeping it fast is manual.

Fine-grained reactivity flips the default. Instead of re-running code to discover what changed, the system **records which code read which state**, and when state changes it runs exactly that code.

## How it works

### Signals, computeds and effects

![Dependency graph from signals through computed values to DOM effects, with only the path from a changed signal highlighted](/figures/signals-reactivity/graph.svg "Each node knows its subscribers, so a change follows only its own edges.")

The three primitives, in a framework-neutral form:

```js
const count = signal(0);
const isEven = computed(() => count.value % 2 === 0);
effect(() => { badge.className = isEven.value ? 'even' : 'odd'; });

count.value = 3; // re-runs isEven, then the badge effect. Nothing else.
```

- A **signal** is a box with a getter and a setter. Setting it to an equal value (by `Object.is`, or a custom comparator) does nothing.
- A **computed** (also called a memo or derived signal) is a cached function of other signals. It's both a subscriber (of its inputs) and a source (for its own readers). It only recomputes when an input actually changed.
- An **effect** is a leaf subscriber that does something outside the graph: writes to the DOM, logs, calls `fetch`, or syncs to `localStorage`.

### Automatic dependency tracking

There's no dependency array. The runtime keeps a global "currently running observer". When an effect or computed runs, it sets itself as that observer; every signal read during the run adds the observer to the signal's subscriber list (and the signal to the observer's source list). When the run ends, the observer is restored.

Dependencies are **re-collected on every run**. If an effect reads `a` in one branch and `b` in another, it's only subscribed to the branch it took last time:

```js
effect(() => console.log(showDetails.value ? details.value : summary.value));
```

While `showDetails` is false, changes to `details` don't trigger the effect at all. Implementations clean up stale subscriptions after each run, often with versioned links to avoid reallocating lists.

Reads outside a tracking context, like an event handler, don't subscribe. Most libraries also offer `untrack()` (or `peek()`) to read a signal inside an effect without depending on it.

### Push-pull propagation and glitches

![Diamond dependency graph showing push-pull propagation: a write marks nodes stale and reads recompute each once, avoiding glitches](/figures/signals-reactivity/pushpull.svg "Marking is eager; computing is lazy and happens once per node.")

Consider a diamond: `b` and `c` both depend on `a`, and `d` depends on both. With naive **push** propagation, setting `a` recomputes `b`, which immediately recomputes `d` with the new `b` and the **old** `c`. For a moment `d` holds a value that never should have existed, a **glitch**, and an effect might even render it.

Modern libraries (Preact Signals, Solid 2, Angular, Vue 3.4+, and the TC39 proposal's polyfill) use **push-pull**:

1. **Push (mark).** A write walks the subscribers and marks them stale (or "maybe stale" for indirect ones), without computing anything. Effects are queued.
2. **Pull (compute).** When something reads a computed, or a queued effect runs, the computed checks whether its sources changed and recomputes if needed, recursively, in dependency order.

Each node recomputes at most once per change, always from consistent inputs, and computeds nobody reads are never computed at all.

**Batching** groups writes: inside `batch(() => { a.value = 1; b.value = 2; })`, effects run once at the end. Most frameworks also defer effects to a microtask or to the next render, so several synchronous writes in an event handler cause one DOM update.

### Components run once

![Comparison of a virtual DOM component re-render, which re-runs and diffs a whole subtree, with a signal update that runs only its subscribed effect](/figures/signals-reactivity/compare.svg "Both produce the same DOM write; the difference is how much code runs to find it.")

In a fully signal-based framework like Solid, a **component function runs once**, at creation. Its JSX compiles to real DOM creation plus a small effect for each dynamic expression:

```jsx
function Counter() {
  const [count, setCount] = createSignal(0);
  return <button onClick={() => setCount(count() + 1)}>Clicked {count()} times</button>;
}
// compiles to roughly: create <button>, then
// effect(() => textNode.data = count())
```

Updates never re-enter `Counter`. That changes the mental model: you can't destructure props (that reads them once, outside any tracking context), and early `return`s based on state don't re-run. You use control-flow components (`<Show>`, `<For>`) instead.

Other frameworks mix approaches:

- **Vue** uses reactive proxies and refs (signals) for state, but components still render through a virtual DOM. Reactivity decides **which components** re-render; the VDOM diff runs only inside them. Vue's "Vapor mode" compiles templates to direct DOM effects, like Solid.
- **Angular** signals (v16+) feed its change detection, letting it check only components whose signals changed instead of the whole tree.
- **Svelte 5** runes (`$state`, `$derived`, `$effect`) are signals behind compiler syntax; the compiler emits fine-grained DOM updates.
- **Preact Signals** can bind a signal straight into JSX text, bypassing the component re-render entirely.

### Lists and ownership

Two practical pieces make signals usable at scale:

- **Keyed list reconciliation still exists.** When an array signal changes, something has to map old items to new ones. `<For>` (Solid) or keyed `each` blocks (Svelte) diff the array by reference or key, create new rows, and move or dispose of others. Only the list is diffed, not the tree.
- **Ownership and disposal.** Effects created inside a component belong to an **owner** (the component's reactive scope). When the component is removed, its owner disposes of all its effects and computeds, removing them from their sources' subscriber lists. Without that, a removed component's effects would keep running forever.

## Where it's used

| Library / framework | Signal API | Rendering |
|---|---|---|
| SolidJS | `createSignal`, `createMemo`, `createEffect` | components run once; compiled DOM effects |
| Preact Signals | `signal`, `computed`, `effect` | also works in React via an adapter |
| Vue 3 | `ref`, `reactive`, `computed`, `watchEffect` | VDOM per component; Vapor mode compiles to DOM effects |
| Angular 16+ | `signal`, `computed`, `effect` | signal-driven, zoneless change detection |
| Svelte 5 | `$state`, `$derived`, `$effect` runes | compiler emits fine-grained updates |
| Qwik | `useSignal`, `useComputed$` | resumable; signals serialized with the HTML |
| MobX, Knockout | observables, computeds, reactions | earlier generations of the same idea |
| TC39 Signals proposal | `Signal.State`, `Signal.Computed`, watchers | stage 1 proposal for a shared standard core |

## Use case walk-through: a live trading dashboard

A dashboard shows 500 instruments in a grid, a portfolio total and a few charts. Prices arrive over a WebSocket at around 200 updates per second. In the current VDOM implementation, each tick updates a big state object, the grid re-renders, and the page drops frames.

1. **Model each price as a signal.** Store one signal per instrument (`prices.get(id)`), not one large object. A tick for AAPL writes to the AAPL signal only.
2. **Bind cells directly.** Each price cell reads its signal in its own effect. A tick updates one text node and one class name (up or down colour). The other 499 rows don't run any code.
3. **Derive totals with computeds.** `portfolioValue = computed(() => sum of position × price)` depends on the held instruments only. Ticks for instruments not in the portfolio never trigger it.
4. **Batch per frame.** Writes from WebSocket messages are collected and applied inside one `batch` per animation frame, so the total recomputes at most once per frame, not 200 times a second.
5. **Dispose of rows.** When a user filters the grid, rows that leave dispose of their effects through their owner scope. Memory stays flat during a long session.
6. **Result.** Scripting time per frame drops from about 30 ms to under 2 ms, and the grid stays at 60 fps during market open.

## Pitfalls

- **Reading outside a tracking context.** Reading `count.value` once at the top of a Solid component, or destructuring props, captures a value instead of a subscription. The UI never updates. Read signals inside JSX, computeds or effects.
- **Effects that write signals.** Using an effect to keep one signal in sync with another creates extra update cycles, and can loop. Use a computed for derived state.
- **Mutating objects inside a signal.** `list.value.push(x)` doesn't change the signal's identity, so nothing is notified. Assign a new array, or use a deeply reactive store or proxy.
- **Too many tiny signals, or one huge one.** One signal per field of every object costs memory; one signal for the whole app state brings back coarse updates. Match granularity to how data changes.
- **Leaking effects.** Effects created outside an owner (in a module, a timer callback) are never disposed of. Create them in a root or component scope, or keep the dispose function.
- **Debugging "magic".** Implicit subscriptions make "why did this run?" harder to answer. Use the framework's devtools or graph-inspection helpers.

> [!TIP]
> When a value can be computed from other state, make it a computed, never an effect that sets another signal. Computeds are lazy, cached, glitch-free and automatically cleaned up; effect-based syncing is none of those things. Reserve effects for talking to the world outside the graph.

## Discussion questions

1. How does a signal know which computeds and effects read it, without a dependency array?
2. What's a glitch in a reactive system, and how does push-pull propagation prevent it in a diamond-shaped graph?
3. Why does a Solid component run only once, and what coding habits from React break because of that?
4. Vue uses reactivity and a virtual DOM together. What does each part do, and what does Vapor mode change?
5. When might coarse re-rendering with memoization be simpler or just as fast as fine-grained signals?
6. What would a standard `Signal` primitive in JavaScript enable for libraries and frameworks?

## FAQ

### Are signals the same as observables (RxJS)?

They're related, but different. An observable is a stream of events over time, with operators for timing and composition, and subscribers receive every emission. A signal always has a **current value**, reads are synchronous, and intermediate values can be skipped. Signals are a good fit for UI state; observables for event streams like WebSocket messages or debounced input.

### Do signals make React obsolete?

No. React's model (re-render and reconcile) is simpler to reason about and has a huge ecosystem, and the React Compiler removes much of the manual memoization. Signals win most clearly on very frequent, very local updates. React has chosen not to adopt signals in its core API; libraries like Preact Signals and Jotai offer signal-like patterns inside React.

### Are computeds evaluated eagerly?

In push-pull libraries, no. A write marks a computed stale, but it only recomputes when something reads it. A computed with no readers is never evaluated, and one that is read several times between changes computes once.

### How do effects avoid running in the middle of a batch?

Writes mark subscribers and queue effects instead of running them. The queue is flushed when the outermost batch ends, or at a scheduled point such as a microtask or the next frame. By then every write has happened, so each effect sees the final state.

### What is the TC39 Signals proposal?

A stage 1 proposal to add `Signal.State` and `Signal.Computed`, plus a low-level watcher API, to JavaScript. It standardizes the graph and push-pull algorithm, not effects or rendering, which stay with frameworks. The aim is interoperability: a signal from one library could be read inside another's computed.

## Key takeaways

- Signals, computeds and effects form a dependency graph that's built automatically from what each function reads.
- An update re-runs only dependents of the changed signal, so the cost tracks the change, not the tree.
- Push-pull propagation marks eagerly and computes lazily, so each node updates once and never sees inconsistent inputs.
- Derive with computeds; keep effects for side effects outside the graph.
- In run-once component models, read signals inside tracked scopes, and rely on owners to dispose of effects.

## References

- SolidJS documentation: [Fine-grained reactivity](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity)
- Preact documentation: [Signals](https://preactjs.com/guide/v10/signals/)
- Vue documentation: [Reactivity in depth](https://vuejs.org/guide/extras/reactivity-in-depth.html)
- Angular documentation: [Signals](https://angular.dev/guide/signals)
- Svelte documentation: [$state](https://svelte.dev/docs/svelte/$state) and [$derived](https://svelte.dev/docs/svelte/$derived)
- TC39 proposal: "JavaScript Signals standard proposal" (tc39/proposal-signals on GitHub)
- Ryan Carniato, "A Hands-on Introduction to Fine-Grained Reactivity" (dev.to, 2021)
- Milo Spencer-Harper et al., "Reactively" and the push-pull "coloring" algorithm write-ups (Modderme, "Super Charging Fine-Grained Reactive Performance", 2022)

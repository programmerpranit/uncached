---
summary: Why single-page apps leak memory when traditional pages don't, and how to find and fix it. Covers garbage collection and reachability, the usual suspects (listeners, timers, subscriptions, detached DOM, unbounded caches, closures), framework cleanup in React, Vue and others, using heap snapshots and allocation timelines to find the retainer, and guarding against regressions.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** JavaScript is garbage-collected: the engine frees any object that can no longer be **reached** from a root such as `window`, the call stack or a live timer. A **memory leak** is memory you no longer need but that is *still reachable*, usually through a forgotten event listener, timer, subscription, cache or closure.
>
> Classic multi-page sites hide leaks because every navigation throws the whole page away. A **single-page app** (SPA) never reloads, so small leaks pile up over hours until the tab slows down or crashes. The fix is disciplined **cleanup** (every subscribe has an unsubscribe) plus **heap snapshots** to find what's retaining memory.

## The problem: SPAs never get a fresh start

On a traditional website, clicking a link loads a new document. The browser discards the old page's JavaScript heap, DOM and listeners. Whatever you forgot to clean up disappears within seconds.

An SPA swaps views in place. The same JavaScript heap lives for as long as the tab is open, which for dashboards, email clients, chat apps and admin tools can be days. Every view that leaves a little memory behind adds to a pile that never shrinks.

![Heap size over repeated navigations: the healthy line returns to the same floor after each garbage collection, the leaking line's floor rises every time](/figures/spa-memory-leaks/growth.svg "A sawtooth is normal. A sawtooth whose floor keeps rising is a leak.")

The symptoms build slowly, which makes them hard to connect to a cause:

- Interactions get sluggish because garbage collection runs more often and takes longer.
- Event handlers fire several times, because old copies were never removed.
- The tab's memory in the browser's task manager climbs into gigabytes.
- On low-end phones, the browser kills the tab and reloads it ("Aw, Snap!" or a silent reload).

## How it works

### Reachability: how garbage collection decides

Modern engines like V8 (Chrome, Node), SpiderMonkey (Firefox) and JavaScriptCore (Safari) use **tracing garbage collection**. Periodically they start from a set of **roots**: global objects, the current call stacks, active timers and callbacks the browser holds for pending events. They mark everything reachable by following references. Whatever isn't marked is garbage and gets freed.

So the engine doesn't free what you're *done with*; it frees what nothing *points to*. A leak is always a chain of references from a root to something you meant to throw away. Heap tools call that chain the **retainer path**.

![A window root holds an event listener and an interval timer, which reference a closure that keeps an unmounted component, detached DOM and fetched data alive](/figures/spa-memory-leaks/roots.svg "One forgotten listener or timer can keep a whole screen's worth of objects reachable.")

### The usual suspects

**Global event listeners.** A component adds `window.addEventListener('resize', onResize)` when it mounts and never removes it. The browser keeps `onResize` alive, `onResize`'s closure keeps the component's state alive, and the component's state may reference DOM nodes and data.

**Timers.** `setInterval` callbacks run forever until cleared. Each one holds its closure. A polling timer started per view, never cleared, means ten timers after ten visits, all polling.

**Subscriptions.** WebSockets, `EventEmitter`s, RxJS observables, store subscriptions, `BroadcastChannel`, `IntersectionObserver`, `ResizeObserver` and `MutationObserver` all hold callbacks until you unsubscribe or disconnect.

**Detached DOM.** An element removed from the page is garbage only if no JavaScript still references it. A module-level `let lastRow = document.querySelector(...)`, a cache of elements, or a third-party library holding a node keeps the node *and its entire subtree* alive. Heap snapshots label these **detached** nodes.

**Unbounded caches and collections.** A `Map` used as a memo cache, an array of logs or analytics events, or a client-side data cache with no eviction grows forever. This isn't a bug in the usual sense, but the effect is identical.

**Closures that capture too much.** A small callback defined inside a large function can keep that function's big variables alive if the engine shares the closure scope between callbacks.

**Pending async work.** A `fetch` or promise that resolves after a component unmounts runs its callback anyway. That's usually a short-lived retention, not a permanent leak, but a stuck request or a never-settled promise can hold memory indefinitely.

### Cleanup is part of the component lifecycle

Every framework gives you a place to undo what you set up:

- **React:** return a cleanup function from `useEffect`. Use an `AbortController` to cancel fetches.
- **Vue:** `onUnmounted` (or `onBeforeUnmount`), and `watch` stop handles.
- **Angular:** `ngOnDestroy`, the `takeUntilDestroyed` operator and `DestroyRef`.
- **Svelte:** functions returned from `onMount`, or `onDestroy`.
- **Vanilla JS:** the `{ signal }` option on `addEventListener` lets one `controller.abort()` remove many listeners at once.

```js
useEffect(() => {
  const ac = new AbortController();
  window.addEventListener('resize', onResize, { signal: ac.signal });
  fetch(url, { signal: ac.signal }).then(setData).catch(() => {});
  const id = setInterval(poll, 5000);
  return () => { ac.abort(); clearInterval(id); };
}, [url]);
```

The rule is symmetry: everything that starts in setup ends in cleanup.

### Weak references

`WeakMap` and `WeakSet` hold keys **weakly**: an entry doesn't keep its key alive. They're perfect for attaching metadata to objects you don't own, such as DOM nodes, because when the node goes away, so does the entry. `WeakRef` and `FinalizationRegistry` exist for advanced caches, but garbage collection timing is unpredictable, so don't build program logic on them.

## Finding a leak

Guessing is slow. The reliable method uses the Memory panel in Chrome or Edge DevTools (Firefox and Safari have equivalents).

![Five steps: take a baseline snapshot, repeat the suspect action several times, take a second snapshot and compare, follow the retainer path of a leaked object, then remove the reference](/figures/spa-memory-leaks/find.svg "Repeat the action N times and look for things that grew by N.")

1. **Get a baseline.** Load the app and do the action once to warm caches and lazy-loaded code. Click the trash-can icon to force garbage collection, then take a heap snapshot.
2. **Repeat the suspect action.** Open and close the modal, or navigate to the page and back, five to ten times.
3. **Compare.** Force GC again, take a second snapshot and switch to the **Comparison** view. Sort by "# Delta". Things that grew by exactly your repetition count (say, 10 more `ProductPage` instances or 10 more listeners) are your leaks. Search for "Detached" to find orphaned DOM.
4. **Follow the retainers.** Select a leaked object and read the **Retainers** pane from bottom to top. It shows the chain back to a root, such as `Window → listeners → onResize → closure → ProductPage`.
5. **Fix and verify.** Remove the reference, then repeat the test and confirm the delta is zero.

Other useful tools are the **Allocation instrumentation on timeline** recording, which shows blue bars for memory still alive at the end, the Performance panel's memory checkbox, and `performance.measureUserAgentSpecificMemory()` for measuring memory in production on cross-origin isolated pages.

## Where it's used

| Context | Why leaks matter there |
|---|---|
| Gmail, Slack, Outlook web | Tabs stay open for days; small leaks become gigabytes |
| Trading and monitoring dashboards | Constant live updates through WebSockets and timers |
| Maps and data visualization | Large buffers, canvas and WebGL resources per view |
| Electron apps (VS Code, Discord) | Desktop apps are long-lived web pages |
| Smart TV and kiosk apps | Weak hardware, never reloaded, crash under pressure |
| Microsoft's MemLab, Meta's leak tooling | Automated leak detection in CI for large SPAs |

## Use case walk-through: the dashboard that slows down by lunchtime

Support agents keep an internal dashboard open all day. By the afternoon it's sluggish, and some agents see duplicate notifications.

1. **Reproduce.** Checking Chrome's task manager shows the tab at 1.8 GB after a few hours. Switching between the Tickets and Customer views ten times adds about 40 MB.
2. **Snapshot and compare.** The Comparison view shows 10 extra `CustomerView` components, around 30,000 detached `HTMLDivElement`s and 10 extra WebSocket message handlers.
3. **Read retainers.** The detached divs are retained by a closure inside `socket.on('message', handler)`. The handler was added in an effect with no cleanup, so every visit adds one more.
4. **Fix the subscription.** The effect now returns `() => socket.off('message', handler)`. That also fixes the duplicate notifications, since only one handler remains.
5. **Fix the cache.** A memoization map for customer avatars has no limit. It becomes a small LRU cache with a maximum of 200 entries.
6. **Prevent regressions.** The team adds a MemLab scenario in CI that navigates between views 20 times and fails if retained `CustomerView` objects grow.

**Result:** memory now stays flat at about 180 MB all day, and duplicate notifications are gone.

## Pitfalls

- **Testing only once.** A single open-and-close looks fine; leaks appear only when you repeat the action and compare.
- **Forgetting to force GC.** Without it, snapshots include garbage that just hasn't been collected yet, which looks like a leak.
- **Blaming the framework.** Framework leaks happen, but most come from app code or third-party widgets (charts, maps, editors) that need an explicit `destroy()`.
- **DevTools itself.** `console.log`ging an object keeps it alive while the console is open. Close DevTools or clear the console before measuring.
- **Ignoring "intended" growth.** Infinite scroll lists, logs and caches are leaks in practice if they never evict. Virtualize lists and bound caches.
- **Treating `WeakRef` as a fix.** It hides the problem and makes behavior depend on GC timing.

> [!TIP]
> Make cleanup automatic. Prefer `addEventListener(..., { signal })`, libraries whose hooks unsubscribe on unmount, and lint rules such as `react-hooks/exhaustive-deps` that make missing cleanup more visible in review.

## Discussion questions

1. Why don't memory leaks matter as much on a traditional multi-page site?
2. What's the difference between memory that's *in use* and memory that's *reachable*, and why does garbage collection only know about the second?
3. A component's fetch resolves after unmount and calls `setState`. Is that a memory leak? When could it become one?
4. How would you design a client-side cache that can't grow without bound?
5. When is a `WeakMap` the right tool, and when is it hiding a design problem?
6. How would you catch memory regressions automatically before they reach production?

## FAQ

### Can JavaScript even leak memory if it has a garbage collector?

Yes. Garbage collection frees only *unreachable* objects. If your code keeps a reference by accident, the collector has to assume you still need it. Most JavaScript leaks are logical leaks like this, not low-level ones.

### How much memory growth is normal?

Some growth is expected: caches warm up, code is lazy-loaded and the engine optimizes. What matters is the trend after garbage collection. If repeating the same action keeps raising the post-GC floor, that's a leak, however small.

### Do frameworks prevent leaks?

They remove listeners and DOM they created themselves when a component unmounts. They can't know about listeners you added to `window`, timers, sockets or third-party widgets. That cleanup is your job.

### What's a detached DOM node?

An element that has been removed from the document but is still referenced by JavaScript, so it can't be freed. Because a node references its children and parent, one detached node can keep an entire subtree alive.

### Can I measure memory in production?

Partially. `performance.measureUserAgentSpecificMemory()` reports memory for cross-origin isolated pages in Chromium browsers. The older `performance.memory` is non-standard and imprecise. Many teams instead track session length against crash and reload rates, plus synthetic leak tests in CI.

## Key takeaways

- Garbage collection frees unreachable objects; a leak is unwanted memory that's still reachable.
- SPAs leak visibly because the heap lives as long as the tab.
- The usual causes are listeners, timers, subscriptions, detached DOM, unbounded caches and closures.
- Pair every setup with a cleanup, and use `AbortController` signals to make it easy.
- Find leaks by repeating an action, comparing heap snapshots and reading the retainer path.

## References

- Chrome DevTools: [Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems)
- Chrome DevTools: [Record heap snapshots](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots)
- MDN: [Memory management](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Memory_management)
- MDN: [WeakRef](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakRef)
- React docs: [Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)
- MemLab on GitHub: [facebook/memlab](https://github.com/facebook/memlab)
- web.dev: [Monitor your web page's total memory usage with measureUserAgentSpecificMemory()](https://web.dev/articles/monitor-total-page-memory-usage)

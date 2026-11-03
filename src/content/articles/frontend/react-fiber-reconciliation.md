---
summary: How React decides what to change in the DOM and when to change it. Covers the fiber data structure, the work loop, double buffering, the render and commit phases, the reconciliation heuristics behind keys, and how lanes let urgent updates interrupt slow renders.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** **Reconciliation** is how React works out what changed between two UI trees. **Fiber** is the engine that does that work since React 16. Each component instance is backed by a **fiber**, a plain object linked to others through **child**, **sibling** and **return** pointers. React walks these links in a loop, not by recursion, so it can **pause after any fiber**, give the browser a turn, and resume. Work happens in two phases:
>
> - **Render** calls components and diffs their output. It has no side effects, so it can be sliced, abandoned, restarted or run twice.
> - **Commit** applies the result to the DOM in one synchronous pass, so users never see a half-updated screen.
>
> The diff is O(n) because of two assumptions: elements of a **different type** produce different trees (so React remounts), and **keys** identify siblings across renders. Updates carry a priority **lane**: a click can interrupt a slow transition render, which is then restarted with the new state.

## The problem: one thread, big trees

The browser has one main thread for JavaScript, layout, paint and input. Before Fiber, React's reconciler (the "stack reconciler") recursed through the component tree in a single call. A large update could hold the thread for 100 ms or more, and typing or animations stuttered for the whole time. Recursion can't stop halfway, because the state of the work lives on the JavaScript call stack.

React needed a way to **split rendering into units**, to **prioritise** some updates over others, and to **throw away** work that became stale. All three require that the in-progress state live in data structures React controls, not in the call stack. That is what a fiber is: a heap-allocated stack frame for one component.

## How it works

### The fiber tree

![Fiber tree with child, sibling and return pointers, and the current and workInProgress trees linked by alternate pointers](/figures/react-fiber/fiber-tree.svg "A fiber tree is walked as a linked list, so the walk can stop anywhere.")

A fiber holds:

- **type and key**: which component or host element (`'div'`) this is, and its identity among siblings.
- **pendingProps / memoizedProps / memoizedState**: the inputs for this render and what was used last time. For function components, `memoizedState` is the linked list of hooks.
- **child, sibling, return**: the tree, as a linked list.
- **flags and subtreeFlags**: what the commit phase needs to do here (placement, update, deletion, effects).
- **lanes and childLanes**: which pending updates apply to this fiber or below it, so untouched subtrees can be skipped.
- **alternate**: the matching fiber in the other tree.

The **work loop** runs `performUnitOfWork` on one fiber at a time:

1. **beginWork**: render the component (call the function, or `render()`), then reconcile its returned children against the existing child fibers. Move to the first child.
2. With no child, **completeWork**: for host elements, create or prepare the DOM node and bubble flags up. Then move to the sibling, or back up via `return`.

In concurrent mode the loop checks `shouldYield()` between units. When roughly 5 ms have passed, it stops and schedules a continuation (via a `MessageChannel` task), so input and paint can run.

### Double buffering

React keeps two trees. **current** reflects what's on screen. **workInProgress** is being built for the next frame. Each fiber's `alternate` points at its counterpart, so React reuses objects instead of allocating a new tree every render. When the workInProgress tree is complete, commit points the root at it. That single pointer swap makes it current, and the old tree becomes the scratch space for next time.

If an update is interrupted, the half-built workInProgress tree is simply discarded. Nothing on screen depended on it.

### Render phase and commit phase

![Timeline of the main thread with render work split into slices around user input, followed by a synchronous commit and paint](/figures/react-fiber/render-commit.svg "Render is sliced and interruptible; commit is a single atomic pass.")

The **render phase** must be pure. Components may be called more than once for one visible update: after an interruption, after a Suspense retry, or deliberately by StrictMode in development. That's why side effects belong in `useEffect`, not in the component body.

The **commit phase** runs in three sub-phases:

- **before mutation**: read the DOM before it changes (`getSnapshotBeforeUpdate`).
- **mutation**: insert, update and remove DOM nodes; detach old refs.
- **layout**: attach refs, run `useLayoutEffect` and `componentDidMount/Update`. They run synchronously, before the browser paints.

`useEffect` callbacks are scheduled to run after paint (they are flushed synchronously first if another update arrives).

### Reconciliation heuristics

![Four reconciliation cases: same element type updates, different type remounts, unkeyed lists match by index, keyed lists match by key](/figures/react-fiber/heuristics.svg "Type and key are how React decides whether a fiber is 'the same thing' as last time.")

The minimum edit distance between two arbitrary trees is O(n³), far too slow for every keystroke. React uses two rules instead:

- **Different type, different tree.** If `<Profile>` becomes `<Settings>`, or `<div>` becomes `<section>`, React unmounts the whole old subtree, including its state and DOM, and mounts the new one. It doesn't try to salvage matching children.
- **Keys identify siblings.** In a list, React matches old and new children by `key`, falling back to index. With stable keys, inserting at the top is one insertion. With index keys, every row is "updated" with its neighbour's data, and any local state (input text, focus, animations) stays attached to the wrong row.

For arrays, `reconcileChildrenArray` first walks both lists in order while keys match (the common append and update case), then puts the remaining old children in a map by key for the moves. React doesn't compute a minimal move set. It marks the fibers that need to move and leaves the rest.

A useful consequence: **changing a key is a reset button**. `<Form key={userId} />` remounts the form with fresh state when the user changes, with no effect-based syncing needed.

### Lanes and priorities

![Lane priorities from SyncLane for clicks down to IdleLane, showing that urgent updates interrupt transition renders](/figures/react-fiber/lanes.svg "Lanes are bit flags, so React can batch, merge and select priorities with bitwise operations.")

Every update is assigned a **lane**, a bit in a 31-bit mask. Discrete events such as clicks get `SyncLane`, updates in `startTransition` get one of the `TransitionLanes`, and so on. Fibers record pending lanes, so React can:

- Pick the highest-priority lanes and render just those updates.
- **Interrupt** a transition render when an urgent update arrives, commit the urgent one, then restart the transition.
- **Batch** all updates in the same lane into one render (automatic batching in React 18+).
- Skip subtrees whose `childLanes` don't include the lanes being rendered (a "bailout").

Higher-level features build on this. `useTransition` and `useDeferredValue` mark work as interruptible, and Suspense can show a previous screen while a transition waits for data.

## Where it's used

| Feature | What Fiber makes possible |
|---|---|
| Concurrent rendering (`createRoot`) | time-sliced, interruptible renders |
| `startTransition`, `useDeferredValue` | low-priority lanes that urgent input can interrupt |
| Suspense | a render can "throw" a pending promise; React shows a fallback and retries later |
| Error boundaries | a throw during render unwinds to the nearest boundary fiber via `return` pointers |
| Hooks | per-fiber linked list of hook state in `memoizedState` |
| React Native, react-three-fiber, Ink | the same reconciler with a different host config (native views, a WebGL scene, a terminal) |
| React DevTools Profiler | reads per-fiber render durations from the tree |

## Use case walk-through: a laggy search box

A product list filters 5,000 rows as the user types. Each keystroke re-renders the list, taking about 80 ms, and typing feels sticky.

1. **Profile.** The DevTools Profiler shows every keystroke commits the input *and* the list in one sync-lane render.
2. **Split the priorities.** Keep the input controlled by urgent state (`query`), and derive the list from `useDeferredValue(query)`. The input now commits in its own fast render; the list re-renders in a transition lane.
3. **Let it be interrupted.** While the list renders, a new keystroke arrives. React yields at the next unit boundary, commits the input, discards the stale list work, and starts again with the newest query. Intermediate queries are never rendered.
4. **Avoid wasted work.** Wrap the row component in `memo` and give rows stable `key={product.id}`, so a filter that keeps a row just moves its fiber instead of rebuilding it.
5. **Result.** Input latency drops to a few ms. The list updates a moment later, showing the old results until the new ones are ready (`isPending` can dim them).

Fiber doesn't make the 80 ms of work cheaper. It makes that work **interruptible and lower priority**, which is what the user actually feels. For lists this size, virtualization is the complementary fix.

## Pitfalls

- **Side effects in render.** Mutating refs, subscribing or logging in the component body breaks when React renders twice or abandons a render. Use effects.
- **Index keys on dynamic lists.** Inserting or sorting attaches state and DOM to the wrong items. Use a stable ID from the data.
- **Random keys** (`key={Math.random()}`). Every render remounts every row: lost state, lost focus and expensive DOM churn.
- **Defining components inside components.** `function Row() {}` inside a parent creates a new type each render, so React remounts the subtree every time.
- **Toggling wrappers.** Conditionally wrapping children (`cond ? <A><X/></A> : <X/>`) changes their position in the tree, so `X` loses its state.
- **Expecting transitions to speed up slow code.** They change scheduling, not cost. A single slow component still blocks while it runs, because React can only yield *between* fibers.

> [!TIP]
> When state is "sticking" to the wrong item or resetting unexpectedly, check identity first: is the element type stable across renders, is it in the same position, and is the key the same? Almost every reconciliation surprise is one of those three changing when you didn't expect it to.

## Discussion questions

1. Why couldn't the pre-Fiber stack reconciler be paused, and what data structure change made pausing possible?
2. What guarantees does the render phase give up so that it can be interrupted, and how does StrictMode test for code that relies on them?
3. Why does React remount a subtree when the element type changes, instead of trying to reuse matching children?
4. Walk through what happens to the DOM and to component state when you prepend an item to a list keyed by index, then by stable ID.
5. A click arrives halfway through a transition render. Describe what React does with the half-built workInProgress tree.
6. When would you deliberately change a component's key, and what's the alternative using effects?

## FAQ

### Is Fiber the same thing as the virtual DOM?

Not quite. "Virtual DOM" usually means the React elements your components return, which are lightweight descriptions recreated every render. Fibers are the long-lived instances that elements are reconciled against; they hold state, effects and the links to DOM nodes, and they persist (via double buffering) between renders.

### Does every React app use concurrent rendering?

Since React 18, `createRoot` enables the concurrent renderer, but updates are still synchronous by default unless they're in a transition or deferred value. Discrete input stays in the sync lane. Time slicing only kicks in for lower-priority lanes.

### Why does my component render twice in development?

StrictMode intentionally double-invokes component bodies, initialisers and reducers, and mounts, unmounts and remounts effects, to surface impure render logic and missing effect cleanups. It only happens in development builds.

### How small is a "unit of work"?

One fiber. React can only yield between fibers, so a single component that does 50 ms of synchronous computation still blocks for 50 ms. Split heavy work into smaller components, memoize it, or move it to a Web Worker.

### What does the React Compiler change about this?

It auto-memoizes components and values at build time, so fewer fibers need to re-render and more subtrees bail out. Reconciliation, phases and lanes work the same way; the compiler just reduces how much render work there is.

## Key takeaways

- A fiber is a heap-allocated unit of work per component, linked by child, sibling and return pointers, so rendering is a resumable loop.
- Render is pure and interruptible; commit is synchronous and atomic. Keep side effects out of render.
- Two trees (current and workInProgress) let React build the next UI off-screen and swap it in with one pointer.
- Element type and key define identity. Unstable types or keys mean remounts and lost state.
- Lanes let urgent updates interrupt transitions, but they reschedule work rather than make it cheaper.

## References

- React documentation: [Preserving and resetting state](https://react.dev/learn/preserving-and-resetting-state)
- React documentation: [Rendering lists: keeping list items in order with key](https://react.dev/learn/rendering-lists)
- React documentation: [useTransition](https://react.dev/reference/react/useTransition) and [useDeferredValue](https://react.dev/reference/react/useDeferredValue)
- React legacy documentation: [Reconciliation](https://legacy.reactjs.org/docs/reconciliation.html)
- Andrew Clark, "React Fiber Architecture" (acdlite/react-fiber-architecture on GitHub, 2016)
- React source: `packages/react-reconciler` in the facebook/react repository (ReactFiberWorkLoop, ReactChildFiber, ReactFiberLane)
- React team, "React v18.0" release post (2022)

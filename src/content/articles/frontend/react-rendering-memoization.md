---
summary: What actually triggers a React re-render, why memo so often fails silently, and when memo, useMemo and useCallback are worth their cost, plus the structural fixes and compiler that often make them unnecessary.
updated: 2026-11-02
---

> [!KEY]
> A component re-renders when its state changes, when its parent re-renders, or when a context it reads changes. Props changing is *not* the trigger. A parent rendering is. `memo` lets a child opt out when its props are equal by `Object.is`, and `useMemo` and `useCallback` exist mostly to keep those props referentially stable. Before reaching for any of them, move state down or pass slow subtrees as `children`. Measure with the Profiler first. With the React Compiler, most manual memoization goes away.

## The problem: "why did this render?"

Teams hit the same wall: typing in a search box feels laggy, a hover effect stutters, or the Profiler shows a 200-row table rendering on every keystroke. The usual reaction is to wrap everything in `memo`, `useMemo` and `useCallback`. Often that doesn't help at all, because one inline object or arrow function quietly defeats the memoization. Meanwhile every component now carries comparison costs and dependency arrays that can go stale.

To fix rendering problems you need an accurate model of three things:

- **What a render is:** calling your function and diffing the result. It is not touching the DOM.
- **What triggers one:** state, parent renders and context.
- **What each memo tool actually compares.**

## How it works

### Render vs commit

React works in two phases:

- **Render phase:** React calls your component functions to produce a new element tree. It then reconciles that tree against the previous one to work out what changed. This is pure JavaScript, with no DOM writes.
- **Commit phase:** React applies only the differences to the DOM, then runs layout effects and, later, effects.

So a "re-render" whose output is identical costs some CPU time for the function call and the diff, and touches nothing in the DOM. Most renders are cheap. They become a problem when:

- the subtree is large,
- a component does expensive work during render, such as sorting, filtering or formatting thousands of items, or
- renders happen at high frequency, such as on every keystroke, pointer move or animation frame.

### The three triggers

1. **Own state changes.** `setState` or a reducer dispatch with a new value. If the new value is `Object.is`-equal to the old one, React may bail out.
2. **Parent re-renders.** By default every child re-renders with its parent, *whether or not its props changed*. React doesn't compare props unless you ask it to.
3. **Context changes.** Every component that reads a context with `useContext` (or `use`) re-renders when the provider's `value` changes identity.

![Render cascade](/figures/react-render/cascade.svg "A setState in Page re-renders every descendant; only the memo-wrapped Footer, whose props are unchanged, is skipped.")

The common myth is "a component re-renders when its props change." It's backwards. A component re-renders because its parent rendered, and its props happen to be new objects at that point. `memo` is the switch that makes React check the props first.

### What memo, useMemo and useCallback do

- **`memo(Component)`** compares each prop with `Object.is` against the previous render's props. If every prop is equal, React reuses the last result and skips the subtree. A memoized component still re-renders on its own state or context changes.
- **`useMemo(fn, deps)`** caches the *return value* of `fn` until a dependency changes. It has two uses: skipping an expensive computation, and keeping an object or array reference stable.
- **`useCallback(fn, deps)`** is `useMemo(() => fn, deps)`. It caches the *function reference* so a memoized child or an effect dependency sees the same function.

### Why memo silently fails

![Referential identity](/figures/react-render/identity.svg "Primitives compare equal across renders; inline objects, closures and derived arrays are new references every time.")

`Object.is` compares primitives by value and objects by reference. Every render creates new values for:

- `style={{...}}`
- `onClick={() => ...}`
- `items={list.filter(...)}`
- `options={{ sort: 'asc' }}`
- JSX passed as a prop, such as `icon={<Star/>}`, which is a new element object

Any one of these fails the comparison. You then pay for the comparison *and* for the render. That's why `memo` without stable props is pure overhead, and why `useCallback` without a memoized consumer is also overhead: nothing ever compares the function.

### Cheaper fixes: change the shape of the tree

Before memoizing, look at where the state lives.

![Structural fixes](/figures/react-render/fixes.svg "Move hover state into a small component, or pass the slow subtree as children, so it is never re-rendered.")

- **Move state down.** If only the tooltip needs `hovered`, put that state in a small `HoverArea` component. Then the page, and the slow chart beside it, never re-render.
- **Lift content up (children as props).** If the state has to wrap the slow part, accept the slow part as `children`. The *parent* created those elements, so when the stateful wrapper re-renders, React receives the same element objects and skips them. There's nothing to memoize and no dependency arrays.
- **Split contexts.** Put fast-changing values, like the current cursor, in a different context from slow ones, like theme and user. Or memoize the provider `value` so consumers don't all re-render when the provider's parent does.

### Keys and identity of state

Keys tell React which child is which across renders:

- A **stable key** keeps a component's state and DOM when the list reorders.
- Using the array **index as the key** in a reorderable list attaches state to the wrong rows.
- A **changing key** deliberately throws state away. `key={userId}` resets a form when the user changes.

### The React Compiler

The React Compiler is a build-time Babel plugin, stable since late 2025. It analyses components and hooks and inserts fine-grained memoization automatically, caching JSX, derived values and callbacks per dependency. That covers what you'd otherwise do with `memo`, `useMemo` and `useCallback`, and it is often more granular than code written by hand.

It relies on your code following the Rules of React:

- pure render,
- no mutating props or state,
- hooks called unconditionally.

Components that break these rules are skipped. Where the compiler is enabled, the advice changes from "memoize carefully" to "write plain code, keep it pure, and profile."

## Where it's used

| Situation | Typical tool | Why |
|---|---|---|
| Large list or table under a frequently-updating parent | `memo` on the row plus stable callbacks | Skips hundreds of row renders per keystroke |
| Expensive derived data (sort or filter 10k items, build a chart series) | `useMemo` | Avoids recomputation when inputs haven't changed |
| Callback passed to a memoized child or used in an effect's deps | `useCallback` | Keeps the identity stable so the comparison passes |
| Context provider near the app root | `useMemo` on `value`, or split contexts | Prevents every consumer re-rendering on unrelated parent renders |
| Hover, drag and input state next to heavy content | Move state down, or `children` | Removes the render instead of optimising it |
| Codebases with the React Compiler enabled | Plain code | The compiler inserts memoization; manual hooks become escape hatches |

## Use case walk-through: a laggy product search

A product page has a search input, a filter sidebar and a grid of 500 product cards. Typing in the search box feels sticky: each keystroke takes about 60 ms.

1. **Profile first.** In React DevTools, turn on the Profiler's "Record why each component rendered". One keystroke shows `ProductPage` re-rendering, then all 500 `ProductCard`s with the note "parent re-rendered". The `filterAndSort` step takes 18 ms.
2. **Find the state.** The `query` state lives in `ProductPage` because both the input and the grid need it, so moving it down isn't an option.
3. **Memoize the expensive derivation.** Wrap `filterAndSort(products, query, filters)` in `useMemo` keyed on those three values. Then sidebar toggles that don't change them stop re-sorting.
4. **Memoize the row.** Wrap `ProductCard` in `memo`. The Profiler still shows every card rendering. Its props include `onAddToCart={() => add(p.id)}` and `style={{ width }}`, both new on every render.
5. **Stabilize the props.**
   - Pass `onAddToCart={add}`, wrapped in `useCallback` or taken from a stable store action, together with `id={p.id}`. The card calls `onAddToCart(id)`.
   - Move the width into CSS.
   - Now only the cards whose `product` object changed re-render.
6. **Keep typing responsive.** Wrap the grid's input in `useDeferredValue(query)`. Keystrokes update the input immediately, and the grid catches up at lower priority, so it can be interrupted.
7. **Verify.** Re-profile. Each keystroke now renders the input and the cards that actually changed.

**Result:** keystroke handling went from about 60 ms to under 8 ms. Three of the changes did nearly all the work: `useMemo` on the derivation, `memo` with stable props on cards, and a deferred query. Wrapping everything else made no measurable difference, so those changes were reverted.

## Pitfalls

- **Memoizing without measuring.** Every `memo` adds a comparison and every `useMemo` adds a dependency check and holds memory. On cheap components this costs more than it saves.
- **One unstable prop.** An inline object, closure or JSX element passed to a `memo` component defeats it. A spread like `{...rest}` can sneak one in.
- **Stale closures.** A `useCallback` with a missing dependency captures old state. Trust the `react-hooks/exhaustive-deps` lint rule. Where you only need the latest value, use the functional updater (`setCount(c => c + 1)`) or a ref.
- **Custom `arePropsEqual` that ignores functions.** Skipping function props in the comparison stops re-renders, but then the child calls stale handlers.
- **Context with an inline value.** `<Ctx.Provider value={{ user, setUser }}>` re-renders every consumer whenever the provider's parent renders.
- **Using `useMemo` for correctness.** React may throw the cache away, for example for offscreen components. `useMemo` is a performance hint, not a guarantee. Don't rely on it to run something exactly once.
- **Index keys in reorderable lists.** Input state and focus attach to the wrong rows.

> [!TIP]
> Order of operations: measure with the Profiler, then fix the structure (move state down, pass `children`, split context), then use `useMemo` for expensive derivations, then `memo` plus stable props for large repeated subtrees. If the React Compiler is available, enable it and remove manual memoization that it already covers.

## Discussion questions

1. Why is "components re-render when props change" an incorrect mental model, and what bug does it lead people to expect?
2. When does `useCallback` *without* `memo` on the consumer still serve a purpose?
3. How does passing a slow subtree as `children` prevent it re-rendering, in terms of element identity?
4. You have a context holding `{ theme, user, cursorPosition }`. What problems does this cause, and how would you restructure it?
5. What does the React Compiler need from your code to optimise it safely, and what happens to components that break those rules?
6. When is a render *with* identical output still expensive enough to fix?

## FAQ

### Should I wrap every component in memo?

No. For most components, rendering is cheaper than the comparison plus the bookkeeping, and the benefit vanishes as soon as a single prop isn't stable. Memoize components that are expensive or repeated many times, and that receive props you can actually keep stable.

### Does a re-render mean the DOM was updated?

No. A render produces a new element tree. React writes to the DOM only where that tree differs from the previous one. Unnecessary renders cost JavaScript time, not DOM time. That still matters on slow devices or during typing and animation.

### What's the difference between useMemo and useCallback?

`useMemo` caches a computed value. `useCallback` caches a function itself. `useCallback(fn, deps)` is equivalent to `useMemo(() => fn, deps)`.

### Does the React Compiler make memo, useMemo and useCallback obsolete?

Mostly, for code it can compile. It memoizes automatically and at a finer grain than most hand-written code. The hooks remain useful as escape hatches, for example to control an effect dependency precisely. Code that breaks the Rules of React is skipped, so the compiler also rewards keeping renders pure.

### Why does my memoized component still re-render?

Check three things:

- a prop that is a new object, array, function or element each render,
- a context it reads changing, and
- its own state changing.

The Profiler's "why did this render" output names the changed prop or hook.

## Key takeaways

- Renders are triggered by state, parent renders and context, not by props changing.
- A render is a function call plus a diff. The DOM changes only where the output differs.
- `memo` compares props with `Object.is`. A single new object or closure defeats it.
- `useMemo` and `useCallback` are mainly about stable references, and secondarily about skipping expensive work.
- Structural fixes (move state down, pass `children`, split context) beat memoization and need no upkeep.
- Profile before and after. With the React Compiler, write plain, pure code and let the build memoize it.

## References

- React docs: [memo](https://react.dev/reference/react/memo)
- React docs: [useMemo](https://react.dev/reference/react/useMemo)
- React docs: [useCallback](https://react.dev/reference/react/useCallback)
- React docs: [Render and Commit](https://react.dev/learn/render-and-commit)
- React docs: [React Compiler](https://react.dev/learn/react-compiler)
- Dan Abramov, [Before You memo()](https://overreacted.io/before-you-memo/), overreacted.io, 2021
- React docs: [useDeferredValue](https://react.dev/reference/react/useDeferredValue)

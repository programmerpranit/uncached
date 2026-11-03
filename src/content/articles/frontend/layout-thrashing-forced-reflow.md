---
summary: Why reading layout properties like offsetHeight right after changing the DOM forces the browser to recalculate layout synchronously, how a loop of interleaved reads and writes turns into layout thrashing, which APIs trigger it, how to spot it in DevTools, and the fixes that remove it, from batching reads and writes to requestAnimationFrame, ResizeObserver, CSS-only layout and content-visibility.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Browsers are lazy about layout on purpose. When you change the DOM or styles, they only mark the tree as **dirty** and recompute layout once, just before painting the next frame. If your JavaScript then **reads** a geometry value such as `offsetHeight` or `getBoundingClientRect()`, the browser has to compute layout **right now** so it can give you a correct answer. That's a **forced synchronous layout**, also called a forced reflow. Doing it once is usually fine. Doing it in a loop, write then read then write then read, is **layout thrashing**: the browser lays out the page dozens or hundreds of times in one task, and frames drop. The fix is almost always the same. Do all your reads first and all your writes after, or let CSS do the layout.

## The problem: a loop that looks harmless

You have a list of 300 cards and want every card to be as tall as the tallest one in its row. The obvious code walks the cards, reads each one's height, and sets a new height:

```js
for (const card of cards) {
  const h = card.offsetHeight;          // read
  card.style.height = `${h + 10}px`;    // write
}
```

On a laptop it takes 200 ms. On a mid-range phone it takes over a second, the page freezes and scroll jank shows up in your field metrics. DevTools flags a purple **Layout** bar under each iteration with the warning *"Forced reflow is a likely performance bottleneck."*

Nothing in that loop is expensive by itself. The cost comes from the **order** of the operations.

## How it works

### The frame pipeline

To produce a frame, the browser runs roughly these stages:

1. **JavaScript:** event handlers, timers and `requestAnimationFrame` callbacks.
2. **Style:** work out which CSS rules apply to which elements, and compute final values.
3. **Layout:** compute the size and position of every box. Older docs and Firefox call this **reflow**.
4. **Paint:** record drawing commands for each layer.
5. **Composite:** combine layers on the GPU and put them on screen.

At 60 Hz, all of this has about **16.7 ms**, and in practice your JavaScript gets around 10 ms of that.

Style and layout are expensive, so the browser postpones them. Setting `el.style.width` or adding a class doesn't lay anything out. It just marks the affected part of the tree as dirty and moves on. Many writes in a row cost about the same as one, because they're all resolved in the single style-and-layout pass before the next paint.

![A normal frame runs JavaScript, style, layout, paint and composite once; a read after a write pulls style and layout into the JavaScript task, and a loop repeats it](/figures/layout-thrashing/frame.svg "Normally layout runs once per frame. Reading geometry from a dirty tree pulls it into your script.")

### Forced synchronous layout

A **read** breaks the deal. If you ask for `el.offsetHeight` while the tree is dirty, the browser can't hand you a stale value, because the spec says the answer must reflect the styles you just set. So it pauses your script, runs style and layout immediately, and then returns the number. That's a **forced synchronous layout**.

One forced layout per frame is often harmless, since the browser would have had to do that work anyway. The problem is repetition. In the card loop:

- Iteration 1 reads (clean tree, cheap), then writes. The tree is now dirty.
- Iteration 2 reads, which forces a layout, then writes. The tree is dirty again.
- …and so on, 300 times.

Each write invalidates the layout that the next read just paid for. That's **layout thrashing**.

### Why it's worse than it sounds

The cost of each forced layout depends on **how much of the tree is dirty** and how far the change can spread. Changing the height of one card in a flex or grid row can change its siblings, its row, and everything below. Browsers try to re-layout only dirty subtrees, but a single height change near the top of a long page can easily invalidate most of it. So 300 forced layouts aren't 300 tiny operations. Each one can be a meaningful fraction of a full page layout.

![Interleaving reads and writes for 100 elements forces about 100 layouts, while doing all reads first and then all writes forces at most one extra layout](/figures/layout-thrashing/batch.svg "Same reads, same writes, different order. Batching collapses ~100 layouts into one.")

### What forces layout

Anything that needs up-to-date geometry can force layout if the tree is dirty. The most common triggers:

- **Box metrics:** `offsetWidth`, `offsetHeight`, `offsetTop`, `offsetLeft`, `offsetParent`, `clientWidth`, `clientHeight`, `getBoundingClientRect()`, `getClientRects()`.
- **Scroll:** reading `scrollTop`, `scrollLeft`, `scrollWidth` or `scrollHeight`, and calling `scrollIntoView()`, `scrollTo()` or `scrollBy()`.
- **Computed style:** reading layout-dependent values (like `width` or `height`) from `getComputedStyle()`. Calling `getComputedStyle()` alone doesn't force anything; reading certain properties from the result does.
- **Text and hit-testing:** `innerText` (it depends on rendering, unlike `textContent`) and `document.elementFromPoint()`.
- **Window and focus:** `window.innerHeight`, `el.focus()`, `input.select()`.

![Four groups of layout-forcing APIs: box metrics, scroll, computed style, and window and focus](/figures/layout-thrashing/triggers.svg "Writes only mark the tree dirty. The next read on a dirty tree pays for layout.")

Paul Irish maintains the widely cited list of these, which is worth bookmarking. There's also a **style-only** variant: reading a non-layout value such as `getComputedStyle(el).color` from a dirty tree forces a style recalculation, which is cheaper than layout but still adds up in loops.

### Spotting it

In the Chrome DevTools **Performance** panel:

- Look for purple **Recalculate Style** and **Layout** bars nested inside a yellow script task, rather than sitting after it.
- Layout events with a small red triangle are flagged as **forced reflow**. Clicking one shows the line of JavaScript that triggered it.
- A repeating sawtooth of tiny script and layout slices inside one long task is the visual signature of thrashing.

Firefox's profiler shows the same as **Reflow** markers with a JavaScript stack.

### Fixes

**1. Batch reads, then writes.** Split the loop in two:

```js
const heights = cards.map(c => c.offsetHeight);   // all reads
cards.forEach((c, i) => {                          // all writes
  c.style.height = `${heights[i] + 10}px`;
});
```

The first read may force one layout. The writes then dirty the tree once, and the browser lays it out once before paint.

**2. Schedule writes for the next frame.** When reads and writes come from different components that don't know about each other, use `requestAnimationFrame` for writes, or a small scheduler like **FastDOM** that queues reads and writes and flushes them in two phases per frame.

**3. Cache what doesn't change.** Read a container's width once on resize, not inside every scroll handler. Better still, let **`ResizeObserver`** tell you sizes. It delivers them after layout, so reading them is free, and **`IntersectionObserver`** replaces most scroll-position math.

**4. Let CSS do it.** The equal-height card loop disappears entirely with `display: grid` or flexbox's default `align-items: stretch`. Sticky headers use `position: sticky`, not scroll handlers. Container queries replace JavaScript that measures a parent to pick a layout. Every measurement you remove is one you can't thrash on.

**5. Shrink the blast radius.** `contain: layout` (or `contain: content`) tells the browser a subtree's layout can't affect the outside, so changes inside it don't invalidate the rest of the page. `content-visibility: auto` skips layout entirely for off-screen sections.

**6. Animate with `transform` and `opacity`.** Animating `top`, `left`, `width` or `height` runs layout every frame. `transform` and `opacity` can skip layout and paint and run on the compositor.

## Where it's used

| Situation | What usually thrashes | Typical fix |
|---|---|---|
| Masonry and equal-height grids | Measure each item, set its height or position, repeat | CSS grid, or measure all then position all |
| Virtualized lists | Measuring each row after rendering it | Batch measurements, `ResizeObserver` on rows |
| Auto-growing textareas | `height = 'auto'` then read `scrollHeight` on each keystroke | Do it once per frame, or CSS `field-sizing: content` where supported |
| Scroll-linked effects | Reading `scrollTop` and writing styles in a scroll handler | `IntersectionObserver`, `position: sticky`, scroll-driven animations |
| Tooltips and popovers | Positioning several popovers, each one reading then writing | Read all anchor rects first, or CSS anchor positioning |
| Third-party widgets | Ad and analytics scripts measuring the page in loops | Load them later, isolate them in iframes |

## Use case walk-through: fixing a janky masonry grid

A product listing page arranges 240 tiles of different heights into a masonry layout. On a mid-range Android phone, adding a filter freezes the page for about 900 ms, and INP in the field is over 600 ms.

1. **Profile.** One long task contains 240 repetitions of a short script slice followed by a purple **Layout** marked as forced reflow. Each layout takes 3–4 ms because the whole grid is dirty every time.
2. **Find the loop.** The layout function, for each tile, reads `tile.offsetHeight`, picks the shortest column, and sets `tile.style.transform` and the column's height. Every iteration reads after the previous iteration's write.
3. **Split it.** Read all 240 heights into an array first. Then compute every position in plain JavaScript, with no DOM access. Then apply all transforms in one pass. The profile now shows one layout before the reads and one at the end of the frame.
4. **Stop re-measuring.** Tile heights only change when an image loads or the viewport resizes. A `ResizeObserver` on the tiles keeps a height cache up to date, so filtering doesn't measure anything.
5. **Contain it.** Adding `contain: layout` to the grid means a tile change doesn't invalidate the header and footer.
6. **Consider CSS.** For new pages, the team trials CSS grid with `grid-template-rows: masonry` behind a feature check, falling back to the JavaScript layout.

**Result:** filtering drops from about 900 ms to 40 ms on the same phone, and field INP on the listing page falls below 200 ms. The algorithm didn't change. Only the order of DOM reads and writes did.

## Pitfalls

- **Hidden reads in libraries.** Animation, tooltip and virtualization libraries read layout internally. Calling a library's `update()` in a loop can thrash even if your own code doesn't read anything.
- **Reads that look like writes.** `el.scrollIntoView()`, `el.focus()` and setting `scrollTop` all need layout first. Calling them right after DOM changes forces it.
- **`innerText` vs `textContent`.** `innerText` depends on CSS (it skips hidden text), so it forces layout. Use `textContent` when you just want the text.
- **Framework lifecycle hooks.** In React, measuring in `useLayoutEffect` is correct, but writing state there and measuring again in a child's layout effect creates the same read-write ping-pong across components.
- **Fixing it in the wrong place.** Wrapping the whole loop in `requestAnimationFrame` doesn't help. It still interleaves reads and writes, just one frame later.
- **Over-correcting.** A single read after a write in an event handler is normal. Don't contort code to avoid every forced layout; look for the ones that repeat.

> [!TIP]
> When you inherit code that thrashes and can't restructure it, add `console.count` on the read, or record a Performance trace and count the forced reflow markers. If the count scales with the number of items, that's the loop to split.

## Discussion questions

1. Why does the browser defer layout instead of updating it immediately on every style change? What would break if it didn't?
2. A forced layout on a clean tree costs almost nothing. What makes a tree "dirty", and how could you keep the dirty region small?
3. `ResizeObserver` delivers sizes without forcing layout. Where in the frame does its callback run, and why can writing inside it cause a loop?
4. When should you read layout in `useLayoutEffect` versus `useEffect` in React, and how does each relate to forced layout?
5. Which layout problems that used to need JavaScript measurement can now be solved with CSS alone?
6. How would you find thrashing caused by a third-party script you don't control?

## FAQ

### Is reflow the same as layout?

Yes. **Reflow** is the older name, still used by Firefox and many articles. Chrome and the specs mostly say **layout**. Both mean computing the geometry of boxes. **Repaint** is a different, later step: it redraws pixels without changing geometry.

### Does every DOM read force a layout?

No. Only reads that need geometry or computed style, and only when something has changed since the last layout. Reading `textContent`, attributes, `classList` or `dataset` never forces layout. Reading `offsetHeight` twice in a row with no writes in between costs one layout at most.

### Does `requestAnimationFrame` fix layout thrashing?

Only if you use it to separate reads from writes. rAF callbacks run just before style and layout, so it's a good place for writes. Reads at the start of a rAF callback, before any writes, see the layout from the previous frame without forcing anything new. A loop that interleaves reads and writes inside rAF still thrashes.

### Do frameworks like React prevent it?

Partly. React batches DOM writes during commit, so rendering alone doesn't thrash. But any code you write that measures the DOM (in refs, effects or event handlers) can still interleave with writes, and so can libraries you call.

### How much does one forced layout cost?

It depends on the size of the dirty subtree and the layout model. On a simple page it might be a fraction of a millisecond. On a large page with deep flex or grid nesting it can be several milliseconds on a phone. The danger is repetition, which multiplies whatever that cost is.

## Key takeaways

- Browsers defer style and layout and run them once per frame. Writes just mark the tree dirty.
- Reading geometry from a dirty tree forces layout **synchronously**, inside your script.
- Interleaving reads and writes in a loop forces a layout per iteration. That's layout thrashing.
- Batch all reads before all writes, schedule writes with `requestAnimationFrame`, and cache measurements with `ResizeObserver`.
- The best fix is often to delete the measurement and let CSS (grid, flexbox, sticky, container queries) do the layout.
- Use `contain` and `content-visibility` to limit how much of the page each layout has to touch.

## References

- Paul Irish, ["What forces layout / reflow"](https://gist.github.com/paulirish/5d52fb081b3570c81e3a), the comprehensive list of layout-triggering APIs.
- web.dev, ["Avoid large, complex layouts and layout thrashing"](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing).
- MDN, ["Window: requestAnimationFrame() method"](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame).
- MDN, ["Resize Observer API"](https://developer.mozilla.org/en-US/docs/Web/API/Resize_Observer_API).
- MDN, ["CSS containment"](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment).
- web.dev, ["content-visibility: the new CSS property that boosts your rendering performance"](https://web.dev/articles/content-visibility).
- Wilson Page, [FastDOM](https://github.com/wilsonpage/fastdom), a library that batches DOM reads and writes.
- Chrome for Developers, "Analyze runtime performance" (DevTools Performance panel documentation).

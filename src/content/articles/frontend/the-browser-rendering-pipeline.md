---
summary: What a browser does between receiving HTML and showing pixels, and again on every frame after that. Covers parsing and the critical rendering path, style, layout, paint, compositing and layers, the 16.7 ms frame budget, and which CSS changes are cheap or expensive.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A browser turns HTML and CSS into pixels in a fixed sequence:
>
> 1. **parse** HTML into the DOM and CSS into the CSSOM;
> 2. compute **style** for each element;
> 3. run **layout** to get every box's size and position;
> 4. **paint** each layer into a list of draw commands;
> 5. **composite** the rasterised layers on the GPU.
>
> Each stage feeds the next, so a change redoes every stage after the earliest one it touches:
>
> - Changing `width` re-runs layout, paint and composite.
> - Changing `color` skips layout.
> - Changing `transform` or `opacity` on a layered element can skip straight to compositing, which runs **off the main thread**.
>
> At 60 Hz all of this, plus your JavaScript, has to fit in about **16.7 ms** per frame. Smooth pages keep main-thread work short, animate compositor-only properties, and avoid forcing layout repeatedly from script.

## The problem: one frame, one thread, many steps

To the user a page is either smooth or janky. Underneath, the browser repeats the same steps for every visual update. Most of them run on the **main thread**, the same thread that runs your JavaScript and handles input. If a click handler takes 120 ms, no frames are produced for 120 ms. If a scroll handler changes layout, the browser may run layout for every scroll event.

Knowing the stages tells you **why** some changes are cheap and others aren't, and where to look in a performance profile.

## How it works

### From bytes to pixels

![Rendering pipeline stages: parse, style, layout, paint and composite, with the main thread and compositor thread](/figures/rendering-pipeline/pipeline.svg "Each stage consumes the previous stage's output.")

**Parse.** The HTML parser builds the **DOM** incrementally as bytes arrive. A **preload scanner** looks ahead for `<link>`, `<script>` and `<img>` URLs so their downloads start early. CSS is parsed into the **CSSOM**. Two things block:

- **CSS blocks rendering.** The browser won't paint until it has the stylesheets in `<head>`; painting without them would cause a flash of unstyled content.
- **Classic `<script>` blocks parsing.** The parser stops, the script downloads and executes (after pending CSS, because the script might read styles), then parsing continues. `defer`, `async` and `type="module"` avoid this.

This first-render chain is the **critical rendering path**.

**Style.** For every element, the engine finds the matching rules, resolves the cascade and inheritance, and produces **computed styles**. Engines use bloom filters and right-to-left selector matching, and they share styles between similar siblings, to keep this fast on large DOMs.

**Layout** (Firefox calls it *reflow*). Using computed styles and the viewport size, the engine builds a **layout tree** of the boxes that will actually render. `display: none` elements are left out; pseudo-elements like `::before` are added. Then it computes the geometry of each box: block, inline, flex and grid formatting, line breaking, and text shaping. Layout is often the most expensive stage, because one change, such as a font loading or a container width changing, can affect many boxes.

**Paint.** The engine walks the layout tree in stacking order and records **display lists** of draw operations ("rect here, text there"). Chrome first builds **property trees** for transforms, clips and effects (pre-paint), then splits content into **layers**.

**Raster and composite.** Display lists are rasterised into bitmap **tiles**, on worker threads and often on the GPU. The **compositor thread** then assembles the layers into a frame, applying transforms, opacity and scroll offsets, and submits it to the GPU process. Because the compositor has its own thread, it can **scroll and run some animations while the main thread is busy**.

### What a change costs

![Which pipeline stages run for layout-triggering, paint-only and composite-only CSS property changes](/figures/rendering-pipeline/property-cost.svg "Prefer the bottom row for anything animated.")

When something changes, the engine marks the affected work dirty and re-runs from the earliest stage needed:

- **Geometry** (`width`, `height`, `top`, `margin`, `font-size`, adding or removing nodes, text content): style → layout → paint → composite.
- **Appearance only** (`color`, `background`, `box-shadow`, `border-color`): style → paint → composite.
- **Compositor properties** (`transform`, `opacity`, some `filter`s) on an element with **its own layer**: composite only, and if animated with CSS animations or the Web Animations API, the animation runs on the compositor thread.

An element gets its own layer for reasons such as `will-change: transform`, an active transform or opacity animation, `<video>`, `<canvas>`, `position: fixed` in some cases, or overlapping another layered element. Layers cost GPU memory, so promote deliberately, not wholesale.

Engines limit how far invalidation spreads. **CSS containment** (`contain: layout paint`, or `content-visibility: auto`) tells the browser that changes inside a subtree can't affect outside it, and lets it skip rendering offscreen subtrees entirely.

### The frame

![Timeline of a single frame: input, JavaScript, requestAnimationFrame, style, layout, paint and composite fitting in a 16.7 ms budget](/figures/rendering-pipeline/frame.svg "Main-thread work that overruns vsync drops the frame.")

On each vsync the browser may produce a frame. A typical frame runs:

1. input events (scroll, pointer, key);
2. timers and other tasks, plus microtasks;
3. `requestAnimationFrame` callbacks;
4. style, layout;
5. paint, then commit to the compositor.

The browser only renders when something changed, and it coalesces work: ten DOM writes in one task produce one style and layout pass at the end. The exception is when script **reads** a layout value (`offsetHeight`, `getBoundingClientRect()`) after a write. The browser must run layout immediately to answer, which is **forced synchronous layout**. Doing that in a loop is layout thrashing.

At 60 Hz the budget is 16.7 ms, at 120 Hz 8.3 ms, and the browser needs some of that for its own work. A **long task** (over 50 ms) delays both the next frame and the response to input, which is what Interaction to Next Paint (INP) measures.

## Where it's used

| Engine / tool | Notes |
|---|---|
| Chromium (Blink) | RenderingNG: property trees, compositor thread, GPU raster, Viz display compositor |
| Firefox (Gecko) | Stylo parallel style engine (Rust, from Servo); WebRender GPU renderer |
| Safari (WebKit) | layer-based compositing via Core Animation |
| Chrome DevTools Performance panel | shows Recalculate Style, Layout, Paint, Commit per frame |
| Lighthouse / web-vitals | First Contentful Paint and LCP come from the critical rendering path; INP from long tasks |
| Frameworks | React, Vue and Svelte batch DOM writes per task so the browser lays out once |

## Use case walk-through: a janky sidebar animation

A sidebar slides in by animating `left` from `-300px` to `0`. On low-end phones it stutters, especially while the page is loading data.

1. **Record a profile.** The Performance panel shows Layout and Paint in every frame of the animation, and a 90 ms JSON-parsing task during which no frames appear.
2. **Identify the stage.** `left` is a geometry property. Every frame re-runs layout for the sidebar and everything that depends on it, then repaints.
3. **Switch to a compositor property.** Animate `transform: translateX(-100%)` to `translateX(0)` with a CSS transition. Add `will-change: transform` just before opening (and remove it after).
4. **Check again.** Frames now show only Composite. The animation stays smooth even during the 90 ms task, because the compositor thread runs it.
5. **Fix the long task anyway.** Taps during that task still feel unresponsive, so split the parsing into chunks, or move it to a worker.

## Pitfalls

- **Animating geometry.** `top`, `left`, `width` and `height` animations re-run layout every frame. Use `transform` and `opacity`.
- **`will-change` everywhere.** Each layer costs memory and compositing time. Large numbers of layers make things slower, not faster.
- **Reading layout in loops.** Alternating style writes and `offsetWidth` reads forces a layout per iteration.
- **Render-blocking CSS and scripts.** A large stylesheet or a synchronous script in `<head>` delays first paint. Inline critical CSS; `defer` scripts.
- **Huge DOMs.** Style and layout scale with node count. Tens of thousands of nodes make every update slow; virtualize long lists and use `content-visibility`.
- **Web fonts swapping late.** A font load can re-run layout across the page and shift content. Use `font-display` and size-adjusted fallbacks.

> [!TIP]
> In Chrome DevTools, open the Rendering drawer and turn on **Paint flashing** and **Layer borders**. Green flashes show what repaints on each interaction, and orange borders show what has its own layer. Often one glance explains a janky interaction.

## Discussion questions

1. Why does CSS block rendering while a classic script blocks parsing, and what do `defer` and `async` change?
2. Which stages run when you change `color`, `width` and `transform` respectively, and why?
3. How can a CSS animation stay smooth while the main thread is blocked by JavaScript, and when does it stop being able to?
4. What are the costs of promoting too many elements to their own compositor layers?
5. What's forced synchronous layout, and how would you restructure code that measures and moves many elements?
6. How does `content-visibility: auto` reduce rendering work, and what trade-off does it introduce for scroll bars and find-in-page?

## FAQ

### Is the "render tree" the same as the DOM?

No. The DOM contains every node, including `<head>`, `display: none` elements and comments. The render or layout tree contains only boxes that will be laid out and drawn, and it adds generated content like `::before` and anonymous boxes. Modern engines have several trees (layout, paint, property and layer trees), but the idea is the same.

### Does `visibility: hidden` skip layout?

No. A `visibility: hidden` element still takes up space, so it's laid out; it just isn't painted. `display: none` removes it from layout. `content-visibility: hidden` keeps its size but skips rendering of its contents.

### Why are `transform` and `opacity` special?

They can be applied when the compositor combines already-rasterised layers, with a matrix and an alpha value, so no re-layout or re-paint is required. Many filters can also be applied by the compositor. Most other properties change either geometry or the pixels inside a layer.

### What is "jank", exactly?

A missed frame: the display refreshes but the browser hasn't produced a new frame, so the old one stays up. It's usually caused by main-thread work running past the frame deadline, by expensive paints, or by raster that can't keep up during fast scrolling.

### Does a requestAnimationFrame callback make my code faster?

No, but it times DOM writes to run just before style and layout, once per frame. That avoids doing visual work several times per frame or at points where its result would be thrown away.

## Key takeaways

- Pixels come from a pipeline: parse, style, layout, paint, composite. A change re-runs every stage after the first one it touches.
- CSS blocks rendering; classic scripts block parsing. Keep the critical path small.
- Animate `transform` and `opacity` on layered elements so the work stays on the compositor.
- Everything on the main thread, your JavaScript included, competes for a ~16.7 ms frame budget.
- Use the Performance panel, paint flashing and layer borders to see which stage is costing you.

## References

- web.dev: [Rendering performance](https://web.dev/articles/rendering-performance)
- web.dev: [Understand the critical path](https://web.dev/learn/performance/understanding-the-critical-path)
- Chrome for Developers: [RenderingNG architecture](https://developer.chrome.com/docs/chromium/renderingng-architecture)
- Chrome for Developers: [Inside look at modern web browser (part 3)](https://developer.chrome.com/blog/inside-browser-part3)
- MDN: [Populating the page: how browsers work](https://developer.mozilla.org/en-US/docs/Web/Performance/How_browsers_work)
- MDN: [content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility)
- HTML Living Standard: "Event loops" (update the rendering steps)

---
summary: Why animating width or top drops frames while transform and opacity stay smooth, how the rendering pipeline and compositor thread explain it, and the techniques (FLIP, will-change, the Web Animations API, View Transitions) that keep motion at 60 fps.
updated: 2026-11-02
---

> [!KEY]
> Every frame, the browser runs style, layout, paint and composite, starting from the first stage a change touches. Animating `width`, `height`, `top` or `margin` re-runs **layout and paint** on the main thread every frame. On a mid-range phone that easily blows the 16.7 ms budget for 60 Hz. Animating `transform` and `opacity` touches **composite only**. The compositor thread moves an already-painted GPU layer, so the animation stays smooth even while JavaScript is busy. Use transforms for motion, FLIP to animate layout changes, `will-change` sparingly, and always respect `prefers-reduced-motion`.

## The problem: the side panel that stutters

A side panel slides in by animating `left` from `-320px` to `0`. On a developer laptop it looks fine. On a mid-range Android phone it judders, and if the panel opens while the app is fetching and parsing data, it freezes for a moment and then jumps to the end.

Nothing is wrong with the easing curve or the duration. The animation is asking the browser to do the most expensive work it has, laying out the page, 60 times a second, on the same thread that runs all of the app's JavaScript.

## How it works

### The rendering pipeline

![Which stages each property re-runs](/figures/animation-perf/pipeline.svg "Changing a geometry property re-runs layout, paint and composite; colour skips layout; transform and opacity only composite.")

To produce a frame, the browser goes through these stages:

1. **JavaScript:** event handlers, `requestAnimationFrame` callbacks, framework updates.
2. **Style:** work out which CSS rules apply and compute each element's styles.
3. **Layout:** compute the size and position of every affected box. Changing one element's width can move every element after it.
4. **Paint:** record drawing commands for text, colours, borders and shadows, and rasterise them into layers.
5. **Composite:** combine the layers on the GPU, applying their transforms and opacity, and put the result on screen.

A change starts the pipeline at the first stage it affects, and everything after it re-runs too:

| Property changed | Stages re-run | Cost |
|---|---|---|
| `width`, `height`, `top`, `left`, `margin`, `padding`, `font-size` | Layout, paint, composite | High; scales with how much of the page moves |
| `color`, `background`, `box-shadow`, `border-radius` | Paint, composite | Medium; scales with painted area |
| `transform`, `opacity` (and usually `filter`) | Composite only | Low; the GPU moves or fades an existing layer |

### The frame budget

![Frame budget](/figures/animation-perf/budget.svg "Animating width spends about 17.5 ms per frame on layout and paint and misses the deadline; transform finishes in under 2 ms.")

At 60 Hz the browser has about 16.7 ms per frame, and less than that in practice, because it needs some of the time for its own work. On a 120 Hz display the budget halves to 8.3 ms. If a frame isn't ready in time, the previous frame stays on screen, and the user sees a stutter, called **jank**.

Layout cost depends on the DOM, not on the animation. A `width` animation on a simple demo page might be fine, while the same animation in a real app with thousands of elements, flex and grid containers and web fonts misses the deadline on every frame.

### Two threads

![Main thread vs compositor thread](/figures/animation-perf/threads.svg "During a 300 ms long task, the compositor keeps producing transform frames; the width animation freezes until the main thread is free.")

Modern browsers split rendering across threads:

- The **main thread** runs JavaScript, style, layout and paint. It's shared with everything your app does.
- The **compositor thread** takes painted layers and assembles frames on the GPU.

When a CSS animation or Web Animation changes only `transform` or `opacity`, the browser can hand the whole animation to the compositor. The compositor then produces each frame itself, without asking the main thread. A 300 ms JSON parse or a big React render on the main thread no longer stops the animation.

A `width` animation can't be handed off. Each frame needs a new layout, and only the main thread can do that, so a long task freezes it.

> [!WARNING]
> An animation driven from JavaScript, such as `requestAnimationFrame` setting `el.style.transform` each frame, runs on the main thread even when it only changes `transform`. It skips layout and paint, but a long task still stalls it. Prefer CSS animations, CSS transitions or the Web Animations API so the compositor can run them.

### Layers and will-change

For the compositor to move an element, the element must be on its own **compositing layer**, a separately painted GPU texture. Browsers promote elements automatically when an animation on `transform` or `opacity` starts. You can ask for promotion in advance:

```css
.panel { will-change: transform; }
```

This avoids a repaint at the start of the animation. But each layer costs GPU memory roughly equal to its width × height × 4 bytes, so a full-screen layer on a high-density phone can take tens of megabytes. Too many layers make things slower, not faster, and can crash tabs on low-memory devices. Add `will-change` to the few elements that are about to animate, and remove it when they're done.

### FLIP: animating layout changes with transforms

Sometimes the layout really changes: a list item is removed and the others move up, or a card expands into a detail view. You can still animate it with transforms, using a technique Paul Lewis named **FLIP**:

1. **First:** record the element's current position with `getBoundingClientRect()`.
2. **Last:** apply the layout change, then record the new position.
3. **Invert:** apply a `transform` that moves the element back to where it started, so nothing visibly changes.
4. **Play:** animate the transform back to none.

The layout happens once, between First and Last. The animation itself is transform-only and runs on the compositor. Libraries such as Motion's layout animations, `react-flip-toolkit` and `auto-animate` package this pattern.

### The Web Animations API

`element.animate()` gives you the same compositor-friendly animations as CSS, from JavaScript:

```js
panel.animate(
  [{ transform: 'translateX(-100%)' }, { transform: 'none' }],
  { duration: 250, easing: 'cubic-bezier(.2,.8,.2,1)' }
);
```

It returns an `Animation` object you can pause, reverse, seek and await (`animation.finished`). That makes it the usual building block for FLIP and for gesture-driven motion.

### View Transitions

The View Transitions API (`document.startViewTransition()` for same-document changes, and `@view-transition { navigation: auto; }` for navigations between pages) automates a common case. The browser snapshots the old and new states and cross-fades or morphs between them, using transform and opacity animations on pseudo-elements. Elements with a matching `view-transition-name` animate from their old position and size to their new one. It turns many hand-written FLIP animations into a line of CSS.

### Reduced motion

Some users get dizzy or nauseous from large movements, and set an operating system preference to reduce motion. Respect it:

```css
@media (prefers-reduced-motion: reduce) {
  .panel { transition: opacity 150ms; }
}
```

Reduced motion doesn't have to mean no feedback. Replace slides, zooms and parallax with short fades.

## Where it's used

| Context | Technique |
|---|---|
| Drawers, modals, toasts | `transform: translate` plus `opacity` transitions |
| List reorder, add and remove | FLIP via the Web Animations API or a layout-animation library |
| Page and route transitions | View Transitions with `view-transition-name` on shared elements |
| Accordions and "expand" effects | Animate a `scale` or clip, or use `interpolate-size` or `grid-template-rows` with care and measure |
| Loading spinners and skeletons | Transform rotation and opacity shimmer, so they keep moving during long tasks |
| Scroll-driven effects | `animation-timeline: scroll()` and `view()`, which can run on the compositor |

## Use case walk-through: fixing the stuttering side panel

The panel from the opening example animates `left` over 300 ms. On a test phone, the Performance panel shows each frame taking 22–30 ms, mostly in "Layout", and a 280 ms gap when it opens during a data fetch.

1. **Record a trace.** In Chrome DevTools, record the Performance panel with 4× CPU throttling. Purple layout blocks and green paint blocks fill every frame of the animation.
2. **Switch to transform.** Position the panel at its final place and hide it with `transform: translateX(-100%)`. Transition `transform` to `none`.
3. **Fade the backdrop with opacity.** The backdrop animated `background-color` alpha, which repainted the whole screen. Animate `opacity` on a fixed black layer instead.
4. **Promote just before opening.** Add `will-change: transform` when the open button receives `pointerdown`, and remove it on `transitionend`.
5. **Check the long task.** Trigger the panel during the data fetch. The panel now slides smoothly, because the compositor runs it while the main thread parses JSON.
6. **Respect reduced motion.** Under `prefers-reduced-motion: reduce`, replace the slide with a 150 ms fade.
7. **Verify.** Re-record. Frames during the animation take about 2 ms of main-thread time, with no layout or paint.

**Result:** the panel animates at a steady 60 fps on the test phone, including while JavaScript is busy. The frame-time trace shows no layout during the animation.

## Pitfalls

- **Animating geometry.** `width`, `height`, `top`, `left` and `margin` re-run layout every frame. Use `transform: translate()` and `scale()`.
- **Animating `box-shadow` or `filter: blur()` on large areas.** These repaint every frame. Animate the `opacity` of a pseudo-element that already has the shadow.
- **`will-change` everywhere.** Each layer costs GPU memory. Too many layers slow compositing down and can crash low-memory devices.
- **JavaScript-driven animation loops.** `requestAnimationFrame` updates run on the main thread and stall during long tasks. Use CSS or the Web Animations API.
- **Layout thrashing in FLIP.** Reading `getBoundingClientRect()` after writes for many elements forces layout repeatedly. Batch all reads, then all writes.
- **Scale distorting content.** Scaling a container stretches its text and borders. Counter-scale children, or animate a clip instead.
- **Ignoring `prefers-reduced-motion`.** Large movement can make some users ill. Offer a reduced version.
- **Testing only on a fast laptop.** Throttle the CPU, or test on a real mid-range phone.

> [!TIP]
> In Chrome DevTools, the Rendering tab's "Paint flashing" highlights repainted areas, and "Layer borders" shows composited layers. If a slide animation flashes green every frame, it isn't running on the compositor.

## Discussion questions

1. Why does a `width` animation get slower as the page gets bigger, while a `transform` animation doesn't?
2. What does the compositor thread need to run an animation without the main thread, and which properties allow that?
3. When does `will-change` help, and how can it hurt?
4. Walk through FLIP for a list where one item is removed. Where does layout happen, and how many times?
5. How would you animate an accordion opening to its natural height without animating `height` every frame?
6. What should a "reduced motion" version of a page transition look like?

## FAQ

### Is transform always GPU-accelerated?

When animated with CSS or the Web Animations API on a composited layer, yes in all modern browsers. Setting it from JavaScript every frame still skips layout and paint, but each frame then depends on the main thread.

### Why not just use `translate3d(0,0,0)` to force a layer?

It's an old hack that promotes the element permanently. `will-change: transform` expresses the same intent clearly, and you can remove it afterwards. Neither should be applied broadly.

### Can I animate height smoothly?

Animating `height` re-runs layout each frame, which is fine for small, isolated elements and costly in big layouts. Newer CSS (`interpolate-size: allow-keywords`, or transitioning `grid-template-rows` from `0fr` to `1fr`) makes height animations easier to write, but they still run layout. For heavy pages, use FLIP or a `scale` and clip approach.

### What's the difference between CSS transitions and the Web Animations API?

They share the same engine. Transitions animate between two states when a property changes. The Web Animations API creates animations from JavaScript with keyframes, and gives you playback control: pause, reverse, seek and a `finished` promise.

### How do I know if my animation is janky?

Record it in the Performance panel with CPU throttling and look for frames longer than the budget, and for layout and paint blocks during the animation. The "Frame rendering stats" overlay in the Rendering tab shows dropped frames live.

## Key takeaways

- The pipeline is style, layout, paint, composite. A change re-runs everything from the first stage it touches.
- `transform` and `opacity` only composite, and CSS or Web Animations on them run on the compositor thread, surviving long tasks.
- Geometry animations re-run layout on the main thread every frame and miss the 16.7 ms budget on real devices.
- Use FLIP or View Transitions to animate layout changes with transforms.
- Use `will-change` only for elements about to animate, and respect `prefers-reduced-motion`.

## References

- web.dev: [How to create high-performance CSS animations](https://web.dev/articles/animations-guide)
- web.dev: [Stick to compositor-only properties and manage layer count](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)
- Paul Lewis, [FLIP Your Animations](https://aerotwist.com/blog/flip-your-animations/), aerotwist.com, 2015
- MDN: [Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API)
- MDN: [View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)
- MDN: [will-change](https://developer.mozilla.org/en-US/docs/Web/CSS/will-change)
- MDN: [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- Chrome for Developers: [Inside look at modern web browser (part 3)](https://developer.chrome.com/blog/inside-browser-part3)

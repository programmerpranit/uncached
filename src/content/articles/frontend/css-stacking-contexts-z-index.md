---
summary: Why z-index 9999 sometimes loses to z-index 2. Covers the paint order inside a stacking context, which elements z-index applies to, the many properties that create a new stacking context, isolation, portals, the top layer used by dialog and popover, and how to debug layering bugs.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Browsers don't compare z-index values across the whole page. They paint in **stacking contexts**: self-contained groups that are layered as a single unit inside their parent.
>
> - Inside a stacking context, content is painted in a fixed order: the context's own background, negative z-index children, block boxes, floats, inline content, `z-index: auto` / `0` positioned boxes, then positive z-index children.
> - z-index only works on **positioned** elements (anything but `position: static`) and on **flex and grid items**.
> - Many properties create a new stacking context, not just z-index: `opacity < 1`, `transform`, `filter`, `position: fixed` or `sticky`, `isolation: isolate`, `will-change`, `contain: paint` and more.
>
> Once an element forms a stacking context, its descendants can never be painted above or below something outside it, whatever their z-index. That's the "z-index: 9999 doesn't work" bug. The fix is to change the **structure** (raise the ancestor, remove its context, or render the overlay elsewhere), not to raise the number.

## The problem: bigger numbers that don't win

A dropdown inside a card is hidden behind the sticky site header. Someone sets `z-index: 10` on the dropdown. Then 100. Then 9999. Nothing changes. Six months later the codebase has `z-index: 2147483647` in three places, and a modal still opens behind a toast.

z-index isn't a global ranking. It's a ranking among **siblings in the same stacking context**. If the two elements you're comparing live in different contexts, their own z-index values are never compared at all; the values of their context-forming ancestors are. Until you can see the tree of stacking contexts, layering bugs look random.

## How it works

### The paint order inside one stacking context

![The seven layers painted inside a stacking context, from background to positive z-index](/figures/stacking-contexts/paint-order.svg "Each stacking context paints its content in the same seven steps, back to front.")

CSS 2.1 Appendix E defines how a stacking context paints, from back to front:

1. the background and borders of the element that forms the context;
2. child stacking contexts with **negative** z-index (most negative first);
3. in-flow, non-positioned **block** boxes;
4. non-positioned **floats**;
5. in-flow **inline** content: text, images, inline-blocks;
6. positioned descendants with `z-index: auto` or `0`, and child contexts with z-index 0, in **document order**;
7. child stacking contexts with **positive** z-index (lowest first; ties in document order).

Two consequences surprise people:

- **Positioned beats non-positioned.** A `position: relative` box with no z-index is painted in step 6, above a later sibling that isn't positioned, even though both have "no z-index".
- **Negative z-index goes behind the parent's content, not behind the parent.** A child with `z-index: -1` is painted after the context's own background (step 1). It disappears behind the page only when its nearest stacking context is the root.

### Who z-index applies to

z-index has no effect on a `position: static` element, unless it's a flex or grid item. For those it works without positioning, and a flex or grid item with a z-index other than `auto` forms a stacking context.

`z-index: auto` and `z-index: 0` look the same on screen but differ in one important way: `0` on a positioned element **creates** a stacking context, `auto` does not. With `auto`, the element's positioned children take part in the parent's context and can still interleave with elements outside.

### The trap

![A dropdown with z-index 9999 inside a card with z-index 1 is painted below a header with z-index 2](/figures/stacking-contexts/trap.svg "The dropdown's 9999 is only compared with its siblings inside the card's context.")

The card has `position: relative; z-index: 1`, so it forms a stacking context. The header is `position: sticky; z-index: 2` in the root context. In the root context, the browser compares **1** (card) against **2** (header): the header wins. Everything inside the card, including the dropdown at 9999, is painted as part of the card's single layer. The 9999 only ranks the dropdown against the card's other children.

Three structural fixes, from smallest to largest:

1. **Raise the context, not the child.** Give the card (or whatever ancestor forms the context) a higher z-index than the header, if that's correct for the design.
2. **Remove the context.** If the card's z-index or transform isn't needed, drop it. The dropdown then joins the root context and its z-index competes with the header directly.
3. **Move the overlay.** Render the dropdown outside the card, at the end of `<body>`, with a portal, or put it in the **top layer** (below).

### What creates a stacking context

![Properties that create a new stacking context: positioning with z-index, fixed and sticky, opacity, transform, filter, isolation and more](/figures/stacking-contexts/creators.svg "Most new contexts come from visual effects, not from z-index.")

An element forms a stacking context if it is:

- the root element (`<html>`);
- positioned (`relative` or `absolute`) with a z-index other than `auto`;
- `position: fixed` or `position: sticky` (always, in all modern browsers);
- a flex or grid item with a z-index other than `auto`;
- `opacity` less than 1;
- any `transform`, `scale`, `rotate`, `translate`, `filter`, `backdrop-filter`, `perspective`, `clip-path` or `mask` other than `none`;
- `mix-blend-mode` other than `normal`;
- `isolation: isolate`;
- `will-change` naming a property that would create a context (`opacity`, `transform` and so on);
- `contain: layout`, `paint`, `strict` or `content`, and size or inline-size `container-type` (container queries).

The visual-effect cases are why stacking bugs appear "out of nowhere": a designer adds a fade-in animation (`opacity`), a hover lift (`transform`) or `will-change: transform` for performance, and a dropdown somewhere inside stops escaping its card. Many animation libraries leave `transform` set after an animation ends, which keeps the context in place.

### isolation: isolate

`isolation: isolate` creates a stacking context with **no other side effect**: no positioning, no z-index, no compositing. It's the right tool when you want a component to be self-contained, so that its internal z-index values (a badge at 1, a tooltip at 2) can't leak out and interact with the rest of the page. Many design systems put it on the root of every component that uses z-index internally.

### Portals and the top layer

When an overlay must appear above **everything**, the reliable approach is to take it out of the tree that traps it:

- **Portals.** React's `createPortal`, Vue's `<Teleport>` and Svelte's portal libraries render the element as a child of `<body>` while keeping it in the component tree for events and context. It then participates in the root stacking context, and a small, documented z-index scale (`dropdown: 1000`, `modal: 1100`, `toast: 1200`) decides the rest. The cost: you have to position it yourself, for example with Floating UI or CSS anchor positioning.
- **The top layer.** Elements shown with `dialog.showModal()`, the Popover API (`popover` attribute, `showPopover()`), and fullscreen elements are promoted to the browser's **top layer**. It's painted above the whole document, regardless of z-index, stacking contexts, `overflow: hidden` or transforms on ancestors. Elements in it are stacked in the order they were added. `::backdrop` renders just below each one.

The top layer removes most of the reasons for z-index wars. A modal `<dialog>` and a popover menu don't need any z-index at all.

### Debugging

- **Chrome DevTools Layers panel** (More tools → Layers) shows compositing layers. They aren't the same thing as stacking contexts, but they often overlap, and the panel shows why each was created.
- **Edge's 3D View** has a z-index mode that shows the stacking contexts and their z-index values as a 3D stack.
- **Walk up the tree.** In the Elements panel, check each ancestor's computed `position`, `z-index`, `opacity`, `transform`, `filter`, `will-change`, `isolation` and `contain`. The first one that creates a context is the one whose z-index is actually being compared.
- Browser extensions such as "CSS Stacking Context inspector" add a panel that lists the context for each element and the reason it was created.

## Where it's used

| Situation | Typical approach |
|---|---|
| Modals and confirmations | `<dialog>` with `showModal()` (top layer), or a portal to `<body>` |
| Menus, tooltips, selects | Popover API, or a portal plus Floating UI / CSS anchor positioning |
| Sticky headers and sidebars | `position: sticky` with a z-index from a shared scale |
| Component libraries | `isolation: isolate` on component roots to keep internal z-index local |
| Design systems | named z-index tokens (`--z-dropdown`, `--z-modal`, `--z-toast`) instead of raw numbers |
| Animations | aware that `transform`, `opacity` and `will-change` create contexts during (and sometimes after) an animation |
| Maps, editors, canvases | stacked absolutely positioned layers inside one isolated container |

## Use case walk-through: a modal behind the header

A settings page has a sticky header (`position: sticky; z-index: 50`). The **Delete account** button opens a confirmation modal with `position: fixed; z-index: 9999`. The modal's overlay covers the page, but the header stays on top of it and its buttons remain clickable.

1. **Find the modal's context.** Walking up from the modal in DevTools, the first ancestor that creates a stacking context is `.settings-panel`, which has `transform: translateY(0)` left behind by a slide-in animation.
2. **Understand the comparison.** The panel has no z-index, so its context sits at level 0 (step 6) in the root context. The header's 50 beats it. The modal's 9999 is only compared inside the panel. And because a transformed ancestor becomes the containing block for `position: fixed`, the modal is also positioned relative to the panel, not the viewport.
3. **Try the quick fix.** Removing the leftover transform works, until the next animation adds one. The structure is still fragile.
4. **Move the modal to the top layer.** The modal becomes a `<dialog>` opened with `showModal()`. It's now painted above the header and everything else, focus is trapped inside it, Esc closes it, and the rest of the page becomes inert. Its z-index is deleted.
5. **Tidy up the scale.** The remaining z-index values (header 50, a toast 60) move into tokens, and the slide-in animation clears its transform with `animation-fill-mode: none`.
6. **Result.** The modal always appears above the header, works inside any animated container, and the codebase has no z-index above 100.

## Pitfalls

- **Raising z-index instead of reading the tree.** If two elements are in different contexts, no value on the inner one can fix it.
- **z-index on a static element.** Outside flex and grid, it does nothing. Add `position: relative` (and be aware that this, plus a z-index, creates a context).
- **Accidental contexts from effects.** `opacity`, `transform`, `filter` and `will-change` all create contexts. A leftover `transform: none` doesn't, but `translate(0)` does.
- **`overflow: hidden` clips regardless of z-index.** Stacking decides what's on top; overflow decides what's visible. A dropdown inside an `overflow: hidden` card is cut off even if it would otherwise be on top. Portals and the top layer fix both.
- **Fixed positioning inside transforms.** A `transform`, `filter` or `perspective` on an ancestor makes `position: fixed` behave like `absolute` relative to that ancestor.
- **Unmanaged numbers.** Without a shared scale, every team picks a bigger number. Keep a small set of named layers and stick to it.

> [!TIP]
> Before changing any z-index, answer one question: "What is the nearest ancestor of each element that creates a stacking context?" If they differ, compare the z-index of the two ancestors that are siblings in the common context. That's the comparison the browser is actually making.

## Discussion questions

1. Why does `z-index: 9999` on a dropdown lose to `z-index: 2` on a header, and what are three ways to fix it?
2. What's the difference between `z-index: auto` and `z-index: 0` on a positioned element?
3. Why does adding `opacity: 0.99` or a hover `transform` sometimes change which element is on top?
4. When would you use `isolation: isolate` rather than `position: relative; z-index: 0`?
5. What does the top layer solve that portals don't, and what do portals still offer?
6. How would you design a z-index scale for a design system used by many teams?

## FAQ

### Is a stacking context the same as a compositing layer?

No. A stacking context is a CSS concept that controls paint order. A compositing layer is a browser implementation detail: a separately rasterized surface the GPU can move. Some properties (`transform`, `will-change`, `opacity` animations) cause both, so the two often coincide, but an element can create a stacking context without its own layer, and vice versa.

### Does `position: relative` alone create a stacking context?

No. A positioned element with `z-index: auto` doesn't form a context. It's painted in step 6 of its parent's order, and its positioned children still take part in the parent's context. Adding any integer z-index, including 0, makes it a context.

### Why does my negative z-index element disappear?

`z-index: -1` paints the element behind the content of its nearest stacking context. If that context is the root, the element goes behind the body's background and seems to vanish. Make the intended parent a stacking context (for example with `isolation: isolate`) so the element stays above that parent's background.

### Do `<dialog>` and popovers still need z-index?

No. When opened with `showModal()` or `showPopover()`, they're in the top layer, which is painted above everything in the document regardless of z-index. A non-modal `dialog.show()` is not in the top layer and behaves like a normal element.

### What's the maximum z-index?

Browsers store it as a signed 32-bit integer, so 2,147,483,647. Larger values are clamped. Reaching for it is a sign of a structural problem: a higher number can't escape a stacking context.

## Key takeaways

- z-index is compared only between siblings in the same stacking context; each context is painted as one unit in its parent.
- Inside a context, paint order is: background, negative z-index, blocks, floats, inline content, positioned `auto`/0, positive z-index.
- z-index applies to positioned elements and flex/grid items; `0` creates a context, `auto` doesn't.
- Many visual effects create contexts: `opacity`, `transform`, `filter`, `will-change`, `fixed`/`sticky`, `contain` and `isolation`.
- Fix layering by changing structure: raise or remove the ancestor's context, use a portal, or use the top layer with `<dialog>` and popovers.

## References

- MDN: [Stacking context](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_positioned_layout/Stacking_context)
- MDN: [z-index](https://developer.mozilla.org/en-US/docs/Web/CSS/z-index)
- MDN: [isolation](https://developer.mozilla.org/en-US/docs/Web/CSS/isolation)
- MDN: [Top layer](https://developer.mozilla.org/en-US/docs/Glossary/Top_layer)
- W3C: [CSS 2.1, Appendix E: Elaborate description of stacking contexts](https://www.w3.org/TR/CSS21/zindex.html)
- W3C: CSS Positioned Layout Module Level 3 (Editor's Draft)
- Josh W. Comeau, "What The Heck, z-index??" (joshwcomeau.com, 2021)
- Philip Walton, "What No One Told You About Z-Index" (philipwalton.com, 2013)

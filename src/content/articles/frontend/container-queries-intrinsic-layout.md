---
summary: Why viewport media queries break reusable components, how container queries and container units let a component respond to its own space, and how intrinsic CSS (auto-fit grids, flex-wrap, clamp) removes many breakpoints entirely.
updated: 2026-11-02
---

> [!KEY]
> Media queries ask "how wide is the viewport?", but a component's layout depends on how much space *it* gets. Container queries let a component respond to its nearest container. You mark a wrapper with `container-type: inline-size`, then write `@container (width > 400px) { … }`, and size things with `cqi` units. Intrinsic layout goes further and avoids breakpoints altogether: `repeat(auto-fit, minmax(14rem, 1fr))`, `flex-wrap`, `clamp()` and `min()` let content and available space decide. Together they make components portable across any slot. Media queries remain right for page-level layout and user preferences.

## The problem: the card that only works in one place

A product card has two layouts: stacked (image above text) and wide (image beside text). With media queries the rule reads "go wide when the viewport is at least 900px". Then the same card is used:

- in a 220px sidebar on a desktop: the viewport is wide, so the card goes side-by-side and gets squashed,
- in a three-column grid: each cell is narrow on a wide screen,
- in a modal, a drawer, or a split-view dashboard where users resize panes.

Teams respond with modifier classes like `.card--in-sidebar`, or with JavaScript that measures widths using `ResizeObserver`. The component now has to know where it's placed, which defeats the point of having a component.

## How it works

### Querying the container, not the viewport

![Media vs container query](/figures/container-queries/same.svg "With a media query the sidebar card goes wide because the viewport is wide; with a container query each card follows its own slot.")

```css
.card-slot { container: card / inline-size; }

.card { display: grid; gap: 1rem; }

@container card (width > 400px) {
  .card { grid-template-columns: 8rem 1fr; }
}
```

- `container-type: inline-size` makes the element a **query container** for its width. The `container` shorthand also gives it a name.
- `@container card (…)` matches against the nearest ancestor container named `card`. If you leave the name out, it matches the nearest container of any name.
- The card's styles now depend only on its slot. The same component works in a sidebar, a grid cell, a modal or the main column.

Container size queries have been supported in all major browsers since early 2023.

### Why containment is required

![Container query setup](/figures/container-queries/setup.svg "Inline-size containment means the container's width can't depend on its children, so queries can't feed back into the size they query.")

If a container's width depended on its children, and the children's styles depended on that width, layout could loop. Wider children make a wider container, which flips the query, which makes narrower children, and so on.

`container-type: inline-size` applies **inline-size containment**: the browser lays out the container's width as if it were empty, using only the parent's constraints. Children can't affect it, so the query is safe. In practice:

- **Query a wrapper, not the component itself.** An element can't query its own size, only an ancestor's. A thin slot or wrapper element is the usual container.
- **`inline-size` vs `size`:** `size` also contains the height. The container then needs an explicit height, or it collapses. Most layouts only need `inline-size`.
- **Shrink-to-fit containers lose their natural width.** A container inside a flex row with no set width or `flex: 1` can collapse to zero.

### Container query units

| Unit | Relative to |
|---|---|
| `cqi` / `cqb` | 1% of the container's inline / block size |
| `cqw` / `cqh` | 1% of its width / height |
| `cqmin` / `cqmax` | The smaller / larger of `cqi` and `cqb` |

With these units, type and spacing scale with the component's slot instead of the viewport, for example `font-size: clamp(1rem, 4cqi, 1.5rem)`. If there's no container, the units fall back to small-viewport units.

### Style and scroll-state queries

- **Style queries** (`@container style(--variant: compact)`) match the computed value of a custom property on the container. They let a parent switch child themes or variants without extra classes. Custom-property style queries are supported in Chromium and Safari. Check current support before relying on them.
- **Scroll-state queries** (`@container scroll-state(stuck: top)`) style a sticky header when it is stuck, or a scroll container that can be scrolled. They're newer and currently Chromium-only.

### Intrinsic layout: fewer breakpoints

![Intrinsic grid](/figures/container-queries/grid.svg "auto-fit with minmax fits as many columns as can be at least 14rem wide, in any container, without media queries.")

Many breakpoints aren't needed at all if the layout is written in terms of content and available space:

| Technique | What it does |
|---|---|
| `grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr))` | As many columns as fit at ≥14rem, stretched to fill |
| `minmax(min(14rem, 100%), 1fr)` | The same, but never overflows a container narrower than 14rem |
| `display: flex; flex-wrap: wrap` plus `flex: 1 1 18rem` | Items sit side by side until they'd shrink below 18rem, then wrap |
| `width: min(65ch, 100%)` | A readable line length that still fits small screens |
| `font-size: clamp(1rem, 0.9rem + 1vw, 1.25rem)` | Fluid type with a floor and a ceiling |
| `aspect-ratio`, `object-fit` | Media keeps its shape at any width |
| `fit-content`, `min-content`, `max-content` | Sizes derived from the content itself |

This style is often called **intrinsic web design**, a term from Jen Simmons. Container queries handle the remaining cases where the *arrangement* has to change, not just the sizes.

### Media queries still matter

Media queries stay the right tool for:

- page-level layout, such as when the app shell switches from a bottom nav to a sidebar,
- user preferences: `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-contrast`,
- device capabilities: `hover`, `pointer: coarse`, `print`.

A good rule of thumb: **macro layout uses media queries, and components use container queries and intrinsic sizing.**

## Where it's used

| Context | How it helps |
|---|---|
| Design system components | Cards, media objects and toolbars adapt to whatever slot they're placed in |
| Dashboards with resizable panels | Widgets reflow as the user drags splitters, with no `ResizeObserver` code |
| CMS and page builders | Editors drop components into any column width |
| E-commerce grids | Product tiles adapt to 2, 3 or 4-column layouts and filter sidebars |
| Embeddable widgets | Third-party widgets respond to the host's container, not the host's viewport |

## Use case walk-through: a dashboard widget library

A dashboard lets users arrange widgets in a resizable grid. Each widget used JavaScript with `ResizeObserver` to toggle classes like `is-compact`. That caused a flash of the wrong layout on load and extra work on every resize.

1. **Make every grid cell a container.**
   ```css
   .cell { container: widget / inline-size; }
   ```
2. **Replace JavaScript breakpoints with container queries.** The KPI widget stacks its value under its label below 280px, and shows a sparkline above 420px:
   ```css
   @container widget (width > 420px) { .kpi__spark { display: block; } }
   ```
3. **Scale type with the slot:** `font-size: clamp(1.25rem, 8cqi, 2.5rem)`.
4. **Use intrinsic layout inside widgets.** The table widget's filter bar uses `flex-wrap`, and the image grid uses `auto-fit` and `minmax`, so no breakpoints are needed.
5. **Handle the edge case.** A widget placed in a flex row had collapsed to zero width once it became a container. Fix it by giving it `flex: 1 1 20rem`.
6. **Delete the code.** Remove 400 lines of resize-observer logic and the `is-*` modifier classes.

**Result:** widgets render correctly on first paint, with no layout flash. Resizing panels no longer runs JavaScript. A widget now behaves identically in any cell, modal or sidebar.

## Pitfalls

- **Querying the element itself.** A container query applies to *descendants* of the container. To change the container's own styles, add a wrapper.
- **Collapsing containers.** Inline-size containment ignores the children's width, so containers in shrink-to-fit contexts (inline-block, floats, flex items without a basis, grid `auto` columns) can become 0px wide. Give them a width or a flex basis.
- **Using `container-type: size` by accident.** It contains height too. Without an explicit height the container collapses vertically.
- **Unnamed containers in nested layouts.** An unnamed `@container` matches the *nearest* container, which may be an unexpected inner one. Name containers once nesting appears.
- **Breakpoints that duplicate intrinsic behaviour.** Three container queries that change column counts are usually one `auto-fit` grid.
- **Forgetting user preferences.** Container queries don't replace `prefers-reduced-motion` or `prefers-color-scheme`.

> [!TIP]
> Reach for intrinsic sizing first (`auto-fit`, `flex-wrap`, `clamp`, `min`). Add a container query only when the *arrangement* must change. Keep media queries for the page shell and user preferences.

## Discussion questions

1. Why does a container query need containment, and what layout loop does it prevent?
2. When would a media query still be the right choice for a component?
3. How would you write a card grid that needs no breakpoints, and what does `min(14rem, 100%)` add?
4. What are the trade-offs between `cqi` units and viewport units for fluid typography?
5. How could style queries replace modifier classes in a design system, and what's the support risk?
6. A widget becomes 0px wide after you add `container-type`. What's going on, and how do you fix it?

## FAQ

### Are container queries supported in all browsers?

Size queries and container units are, in all evergreen browsers since 2023. Style queries for custom properties and scroll-state queries are newer and have partial support. Use them as progressive enhancements.

### Do container queries hurt performance?

Not meaningfully for typical use. Containment can even help, because it limits how far layout changes propagate. Avoid making thousands of tiny elements into containers without a reason.

### Can I query the height of a container?

Yes, with `container-type: size`, but then the container's height must not depend on its content. Give it an explicit or stretched height. Most component layouts only need width.

### Should I replace all my media queries?

No. Move *component-level* breakpoints to container queries. Keep media queries for page layout, print styles and user preferences.

### How do container queries relate to ResizeObserver?

They cover the most common reason to use `ResizeObserver`: changing styles when an element's size crosses a threshold. They do it in CSS, before first paint, without JavaScript. `ResizeObserver` is still useful when you need the size in script, for example to draw a canvas chart.

## Key takeaways

- Media queries measure the viewport, but components care about their own slot. Container queries measure the container.
- `container-type: inline-size` adds containment, so children can't affect the width they query. Query a wrapper.
- `cqi` and related units scale type and spacing with the component.
- Intrinsic layout (`auto-fit`/`minmax`, `flex-wrap`, `clamp`, `min`) removes most breakpoints.
- Use media queries for the page shell and user preferences, and container queries and intrinsic sizing for components.

## References

- MDN: [CSS container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries)
- MDN: [Container size and style queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_size_and_style_queries)
- W3C: [CSS Conditional Rules Module Level 5](https://www.w3.org/TR/css-conditional-5/)
- web.dev: [Container queries land in stable browsers](https://web.dev/blog/cq-stable)
- Una Kravets, [Container queries](https://developer.chrome.com/docs/css-ui/container-queries), developer.chrome.com
- Jen Simmons, "Intrinsic Web Design", talks and writing, 2018
- Every Layout (Heydon Pickering and Andy Bell), [every-layout.dev](https://every-layout.dev/)

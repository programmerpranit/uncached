---
summary: How to show 10,000 or 1,000,000 rows without 10,000 DOM nodes. Covers the windowing idea, computing the visible range, overscan, spacers vs transforms, variable and dynamic row heights, grids, infinite loading, accessibility and find-in-page trade-offs, and when CSS content-visibility is enough.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A **virtualized** (or **windowed**) list renders only the rows near the viewport, plus a few extra (**overscan**), and fakes the rest:
>
> - a container with the list's **full height** keeps the scrollbar honest;
> - on scroll, the list computes which indices are visible from `scrollTop` and the row heights;
> - only those rows are mounted, each placed at its offset with `transform` or absolute positioning.
>
> DOM size, render time and memory become proportional to the **viewport**, not to the data. The hard parts are rows whose height isn't known in advance (estimate, measure, correct), and what you lose by not having everything in the DOM: browser find-in-page, some screen-reader navigation, and printing.

## The problem: the DOM doesn't scale to big lists

A log viewer, a spreadsheet, a chat history or an admin table can easily hold 10,000+ rows. Rendering every row means every row's elements exist: each is created, styled, laid out and kept in memory, and a framework also keeps its virtual tree and component instances.

With 10,000 rows of about 8 elements each, that's 80,000 DOM nodes. The initial render takes seconds, every style change recalculates styles for all of them, memory climbs into the hundreds of MB on low-end phones, and a filter that re-renders the list freezes the page. Pagination avoids this, but it isn't always acceptable: users want to scroll, search visually and keep context.

Most of that work is wasted. A 600-pixel viewport shows maybe 15 rows.

## How it works

### The window

![A scroll container where only rows near the viewport are rendered, with spacers standing in for the rest](/figures/virtualization/window.svg "The scrollable height is real; the rows are only rendered where you can see them.")

The structure has three layers:

1. **The scroll container**: a fixed-height element with `overflow: auto` (or the window itself).
2. **The sizer**: an inner element whose height is the total height of all rows, say 10,000 × 40 px = 400,000 px. It gives the scrollbar the right size and range.
3. **The rendered rows**: only the rows in the current range, each positioned at its offset.

On every scroll event (or in a `requestAnimationFrame` after one), the list computes the range. With fixed 40-pixel rows and a 400-pixel viewport:

```js
const start = Math.max(0, Math.floor(scrollTop / 40) - overscan);
const end = Math.min(count, Math.ceil((scrollTop + 400) / 40) + overscan);
```

It renders rows `start` to `end` and places each at `index * 40`. Positioning can use `transform: translateY()` on each row (cheap, composited), absolute `top`, or a top spacer element followed by the rows in normal flow. When the range changes, rows leaving the window unmount and new ones mount; libraries key rows by index or item ID so the framework can reuse elements.

### Overscan

If only the exact visible rows are rendered, fast scrolling shows blank space for a frame before new rows appear, because the scroll moves on the compositor thread while rendering happens on the main thread. **Overscan** renders a few extra rows above and below the viewport (typically 3 to 10, or a fraction of a viewport) so there's content ready when the user scrolls. More overscan means fewer blank flashes and more work per update. Some libraries increase overscan in the scroll direction.

### What it saves

![Bar comparison: rendering every row costs far more DOM nodes, render time and memory than rendering a window](/figures/virtualization/cost.svg "Cost becomes proportional to the viewport instead of the data. Numbers are illustrative.")

The cost of a virtualized list is roughly constant, whatever the data size: a few dozen rows rendered, updated as you scroll. The exact gains depend on row complexity and device, but they're usually orders of magnitude for lists in the thousands. The data itself still lives in JavaScript memory; virtualization doesn't make holding a million objects free, it makes rendering them cheap.

### Variable and dynamic heights

![Steps for variable row heights: estimate, render, measure with ResizeObserver, then correct offsets](/figures/virtualization/variable.svg "Unknown heights are estimated, then measured and corrected as rows render.")

Fixed heights make the math trivial. Real content (chat messages, comments, cards with images) has different heights, often unknown until rendered. Libraries handle three cases:

- **Known variable heights.** If a function can give each row's height from its data, the list builds an **offset table** of prefix sums. The first visible row is found with a binary search on `scrollTop`.
- **Unknown heights, estimated.** Unmeasured rows use an **estimated** height. When a row renders, its real height is measured (via `ResizeObserver` or `getBoundingClientRect`), cached, and the offsets after it are updated. The total height, and the scrollbar, adjust as measurements arrive.
- **Rows that change size.** An image loads, or a message is expanded. `ResizeObserver` reports the new height and offsets are updated again.

The tricky part is **scroll anchoring**: if a row **above** the viewport changes height, everything below shifts, and the content under the user's eyes jumps. Libraries compensate by adjusting `scrollTop` by the same delta. Browsers do something similar natively (`overflow-anchor`), but absolutely positioned rows defeat it, so virtual lists usually handle it themselves.

Reverse lists (chat, logs that stick to the bottom) add the reverse problem: new items arrive at the bottom and older ones are prepended at the top, which needs the same scroll compensation to keep the view stable.

### Grids, tables and horizontal lists

The same idea works in two dimensions. A data grid virtualizes **rows and columns**: it renders only the cells in the visible rectangle, with separate offset tables for column widths and row heights. Sticky headers and frozen columns are rendered outside the virtual area and synced to the scroll position. Horizontal carousels virtualize along x in the same way.

### Infinite loading

Virtualization is about rendering; **infinite loading** is about fetching. They're often combined: the list knows the total count (or an estimate), renders placeholders for indices without data, and when the visible range gets close to the end of what's loaded, it fetches the next page. An `IntersectionObserver` on a sentinel row or a range check in the scroll handler triggers the fetch. Keeping only nearby pages in memory, and dropping far-away ones, lets the data side scale too.

### The lighter alternative: content-visibility

CSS `content-visibility: auto` tells the browser to skip layout and painting for an element's contents while it's off screen, while keeping the elements in the DOM. Paired with `contain-intrinsic-size: auto 500px` (a placeholder size, remembered once rendered), it gives much of the rendering benefit for long pages and lists of hundreds of items, with no JavaScript, and keeps find-in-page, anchors and accessibility working.

It doesn't remove the cost of **creating** the elements, or the framework's memory for them, so for tens of thousands of rows a JavaScript virtualizer is still needed.

## Where it's used

| Tool / product | Approach |
|---|---|
| TanStack Virtual | headless virtualizer for React, Vue, Solid, Svelte and Lit; fixed, variable and dynamic sizes |
| react-window, react-virtuoso | React list and grid components; Virtuoso handles dynamic heights and reverse (chat) lists |
| AG Grid, MUI Data Grid, Glide Data Grid | row and column virtualization in data grids; Glide draws cells on a canvas |
| VS Code, Monaco editor | virtualized lines in the editor and virtualized trees and lists in the UI |
| Android `RecyclerView`, iOS `UICollectionView` | native equivalents that recycle row views as they scroll off screen |
| Flutter `ListView.builder`, React Native `FlatList` | build items lazily as they come into view |
| Long articles, docs, feeds | `content-visibility: auto` on sections |

## Use case walk-through: a 50,000-line log viewer

An internal tool shows build logs. Large logs have 50,000 lines and the page takes 9 seconds to become usable; scrolling stutters, and searching for an error freezes the tab.

1. **Measure.** The Performance panel shows a 6-second initial render, 400,000 DOM nodes (each line has a timestamp, level badge, text and a copy button) and long style recalcs.
2. **Virtualize with fixed heights.** Lines are rendered in monospace with no wrapping, so every row is 20 px. A virtualizer renders about 40 lines plus 10 of overscan in each direction. Initial render drops to 40 ms.
3. **Handle long lines.** Some lines wrap when a "wrap lines" toggle is on. With it enabled, the list switches to dynamic measurement: an estimated 20 px, then real heights from `ResizeObserver`.
4. **Replace find-in-page.** Ctrl+F only finds lines that are rendered, so the tool adds its own search box: it searches the data array, shows the match count, and calls `scrollToIndex(matchIndex)` to jump. It also highlights matches in the rendered rows.
5. **Follow the tail.** When the build is still running, new lines are appended. If the user is at the bottom, the list stays pinned to it; if they've scrolled up, it shows a "new lines" button instead of jumping.
6. **Keep it accessible.** The container is a `role="log"` region with a label. Rows have `aria-setsize` and `aria-posinset` so screen readers announce "line 3,201 of 50,000", and keyboard navigation (arrows, Page Up/Down, Home/End) moves through the data and scrolls the list.
7. **Result.** The log opens in under 200 ms, scrolling holds 60 fps, and search over 50,000 lines takes under 30 ms.

## Pitfalls

- **Virtualizing too early.** For a few hundred simple rows, plain rendering (maybe with `content-visibility`) is simpler and keeps all browser features. Virtualize when profiling shows the list is the bottleneck.
- **Broken find-in-page.** Browser search only sees rendered rows. Provide your own search, or keep the list small enough not to need virtualization.
- **Accessibility gaps.** Screen readers only see rendered rows, so they can't tell how long the list is. Use `aria-setsize`/`aria-posinset` (or `aria-rowcount`/`aria-rowindex` in grids), keep focus on a stable element, and support keyboard navigation through the data.
- **Losing focus and state on unmount.** A row with a focused input or an open menu that scrolls out of the window is unmounted, and its local state is lost. Keep the state outside the row, or keep the focused row mounted.
- **Expensive rows.** Virtualization limits how many rows render, not how expensive each is. A row with heavy components still makes scrolling janky; memoize rows and keep them light.
- **Scroll jumps with dynamic heights.** Bad estimates cause the scrollbar thumb to drift and the content to jump as rows are measured. Use realistic estimates and scroll compensation.
- **Very large totals.** Browsers cap element heights (around 16 to 33 million pixels, depending on the browser). Lists past a million rows need scaling tricks, where scroll positions are mapped to indices non-linearly.

> [!TIP]
> Try `content-visibility: auto` with a `contain-intrinsic-size` first. If the list is still slow because there are simply too many elements, move to a virtualizer, and plan from the start for search, keyboard navigation and accessibility, since the browser no longer provides them for free.

## Discussion questions

1. How does a virtualized list keep the scrollbar size and position correct while rendering only 20 rows?
2. Why is overscan needed, and what are the costs of making it larger?
3. How would you virtualize a chat with variable-height messages, where new messages arrive at the bottom and old ones load at the top?
4. Which browser features break when a list is virtualized, and how would you restore each?
5. When is `content-visibility: auto` enough, and when do you need a JavaScript virtualizer?
6. A virtualized table still scrolls at 30 fps. What would you look at next?

## FAQ

### What's the difference between virtualization and pagination?

Pagination splits the **data** into pages and shows one at a time; the user navigates between them. Virtualization keeps one continuous scrollable list and only splits the **rendering**. They combine well: infinite loading fetches pages of data, and virtualization renders whatever part of the loaded data is on screen.

### Does virtualization help if my data has 200 rows?

Usually not. 200 simple rows render quickly, and virtualizing them costs find-in-page and adds complexity. It starts to pay off at thousands of rows, or hundreds of very expensive rows (rich cells, charts, images).

### Why do rows flash blank when I scroll fast?

Scrolling happens on the compositor thread, which moves the content immediately; rendering the newly visible rows happens on the main thread, which may be a frame or more behind. Increase overscan, make rows cheaper to render, and avoid long tasks on the main thread during scroll.

### How do screen readers handle virtualized lists?

They only see what's in the DOM. Without help, a user might hear "list, 30 items" for a list of 10,000. Setting `aria-setsize` and `aria-posinset` on rows (or `aria-rowcount` and `aria-rowindex` in a grid) announces the real size and position, and keyboard handling moves through the full data set.

### Can I virtualize a CSS grid of cards with responsive columns?

Yes. Group cards into rows based on the current column count (from the container width), and virtualize those rows. When the width changes, recompute the column count and the row grouping. Libraries such as TanStack Virtual and react-virtuoso support this layout.

## Key takeaways

- Virtualization renders only the rows near the viewport plus overscan, inside a container sized for the whole list.
- Rendering cost becomes proportional to the viewport, not the data size.
- Fixed heights are simple; variable heights need an offset table, estimates, measurement and scroll compensation.
- Off-screen rows don't exist, so find-in-page, screen-reader context and row state need explicit handling.
- For moderate lists, try `content-visibility: auto` first; virtualize when profiling shows you need it.

## References

- web.dev: [Virtualize large lists with react-window](https://web.dev/articles/virtualize-long-lists-react-window)
- web.dev: [content-visibility: the new CSS property that boosts your rendering performance](https://web.dev/articles/content-visibility)
- MDN: [content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility)
- MDN: [ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)
- MDN: [aria-setsize](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-setsize)
- TanStack Virtual documentation (tanstack.com/virtual)
- Brian Vaughn, react-window (github.com/bvaughn/react-window)

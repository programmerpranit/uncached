---
summary: What screen readers and other assistive technologies actually see when they read your page. Covers how the browser builds the accessibility tree from the DOM, roles, names, states and relationships, how accessible names are computed, what ARIA can and can't do, live regions, focus management, and why "no ARIA is better than bad ARIA".
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Assistive technologies (screen readers, voice control, switch devices) don't read your pixels or your raw DOM. They read the **accessibility tree**, a simplified tree the browser derives from the DOM, where each node has a **role** (button, link, heading), a **name** ("Save"), **states** (expanded, checked, disabled) and **relationships**.
>
> - Native HTML elements fill this tree correctly for free. A `<button>` is a focusable, keyboard-operable "button" with a name from its text.
> - **ARIA** attributes (`role`, `aria-*`) let you edit the tree when HTML has no element for what you're building, like tabs, comboboxes or live updates.
> - ARIA changes only what is **announced**. It adds no keyboard support, focus or behaviour, so a wrong or incomplete ARIA role is often worse than none.

## The problem: the screen shows one thing, the tree says another

A sighted mouse user sees a magnifying-glass icon and knows it's search. A screen reader user tabbing through the same page hears "button". Which button? It doesn't say, because the icon had no text and no label.

Modern UIs are full of these gaps: clickable `<div>`s that keyboard users can't reach, custom dropdowns that announce nothing when they open, toasts that appear and vanish without a sound, modals that let focus wander behind them. The page looks fine, but the information a non-visual user needs was never in the tree.

To fix this you have to think about the page the way assistive tech receives it.

## How it works

### From DOM to accessibility tree

As the browser builds the DOM and computes styles, it also builds an **accessibility tree** and exposes it through the operating system's accessibility API (UI Automation on Windows, NSAccessibility on macOS, AT-SPI on Linux). Screen readers such as NVDA, JAWS, VoiceOver and TalkBack query that API.

![The browser turns the DOM into an accessibility tree of roles, names and states, pruning wrappers; an icon-only button ends up with no name](/figures/a11y-tree/tree.svg "The accessibility tree keeps meaning and drops layout: wrappers disappear, labels fold into controls, and missing names show up as gaps.")

Along the way the browser:

- **Maps elements to roles.** `<nav>` becomes `navigation`, `<h1>` becomes `heading` level 1, `<input type=checkbox>` becomes `checkbox`, `<ul>` becomes `list` with a count.
- **Prunes** nodes with no meaning: generic `<div>`/`<span>` wrappers, elements with `display: none` or `visibility: hidden`, `aria-hidden="true"` subtrees, and decorative images with `alt=""`.
- **Computes names and descriptions** for each node.
- **Tracks states and properties**: `checked`, `expanded`, `selected`, `disabled`, `invalid`, `required`, current value, heading level.
- **Exposes relationships**: which label belongs to which input, which element controls which panel, list item position ("2 of 5").

You can inspect the result in Chrome DevTools (Elements → Accessibility pane, or the full-tree view) and Firefox's Accessibility Inspector. That's the fastest way to see what a screen reader will get.

Note that CSS can change the tree. `display: none` removes content, `display: contents` historically stripped semantics from tables and lists in some browsers, and CSS-generated `content:` text is included in names. Visual order changed with `order` or grid placement does **not** change reading order, which follows the DOM.

### Roles, names, states

Every interactive node needs three things for a user to operate it:

1. **Role**: what is it? (`button`, `link`, `tab`, `checkbox`)
2. **Name**: which one? ("Delete invoice", "Search")
3. **State**: what condition is it in? (pressed, expanded, checked, disabled)

A screen reader announces something like "Notifications, toggle button, pressed". Voice control users rely on names too: they say "click Search", which only works if the button's name is "Search".

### How the accessible name is computed

The browser follows the **Accessible Name and Description Computation** spec. In simplified form, the first source that produces text wins:

![Accessible name sources in order: aria-labelledby, aria-label, native label, contents, then title or placeholder](/figures/a11y-tree/name.svg "The first source that yields text wins, so aria-label silently overrides visible text.")

Two consequences trip people up:

- `aria-label` **replaces** visible text. `<button aria-label="Save">Submit</button>` is announced "Save", so a voice user saying "click Submit" fails. The WCAG "label in name" criterion asks that the accessible name include the visible label.
- `placeholder` and `title` are weak. Placeholders disappear when typing, and `title` tooltips aren't available to keyboard or touch users. Use a real `<label>`.

A **description** (`aria-describedby`, or `title` when it isn't used as the name) is read after the name, usually after a pause. It's the right place for hints like "Must be at least 12 characters".

### What ARIA is for

ARIA (Accessible Rich Internet Applications) is a W3C spec of attributes that override or add to the accessibility tree:

- **Roles** for widgets HTML lacks: `tablist`/`tab`/`tabpanel`, `combobox`, `listbox`, `menu`, `tree`, `grid`, `dialog` (before `<dialog>`), `switch`.
- **States and properties**: `aria-expanded`, `aria-pressed`, `aria-selected`, `aria-checked`, `aria-current="page"`, `aria-invalid`, `aria-disabled`.
- **Relationships**: `aria-controls`, `aria-labelledby`, `aria-describedby`, `aria-owns`, `aria-activedescendant`.
- **Live regions**: `aria-live`, `role="status"`, `role="alert"`.
- **Hiding**: `aria-hidden="true"` removes a subtree from the tree but leaves it visible.

The WAI-ARIA Authoring Practices Guide (APG) describes the expected roles, states and **keyboard interaction** for each widget pattern. Keyboard interaction is the part people skip.

### ARIA changes semantics, not behaviour

![Comparing a div with role button, which needs tabindex, key handlers and disabled logic added by hand, to a native button that has them built in](/figures/a11y-tree/div-vs-button.svg "A button role only changes what is announced. Everything else a button does, you have to rebuild.")

This is why the **first rule of ARIA** is: if a native HTML element or attribute already has the semantics and behaviour you need, use it. `<button>`, `<a href>`, `<input type=checkbox>`, `<select>`, `<details>`/`<summary>` and `<dialog>` come with focus, keyboard support, states and form integration.

Bad ARIA is actively harmful because it **promises** behaviour. If something is announced as a `menu`, screen reader users expect arrow keys to move between items. If arrow keys do nothing, the widget is worse than a plain list of links. WebAIM's annual analysis of the top million home pages consistently finds that pages using ARIA have more detected accessibility errors on average than pages without it.

Other common ARIA mistakes:

- `aria-hidden="true"` on something focusable: keyboard users land on an element the screen reader can't describe.
- `role="presentation"` on a focusable or semantic element, wiping its meaning.
- Redundant roles (`<button role="button">`, `<nav role="navigation">`): harmless but noisy.
- States that never update: `aria-expanded="false"` hard-coded on a disclosure that opens.

### Live regions

Screen readers read what has focus or what the user navigates to. Content that changes elsewhere, such as "Saved", a validation summary, or a chat message, is silent unless it's in a **live region**:

- `aria-live="polite"` (or `role="status"`): announce when the user is idle.
- `aria-live="assertive"` (or `role="alert"`): interrupt now. Reserve it for errors and urgent alerts.

The live region element must already exist in the DOM before you change its contents. Inserting a new element that already has `aria-live` and text is often not announced.

### Focus management

The accessibility tree describes the page, and **focus** is where the user is in it. Single-page apps need to manage focus explicitly:

- On client-side route changes, move focus to the new page's heading or main region (and update `document.title`), otherwise screen reader users don't know anything changed.
- When a modal opens, move focus into it, keep Tab inside it, and return focus to the trigger on close. `<dialog>` opened with `showModal()` does most of this and makes the rest of the page inert.
- When an item is deleted, move focus somewhere sensible instead of letting it fall to `<body>`.
- Never remove the focus outline without providing a visible replacement; `:focus-visible` lets you show it for keyboard users only.

## Where it's used

| Area | Accessibility tree concern |
|---|---|
| Design systems | Encode correct roles, names and keyboard patterns once in shared components |
| Headless UI libraries (Radix, React Aria, Headless UI) | Ship APG-compliant ARIA and keyboard logic without styling |
| Automated testing | axe-core, Lighthouse and Testing Library queries (`getByRole`) read the accessibility tree |
| End-to-end tests | Playwright's role locators and accessibility snapshots |
| Browser automation and AI agents | Many agents navigate pages through the accessibility tree rather than pixels |
| Legal compliance | WCAG 2.2 AA is referenced by the ADA (US) case law, Section 508, EN 301 549 and the European Accessibility Act |

## Use case walk-through: fixing a custom select

A product page has a custom "Size" picker: a `<div>` showing "Medium ▾" that opens a floating list of `<div>`s on click.

1. **Audit with a screen reader.** VoiceOver reads "Medium" as plain text. Tab skips it entirely. The list isn't announced when it opens.
2. **Check the tree.** DevTools shows two generic nodes with text and no role, no state, no relationship.
3. **Consider native first.** A styled `<select>` would handle everything. Newer browsers also support customizable selects via `appearance: base-select`, but design requires per-option images, so the team keeps a custom widget.
4. **Use a pattern.** They follow the APG "select-only combobox" pattern: a focusable `role="combobox"` with `aria-expanded`, `aria-controls` pointing at a `role="listbox"`, `role="option"` children with `aria-selected`, and `aria-activedescendant` tracking the highlighted option.
5. **Add the keyboard model.** Enter/Space/Alt+Down open, arrows move, typing jumps to matching options, Enter selects, Escape closes and returns focus.
6. **Name it.** A visible "Size" label is linked with `aria-labelledby`, so the control announces "Size, Medium, combobox, collapsed".
7. **Test.** Testing Library tests use `getByRole('combobox', { name: 'Size' })`, which fails if the name or role regresses. Manual checks with NVDA and VoiceOver confirm announcements.

**Result:** keyboard and screen reader users can choose a size, and the component's tests now break if someone removes the semantics. In hindsight, the team also notes that a native `<select>` would have been a fraction of the work.

## Pitfalls

- **Clickable divs and spans.** No focus, no keyboard, no role. Use `<button>` for actions and `<a href>` for navigation.
- **Icon-only buttons without names.** Add visible text, visually hidden text, or `aria-label`.
- **Images with missing or useless alt.** Decorative images need `alt=""`; informative ones need a description of their purpose, not "image".
- **Skipped or decorative headings.** Screen reader users navigate by headings. Use levels for structure, not font size.
- **Custom widgets without keyboard support.** If you use an ARIA widget role, implement the APG keyboard model.
- **Hiding content the wrong way.** `display: none` hides from everyone; `aria-hidden` hides only from assistive tech; a "visually hidden" class hides only visually. Pick deliberately.
- **Relying on automated tools alone.** Tools like axe catch roughly a third to half of WCAG issues. They can't tell whether a name makes sense or a focus order is logical.

> [!TIP]
> Write UI tests with role-based queries (`getByRole('button', { name: 'Save' })`). They read the accessibility tree, so they double as accessibility regression tests and survive markup refactors that don't change meaning.

## Discussion questions

1. Why does the browser keep a separate accessibility tree instead of letting screen readers walk the DOM directly?
2. When is `aria-label` the right tool, and when should you use visible text or `aria-labelledby` instead?
3. Your design system's `<Menu>` component uses `role="menu"` for site navigation. What problems might users hit?
4. How would you announce "3 new messages" in a chat app without interrupting a user who is typing?
5. What should happen to focus when a user deletes the last item in a list?
6. How might AI agents that browse through the accessibility tree change the incentives for teams to get semantics right?

## FAQ

### Do I need ARIA if I use semantic HTML?

Usually very little. Native elements give you correct roles, names and keyboard behaviour. You still need ARIA for live regions, for states HTML can't express (like `aria-expanded` on a disclosure button or `aria-current` on the active nav link), and for complex widgets with no native equivalent.

### What's the difference between `aria-hidden`, `hidden` and visually hidden?

`hidden` (or `display: none`) removes content for everyone. `aria-hidden="true"` keeps it on screen but removes it from the accessibility tree, which suits decorative icons. A visually-hidden CSS class keeps content in the tree but off screen, which suits extra context like "(opens in new tab)".

### Is a `<div role="button" tabindex="0">` acceptable?

It can be made accessible, but you must also handle Enter and Space, disabled states, focus styles and form submission yourself. A `<button>` with its default styles reset gives you all of that for free and is almost always the better choice.

### How do I test with a screen reader?

Use NVDA (free) with Firefox or Chrome on Windows, VoiceOver on macOS and iOS, and TalkBack on Android. Learn a few commands: read next item, list headings, list landmarks, tab through controls. Then try to complete your page's main task without looking.

### Does accessibility hurt performance or design?

No. Semantic HTML is usually less code than custom widgets, the accessibility tree is built anyway, and visible focus styles and labels can be designed to fit any brand. The cost comes from retrofitting late, not from doing it.

## Key takeaways

- Assistive tech reads the accessibility tree: roles, names, states and relationships derived from the DOM.
- Native HTML elements fill that tree correctly and come with keyboard behaviour; prefer them.
- Accessible names follow a fixed order, and `aria-label` overrides visible text.
- ARIA changes only what is announced. Any widget role you use carries a promise of keyboard behaviour you must implement.
- Live regions announce dynamic changes; focus management tells users where they are in SPAs and modals.
- Test with role-based queries, automated scanners and real screen readers; each catches different problems.

## References

- MDN: [Accessibility tree](https://developer.mozilla.org/en-US/docs/Glossary/Accessibility_tree)
- MDN: [ARIA](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA)
- W3C: [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/)
- W3C: [ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/)
- W3C: [Accessible Name and Description Computation 1.2](https://www.w3.org/TR/accname-1.2/)
- W3C: [Using ARIA (the five rules of ARIA use)](https://www.w3.org/TR/using-aria/)
- W3C: [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/)
- WebAIM: The WebAIM Million, annual accessibility analysis of the top 1,000,000 home pages (webaim.org/projects/million)

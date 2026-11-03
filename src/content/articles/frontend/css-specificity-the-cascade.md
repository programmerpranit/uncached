---
summary: How the browser decides which CSS rule wins when several apply to the same element. Covers the full cascade order (origin and importance, context, inline styles, cascade layers, specificity, source order), how specificity is calculated, the zero-specificity :where() and the argument-based :is() and :not(), inheritance and the initial, inherit, unset and revert keywords, and practical strategies like @layer, scoping and utility classes that keep specificity flat.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** When two declarations set the same property on the same element, the **cascade** picks one. It checks these in order and stops at the first difference:
>
> 1. origin and `!important`
> 2. shadow DOM context
> 3. inline `style` attributes
> 4. **cascade layers** (`@layer`)
> 5. **specificity**
> 6. **source order** (last one wins)
>
> Specificity is a triple of counts, **(ids, classes, types)**, compared left to right, so one id beats any number of classes. Most "CSS doesn't work" bugs are a more specific selector winning somewhere else. The modern fix is to keep specificity low and flat with `:where()`, and to control priority explicitly with `@layer` instead of escalating selectors or reaching for `!important`.

## The problem: "why isn't my style applying?"

You write `.button { color: white; }`, reload, and the text is still blue. DevTools shows your rule crossed out. Somewhere, a rule like `#sidebar a { color: blue; }` matches the same element and wins.

The usual reactions make it worse. Add a class to the selector, `.sidebar .button.primary`, and it wins today, but the next person has to go even more specific. Add `!important`, and now the only way to override it is another `!important`. Over a few years a codebase turns into a **specificity war**, where nobody can change a style without breaking another one.

CSS's rules for resolving conflicts are fully defined and predictable. They're just rarely taught in full.

## How it works

### Which declarations compete

First, the browser collects every declaration that applies to an element, from the browser's own default styles (the **user-agent** stylesheet), any user styles, and your stylesheets. Conflicts only exist between declarations for the **same property** on the **same element**. `color` from one rule and `margin` from another never compete, and both apply.

For each property, the browser sorts the competing declarations by the cascade criteria below and picks the first.

![Six nested steps: origin and importance, context, element-attached styles, cascade layers, specificity, order of appearance](/figures/css-cascade/order.svg "Each step only matters if every earlier step was a tie.")

1. **Origin and importance.** Normal author styles beat normal user styles, which beat the browser's defaults. `!important` **reverses** this order: an important user style beats an important author style. That's deliberate, so a user who needs large text or high contrast can override any website.
2. **Context.** With shadow DOM, styles from the outer page and from inside a component are compared. For normal declarations the outer page wins, and for `!important` the component's styles win.
3. **Element-attached styles.** A `style="…"` attribute beats any selector in a stylesheet.
4. **Cascade layers.** Declarations in a later-declared `@layer` beat earlier layers, and unlayered styles beat all layers.
5. **Specificity.** The more specific selector wins.
6. **Order of appearance.** If everything else ties, the declaration that comes last wins. That includes stylesheet order in the HTML.

Animations and transitions also take part. Running animations override normal declarations, and running transitions override even `!important` ones.

### Calculating specificity

Specificity is three separate counters, written **(A, B, C)**:

- **A:** id selectors (`#main`).
- **B:** class selectors (`.btn`), attribute selectors (`[type="text"]`) and pseudo-classes (`:hover`, `:nth-child()`).
- **C:** type selectors (`p`, `a`) and pseudo-elements (`::before`).

The universal selector `*` and combinators (` `, `>`, `+`, `~`) add nothing.

![A table of selectors with their A, B and C counts: p is 0,0,1, .btn is 0,1,0, #main .link is 1,1,0, :where(#main) a is 0,0,1, :is(#main, p) a is 1,0,1](/figures/css-cascade/specificity.svg "Compare A first, then B, then C. The counters never carry over into each other.")

The comparison goes column by column. A selector with one id, (1,0,0), beats a selector with fifteen classes, (0,15,0). It isn't a base-10 number: eleven classes don't "overflow" into an id.

Some pseudo-classes have special rules:

- **`:where(…)`** always contributes **zero**, whatever is inside it. That makes it perfect for default styles that should be easy to override.
- **`:is(…)`, `:not(…)` and `:has(…)`** take the specificity of their **most specific argument**. So `:is(#main, p) a` counts as (1,0,1) even when it matches through the `p`.
- **`:nth-child(… of S)`** adds one class-level point plus the most specific selector in `S`.

### Cascade layers

Cascade layers, supported in all major browsers since 2022, let you set priority by **group** instead of by selector weight:

```css
@layer reset, base, components, utilities;

@layer base       { #app a { color: navy; } }        /* (1,0,1) */
@layer components { .btn   { color: white; } }       /* (0,1,0) */
```

![Five stacked layers: reset, base, components, utilities, and unlayered styles; later layers win conflicts regardless of specificity](/figures/css-cascade/layers.svg "The layer order statement at the top fixes priority once, for the whole codebase.")

`.btn` wins even though `#app a` is far more specific, because layers are checked **before** specificity. Specificity only matters between rules in the same layer.

A few rules to remember:

- The first `@layer` statement sets the order. Declaring all layer names at the top of your main stylesheet makes it explicit.
- **Unlayered styles beat every layer.** That's handy during a migration, because old CSS outside layers keeps winning, but it surprises people who expect "no layer" to mean "lowest".
- For `!important`, layer order **flips**: an important declaration in an earlier layer beats one in a later layer. This lets a reset layer protect critical rules.
- Third-party CSS can be put into a low-priority layer with `@import url(lib.css) layer(vendor);`.

### Inheritance is separate

If no declaration sets a property on an element, the cascade has nothing to pick. Then **inheritance** applies: some properties, mostly text-related ones like `color`, `font-family` and `line-height`, take the parent's value. Others, like `margin`, `border` and `background`, reset to their initial values.

An inherited value always loses to any rule that targets the element directly, even `* { color: black }` with zero specificity. That's a common source of confusion: "my `body { color: red }` doesn't reach this link" is usually the user-agent stylesheet's `a { color: … }` targeting the link itself.

The global keywords control this explicitly:

- **`inherit`** takes the parent's value.
- **`initial`** uses the property's initial value from the spec (for `display`, that's `inline`, not the element's default).
- **`unset`** acts as `inherit` for inherited properties and `initial` for the rest.
- **`revert`** rolls back to the previous origin, usually the browser's defaults. **`revert-layer`** rolls back to the previous cascade layer.

### Strategies that keep specificity flat

- **Single-class selectors.** Methodologies like BEM (`.card__title--large`) give almost every rule (0,1,0), so source order and layers decide, not selector weight.
- **Utility classes.** Tailwind and similar frameworks apply one class per property and put utilities in the highest layer.
- **Scoped styles.** CSS Modules, Vue's scoped styles, shadow DOM and the native `@scope` rule limit where selectors match, so names don't collide across components. `@scope` also adds **scoping proximity** to the cascade: when specificity ties, the rule whose scope root is closer to the element wins.
- **Zero-specificity defaults.** Library authors write `:where(.btn) { … }` so that any user rule overrides them.
- **No ids for styling.** Keep ids for anchors, labels and JavaScript.

## Where it's used

| Context | Approach | Why |
|---|---|---|
| Design system libraries | `:where()` defaults, everything in a low layer | Consumers can override without fighting |
| Tailwind CSS v4 | Native `@layer theme, base, components, utilities` | Utilities always beat component styles |
| Large legacy apps | Wrap old CSS in a `legacy` layer during migration | New code wins without specificity hacks |
| Web components | Shadow DOM plus `::part()` for exposed styling hooks | Encapsulation with a controlled API |
| Content management systems | Low-specificity theme CSS, `revert` for user content | Authors and editors can both adjust styles |
| Accessibility tools | User style sheets with `!important` | Users can enforce fonts, sizes and contrast |

## Use case walk-through: ending a specificity war

A team's app has 9,000 lines of CSS, 140 uses of `!important`, and selectors like `#root .page .sidebar .nav ul li a.active`. A new button component won't style correctly anywhere.

1. **Audit.** A tool like Project Wallace or CSS Stats shows the specificity graph. Most rules sit at (0,1,0)–(0,3,0), with spikes above (1,0,0) from id-based layout rules.
2. **Declare layers** at the top of the main stylesheet: `@layer reset, legacy, components, utilities;`.
3. **Wrap the old CSS** in `@layer legacy { … }` (or `@import "old.css" layer(legacy);`). Now any rule in `components` beats it, whatever its specificity.
4. **Write new components with single classes** inside `@layer components`, and put a small set of utilities (spacing, visually-hidden) in `@layer utilities`.
5. **Handle `!important`.** Inside layers, important declarations reverse: an important rule in `legacy` now beats important rules in `components`. Search for `!important` in the legacy CSS and remove the ones that only existed to win specificity fights.
6. **Migrate gradually.** Each time a page is touched, move its styles from `legacy` into components and delete the old rules.

**Result:** new components style predictably from day one, the `!important` count drops sharply, and the legacy layer shrinks as pages are rewritten instead of needing a risky big-bang rewrite.

## Pitfalls

- **Escalating selectors.** Adding classes or ids to win a conflict sets up the next conflict. Fix the source of the conflict instead.
- **`!important` as a first resort.** It jumps to a separate tier of the cascade, and the only way out is another `!important`. Keep it for utilities that must always apply and for accessibility overrides.
- **Forgetting unlayered styles win.** Moving some CSS into layers can make the remaining unlayered CSS suddenly win everywhere.
- **Inline styles from JavaScript.** Libraries that set `element.style` beat every stylesheet selector, which makes themes hard to override.
- **Assuming `:is()` is zero-specificity.** Only `:where()` is. `:is(#id, .a)` carries id-level weight for every match.
- **Relying on stylesheet order across bundles.** Code-split CSS can load in different orders on different routes, so a rule that wins by source order on one page may lose on another. Layers make the order explicit.

> [!TIP]
> In Chrome or Firefox DevTools, the Styles panel lists every matching rule in cascade order, crosses out the losers, and shows each selector's specificity on hover. The Computed panel shows the single winning value and links back to the rule that set it. Start there before changing any selector.

## Discussion questions

1. Why does `!important` reverse the origin order, so that user styles beat author styles?
2. A rule with (0,1,0) in a later layer beats a rule with (1,0,1) in an earlier one. What problem does that solve?
3. When would you choose `:where()` over `:is()` in a component library?
4. Why might "unlayered styles win" be a good default for migrating to layers, and when does it cause trouble?
5. How does CSS-in-JS or CSS Modules change the role of specificity in an app?
6. Why is inheritance not part of the cascade's conflict resolution?

## FAQ

### Do inline styles always win?

They beat any selector-based rule in normal author styles. They lose to `!important` declarations in stylesheets, to running animations, and to important user styles.

### Does the order of classes in the class attribute matter?

No. `class="red blue"` and `class="blue red"` behave the same. What matters is the order of the rules in the CSS, along with their layers and specificity.

### How do I override styles inside a web component?

Shadow DOM blocks outside selectors from reaching inside. Components expose hooks: CSS custom properties (which do inherit through the shadow boundary), `::part()` for named parts and `::slotted()` for slotted content.

### Is the universal selector bad for performance?

Not in any meaningful way in modern browsers. `* { box-sizing: border-box }` is fine. Selector matching is rarely the bottleneck compared with layout and paint.

### What is the specificity of a style set with :host in a component?

`:host` counts as a pseudo-class, (0,1,0), and `:host(.x)` adds the specificity of its argument. Outer page styles on the host element still beat `:host` rules, because of the context step in the cascade.

## Key takeaways

- The cascade checks origin and importance, context, inline styles, layers, specificity and source order, in that order.
- Specificity is (ids, classes, types), compared column by column. One id beats any number of classes.
- `:where()` adds zero specificity. `:is()`, `:not()` and `:has()` take their most specific argument.
- Cascade layers let you set priority by group, and they're checked before specificity.
- Inheritance only applies when nothing targets the element directly.
- Keep selectors flat, avoid ids and `!important`, and use layers to make priority explicit.

## References

- MDN: [Introducing the CSS cascade](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Cascade)
- MDN: [Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)
- MDN: [Cascade layers](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics/Cascade_layers)
- MDN: [:where()](https://developer.mozilla.org/en-US/docs/Web/CSS/:where)
- W3C: [CSS Cascading and Inheritance Level 5](https://www.w3.org/TR/css-cascade-5/)
- CSS-Tricks: [A Complete Guide to CSS Cascade Layers](https://css-tricks.com/css-cascade-layers/)
- Polypane: [CSS Specificity Calculator](https://polypane.app/css-specificity-calculator/)

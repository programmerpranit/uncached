---
summary: How design tokens, primitives and components stack into a design system, and how to design component APIs (variants, composition, polymorphism, controlled state) that keep a product consistent without boxing teams in.
updated: 2026-11-02
---

> [!KEY]
> A design system is a layered set of decisions:
> - **Design tokens:** named values for colour, spacing, type and motion.
> - **Primitives:** layout and typography building blocks.
> - **Components:** accessible, typed building blocks.
> - **Patterns:** documented recipes built from components.
>
> The component API is where consistency is won or lost. Constrained props for things that must stay on-brand (`variant`, `size`, `tone`) and composition for content the system can't predict give you consistency without a pile of escape hatches. Treat the system as a product: version it, document it, measure adoption, and make the right thing the easiest thing.

## The problem: twelve slightly different buttons

Without a shared system, every team rebuilds the same UI. A product audit typically finds:

- a dozen button styles,
- seven shades of "brand blue",
- three modal implementations with different focus behaviour,
- spacing values like 13px and 15px that came from nowhere.

Each one was a reasonable local decision. Together they make the product look inconsistent, make accessibility fixes impossible to roll out, and make every redesign a rewrite.

A component library alone doesn't fix it. If the `Button` takes `color`, `padding` and `className` props, teams will recreate the twelve variants *through* the shared component. The API decides whether consistency is the default or a fight.

## How it works

### Layers, each built from the one below

![Design system layers](/figures/design-systems/layers.svg "Tokens, primitives, components, patterns, then product screens. Each layer uses only the layer below.")

| Layer | Contains | Example |
|---|---|---|
| Design tokens | Named design decisions | `space.4 = 16px`, `color.text.default`, `radius.md`, `motion.fast` |
| Primitives | Low-level layout and type | `Box`, `Stack`, `Grid`, `Text`, `Icon` |
| Components | Interactive, accessible UI | `Button`, `Dialog`, `Select`, `Tabs`, `Toast` |
| Patterns | Recipes and guidance | Form layout, empty states, error handling, data tables |
| Product | Screens built by feature teams | Checkout, settings, dashboards |

The rule that makes it work: each layer uses only the layer below. A component reads `space.4`, never `16px`. A screen uses `Stack gap="4"`, never a one-off margin. Change a token once and everything above it follows.

### Design tokens in three tiers

![Token tiers](/figures/design-systems/tokens.svg "Primitive tokens hold raw values, semantic tokens give them meaning, component tokens map meaning to use. A theme remaps the semantic tier.")

- **Primitive tokens** are the raw palette and scales: `blue-600`, `gray-50`, `space-4`.
- **Semantic tokens** describe *purpose*: `color.action.primary`, `color.text.danger`, `color.surface.raised`.
- **Component tokens** (optional) map purpose to a specific part: `button.primary.bg`.

Components should reference semantic or component tokens, never primitives. Then:

- dark mode,
- high-contrast mode,
- a second brand,
- a seasonal theme

are each just a new mapping of the semantic tier. On the web, tokens usually become CSS custom properties, so switching a theme is a matter of changing which set of variables applies. Tools like Style Dictionary compile one token source to CSS, iOS, Android and design tools. The W3C Design Tokens Community Group format standardises the JSON.

### Component API principles

Good component APIs share a few habits.

**1. Constrain what must stay consistent.** Use enumerated props, not open values:

```tsx
<Button variant="primary" size="md">Save</Button>
```

`variant: 'primary' | 'secondary' | 'ghost' | 'danger'` is a design decision encoded in a type. `color="#2563eb"` is an escape hatch.

**2. Compose what you can't predict.** Content and arrangement vary endlessly. Slots and compound components handle them without new props.

![Configuration vs composition](/figures/design-systems/api.svg "Props are consistent but explode with new needs; composition is flexible but easier to misuse. Mix the two.")

**3. Extend the platform, don't hide it.**
- Forward the native attributes (`type`, `disabled`, `aria-*`, event handlers) and the `ref`.
- A `Button` that drops `onKeyDown` or `form` forces people to fork it.

**4. Make polymorphism explicit.** A link that looks like a button needs `<a>` semantics. Two common shapes are `as` (`<Button as="a" href>`) and `asChild` (Radix-style, where `Button` passes its props to its child element). Either is fine. Wrapping a `<button>` around an `<a>` is not.

**5. Support controlled and uncontrolled use.** Stateful components like `Tabs`, `Dialog` and `Select` should work both ways:
- **Uncontrolled:** `defaultValue`. The component owns the state.
- **Controlled:** `value` plus `onValueChange`. The parent owns the state.

Name the props consistently across the whole library.

**6. Build accessibility in.** Focus management, keyboard support, ARIA roles and labelling belong inside the component, so every use gets them for free. Make required labels required in the types. An `IconButton` without `aria-label` shouldn't compile.

### Headless and styled layers

Many systems split the work:

- **Headless primitives** handle behaviour and accessibility with no styles. Examples are Radix Primitives, React Aria and Headless UI.
- **The styled layer** applies tokens and variants on top.

Teams with unusual needs can drop to the headless layer and still get correct keyboard and focus behaviour. Libraries such as shadcn/ui take a further step: you copy the styled source into your repo and own it from then on.

### Escape hatches, deliberately

Every system needs some escape hatch. Decide which ones you offer:

- `className` or `style` passthrough for layout only, such as margin and width,
- a `css` prop limited to tokens,
- dropping to headless primitives,
- a documented "detached" status for one-offs.

Track how often each is used. Heavy use of an escape hatch tells you a component or variant is missing.

## Where it's used

| System | Notable for |
|---|---|
| Material Design (Google) | Comprehensive guidance, tokens and components across platforms |
| Carbon (IBM) | Enterprise data-dense patterns and an open governance model |
| Polaris (Shopify) | Strong content and pattern guidance for merchant tools |
| Primer (GitHub) | Primitives and components for React and Rails view components |
| Spectrum (Adobe) | React Aria and React Spectrum: headless hooks plus a styled layer |
| Radix and shadcn/ui | Headless primitives, and a copy-into-your-repo styled layer |

## Use case walk-through: consolidating twelve buttons

A 60-engineer product team audits its UI. It finds 12 button styles, 4 dialog implementations (two of which trap focus incorrectly) and 140 distinct colour values.

1. **Inventory.** Screenshot every button and dialog, and grep for hex values. Group them by *intent*: primary action, secondary, destructive, quiet, link-like.
2. **Define tokens.** Collapse 140 colours into a palette of primitives, then about 30 semantic tokens such as `action.primary`, `text.muted` and `border.danger`. Light and dark themes are two mappings.
3. **Design the Button API.**
   - `variant: primary | secondary | ghost | danger`
   - `size: sm | md | lg`
   - `loading`, `iconStart`, `iconEnd`
   - `asChild` for links
   - all native button attributes and `ref`
   - No `color` or `padding` props.
4. **Build the Dialog on a headless primitive** so focus trapping, Escape to close and focus return are correct everywhere. Use compound parts: `Dialog.Trigger`, `Dialog.Content`, `Dialog.Title`, `Dialog.Close`.
5. **Migrate with codemods and lint.** A codemod maps old button classes to variants. An ESLint rule bans raw hex values and the legacy components in new code.
6. **Measure adoption.** A script counts imports of system components against legacy ones per package, each week. Leftover one-offs show up as feature requests: two teams needed a split button, so it became a component.

**Result:**
- 12 button styles became 4 variants.
- The focus bugs were fixed once, for every dialog.
- Dark mode shipped as a token mapping in two weeks.
- After a quarter, 94% of buttons were imported from the system.

## Pitfalls

- **Open-ended style props.** `color`, `padding` and `fontSize` props let teams recreate the inconsistency through the shared component.
- **Prop explosion.** Adding a boolean for every request (`hideIcon`, `compactFooter`, `titleBold`) creates combinations nobody tested. Reach for composition or a new variant.
- **Swallowing native behaviour.** Not forwarding `ref`, `aria-*`, `type` or event handlers forces forks.
- **Referencing primitive tokens in components.** `blue-600` in a component breaks theming. Use semantic tokens.
- **Inconsistent naming.** `onChange` here, `onValueChange` there, and `isOpen` vs `open`, make the library feel arbitrary. Write naming conventions down.
- **Breaking changes without a path.** Renaming props without codemods or deprecation warnings stalls upgrades for months. Version the system semantically and ship migration tooling.
- **A system nobody owns.** Without a team, a roadmap and an intake process, the library rots and teams leave it.

> [!TIP]
> Track adoption and escape-hatch usage as metrics. Low adoption or heavy `className` overrides usually mean the API doesn't fit real needs. That calls for a conversation with product teams, not a lint rule.

## Discussion questions

1. Which properties of a `Button` should be constrained enums, and which should stay open? Why?
2. How do semantic tokens make dark mode cheaper than overriding component styles one by one?
3. When would you choose a compound-component API over a configuration-style API, and how would you stop the flexible version drifting off-brand?
4. Compare `as` and `asChild` for polymorphism. What typing and behaviour problems does each have?
5. How would you roll out a breaking change to a component used in 2,000 places?
6. What signals tell you a design system is failing its users, and how would you collect them?

## FAQ

### Is a component library the same as a design system?

No. A component library is one part of it. A design system also includes the tokens, the guidelines (when to use what, content and accessibility guidance), design-tool assets, and the process and people who maintain them.

### Should we build our own or adopt an existing system?

If your product has no strong brand requirements, adopting one (Material, or shadcn/ui on Radix) is faster. Building on headless primitives is a common middle ground: you get accessible behaviour for free and full control over the look.

### What should design tokens be named after?

Their purpose, not their value. `color.text.danger` survives a rebrand, while `red-600-text` doesn't. Keep the raw palette as primitive tokens underneath.

### How do we stop teams from bypassing the system?

Make the system the easiest path: good docs, fast fixes and components that cover real needs. Back that up with lint rules for new code, such as banning raw colours and legacy imports. Enforcement without usefulness just pushes people to escape hatches.

### Do design systems slow teams down?

At first, a little, while components are missing. Once the system covers common needs, teams build faster, because buttons, forms and dialogs are solved, accessible and consistent by default.

## Key takeaways

- A design system is layered: tokens, primitives, components, patterns, product. Each layer builds only on the one below.
- Name tokens by purpose. Themes and brands become remappings of the semantic tier.
- Constrain what must be consistent with enumerated props, and use composition for what can't be predicted.
- Forward native attributes and `ref`, support controlled and uncontrolled state, and build accessibility in.
- Run the system as a product: versioning, codemods, documentation, adoption metrics and an owning team.

## References

- Brad Frost, [Atomic Design](https://atomicdesign.bradfrost.com/), 2016
- W3C Design Tokens Community Group: [Design Tokens Format Module](https://www.designtokens.org/)
- [Style Dictionary](https://styledictionary.com/) documentation
- Radix: [Primitives documentation](https://www.radix-ui.com/primitives/docs/overview/introduction)
- Adobe: [React Aria](https://react-spectrum.adobe.com/react-aria/)
- Nathan Curtis, articles on design system practice, EightShapes on Medium
- Alla Kholmatova, *Design Systems*, Smashing Magazine, 2017

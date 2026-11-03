---
summary: Where form state should live, the trade-offs between controlled and uncontrolled inputs, how form libraries and server actions avoid re-rendering the whole form on every keystroke, and how to validate and submit forms that are fast and accessible.
updated: 2026-11-02
---

> [!KEY]
> A **controlled** input gets its value from component state and reports every change through `onChange`. That makes the value available to render logic at every keystroke, which you need for live formatting, dependent fields and instant feedback. An **uncontrolled** input lets the DOM keep the value, and you read it when you need it, with `FormData` or a ref. Neither is "right". The cost to watch is *what re-renders on each keystroke*, and the answer is to keep state close to the field, or let the DOM hold it. Validate with "reward early, punish late" timing, build on native form features, and always validate again on the server.

## The problem: the sluggish 40-field form

An insurance quote form has 40 fields, held in a single `useState` object at the top of the form. Every keystroke calls `setForm({...form, [name]: value})`, and the entire form re-renders, including the address autocomplete, a date picker and a live premium preview. On a mid-range phone, typing a postcode lags noticeably.

The validation is also unpleasant. Errors appear in red as soon as the user types the first character of an email address, and the submit button stays disabled without saying why. Screen-reader users don't hear the errors at all.

None of this is about choosing a library. It's about where the state lives, when the code reacts to changes, and how much the browser already does for free.

## How it works

### Controlled vs uncontrolled

![Where the value lives](/figures/forms/flow.svg "A controlled input routes every change through React state and back; an uncontrolled input keeps its value in the DOM until you read it.")

**Controlled** (React's term, but the idea applies to any framework with one-way data flow):

```tsx
const [email, setEmail] = useState('');
<input value={email} onChange={e => setEmail(e.target.value)} />
```

State is the source of truth. Every keystroke runs `onChange`, updates state, re-renders and writes the value back into the input. Use this when render output depends on the value *as it changes*:

- formatting as you type (card numbers, phone numbers),
- fields that appear or change based on other fields,
- a live preview or character counter,
- restricting input, such as digits only.

**Uncontrolled:**

```tsx
<form onSubmit={e => {
  e.preventDefault();
  const data = new FormData(e.currentTarget);
  save(Object.fromEntries(data));
}}>
  <input name="email" type="email" defaultValue={user.email} required />
</form>
```

The DOM holds the value. `defaultValue` sets the initial value only. You read values when you need them: on submit with `FormData`, or through a ref. Typing renders nothing. This suits forms where nothing on screen depends on the value until submission, which is most of them.

`<input type="file">` is always uncontrolled, because its value can only be set by the user.

### The real cost: what re-renders

![Renders per keystroke](/figures/forms/renders.svg "One state object at the root re-renders all 20 fields per keystroke; per-field state re-renders one; uncontrolled inputs with subscriptions re-render none.")

Controlled inputs aren't slow in themselves. A single input re-rendering is cheap. The problem is *where* the state lives:

- **State at the form root:** every keystroke re-renders the whole form and everything in it.
- **State in each field component:** only the edited field re-renders. Parent logic that needs values reads them on submit, or through a store with per-field subscriptions.
- **Uncontrolled inputs plus subscriptions:** form libraries like React Hook Form register inputs by ref and keep values outside React state. Components re-render only when they `watch` a field whose value they display.

Libraries take different approaches:

| Library | Model |
|---|---|
| React Hook Form | Uncontrolled by default; values in refs; subscriptions with `watch` and `useWatch` |
| TanStack Form | Controlled, with a store and fine-grained per-field subscriptions |
| Formik | Controlled; one state object, so large forms re-render broadly |
| Conform | Built around native forms, `FormData` and server actions with progressive enhancement |

### Native forms do a lot for free

Before adding JavaScript, use what HTML already gives you:

- **Constraint validation:** `required`, `type="email"`, `type="url"`, `min`, `max`, `minlength`, `pattern`. The browser checks them on submit, focuses the first invalid field and shows a localised message.
- **The right keyboard on phones:** `type="email"`, `type="tel"`, `inputmode="numeric"`.
- **Autofill:** `autocomplete="email"`, `"street-address"`, `"one-time-code"`, `"new-password"`. Good autocomplete attributes save users more time than any widget.
- **Submission without JavaScript:** a `<form action method>` works before scripts load, and even if they fail.
- **`:user-invalid`:** a CSS pseudo-class that matches only after the user has interacted with a field, unlike `:invalid`, which matches immediately.

### When to validate

![Validation timing](/figures/forms/validation.svg "Stay quiet while the user types, check on blur, re-check on every change once an error shows, validate everything on submit, and again on the server.")

Good validation timing is often called **reward early, punish late**:

1. **While the user is typing a field for the first time:** don't show errors. "Invalid email" after one character is noise.
2. **On blur:** validate when the user leaves the field.
3. **Once an error is showing:** re-validate on every change, so the error disappears as soon as the input is fixed.
4. **On submit:** validate everything. Move focus to the first invalid field, or to an error summary at the top for long forms.
5. **On the server:** validate again. Client validation is for speed and convenience. The server is the only check you can trust, because requests can be sent without your UI.

Using one schema, for example with Zod or Valibot, on both client and server keeps the rules identical. Some rules can only be checked on the server, such as "this username is taken". Return those as field errors and show them in the same place as client errors.

Avoid disabling the submit button until the form is valid. Users can't tell what's missing, and some assistive technology skips disabled buttons. Let them submit and show what to fix.

### Accessible errors

- Every input needs a `<label>` (or `aria-label`). A placeholder is not a label.
- Link the error text to the input with `aria-describedby`, and set `aria-invalid="true"` on invalid inputs.
- Write errors that say how to fix the problem: "Enter a date in the format DD/MM/YYYY", not "Invalid input".
- On submit with errors, move focus to the first error, or to an error summary with links to each field.
- Don't rely on colour alone. Add an icon or text.

### Submitting: pending state, server actions and optimistic UI

Submission needs a pending state that prevents double submits and tells the user something is happening. React 19 adds tools for this on top of native forms:

- `<form action={serverAction}>` submits to a server function, with progressive enhancement when the framework supports it.
- `useActionState` returns the action's last result (such as field errors) and an `isPending` flag.
- `useFormStatus` lets a submit button inside the form read whether the form is pending.
- `useOptimistic` shows the expected result immediately and rolls it back on error.

After a successful submit, preserve what the user typed if the server rejects it. Losing a long form to a server error is one of the worst experiences on the web.

## Where it's used

| Form type | Usual approach |
|---|---|
| Login, sign-up, contact, search | Uncontrolled native form, `FormData`, native constraints, server validation |
| Long data-entry forms (insurance, onboarding, admin) | Form library with field-level subscriptions and a shared schema |
| Formatted inputs (card number, phone, currency) | Controlled field component with its own local state |
| Dependent fields and live previews | Controlled or watched fields, subscribed only where displayed |
| Multi-step wizards | Per-step validation, state kept in a store or the URL, final server validation |
| Inline edit in tables | Uncontrolled inputs read on blur or Enter, with optimistic save |

## Use case walk-through: fixing the 40-field quote form

The quote form from the opening example re-renders all 40 fields per keystroke and shows errors too early.

1. **Profile.** The React Profiler shows the whole `QuoteForm` tree rendering on each keystroke, about 35 ms on a test phone, mostly in the address autocomplete and premium preview.
2. **Move to a form library.** Switch to React Hook Form. Inputs register by `name` and are uncontrolled, so typing no longer re-renders the form.
3. **Subscribe only where needed.** The premium preview uses `useWatch` on the six fields that affect the price. Only it re-renders when those change, and its calculation is debounced.
4. **Keep the controlled parts local.** The card-number field stays controlled for formatting, inside its own component, so its renders don't spread.
5. **Share the schema.** Define the rules once with Zod and use the same schema in the client resolver and in the API handler.
6. **Fix the timing.** Set validation to `onBlur` for the first check, then re-validate on change once a field has an error. Stop disabling the submit button. On submit, focus the first invalid field.
7. **Make errors accessible.** Add `aria-invalid`, link each error with `aria-describedby`, add proper `autocomplete` attributes, and add an error summary at the top for submits with several errors.
8. **Handle server errors.** Server-only errors, such as an unsupported postcode, come back as field errors and appear next to the field. The user's input is kept.

**Result:** keystrokes went from about 35 ms to under 4 ms. Form completion rose, abandonment at the address step fell, and screen-reader testing found every error announced and linked.

## Pitfalls

- **One big state object at the root.** Every keystroke re-renders the whole form. Move state to fields, or use a library with subscriptions.
- **Switching between controlled and uncontrolled.** `value={undefined}` followed by a string triggers React's "changing an uncontrolled input to be controlled" warning. Initialise with `''`, not `undefined`.
- **`value` without `onChange`.** The input becomes read-only. Use `defaultValue` if you don't need to control it.
- **Errors while typing.** Showing an error after the first keystroke punishes users for being mid-way. Validate on blur first.
- **Client-only validation.** Anyone can send a request without your UI. Always validate on the server.
- **Disabled submit buttons.** Users can't tell what's wrong. Allow submit and explain.
- **Placeholders as labels.** They disappear when typing, often have low contrast, and aren't reliably announced.
- **Losing input on errors.** A failed submit should never clear the form.
- **Fighting autofill.** Custom inputs that ignore `name` and `autocomplete`, or reset on autofill, break password managers.

> [!TIP]
> Start with a native `<form>`, `name` attributes, labels, `autocomplete` and constraint attributes. Read values with `FormData` on submit. Add controlled fields only where the UI must react to each change, and keep that state inside the field component.

## Discussion questions

1. When does a field genuinely need to be controlled, and when is that just habit?
2. Why does keeping form state at the root cause performance problems, and what are three ways to fix it?
3. Explain "reward early, punish late". What happens to the user experience if you validate on every change from the first keystroke?
4. Why should the same validation schema run on client and server, and which rules can only run on the server?
5. What does progressive enhancement buy you for a sign-up form, and what does it cost?
6. How would you design error handling for a five-step wizard where the server rejects step two after the user reaches step five?

## FAQ

### Are uncontrolled inputs an anti-pattern in React?

No. React's documentation describes both, and uncontrolled inputs with `FormData` are the model behind form actions in React 19. Use controlled inputs where render logic needs the value as it changes.

### Should I use a form library?

For small forms, native forms and `FormData` are enough. For large forms with complex validation, dependent fields and arrays of fields, a library like React Hook Form or TanStack Form saves a lot of code and avoids broad re-renders.

### How do I reset an uncontrolled form?

Call `form.reset()`, which restores each field's `defaultValue`. In React you can also change the form's `key` to remount it with fresh defaults.

### Is client-side validation required at all?

It isn't required for correctness, because the server validates. It's required for a good experience: instant feedback without a round trip, and fewer failed submits.

### How do I handle a field whose options depend on another field?

Make the controlling field controlled or watched, so the dependent field can re-render when it changes. Only the dependent field needs to subscribe. Also clear or re-validate the dependent value when its options change.

## Key takeaways

- Controlled means state owns the value. Uncontrolled means the DOM owns it and you read it on demand.
- The performance question is what re-renders per keystroke. Keep state near the field, or use subscriptions.
- Native forms give you validation, mobile keyboards, autofill and submission without JavaScript. Build on them.
- Validate on blur, then on change once there's an error, then on submit, and always on the server with the same schema.
- Make errors accessible, keep the user's input on failure, and show a clear pending state.

## References

- React docs: [`<input>` (controlled and uncontrolled)](https://react.dev/reference/react-dom/components/input)
- React docs: [`<form>` and actions](https://react.dev/reference/react-dom/components/form)
- React docs: [useActionState](https://react.dev/reference/react/useActionState)
- MDN: [Client-side form validation](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Form_validation)
- MDN: [FormData](https://developer.mozilla.org/en-US/docs/Web/API/FormData)
- MDN: [:user-invalid](https://developer.mozilla.org/en-US/docs/Web/CSS/:user-invalid)
- [React Hook Form documentation](https://react-hook-form.com/)
- W3C WAI: [Forms tutorial](https://www.w3.org/WAI/tutorials/forms/)
- GOV.UK Design System: [Error message](https://design-system.service.gov.uk/components/error-message/) and [Validation](https://design-system.service.gov.uk/patterns/validation/) guidance

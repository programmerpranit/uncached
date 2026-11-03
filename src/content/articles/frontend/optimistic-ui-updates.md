---
summary: How optimistic UI makes apps feel instant by showing the result of an action before the server confirms it. Covers when it's safe to be optimistic, modelling displayed state as confirmed data plus pending mutations, rollback and error messaging, out-of-order responses and idempotency, temporary ids for created items, and how TanStack Query, React's useOptimistic, Apollo and sync engines implement it.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** An **optimistic update** changes the UI as if the server had already said yes, then sends the request in the background. Most requests succeed, so for most clicks the app feels instant. When one fails, you **roll back** and tell the user.
>
> Doing it well comes down to three things:
>
> - **Pick actions that almost always succeed** and are easy to undo.
> - **Keep the confirmed server state separate** from the pending guesses layered on top.
> - **Handle the awkward cases deliberately:** errors, responses that arrive out of order, retries that must not apply twice, and items that don't have a server id yet.
>
> Libraries like TanStack Query and React's `useOptimistic` cover the common path. Sync engines go further and make every write optimistic by default.

## The problem: every click waits for a round trip

A user taps the heart on a post. The app sends `POST /likes`, shows a spinner, waits 400 ms on a good connection or two seconds on a train, and then fills in the heart. The user taps again because nothing seemed to happen, and now there are two requests.

Waiting for the server makes sense when the outcome is uncertain, such as a payment or a username that might be taken. But a like, a checkbox, a rename or a reorder almost never fails. Making the user wait for confirmation of something that's 99.9% certain is paying latency for nothing.

Research on response times says that below about **100 ms**, an action feels instantaneous, and by one second the user's flow of thought is interrupted. Network round trips on mobile regularly exceed both.

## How it works

### Update first, confirm later

The optimistic flow for a single action:

1. **Apply the expected result locally.** The heart fills in, the todo gets checked, the new comment appears in the list.
2. **Send the request** in the background.
3. **On success,** replace the guess with the server's response, which may include fields the client couldn't know, like a server-generated id or timestamp.
4. **On failure,** undo the guess and tell the user what happened.

![Pessimistic UI shows a spinner until the server responds; optimistic UI updates immediately and confirms or rolls back when the response arrives](/figures/optimistic-ui/timeline.svg "The response becomes a confirmation of what the user already sees, not the moment the UI changes.")

### When to be optimistic

Optimism is a bet that the request will succeed. It's a good bet when:

- **Failure is rare.** Validation can be done on the client, and the server rarely rejects valid input.
- **The result is predictable.** The client can compute what the server will return, or something close enough.
- **Rolling back is cheap and clear.** Unchecking a box is easy to explain. Un-sending an email or un-charging a card isn't.

It's a bad bet for payments, irreversible actions, anything with complex server-side rules (inventory, uniqueness, permissions that change), and actions whose result the user will immediately act on elsewhere, like "Publish" followed by sharing a link.

A middle ground is common: show the change immediately but mark it as **pending**, with a lighter colour, a "Sending…" label or a small clock icon, until it's confirmed. Chat apps do this for every message.

### Confirmed state plus pending changes

The naive implementation takes a snapshot, mutates the cache, and restores the snapshot on error. That works for one action at a time, but breaks when several are in flight. If the user toggles todo 1, adds todo 4, then renames todo 2, and the *second* request fails, restoring the snapshot taken before it also throws away the rename.

The robust model keeps two things:

- **Confirmed state:** the last data the server agreed to.
- **A queue of pending mutations,** each a function that transforms state.

What the UI shows is the confirmed state with every pending mutation applied on top, in order.

![Confirmed server state plus a queue of pending mutations equals the displayed state; failed mutations are dropped and the view is recomputed](/figures/optimistic-ui/layers.svg "Recomputing from confirmed state plus the queue lets one failure roll back without losing the others.")

- When a mutation **succeeds,** fold its result into the confirmed state and remove it from the queue.
- When a mutation **fails,** remove it from the queue and recompute. Later mutations survive.
- When fresh data arrives from the server (a refetch or a push), replace the confirmed state and re-apply whatever is still pending.

This is how React's `useOptimistic` works: you pass it the real state and a reducer, and it shows the real state with pending updates applied, dropping them automatically when the surrounding transition finishes. Sync engines like Replicache use the same idea at the scale of the whole app, which they call **rebasing**.

### Out-of-order responses

Two fast clicks, like then unlike, send two requests. Networks don't guarantee order, so the response to the first can arrive after the second. If the client blindly applies "the last response it received", the heart ends up filled even though the user's last action was unlike.

![Two requests whose responses come back in the opposite order; applying the late response flips the UI to the wrong state](/figures/optimistic-ui/race.svg "The user's last action must win, whatever order the network delivers responses in.")

Ways to handle it:

- **Ignore stale responses.** Tag each request with an incrementing counter per item and only apply responses for the latest one.
- **Cancel in-flight work.** TanStack Query's recipe cancels outgoing refetches for the affected data before writing the optimistic value, so an old refetch can't overwrite it.
- **Serialize per item.** Queue mutations to the same entity so only one is in flight at a time, and coalesce rapid toggles into one final request.
- **Send intent, not deltas.** `PUT like=false` is safe to apply in any order relative to itself. `POST /toggle-like` isn't. The server can also reject writes with an old **version** number.

### Retries and idempotency

Optimistic apps often retry failed requests automatically, especially offline-capable ones. A retry after a timeout is dangerous if the first request actually succeeded: "add comment" runs twice. The standard fix is an **idempotency key**, a unique id generated on the client per action and sent with every attempt. The server records keys it has processed and returns the original result for repeats.

### Creating items before they have an id

A new comment needs an id to be rendered in a list (React needs a `key`, and the user might edit or delete it immediately). Two options:

- **Temporary id.** Use something like `temp-<uuid>`, then swap in the server id on success. Any action taken on the item in the meantime must be queued until the real id exists, or mapped through.
- **Client-generated id.** Generate a UUID on the client and let the server accept it as the real primary key. This removes the swap entirely, and it's what most sync engines do.

### Failing honestly

Silent rollback is the worst outcome: the user saw the change succeed, moved on, and later finds it gone. When a mutation fails:

- **Say what failed,** near where it happened if possible: "Couldn't save 'Buy milk'. Retry?"
- **Keep the user's input.** For a failed comment, put the text back in the box rather than discarding it.
- **Retry automatically** for transient errors (network, 503) before bothering the user, and only roll back once you've given up.
- **Distinguish rejection from network failure.** A 409 or 422 means the server said no and the change should be reverted. A network error means the outcome is unknown, so it's often better to keep it pending and retry.

## Where it's used

| Product | Optimistic action | Notes |
|---|---|---|
| Social feeds (likes, follows, reactions) | Toggle immediately | Coalesce rapid toggles; last action wins |
| Chat and messaging apps | Message appears instantly with a "sending" mark | Client-generated ids; resend on reconnect |
| Todo and project tools (e.g. Linear) | Every edit applied locally first | Sync engine with local store and rebasing |
| Email clients | Archive, mark read, label | Undo toast doubles as rollback UI |
| E-commerce cart | Quantity change | Optimistic count, but price and stock confirmed by the server |
| Collaborative docs | Typing and formatting | Operational transforms or CRDTs merge concurrent edits |

## Use case walk-through: making a kanban board feel instant

A team's kanban board waits for the server on every card move. Moving a card takes 300–800 ms, during which the card snaps back to its old column, then jumps to the new one. Users complain the board feels "sticky".

1. **Classify actions.** Moving cards, renaming and reordering almost never fail. Deleting a board or changing permissions sometimes does. Only the first group goes optimistic.
2. **Cancel and apply.** On drop, cancel any in-flight refetch of the board, then apply the move to the cached board through a pending-mutation queue.
3. **Make requests order-safe.** The request sends the card's target column and position, not "move one to the right". Each card keeps a counter, and responses for older moves are ignored.
4. **Use client ids for new cards.** New cards get a UUID on the client, which the API accepts as the card id. Creating a card and immediately dragging it just works.
5. **Retry, then roll back.** Network errors retry three times with backoff while the card shows a small "syncing" indicator. A 403 or 409 rolls the move back with a toast: "You no longer have access to Done. Card moved back."
6. **Reconcile.** When the mutation settles, either way, the board is refetched in the background so the cache matches the server, including other people's changes.

**Result:** moves feel instant on every connection. Over a month, fewer than 0.1% of moves roll back, almost all of them permission changes. Support tickets about the board feeling slow stop entirely.

## Pitfalls

- **Rolling back with a stale snapshot.** Restoring "the state before this mutation" undoes everything that happened since. Recompute from confirmed state and the remaining pending mutations instead.
- **Forgetting the refetch.** The optimistic guess can differ from the server's real result (a server-side sort order, a computed field). Revalidate after the mutation settles.
- **Optimistic on non-idempotent endpoints.** Automatic retries plus `POST /increment` equals double counting. Use idempotency keys or absolute values.
- **Derived data drifting.** Updating a todo but not the "3 remaining" counter, or the item in one list but not another view of it, leaves the UI inconsistent. Normalized caches help.
- **Hiding errors.** A failure toast that disappears after two seconds, while the user is looking elsewhere, is effectively silent. Keep failed items visible until they're dismissed or retried.
- **Navigation during a pending mutation.** If the user leaves the page, the request should still complete, and any failure should still be reported somewhere.

> [!WARNING]
> Don't be optimistic about anything with money, legal weight or irreversible side effects. "Payment sent!" followed by "Actually, it wasn't" destroys trust far more than a two-second spinner would have.

## Discussion questions

1. Which actions in an app you've worked on are good candidates for optimistic updates, and which aren't? What's the deciding factor?
2. Why does snapshot-and-restore break with concurrent mutations, and how does the pending-queue model fix it?
3. How would you design an API so that requests can safely be applied in any order or retried?
4. What should the UI show when the network is down entirely? How long should a change stay "pending" before you give up?
5. How do temporary ids complicate follow-up actions, and what does a client-generated id change on the server side?
6. Where does optimistic UI end and a full local-first sync engine begin?

## FAQ

### Isn't optimistic UI just lying to the user?

It's a prediction, and it's honest as long as you correct it visibly when it's wrong. For actions that succeed 99.9% of the time, showing the likely result is closer to the truth than showing a spinner. Marking unconfirmed items as pending makes the uncertainty explicit when it matters.

### What's the difference between `useOptimistic` and TanStack Query's optimistic updates?

`useOptimistic` is a React primitive. It shows an optimistic value during an async transition and automatically falls back to the real state when the transition ends, with no cache involved. TanStack Query works on its shared cache: in `onMutate` you cancel queries, snapshot and write the cache; in `onError` you restore; in `onSettled` you invalidate. It can also skip the cache and render pending mutation variables directly from `useMutation`.

### How do I handle an optimistic create when the list is sorted on the server?

Insert the item where your client-side sort puts it, then accept that it may move when the refetch arrives. If the server's ordering can't be predicted, insert it at a predictable place (top or bottom) with a pending style, and let the refetch place it properly.

### What happens if the user goes offline?

A simple optimistic setup will fail the request and roll back. Offline-capable apps instead persist the pending queue (for example in IndexedDB), keep showing the changes as pending, and replay the queue when the connection returns. That requires idempotent requests and conflict handling on the server.

### Do I need a sync engine?

Not for a few optimistic actions. Libraries like TanStack Query, SWR and Apollo handle those well. A sync engine (Replicache, Zero, Electric, or a CRDT library) is worth it when nearly every interaction should be instant, when the app must work offline, or when many users edit the same data at once.

## Key takeaways

- Optimistic UI applies the expected result immediately and treats the server response as a confirmation.
- Use it for frequent, low-risk, easily reversible actions. Don't use it for payments or irreversible operations.
- Model the display as confirmed state plus a queue of pending mutations, so one failure doesn't undo unrelated changes.
- Make requests order-safe and idempotent: send absolute values, ignore stale responses, use idempotency keys for retries.
- Client-generated ids remove the temporary-id dance for created items.
- When something fails, say so clearly, keep the user's input, and refetch to reconcile.

## References

- React, ["useOptimistic"](https://react.dev/reference/react/useOptimistic).
- TanStack Query, ["Optimistic Updates"](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates).
- Apollo Client, ["Optimistic mutation results"](https://www.apollographql.com/docs/react/performance/optimistic-ui).
- SWR, ["Mutation & Revalidation"](https://swr.vercel.app/docs/mutation).
- Jakob Nielsen, ["Response Times: The 3 Important Limits"](https://www.nngroup.com/articles/response-times-3-important-limits/), Nielsen Norman Group.
- Replicache documentation, "How Replicache Works" (rebasing pending mutations on top of server state).
- Stripe API documentation, "Idempotent requests" (idempotency keys for safe retries).

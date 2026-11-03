---
summary: Why fetched data is not really "your" state, and what changes when you treat it as a cache. Covers the difference between client and server state, query keys, deduplication, staleTime and gcTime, refetch triggers, invalidation after mutations, where real client state should live, and how SWR, TanStack Query, RTK Query, Apollo, Relay and server components compare.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Most "state management" pain in front-end apps comes from mixing two different things. **Client state** is owned by the browser: a modal is open, a draft is half-typed, a tab is selected. It is synchronous and always correct. **Server state** is a *copy* of data that lives somewhere else. It is fetched asynchronously, shared with other users and can go out of date at any moment.
>
> Server state is best handled as a **cache** keyed by what you asked for. Each entry has a freshness policy. Requests for the same key are deduplicated. Entries are refetched on focus, reconnect or invalidation, and garbage-collected when nobody is using them. Libraries like TanStack Query and SWR do this for you, and what remains as client state is usually small enough for `useState`, context or the URL.

## The problem: a global store full of copies

A common pattern in older React codebases goes like this. Fetch the todos in a `useEffect`, dispatch them into a Redux store, then read them from any component that needs them. It works at first. Then you need:

- an `isLoading` flag, an `error` field and a `lastFetched` timestamp for every resource;
- logic to avoid fetching the same list twice when two components mount together;
- a way to notice the data is old when the user comes back to the tab after lunch;
- code to update or refetch the list after the user adds an item;
- cleanup so the store doesn't keep every page of every list forever;
- protection against a slow, older response overwriting a newer one.

Each of these is a cache problem, and each team ends up writing a small, buggy cache by hand. The store also mixes two kinds of data with different rules. A boolean like `sidebarOpen` is the truth. The `todos` array is only a snapshot of the truth as of some past moment.

![Two cards comparing client state and server state: ownership, sync vs async, freshness and examples](/figures/server-state/two-kinds.svg "Client state is owned and always correct. Server state is a borrowed snapshot that can go stale.")

## How it works

### Two kinds of state, two sets of rules

| | Client state | Server state |
|---|---|---|
| Who owns it | The browser tab | A server or database |
| Access | Synchronous | Asynchronous (network) |
| Can it be wrong? | No, it *is* the truth | Yes, other people can change it |
| Shared with | This tab only | Every user and device |
| Typical home | `useState`, context, Zustand, URL | A query cache |

Once you split them, each side becomes simpler. Client state needs no loading flags. Server state needs no reducers, because the server already defines how it changes.

### The query cache

A query library keeps a map from a **query key** to a cache entry. The key describes *what* you asked for, for example `['todos']` or `['todo', 42]` or `['todos', { status: 'done', page: 2 }]`. The entry holds the data, the error, a timestamp and a list of components currently using it.

When a component calls `useQuery({ queryKey: ['todo', 42], queryFn })`:

1. If an entry exists, the component gets its data immediately, even if it is old.
2. If the entry is missing or **stale**, the library runs `queryFn` in the background.
3. If another component asks for the same key while that request is in flight, it joins the same promise. This is **deduplication**, and it is why you can call the hook in ten components without making ten requests.
4. When the response arrives, every subscriber re-renders with the new data.

![Several components reading query keys from a shared cache, which fetches from the API; a mutation invalidates the todos key](/figures/server-state/query-keys.svg "Components subscribe to keys, not to requests. A mutation invalidates a key and every subscriber refetches.")

Because the key includes every input to the request, changing a filter or a page number simply switches to a different entry. Going back to page 1 shows the cached page 1 instantly while it revalidates.

### Fresh, stale, inactive, removed

Every entry moves through a small lifecycle. Two timers control it:

- **`staleTime`** is how long data counts as fresh. While fresh, the cache returns it without any network request. TanStack Query defaults to **0**, so data is stale as soon as it arrives. That sounds aggressive, but stale data is still shown; it only means "refetch when there's a reason to".
- **`gcTime`** (called `cacheTime` before TanStack Query v5) is how long an entry with **no subscribers** stays in memory before it is deleted. The default is **5 minutes**. Navigating away and back within that window shows the old data instantly.

![Lifecycle of a cache entry from fetching to fresh, stale, inactive and removed, with a refetch arc back to fresh](/figures/server-state/lifecycle.svg "staleTime decides when data needs revalidating; gcTime decides when unused data is thrown away.")

Stale entries are refetched on certain **triggers**:

- a new component mounts and subscribes to the key;
- the window regains focus (`refetchOnWindowFocus`);
- the network reconnects (`refetchOnReconnect`);
- an optional polling interval (`refetchInterval`);
- explicit invalidation.

This pattern is called **stale-while-revalidate**, the same idea as the HTTP `Cache-Control` directive. The user sees something immediately, and it quietly becomes correct a moment later.

### Mutations and invalidation

Writes go through a **mutation**. After a successful mutation you tell the cache which keys are now out of date:

```ts
const qc = useQueryClient();
const addTodo = useMutation({
  mutationFn: postTodo,
  onSuccess: () => qc.invalidateQueries({ queryKey: ['todos'] }),
});
```

Invalidation matches by prefix, so `['todos']` also marks `['todos', { page: 2 }]` stale. Any of those entries with active subscribers refetch at once. The others refetch the next time someone uses them. You don't have to work out by hand which lists contain the new item.

When waiting for the round trip feels too slow, you can write the expected result into the cache straight away (`setQueryData`), then roll back if the server rejects it. This is an **optimistic update**, covered in its own article. Invalidating after the mutation settles is still a good idea, so the cache ends up matching the server either way.

### Where client state lives

With server data gone from the global store, what is left is usually small:

| Kind of state | Good home |
|---|---|
| Local UI (open, hovered, input draft) | `useState` / `useReducer` in the component |
| Shared UI (theme, current user's preferences) | React context, or a tiny store like Zustand or Jotai |
| Shareable, bookmarkable (filters, tab, page, search) | The URL: path and query string |
| Complex local workflows (multi-step editor, canvas) | A reducer, a state machine or a dedicated store |
| Form values | A form library, or uncontrolled inputs |

The URL is underused. If refreshing the page or sharing a link should keep the user's filters, they belong in the query string. They then become part of the query key too.

### The libraries

| Library | Shape | Notes |
|---|---|---|
| **TanStack Query** | Key-based cache for any async function | Framework-agnostic core; devtools; infinite queries; fine-grained timers |
| **SWR** (Vercel) | Key-based, minimal API | Named after stale-while-revalidate; smaller and simpler |
| **RTK Query** | Built into Redux Toolkit | Endpoints defined up front; invalidation by tags; good if you already use Redux |
| **Apollo Client** | Normalized GraphQL cache | Stores entities by `__typename:id`, so updating one object updates every query that includes it |
| **Relay** | Normalized GraphQL cache plus compiler | Components declare data needs as fragments; strongest consistency, steeper learning curve |

Key-based caches (TanStack, SWR, RTK Query) are **document caches**: each query's response is stored as a whole, so the same todo can appear in two entries. Normalized caches (Apollo, Relay) break responses into entities, so one update is reflected everywhere, at the cost of more setup.

### Another route: fetch on the server

React Server Components, Remix and React Router loaders, and Next.js App Router data fetching move a lot of reads to the server. The component, or route, gets its data before the HTML is sent. "Revalidation" becomes re-running the loader or refreshing the route after an action. This removes many client caches entirely. Highly interactive views (dashboards, infinite feeds, things that poll) still benefit from a client query cache, and many apps use both.

## Where it's used

| Situation | What the split buys you |
|---|---|
| Dashboards that several people edit | Refetch on focus shows other people's changes without a manual refresh |
| Master-detail screens | The detail view can seed itself from the list entry, then fetch the full record |
| Paginated and filtered tables | Each filter combination is its own key; going back is instant |
| Mobile web on flaky networks | Refetch on reconnect, retries and showing cached data while offline |
| Migrating off a large Redux store | Move server data to queries slice by slice; the store shrinks to real UI state |
| Prefetching | Hovering a link calls `prefetchQuery`, so the next page renders from cache |

## Use case walk-through: cleaning up a project tracker

A team's React app keeps projects, tasks and comments in Redux. Each slice has its own loading and error fields and its own thunk. Bugs keep appearing: lists that don't update after edits, and duplicate requests on the dashboard.

1. **Audit the store.** About 80% of it is server data (projects, tasks, comments, users). The rest is UI: the selected project, open panels, a draft comment.
2. **Introduce a query client** at the root, with `staleTime: 30_000` because tasks don't change every second.
3. **Replace one slice at a time.** `useProjects()` becomes a thin wrapper around `useQuery({ queryKey: ['projects'], ... })`. The slice, its thunk and its loading flags are deleted.
4. **Design keys around inputs.** Tasks use `['tasks', projectId, { status }]`. Changing the status filter switches entry; switching back is instant.
5. **Convert writes to mutations.** Creating a task invalidates `['tasks', projectId]`, which refreshes every filtered view of that project.
6. **Move the selected project to the URL** (`/projects/:id`), so reloads and shared links work. The remaining Redux state is small enough to replace with two `useState` calls and one context.
7. **Turn on devtools** to check that the dashboard now makes one request per key, not one per widget.

**Result:** the data layer shrinks from about 2,000 lines of reducers and thunks to a few hundred lines of hooks. Duplicate requests disappear, and edits show up everywhere without hand-written update logic.

## Pitfalls

- **Copying query data into `useState`.** It freezes a snapshot and the copy stops updating. Read from the query directly, and derive values during render.
- **Keys that leave out an input.** If the `queryFn` uses `page` but the key doesn't include it, every page shares one entry and shows the wrong data.
- **Unstable keys.** Building a key from a new object with different values on each render, such as `Date.now()`, creates a new entry every time and refetches in a loop.
- **Confusing staleTime and gcTime.** Raising `gcTime` doesn't reduce requests; raising `staleTime` does.
- **Forgetting to invalidate.** A mutation that doesn't invalidate or update related keys leaves stale lists until the next focus event.
- **Over-fetching on focus.** Default focus refetching can surprise you in development or on expensive endpoints. Raise `staleTime` rather than turning it off globally.
- **Putting everything in the query cache.** A modal's open flag is not server state. Keep the two kinds separate in both directions.

> [!TIP]
> A quick test: *"If I open the same page in a second tab and change this there, should the first tab eventually see it?"* If yes, it's server state and belongs in a query cache. If no, it's client state.

## Discussion questions

1. Why is `staleTime: 0` a reasonable default, given that stale data is still shown to the user?
2. When would a normalized cache like Apollo's be worth its extra complexity over a key-based one?
3. Which pieces of state in an app you know should live in the URL but currently don't?
4. How do server components and route loaders change the need for a client-side query cache?
5. What could go wrong if two mutations to the same item are sent quickly one after another, and how could the cache help?
6. How would you decide `staleTime` for a stock price, a user profile and a list of countries?

## FAQ

### Do I still need Redux if I use TanStack Query?

Often not. Once server data moves to queries, many apps have little global state left, and context or a small store covers it. Redux is still a sensible choice for large, complex client-side workflows, and RTK Query lets you keep everything in one tool.

### What is the difference between staleTime and gcTime?

`staleTime` controls when data needs to be *revalidated*: fresh data is never refetched, stale data is refetched on the next trigger. `gcTime` controls when *unused* data is deleted from memory. They answer different questions and are usually tuned separately.

### Why does my query refetch every time I switch browser tabs?

Because `refetchOnWindowFocus` is on by default and `staleTime` defaults to 0, so data is always stale when you come back. That is intentional; it keeps data in sync with changes made elsewhere. Raise `staleTime` for data that changes rarely.

### Should I use SWR or TanStack Query?

Both implement the same idea. SWR has a smaller API and fits simple read-heavy apps well. TanStack Query has more built-in features, such as mutations, infinite queries, fine-grained cache control and devtools, and supports frameworks beyond React.

### Is the query cache shared between users or persisted?

By default it lives in memory in one browser tab and is lost on reload. You can persist it to storage with plugins, or seed it on the server during SSR and send it down with the HTML (called hydration). It is never shared between users.

## Key takeaways

- Client state is owned and synchronous; server state is a borrowed, asynchronous snapshot that can go stale.
- Treat server state as a cache keyed by the request inputs, with deduplication, freshness timers and background refetching.
- `staleTime` decides when to revalidate; `gcTime` decides when to forget unused data.
- After writes, invalidate the affected keys instead of hand-editing every list.
- What's left as client state is usually small: local state, a little context, and the URL.
- Server components and loaders move many reads to the server, but interactive views still benefit from a client cache.

## References

- TanStack Query docs: [Important Defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
- TanStack Query docs: [Query Keys](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys)
- TanStack Query docs: [Query Invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)
- SWR documentation: [swr.vercel.app](https://swr.vercel.app/)
- Redux Toolkit: [RTK Query Overview](https://redux-toolkit.js.org/rtk-query/overview)
- Apollo Client docs: [Caching in Apollo Client](https://www.apollographql.com/docs/react/caching/overview)
- RFC 5861: [HTTP Cache-Control Extensions for Stale Content](https://www.rfc-editor.org/rfc/rfc5861)
- Kent C. Dodds, "Application State Management with React" (kentcdodds.com, 2020)

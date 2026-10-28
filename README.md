# Uncached

**Live:** https://uncached.vercel.app

A "spin a random tech topic" game for teams. One person spins, the app lands on an intermediate-to-hard topic, and the group explains and discusses it together.

There is no backend, no login and no timer. Everything runs in the browser, and progress is saved in `localStorage`.

## How to play

- Pick one or more categories. **All** is the default. When All is active, tapping a single category narrows the selection to just that one.
- Press **Spin**, or hit the spacebar, to land on a topic.
- A landed topic counts as covered right away. Covered topics are skipped on future spins.
- **Reroll** skips the current topic. The skipped topic is un-covered, so it can come up again later.
- **Show covered** lists everything explored so far. **Reset history** clears that list (it asks you to confirm).

## Run locally

Requires Node 20+.

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check + production build into dist/
npm run preview   # serve the production build locally
```

## Deploy to Vercel

The app is a static Vite build, so it needs no `vercel.json`.

- **From the dashboard:** import the GitHub repo. Vercel detects Vite automatically: build command `npm run build`, output directory `dist`.
- **From the CLI:** run `npx vercel` for a preview deploy, or `npx vercel --prod` for production.

Every push to `main` redeploys once the repo is connected.

## Add or edit topics

All topics live in [`src/data/topics.ts`](src/data/topics.ts), grouped by category. Each entry is a `[title, hook]` pair:

```ts
'Databases': [
  ['MVCC', 'Letting readers and writers proceed without blocking each other through row versions.'],
  // add yours here
],
```

Guidelines:

- Keep topics meaty enough to fill a real discussion. Skip anything basic.
- Keep the hook to one accurate line, ideally under ~100 characters, so it reads on a projector.
- Titles must be unique within a category.
- Progress is keyed by `category::title`, so renaming a topic resets its covered status. Removed topics are pruned from saved history automatically.

To add a new **category**, add its name to `CATEGORIES` and add a matching key to `RAW` in the same file. TypeScript flags a missing key.

## Stack

Vite, React and TypeScript, with plain CSS (`src/styles.css`). Fonts are Instrument Serif and JetBrains Mono, loaded from Google Fonts. The spin animation respects `prefers-reduced-motion`.

# Uncached

**Live:** https://uncached.vercel.app

A "spin a random tech topic" game for teams. One person spins, the app lands on an intermediate-to-hard topic, and the group explains and discusses it together.

There is no backend, no login and no timer. Everything runs in the browser, and progress is saved in `localStorage`.

## How to play

- Pick one or more categories. **All** is the default. When All is active, tapping a single category narrows the selection to just that one.
- Press **Spin**, or hit the spacebar. The reel spins for 5 seconds, slowing down before it lands on a topic.
- The spin has sound effects: a whoosh, a click per reel step and a chime on landing. They are synthesized with the Web Audio API, so there are no audio files. Toggle them with **Sound on/off** in the footer; the choice is saved per browser.
- A landed topic counts as covered right away. Covered topics are skipped on future spins.
- **Reroll** skips the current topic. The skipped topic is un-covered, so it can come up again later.
- If the topic has a write-up, **Read the deep dive** opens a long-form article with diagrams, worked examples, real-world use cases, discussion questions and references. Press **Esc** or **Back to spin** to return. Articles have their own URLs (`/#/read/<category>/<topic>`), so you can share them.
- **Show covered** lists everything explored so far. Topics with a deep dive are marked **· read** and open the article. **Reset history** clears that list (it asks you to confirm).

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

## Write a deep dive

Articles are Markdown files at `src/content/articles/<category-slug>/<title-slug>.md`. A slug is the name lowercased, with every run of other characters replaced by `-`. For example, `System Design` / `Consistent hashing` becomes `system-design/consistent-hashing.md`. If the file exists, the button appears automatically. Each article is its own lazy-loaded chunk.

```md
---
summary: One or two sentences shown under the title.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** …

## The problem
…
![Alt text for screen readers](/figures/my-topic/diagram.svg "Caption. *Markdown* works here.")
```

- `## ` and `### ` headings build the table of contents.
- A paragraph that contains only an image becomes a numbered figure. The image title is the caption.
- Callouts: start a blockquote with `[!KEY]`, `[!NOTE]`, `[!TIP]`, `[!WARNING]` or `[!EXAMPLE]`.
- Put figures in `public/figures/<topic>/`. Use SVGs in the app's palette (`#1b1712` background, `#ede6d8` ink, `#ff5b2e` accent).
- Suggested outline: TL;DR → The problem → How it works → Deep-dive sections → Code → Where it's used → Pitfalls → Alternatives → Discussion questions → Key takeaways → References.

## Stack

Vite, React and TypeScript, with plain CSS and [marked](https://marked.js.org) for articles (`src/styles.css`). Fonts are Instrument Serif and JetBrains Mono, loaded from Google Fonts. With `prefers-reduced-motion`, the reel doesn't cycle. It shows a static line for the same 5 seconds, then the topic fades in. Spin timing lives in `SPIN_MS` and `REEL_TICKS` in `src/App.tsx`; the sounds are in `src/sound.ts`.

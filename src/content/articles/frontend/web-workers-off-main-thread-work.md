---
summary: Why heavy JavaScript makes pages freeze, and how Web Workers move that work to another thread. Covers the single main thread and long tasks, how dedicated workers start and communicate, structured cloning vs transferable objects vs SharedArrayBuffer, the other members of the worker family, OffscreenCanvas and WebAssembly in workers, and when moving work off the main thread is (and isn't) worth it.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** In the browser, your JavaScript, style calculation, layout, painting and input handling all share **one main thread**. A function that runs for 300 ms blocks all of them, so the page stops responding. A **Web Worker** runs a separate script on its own thread. It has no access to the DOM, and it talks to the page only through asynchronous **messages** (`postMessage`).
>
> Data is **copied** by default (structured clone). Large binary buffers can be **transferred** at almost no cost. **SharedArrayBuffer** lets threads share memory outright, but needs cross-origin isolation. Workers are ideal for CPU-heavy, self-contained work like parsing, compression, search, image processing or WebAssembly. They don't help with work that's slow because of the DOM or the network.

## The problem: one thread does everything

Browsers run each page's JavaScript on the **main thread**, and the same thread handles input events, style and layout, and painting. The browser aims to produce a frame every 16.7 ms on a 60 Hz screen. If a single task runs for 600 ms, the browser can't paint, can't respond to a click and can't run your `requestAnimationFrame` callbacks until it finishes. Scrolling may still work, because modern browsers scroll on a separate compositor thread, but anything that needs JavaScript waits.

The browser calls any task longer than **50 ms** a **long task**. Long tasks are the main cause of poor **Interaction to Next Paint (INP)**, the Core Web Vital that measures how quickly a page responds to input.

Common culprits:

- Parsing a big JSON or CSV file the user uploaded.
- Filtering, sorting or fuzzy-searching tens of thousands of rows.
- Syntax highlighting, Markdown rendering or diffing large documents.
- Image filters, compression, hashing or encryption.
- Running a WebAssembly module, such as a PDF renderer or a SQLite database.

![Timeline: a 600 millisecond task on the main thread drops about 36 frames, while the same task in a worker leaves the main thread free to render](/figures/web-workers/blocking.svg "The total work doesn't shrink. It just stops competing with input and painting.")

There are two broad fixes. You can **break the work up** and yield back to the browser between pieces (`scheduler.yield()`, `setTimeout`, `requestIdleCallback`). Or you can **move it to another thread**. Workers are the second option.

## How it works

### Starting a worker

A dedicated worker is created from a separate script file. With modern bundlers you can use module workers:

```js
const worker = new Worker(new URL('./parse.worker.js', import.meta.url), { type: 'module' });
worker.postMessage(file);
worker.onmessage = (e) => render(e.data);
```

Inside the worker, `self` replaces `window`:

```js
self.onmessage = async (e) => {
  const rows = parseCsv(await e.data.text());
  self.postMessage(rows);
};
```

The browser starts a new thread with its own JavaScript engine instance, its own global scope and its own event loop. Starting a worker costs a few milliseconds and some memory, so keep long-lived workers around rather than creating one per task.

### What a worker can and can't do

A worker gets most of the platform that doesn't touch the page: `fetch`, `WebSocket`, `IndexedDB`, timers, `crypto.subtle`, `WebAssembly`, the Cache API, and even `importScripts` or ES module imports.

It cannot touch the **DOM**, `window`, `document` or `localStorage`. The DOM isn't thread-safe, so the browser keeps it on the main thread. A worker computes; the main thread applies the result to the page.

### Moving data: copy, transfer or share

Workers and the page don't share variables. Everything goes through messages, and there are three ways to send data.

![Three rows showing data moving from main thread to worker: structured clone copies it, transfer moves ownership, and SharedArrayBuffer lets both threads see the same memory](/figures/web-workers/messaging.svg "Copying is simplest, transferring is fastest for big buffers, sharing needs extra headers and careful coordination.")

**Structured clone (the default).** `postMessage(obj)` deep-copies the value with the structured clone algorithm. It handles objects, arrays, Maps, Sets, Dates, Blobs, typed arrays and cycles, but not functions, DOM nodes or class prototypes. Copying is fine for small messages. For tens of megabytes, the copy itself can become a long task on the main thread.

**Transferable objects.** `postMessage(buf, [buf])` moves ownership of an `ArrayBuffer` (or a `MessagePort`, `ImageBitmap`, `OffscreenCanvas` or stream) to the other side. No copy happens. The sender's buffer becomes **detached**, with length zero, so you can't use it accidentally after sending.

**SharedArrayBuffer.** Both threads see the same memory, as in native multithreading. You coordinate with `Atomics` (`Atomics.wait`, `Atomics.notify`, atomic add and compare-exchange). Because shared memory enables high-precision timers that can be used in Spectre-style attacks, browsers only allow it on **cross-origin isolated** pages, which requires the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. Multithreaded WebAssembly builds (for example, of FFmpeg or Photoshop's engine) depend on it.

### Making messages feel like function calls

Raw `postMessage` gets messy once a worker has several jobs: you invent message types, match replies to requests and handle errors yourself. **Comlink**, a small library from the Chrome team, wraps a worker in a proxy so you can write `await api.search(query)` as if it were a local async function. Under the hood it's still messages.

### The worker family

"Worker" covers several related APIs. All of them run off the main thread without DOM access.

![Four cards: dedicated workers for CPU work, shared workers for many tabs, service workers as a network proxy, and worklets for audio, paint and animation](/figures/web-workers/kinds.svg "Same isolation model, different jobs.")

- **Dedicated workers** belong to one page. This is what `new Worker()` creates and what this article focuses on.
- **Shared workers** can be reached by every tab of the same origin, for example to keep one WebSocket for all open tabs. Support arrived late in some mobile browsers, so check before relying on it.
- **Service workers** sit between the page and the network for offline support, caching and push. They have their own lifecycle and can be stopped by the browser at any time, so they're a poor place for heavy computation.
- **Worklets** (AudioWorklet, PaintWorklet, AnimationWorklet) are tiny, tightly controlled scripts that run inside a specific part of the rendering or audio pipeline.

### OffscreenCanvas: drawing off the main thread

`canvas.transferControlToOffscreen()` hands a canvas to a worker, which can then draw to it with 2D or WebGL, and the frames reach the screen without involving the main thread. Charting libraries, maps and games use this to keep rendering smooth even when the page's own JavaScript is busy.

## Where it's used

| Product or tool | What runs in a worker |
|---|---|
| VS Code for the web, Monaco | Language services: parsing, type checking, completions |
| Figma | Parts of the document engine and file processing |
| Google Sheets and similar | Formula recalculation for large spreadsheets |
| Squoosh | Image codecs compiled to WebAssembly |
| Partytown | Third-party scripts such as analytics, proxied into a worker |
| sql.js / SQLite WASM | An entire database, with OPFS storage, off the main thread |
| PDF.js | PDF parsing and rendering |

## Use case walk-through: a CSV importer that doesn't freeze

A dashboard lets users upload CSV files of up to 50 MB. Parsing and validating on the main thread freezes the tab for several seconds, and users think it's crashed.

1. **Measure first.** A Performance panel recording shows a 4-second long task in `parseCsv` and `validateRows`. Input during that time isn't handled at all.
2. **Move the CPU work.** Parsing and validation move into a module worker. The main thread sends the `File` object, which is cheap to clone because the file data isn't copied.
3. **Read in the worker.** The worker streams the file with `file.stream()` and parses it in chunks, so memory stays flat.
4. **Report progress.** Every 5,000 rows the worker posts `{ type: 'progress', rows }`, and the main thread updates a progress bar.
5. **Send the result efficiently.** Rather than posting 500,000 objects (a slow structured clone), the worker packs numeric columns into typed arrays and **transfers** their buffers. Text columns go as one array of strings.
6. **Keep the main thread's work small.** The page renders only the visible rows with a virtualized table.
7. **Allow cancelling.** A Cancel button calls `worker.terminate()` and starts a fresh worker for the next import.

**Result:** the tab stays responsive throughout, users see progress, and INP during imports drops from seconds to a few dozen milliseconds.

## Pitfalls

- **Expecting the DOM.** A worker can't measure elements or update the page. If your slow work is mostly DOM updates, fix that on the main thread (fewer nodes, virtualization, batching) instead.
- **Huge clones.** Posting a giant object graph moves the cost into serialization on both threads. Transfer typed arrays, or send only what the UI needs.
- **Chatty messaging.** Thousands of tiny messages per second add overhead. Batch them.
- **Startup cost.** Creating a worker per click adds latency. Keep a long-lived worker, or a small pool sized to `navigator.hardwareConcurrency`.
- **Duplicated code.** A worker bundle that imports large shared modules loads them a second time. Keep worker entry points lean.
- **Unhandled errors.** Exceptions in a worker don't appear as page errors by default. Listen for `error` and `messageerror` events and reply with explicit error messages.
- **SharedArrayBuffer headers.** Turning on cross-origin isolation can break third-party embeds and images that lack the right CORS or CORP headers.

> [!TIP]
> Before reaching for a worker, check whether the long task can simply be split with `scheduler.yield()`. Yielding is often enough for work that touches the DOM, while workers shine for big, self-contained computations.

## Discussion questions

1. Why does the browser keep the DOM on a single thread instead of making it thread-safe?
2. A search box filters 100,000 items on every keystroke and feels sluggish. Would you use a worker, debouncing, an index, or all three? Why?
3. When would you choose structured cloning over transferring an `ArrayBuffer`, even for medium-sized data?
4. What security problem led browsers to require cross-origin isolation for SharedArrayBuffer?
5. How would you design a worker API so the main thread can cancel a stale request when the user types again?
6. Why are service workers a poor fit for long-running CPU-heavy tasks?

## FAQ

### Do workers make code run faster?

Not by themselves. The same computation takes about the same time on another thread. What improves is **responsiveness**, because the main thread stays free. Real speed-ups come from running several workers in parallel on multi-core devices, which only helps when the work divides into independent pieces.

### Can I use React or other UI frameworks inside a worker?

You can run framework logic that doesn't need the DOM, such as state calculations or a virtual DOM diff, but the results still have to be applied on the main thread. Experiments like running React in a worker exist, but the messaging overhead usually outweighs the benefit for normal UIs.

### How many workers should I create?

Usually one long-lived worker per kind of task is enough. For parallel work, a pool of `navigator.hardwareConcurrency - 1` workers is a reasonable upper limit, since each worker uses memory and the main thread needs a core too.

### Are workers supported everywhere?

Dedicated workers, transferables and module workers are supported in all modern browsers. Shared workers and OffscreenCanvas arrived later on some platforms, and SharedArrayBuffer needs cross-origin isolation headers. Node.js has the similar `worker_threads` module, and Deno and Bun support the web `Worker` API.

### How do I debug a worker?

Browser DevTools list each worker as its own JavaScript context. You can set breakpoints in worker files, view their console output and see their activity as a separate track in the Performance panel.

## Key takeaways

- The main thread runs JavaScript, layout, paint and input, so any task over 50 ms hurts responsiveness.
- Web Workers run scripts on another thread without DOM access and communicate only by messages.
- Data is copied by default; transfer large buffers, and use SharedArrayBuffer only with cross-origin isolation.
- Use workers for CPU-heavy, self-contained work: parsing, search, media, crypto and WebAssembly.
- Keep messages coarse, workers long-lived and errors explicit; yield instead when the slow work is DOM-bound.

## References

- MDN: [Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)
- MDN: [Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- MDN: [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- MDN: [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- web.dev: [Optimize long tasks](https://web.dev/articles/optimize-long-tasks)
- web.dev: [Making your website "cross-origin isolated" using COOP and COEP](https://web.dev/articles/coop-coep)
- Comlink on GitHub: [GoogleChromeLabs/comlink](https://github.com/GoogleChromeLabs/comlink)
- HTML Standard: Workers section (html.spec.whatwg.org/multipage/workers.html)

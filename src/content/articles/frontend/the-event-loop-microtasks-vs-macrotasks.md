---
summary: Why a resolved Promise runs before a zero-delay setTimeout, and what that means for responsiveness. Covers the call stack, task queues, the microtask queue, where rendering fits into each loop turn, async/await under the hood, Node.js phases, and how to break up long work without freezing the page.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** JavaScript in a browser tab runs on one thread, driven by an **event loop**. Each turn of the loop:
>
> 1. takes **one task** (also called a macrotask) from a task queue and runs it to completion. Tasks include the initial script, a `setTimeout` callback, a click event or a network callback;
> 2. runs **every microtask** in the microtask queue, including microtasks queued along the way. Microtasks come from Promise reactions, `await`, `queueMicrotask` and `MutationObserver`;
> 3. **renders** if a frame is due: `requestAnimationFrame` callbacks, then style, layout and paint.
>
> That's why `Promise.resolve().then(f)` runs before `setTimeout(f, 0)`: the promise callback is a microtask of the current task, while the timer callback is a separate, later task. The flip side: an endless chain of microtasks starves rendering just as badly as a long loop does. To keep the page responsive, split long work into separate **tasks**.

## The problem: one thread, many sources of work

A web page has to respond to clicks, run timers, process network responses, run your application code and paint frames, and almost all of it happens on the **main thread**. JavaScript has run-to-completion semantics: once a function starts, nothing else on that thread interrupts it. There's no preemption, so no locks are needed, but it also means a slow function freezes everything else.

The event loop is the scheduler that decides what runs next. If you don't know its rules, ordering bugs look random: a state update that "hasn't happened yet", a spinner that never appears, or a `setTimeout(..., 0)` that runs much later than expected.

## How it works

### Tasks, microtasks and rendering

![Event loop: call stack, task queue, microtask queue and the rendering step, with the order in which they run](/figures/event-loop/loop.svg "One task, then all microtasks, then possibly a render.")

The HTML specification defines the pieces:

- **The call stack.** The functions currently executing. The loop only picks new work when it's empty.
- **Task queues.** An event loop has several, by source: timers, user interaction, networking, `postMessage`. The browser may pick between queues (for example, favouring input), but within a queue tasks run in order. "Macrotask" isn't a spec term; it's community shorthand for "task".
- **The microtask queue.** A single FIFO queue. It's **drained completely** after each task, and also whenever the call stack empties in the middle of callback processing (for example, between two event listeners dispatched by a real user click).
- **Update the rendering.** At most once per display frame, typically every 16.7 ms at 60 Hz, and only if something changed. It runs `requestAnimationFrame` callbacks, then style, layout and paint.

The key asymmetry: **one** task per turn, but **all** microtasks per checkpoint. If a microtask queues another microtask, that one runs in the same checkpoint too.

### Ordering in practice

![Ordering of console output for synchronous code, promise microtasks and a zero-delay timeout](/figures/event-loop/order.svg "The script is itself a task; its microtasks run before the timer task.")

```js
console.log('A');
setTimeout(() => console.log('B'), 0);
Promise.resolve().then(() => console.log('C'));
queueMicrotask(() => console.log('D'));
console.log('E');
// A E C D B
```

1. The script is a task. `A` logs, a timer is registered, two microtasks are queued, and `E` logs.
2. The script task ends, so the microtask checkpoint runs `C` and then `D`.
3. Later, when the timer has expired, its callback is queued as a new task and `B` logs.

Notes on timers:

- **Zero isn't zero.** `setTimeout(f, 0)` means "queue a task once at least 0 ms has passed". Nested timers are clamped to at least 4 ms after five levels of nesting, and background tabs throttle timers to once per second or less.
- **Timers are a minimum.** If the main thread is busy for 200 ms, a 10 ms timer fires after 200 ms.

### async/await is microtasks

`await x` splits a function. The code before it runs synchronously. Then the function suspends, and the rest is scheduled as a **microtask** that runs when `x` settles. If `x` is already resolved, the continuation runs in the current microtask checkpoint, not in a later task.

So an `async` function that awaits already-resolved values in a loop never gives the browser a chance to paint or handle input. Each step is a microtask, and the checkpoint keeps going until the queue is empty. `await` doesn't yield to the event loop; it yields to the microtask queue.

### Where rendering fits

![Main-thread timelines: a long task and a microtask chain block frames, chunked tasks let rendering and input run](/figures/event-loop/starve.svg "Only task boundaries give the browser a chance to paint and handle input.")

Rendering happens between tasks, never in the middle of one, and never in the middle of a microtask checkpoint. That has practical consequences:

- **A DOM change is invisible until the task ends.** Showing a spinner and then running a 2-second loop in the same task shows nothing, because the spinner can't paint until the loop is done.
- **Changes made in microtasks are visible in the same frame.** Promise-based state libraries batch updates without causing a flash of intermediate state.
- **`requestAnimationFrame` runs just before paint.** It's the right place for visual updates, and it's paused in background tabs.
- **Long tasks hurt INP.** Any task over 50 ms delays the next frame and the response to clicks, which the Interaction to Next Paint metric captures.

To give the browser a turn, end the current task and continue in a new one: `setTimeout(resolve, 0)`, a `MessageChannel` message (no 4 ms clamp), or `scheduler.yield()` where available. `scheduler.yield()` also puts the continuation ahead of other pending tasks, so your work isn't pushed to the back of the queue.

### Node.js

Node.js uses libuv, whose loop runs in **phases**: timers, pending callbacks, poll (I/O), check (`setImmediate`) and close callbacks. Two queues run between each callback:

- `process.nextTick` callbacks, which run **before** Promise microtasks;
- the Promise microtask queue.

Consequences:

- `setImmediate` runs in the check phase, right after I/O. Inside an I/O callback, it always fires before `setTimeout(f, 0)`. In the main module, their order is not guaranteed.
- Recursive `process.nextTick` can starve I/O completely. Node's docs recommend `queueMicrotask` or `setImmediate` for most cases.

## Where it's used

| Context | Event-loop behaviour |
|---|---|
| Browsers (HTML spec) | task queues per source, microtask checkpoint after each task, rendering steps once per frame |
| Node.js (libuv) | phases (timers, poll, check, close), plus `nextTick` and Promise queues between callbacks |
| Deno, Bun | Promise semantics as in the spec; Deno uses Tokio, Bun its own loop |
| Web Workers | own event loop and microtask queue, no rendering steps |
| React | batches state updates per task; the scheduler yields with `MessageChannel` tasks every ~5 ms |
| Vue, Svelte, Lit | queue DOM updates in a microtask (`nextTick`, `tick()`, `updateComplete`) |
| `scheduler.postTask` / `scheduler.yield()` | prioritised tasks (`user-blocking`, `user-visible`, `background`) |

## Use case walk-through: a frozen CSV import

A dashboard imports a 50,000-row CSV. Clicking **Import** freezes the page for 3 seconds. The progress bar jumps from 0 to 100% at the end, and clicks on **Cancel** are ignored.

1. **Profile.** The Performance panel shows one 3-second task: the click handler parses, validates and inserts all rows in one loop.
2. **First attempt: make it async.** The loop becomes `for (const row of rows) await processRow(row)`. Nothing changes. `processRow` resolves immediately, so every `await` continues in the same microtask checkpoint, and the task still never ends.
3. **Yield to the event loop.** Process 500 rows, update the progress bar, then `await scheduler.yield()` (falling back to a `setTimeout`-based promise). Each chunk is now its own task, about 25 ms long.
4. **Handle cancellation.** The Cancel click now gets a chance to run between chunks. It sets a flag that the loop checks after each yield.
5. **Move the heavy part off the thread.** Parsing and validation don't need the DOM, so they move to a Web Worker. The main thread only receives validated batches and updates the UI.
6. **Result.** The progress bar animates smoothly, Cancel responds within one chunk, and INP during the import drops from over 3 s to under 100 ms.

## Pitfalls

- **Believing `async` means "in the background".** An `async` function runs on the main thread. Without a real task boundary it blocks just like synchronous code.
- **Using `setTimeout(f, 0)` as "next tick".** It's a task, so it runs after rendering and other tasks, and can be clamped or throttled. Use `queueMicrotask` when you need "after the current code, before anything else".
- **Microtask loops.** A promise chain that keeps scheduling itself (polling, recursive `then`) starves rendering and input entirely.
- **Measuring after a DOM change in the same task.** The change hasn't painted. Reading layout forces a synchronous layout, but not a paint. Use `requestAnimationFrame` (or two) to run code after the next frame.
- **Unhandled rejections are reported late.** They're detected after the microtask checkpoint, so a `.catch` attached in a later task still triggers a warning.
- **`process.nextTick` recursion in Node.** It runs before Promises and I/O, so a recursive `nextTick` can starve the whole process.

> [!TIP]
> When ordering surprises you, label each callback with what queued it: "task (timer)", "task (event)", "microtask (promise)", "rAF". Then apply the rule: finish the current task, drain all microtasks, maybe render, take the next task. Almost every puzzle resolves in a few lines.

## Discussion questions

1. Why does a resolved Promise's callback run before a `setTimeout(f, 0)` callback scheduled earlier?
2. Why doesn't `await` inside a loop let the browser repaint, and what would you use instead?
3. A click handler sets `button.disabled = true` and then runs a 1-second computation. What does the user see, and when?
4. What's the difference between `queueMicrotask`, `setTimeout(f, 0)`, `MessageChannel` and `scheduler.yield()`?
5. How does Node's `process.nextTick` differ from a Promise microtask, and why is it easy to misuse?
6. Why do frameworks like Vue batch DOM updates in a microtask, while React's scheduler yields using tasks?

## FAQ

### Are microtasks faster than tasks?

They're not faster to execute; they run **sooner**. A microtask runs as soon as the current call stack empties, before rendering and before any other task. That's useful for consistency (state settles before anyone sees it) and harmful for responsiveness if there's a lot of work.

### Does the browser have one task queue or several?

Several. The spec groups tasks by **task source** (timers, DOM manipulation, user interaction, networking, history), and the browser chooses which queue to take from next. Browsers typically prioritise input, so a click can run before an earlier-queued timer. Order is only guaranteed within one source.

### Where do `requestAnimationFrame` callbacks run?

In the rendering step, after a task and its microtasks, just before style and layout. They're neither tasks nor microtasks. Microtasks queued inside a rAF callback run right after that callback, before the next one.

### Do Web Workers have an event loop?

Yes, each worker has its own event loop, task queues and microtask queue, but no rendering steps. Communication with the main thread happens through `postMessage`, which queues a task on the receiving side.

### Is `setTimeout` accurate?

No. It's a minimum delay. The callback waits for the main thread to be free, nested timers are clamped to 4 ms, background tabs throttle timers heavily, and some browsers align timers to save power. For animation, use `requestAnimationFrame`; for measuring time, use `performance.now()`.

## Key takeaways

- The event loop runs one task, then drains all microtasks, then renders if a frame is due.
- Promise reactions and `await` continuations are microtasks; timers, events and messages are tasks.
- Rendering and input only happen between tasks, so long tasks and microtask chains both freeze the page.
- Break long work into separate tasks (`scheduler.yield()`, `setTimeout`, `MessageChannel`) or move it to a worker.
- Node.js adds phases, `setImmediate` and `process.nextTick`, which runs before Promise microtasks.

## References

- HTML Living Standard: [Event loops](https://html.spec.whatwg.org/multipage/webappapis.html#event-loops)
- MDN: [Using microtasks in JavaScript with queueMicrotask()](https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide)
- MDN: [The event loop](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Event_loop)
- web.dev: [Optimize long tasks](https://web.dev/articles/optimize-long-tasks)
- Node.js documentation: [The Node.js event loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)
- Jake Archibald, "Tasks, microtasks, queues and schedules" (jakearchibald.com, 2015)
- Jake Archibald, "In the Loop" (JSConf.Asia talk, 2018)

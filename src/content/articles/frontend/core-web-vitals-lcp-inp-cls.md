---
summary: The three field metrics Google uses to judge real-user experience - Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift. Covers what each one measures, how it's scored, field vs lab data, how to break each metric into parts you can fix, and the changes that actually move the numbers.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Core Web Vitals are three metrics measured on **real users' devices**:
>
> - **LCP** (Largest Contentful Paint): when the biggest image or text block in the viewport is painted. Good is **≤ 2.5 s**.
> - **INP** (Interaction to Next Paint): the delay from a click, tap or key press until the next frame shows a response, taken from roughly the worst interaction on the page. Good is **≤ 200 ms**.
> - **CLS** (Cumulative Layout Shift): how much visible content moves unexpectedly, taken from the worst burst of shifts. Good is **≤ 0.1**.
>
> Each is judged at the **75th percentile** of page loads, separately for mobile and desktop. To improve one, break it into parts:
>
> - LCP: server time, discovery delay, download and render delay.
> - INP: input delay, handler time and presentation delay.
> - CLS: the specific elements that moved.
>
> Then fix the largest part. Lab tools help you debug, but only field data says whether users got faster.

## The problem: "fast" means different things

Older metrics described the browser, not the user. `DOMContentLoaded` and the `load` event fire at points that may have nothing to do with what the user sees. A page can hit `load` in 1 second and show a spinner for 4 more, or show content early and then freeze for 2 seconds while JavaScript runs. Lab scores from one fast laptop on office Wi-Fi miss the slow phones where most problems happen.

Core Web Vitals, introduced by Google in 2020, pick one metric for each of three questions users actually care about: *Is it loading?* *Does it respond?* *Is it stable?* They're defined so that browsers can measure them on real visits, and they're used in Google Search's page experience signals. INP replaced First Input Delay (FID) as the responsiveness metric in March 2024.

## How it works

### The metrics and their thresholds

![The three Core Web Vitals, LCP, INP and CLS, with their good, needs-improvement and poor thresholds](/figures/web-vitals/thresholds.svg "Each metric is judged at the 75th percentile of real visits.")

The **75th percentile** matters: a page passes only if three out of four visits are good. Improving the median doesn't help if slow devices and networks stay slow. Field data is grouped by device type, so a site can pass on desktop and fail on mobile.

Where the data comes from:

- **Chrome UX Report (CrUX):** anonymised field data from opted-in Chrome users, aggregated per URL and per origin over 28 days. PageSpeed Insights and Search Console show it.
- **Real-user monitoring (RUM):** your own measurement with the `web-vitals` library or a vendor, which lets you segment by page, device, country or release.
- **Lab tools:** Lighthouse and the DevTools Performance panel run one load in controlled conditions. Lab results can't measure INP directly (there's no real user), so Lighthouse reports Total Blocking Time as a proxy.

### LCP: when the main content appears

![LCP broken into time to first byte, resource load delay, resource load duration and element render delay, with fixes for each](/figures/web-vitals/lcp.svg "Find the largest sub-part and fix that one.")

The LCP element is the largest image, video poster, background image or text block **visible in the viewport**. The browser reports new candidates as larger elements paint, and stops at the first user input. The final candidate's paint time is LCP.

LCP splits into four parts, each with different causes:

1. **Time to first byte (TTFB).** Redirects, DNS, TLS, and server time to produce HTML. Fix with caching, a CDN, edge rendering, or fewer redirects.
2. **Resource load delay.** Time from TTFB until the browser *starts* downloading the LCP image. It's large when the image isn't in the initial HTML: a CSS `background-image`, markup rendered by client JavaScript, or an `<img loading="lazy">`. Fix by putting the image in the HTML, adding `fetchpriority="high"`, or `<link rel="preload">`.
3. **Resource load duration.** Download time. Fix with smaller files: AVIF or WebP, correct `srcset`/`sizes`, compression.
4. **Element render delay.** Time from download until paint. Render-blocking CSS and scripts, web fonts for text LCP, or the element being hidden until JavaScript shows it (an A/B-testing script, a carousel, a fade-in animation).

For a text LCP element, there's no resource to load, so it's mostly TTFB plus render delay.

### INP: does it respond?

![Timeline of one interaction split into input delay, processing time and presentation delay until the next frame](/figures/web-vitals/inp.svg "All three parts compete for the main thread.")

For every click, tap and key press (not scroll or hover), the browser measures the time until the next frame is painted after the event handlers ran. Three parts:

- **Input delay:** the event waits because the main thread is busy with something else, such as a hydration task, a third-party script or a timer.
- **Processing time:** your event handlers run. Several listeners for the same interaction (`pointerdown`, `pointerup`, `click`) all count.
- **Presentation delay:** the browser recalculates style, runs layout and paints the change. A huge DOM or a large re-render makes this slow.

INP reports the **worst** interaction on the page, ignoring one outlier for every 50 interactions, so long-lived pages with many interactions aren't punished for a single hiccup. It's reported at the end of the visit, so a page with a slow menu that's opened once still gets a bad INP.

FID, its predecessor, only measured the input delay of the *first* interaction. It was easy to pass, because handlers and rendering didn't count, and the first click is often not the slow one.

### CLS: does it stay still?

![A late-loading ad pushing article text down, with the impact fraction and distance fraction that make up its layout shift score](/figures/web-vitals/cls.svg "Each shift's score is impact fraction times distance fraction.")

A **layout shift** happens when a visible element changes its start position between two frames. Each shift scores:

- **impact fraction:** the area of the viewport covered by the unstable elements, before and after, combined;
- **distance fraction:** the largest distance any of them moved, divided by the viewport's larger dimension;
- **score:** impact fraction × distance fraction.

Shifts are grouped into **session windows**: shifts less than 1 second apart join a window, up to 5 seconds long. CLS is the score of the **worst window**, not the sum over the whole visit, so infinite-scroll pages aren't penalised just for being open long.

**Expected shifts don't count.** A shift within 500 ms of a click, tap or key press (an accordion opening) is excluded. Changes made with `transform` don't count either, because they don't move the element's layout position.

Common causes:

- images and iframes without `width` and `height` (or `aspect-ratio`);
- ads, embeds and banners inserted above existing content;
- web fonts swapping in with different metrics;
- content inserted after a fetch, such as a "Recommended for you" row at the top;
- animating `top` or `height` instead of `transform`.

### Measuring in code

The `web-vitals` library wraps the browser's `PerformanceObserver` entries and handles the edge cases (background tabs, back/forward cache restores, prerendering):

```js
import { onLCP, onINP, onCLS } from 'web-vitals/attribution';

function send(metric) {
  navigator.sendBeacon('/rum', JSON.stringify({
    name: metric.name, value: metric.value, rating: metric.rating,
    page: location.pathname, debug: metric.attribution,
  }));
}
onLCP(send); onINP(send); onCLS(send);
```

The **attribution** build adds the diagnosis: the LCP element and its sub-part timings, the INP target element and its three phases, and the element that shifted most. Without it you know *that* a page is slow but not *why*.

## Where it's used

| Tool / context | Role |
|---|---|
| Chrome UX Report (CrUX) | public field data per origin and URL; the source for Search ranking signals |
| PageSpeed Insights, Search Console | CrUX field data plus a Lighthouse lab run |
| `web-vitals` library | measure the three metrics (and TTFB, FCP) in your own RUM |
| Chrome DevTools Performance panel | live local metrics, LCP element, interaction phases, layout shift regions |
| Lighthouse | lab LCP, CLS and Total Blocking Time as an INP proxy |
| RUM vendors (Datadog, Sentry, SpeedCurve, Vercel Speed Insights) | field data segmented by route, device and release |
| Safari and Firefox | LCP is supported in Firefox; INP and CLS APIs are Chromium-first, so field data mostly reflects Chrome users |

## Use case walk-through: a news site failing on mobile

Search Console reports that article pages fail on mobile: LCP at p75 is 4.1 s, INP 340 ms, CLS 0.22. Desktop passes.

1. **Add attributed RUM.** A week of `web-vitals/attribution` data shows the LCP element is the hero image on 90% of loads, the INP target is usually the "Menu" button, and the largest shifts come from the ad slot below the headline.
2. **LCP.** Sub-parts: TTFB 0.6 s, load delay 1.9 s, download 0.9 s, render delay 0.7 s. The hero is lazy-loaded by a JavaScript image component. Rendering it as a plain `<img>` with `fetchpriority="high"` and `srcset` cuts load delay to 0.2 s, and AVIF halves the download. LCP drops to 2.2 s.
3. **CLS.** The ad slot has no reserved height. Giving it `min-height` equal to the most common ad size, and putting late-loading "related" content below the fold, drops CLS to 0.04.
4. **INP.** The Menu tap often lands during a 400 ms third-party analytics task (input delay), then re-renders the whole header (processing). Loading the analytics script after the page is idle, and toggling the menu with a CSS class instead of re-rendering, brings INP to 150 ms.
5. **Confirm in the field.** Lab scores improved immediately, but CrUX takes 28 days to fully reflect the change. The team watches their own RUM by release instead.

## Pitfalls

- **Optimising the lab score.** A Lighthouse 100 on a fast machine doesn't mean real users pass. Field p75 on mobile is the number that matters.
- **Lazy-loading the LCP image.** `loading="lazy"` on above-the-fold images delays them until layout. Only lazy-load what's below the fold.
- **Hiding content until JavaScript runs.** Fade-in animations, A/B-test anti-flicker snippets and client-rendered heroes all add render delay.
- **Fixing INP by fixing the handler only.** If input delay is the large part, the culprit is some *other* long task, often third-party scripts or hydration.
- **Reserving no space.** Images, embeds and ads without dimensions are the most common CLS source. Skeletons should match the final size.
- **Comparing averages.** Means hide the long tail. Track p75 (and p95 for debugging), by device type.

> [!TIP]
> Always fix the **biggest sub-part** first. Before changing anything, write down the breakdown: four LCP parts, three INP phases, the top shifting element. A 2 s resource load delay won't move if you compress the image, and a 300 ms input delay won't move if you optimise your click handler.

## Discussion questions

1. Why are Core Web Vitals judged at the 75th percentile rather than the median or the mean?
2. Why did INP replace FID, and what kinds of slowness did FID miss?
3. Your LCP element is a CSS background image. Which sub-part of LCP does that hurt, and how would you fix it?
4. Why are shifts within 500 ms of user input excluded from CLS, and how could that be abused?
5. A page has good lab scores but poor field INP. What could explain the difference, and how would you find the cause?
6. Should a single-page app measure Core Web Vitals per route change? What do the metrics actually capture after a client-side navigation?

## FAQ

### Do Core Web Vitals affect search ranking?

They're part of Google's page experience signals, which are used in ranking, but content relevance matters far more. In practice they act as a tie-breaker between similarly relevant pages. The stronger reason to care is that the same problems hurt conversion and engagement.

### Why don't my Lighthouse and PageSpeed field numbers match?

Lighthouse is one simulated load with a specific device and network profile. Field data is 28 days of real visits on real devices, networks and caches, including repeat visits and back/forward-cache restores. Use the lab to debug and field data to decide whether you're done.

### Are client-side navigations in single-page apps measured?

Not by default: the metrics are tied to a full page load. LCP is only measured for the initial load, and CLS and INP accumulate across all the soft navigations until the user leaves. Chrome has been experimenting with soft navigation measurement, but CrUX doesn't report it per route yet.

### What about TTFB and FCP?

Time to First Byte and First Contentful Paint are useful diagnostic metrics, not Core Web Vitals. TTFB is the first part of LCP; FCP tells you when *anything* appears. Total Blocking Time is a lab metric that correlates with INP.

### Can I fix CLS with a skeleton screen?

Only if the skeleton has the same dimensions as the final content. A skeleton that's shorter than what replaces it still causes a shift. For unknown sizes, reserve the most likely size, or place the content below the fold.

## Key takeaways

- LCP measures loading, INP responsiveness, CLS visual stability; each is judged at p75 of real visits, per device type.
- LCP = TTFB + resource load delay + resource load duration + render delay. Make the LCP image discoverable in the HTML and prioritised.
- INP = input delay + processing + presentation delay, for roughly the worst interaction. Break up long tasks and keep updates small.
- CLS is the worst burst of unexpected shifts. Reserve space for anything that loads late.
- Debug with attributed field data and lab tools; confirm with field data.

## References

- web.dev: [Web Vitals](https://web.dev/articles/vitals)
- web.dev: [Largest Contentful Paint (LCP)](https://web.dev/articles/lcp) and [Optimize LCP](https://web.dev/articles/optimize-lcp)
- web.dev: [Interaction to Next Paint (INP)](https://web.dev/articles/inp)
- web.dev: [Cumulative Layout Shift (CLS)](https://web.dev/articles/cls)
- GoogleChrome/web-vitals: [library on GitHub](https://github.com/GoogleChrome/web-vitals)
- Chrome for Developers: [Chrome UX Report](https://developer.chrome.com/docs/crux)
- W3C: Largest Contentful Paint and Event Timing specifications (Web Performance Working Group)

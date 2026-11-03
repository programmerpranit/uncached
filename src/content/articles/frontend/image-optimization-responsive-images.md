---
summary: Why images are usually the heaviest part of a web page, and how to ship the right image to every device. Covers resolution switching with srcset and sizes, art direction with picture, modern formats (WebP and AVIF), compression, lazy loading and fetch priority for the LCP image, reserving space to avoid layout shift, and image CDNs that do the work automatically.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** Images are often most of a page's bytes, and the largest one is usually the **Largest Contentful Paint (LCP)** element. Optimizing them comes down to five habits:
>
> 1. **Send the right size.** Use `srcset` and `sizes` so a phone doesn't download a 2,400-pixel desktop image.
> 2. **Use a modern format.** AVIF or WebP are much smaller than JPEG at the same quality. PNG is for graphics, not photos.
> 3. **Load in the right order.** Fetch the LCP image early with `fetchpriority="high"`, and lazy-load images below the fold.
> 4. **Reserve space.** Set `width` and `height` so the layout doesn't jump when the image arrives.
> 5. **Automate it.** An image CDN or a framework image component can resize, convert and cache for you.

## The problem: one image for every screen

Take a 2,400 × 1,350 hero photo saved as a JPEG at about 600 KB. On a 27-inch monitor it looks great. On a phone with a 390-pixel-wide screen, that same file is downloaded in full, decoded into roughly 13 MB of memory (2,400 × 1,350 pixels × 4 bytes) and then scaled down to fit. Most of those pixels are thrown away.

Images are frequently the largest single category of bytes on a page, according to the HTTP Archive's Web Almanac. They also drive two Core Web Vitals:

- **LCP** measures when the largest visible element finishes rendering. On most pages that element is an image.
- **Cumulative Layout Shift (CLS)** measures how much content jumps around. An image without dimensions takes no space until it loads, then pushes everything below it down.

Mobile users pay the most, on slower networks, with data caps and weaker CPUs for decoding.

## How it works

### Resolution switching with srcset and sizes

The `srcset` attribute lists the same image at several widths. The `w` descriptor tells the browser each file's actual pixel width. The `sizes` attribute tells it how wide the image will be **displayed** at different viewport widths, because the browser has to choose before layout has happened and before CSS has loaded.

```html
<img
  src="hero-1200.jpg"
  srcset="hero-400.jpg 400w, hero-800.jpg 800w,
          hero-1200.jpg 1200w, hero-1600.jpg 1600w"
  sizes="(max-width: 600px) 100vw, 50vw"
  width="1600" height="900"
  alt="Mountain lake at sunrise">
```

![The same img tag on three devices: a phone with DPR 3 needs 1170 pixels and gets the 1200w file, a laptop with DPR 2 needs 1440 and gets 1600w, a 1x desktop needs 960 and gets 1200w](/figures/responsive-images/srcset.svg "The browser does the maths: slot width from sizes, times the device pixel ratio, then the smallest file that covers it.")

The browser takes the slot width from `sizes`, multiplies it by the **device pixel ratio (DPR)**, and picks a candidate at least that wide. The spec leaves the final choice to the browser, so it may choose a smaller file on a slow connection or reuse a larger one it already has cached.

Two details matter:

- **If you leave out `sizes`, it defaults to `100vw`.** A thumbnail in a 300-pixel column would then download a full-screen-width file. Wrong `sizes` values are the most common responsive-image bug.
- **Fixed-size images can use `x` descriptors** instead: `srcset="avatar.png 1x, avatar@2x.png 2x"`. That suits icons and avatars whose display size never changes.

Very high DPRs give diminishing returns. A 3× phone screen rarely looks noticeably better than 2×, so some sites cap candidates at 2× to save bytes.

### Art direction and formats with picture

Sometimes a smaller screen needs a **different crop**, not just fewer pixels. A wide landscape shot shrunk to a phone makes the subject tiny. The `<picture>` element lets you switch sources by media query:

```html
<picture>
  <source media="(max-width: 600px)" srcset="hero-portrait.avif" type="image/avif">
  <source srcset="hero-wide.avif" type="image/avif">
  <source srcset="hero-wide.webp" type="image/webp">
  <img src="hero-wide.jpg" width="1600" height="900" alt="Mountain lake at sunrise">
</picture>
```

The browser uses the first `<source>` whose `media` matches and whose `type` it supports. The inner `<img>` is required. It's the element that actually renders, carries the `alt` text and dimensions, and serves as the fallback.

### Choosing a format

![Bar chart of illustrative sizes for one photo: PNG about 1,400 KB, JPEG about 240 KB, WebP about 165 KB, AVIF about 115 KB](/figures/responsive-images/formats.svg "Illustrative numbers. The right format often matters more than any other single change.")

- **JPEG.** Universal, lossy, good for photos. Use progressive encoding and a modern encoder like MozJPEG.
- **PNG.** Lossless. Great for screenshots, flat graphics and transparency, terrible for photos.
- **WebP.** Supported by all modern browsers. Lossy WebP is typically 25–35% smaller than JPEG at similar quality, and it supports transparency and animation.
- **AVIF.** Based on the AV1 video codec, often around 50% smaller than JPEG, with good handling of gradients and HDR. Encoding is slower, so generate it at build time or cache it in a CDN.
- **SVG.** Vector, so it stays sharp at any size. Best for logos, icons and diagrams. Minify it with a tool like SVGO.
- **Animated GIF.** Replace it with a muted, looping `<video>`, which is usually many times smaller.

**Quality settings** matter as much as format. Most photos look identical to the eye at quality 75–85, and the last few points of quality cost a lot of bytes. Stripping metadata (camera EXIF data, embedded colour profiles you don't need) saves a little more.

### Loading in the right order

![A page mock-up: the above-the-fold hero is loaded with high fetch priority, images below the fold use loading lazy, and every image has width and height to reserve space](/figures/responsive-images/loading.svg "The LCP image should be first in line. Everything below the fold can wait.")

- **The LCP image.** Load it eagerly and add `fetchpriority="high"`, which moves it up the browser's download queue. If CSS or JavaScript inserts it (a CSS background, a client-rendered carousel), the browser can't discover it early. Use `<link rel="preload" as="image">` with `imagesrcset` and `imagesizes`, or better, put it in the HTML as a real `<img>`.
- **Below the fold.** `loading="lazy"` makes the browser wait until the image is close to the viewport before fetching it. Browsers start loading a bit early, so users rarely see the delay.
- **Never lazy-load the LCP image.** It's a common mistake when a component library adds `loading="lazy"` to every image. The browser then waits for layout before even requesting the most important file.
- **`decoding="async"`** hints that the browser can decode the image without holding up other rendering.

### Reserving space

Setting `width` and `height` attributes lets the browser compute the **aspect ratio** before the file arrives. Modern browsers map those attributes to a CSS `aspect-ratio`, so with `img { width: 100%; height: auto; }` the image still scales responsively while its box is reserved. For images in CSS-sized containers, set `aspect-ratio` directly and use `object-fit: cover` to crop.

A **placeholder** can fill that reserved space while loading: a solid dominant colour, a tiny blurred version (often called LQIP, low-quality image placeholder) or a BlurHash string. It makes the wait feel shorter but adds a few bytes and some complexity.

### Image CDNs and framework components

Generating four widths × three formats for every image by hand doesn't scale. **Image CDNs** (Cloudinary, imgix, Cloudflare Images, Vercel's and Netlify's image services) transform images from URL parameters, like `/hero.jpg?w=800&format=auto`. They pick AVIF or WebP from the browser's `Accept` header, resize on the first request and cache the result at the edge.

Framework components such as `next/image`, Astro's `<Image>` and Angular's `NgOptimizedImage` generate `srcset`, require dimensions, lazy-load by default and warn about common mistakes. They still need a correct `sizes` value and a priority flag for the LCP image, because only you know the layout.

## Where it's used

| Context | Typical technique | Why |
|---|---|---|
| News and blog article images | `srcset` + `sizes`, lazy below the fold | Many images, mostly read on phones |
| E-commerce product galleries | Image CDN with `format=auto`, zoom loads a larger file | Thousands of SKUs, images change often |
| Landing page hero | AVIF/WebP, `fetchpriority="high"`, preload | It's the LCP element |
| Responsive marketing banners | `<picture>` with art-directed crops | Text and subject must stay readable on phones |
| User avatars and icons | `x` descriptors or SVG | Fixed display size |
| Social feeds and infinite scroll | Lazy loading, placeholders, reserved aspect ratio | Avoid layout shift while scrolling |

## Use case walk-through: fixing a slow product page

A product page has a mobile LCP of 4.8 seconds and a CLS of 0.21. The hero image is a 2,000-pixel PNG of 1.9 MB, inserted by a JavaScript carousel.

1. **Find the LCP element.** In Chrome DevTools' Performance panel, the LCP marker points to the hero image. Its request starts only after the carousel bundle runs, about 1.6 seconds in.
2. **Render the first slide in HTML** as a real `<img>` instead of injecting it with JavaScript. The browser's preload scanner now discovers it immediately.
3. **Switch format and size.** Convert to AVIF and WebP with a JPEG fallback, and generate widths of 480, 800, 1200 and 1600. The phone download drops from 1.9 MB to about 70 KB.
4. **Write a correct `sizes`.** The hero is full width on phones and 60% wide on desktop, so `sizes="(max-width: 768px) 100vw, 60vw"`.
5. **Set the priority.** Add `fetchpriority="high"` to the hero, and remove the `loading="lazy"` that the carousel added to every slide. Keep lazy loading for slides 2 onward and for reviews further down.
6. **Fix CLS.** Add `width` and `height` to every product thumbnail, which were rendering at zero height and then pushing the reviews down.
7. **Verify with field data.** Check Chrome UX Report or your own real-user monitoring over the next weeks, not only a lab run.

**Result:** mobile LCP falls to about 1.9 seconds, CLS to 0.02, and image bytes on the page drop by over 80%.

## Pitfalls

- **Missing or wrong `sizes`.** Without it, every candidate is judged against full viewport width, and small images download huge files.
- **Lazy-loading the LCP image.** This delays the most important resource on the page.
- **Images hidden in CSS or JavaScript.** Background images and client-rendered images aren't found by the preload scanner, so they start late.
- **Upscaling small sources.** A 600-pixel original resized to 1,600 is just a bigger blurry file. Keep high-resolution masters.
- **Forgetting `alt`.** Informative images need a meaningful description. Decorative ones need `alt=""` so screen readers skip them.
- **Encoding AVIF on every request without caching.** It's slow to encode, so a cold server can make the first visitor wait longer than a JPEG would.
- **Huge decoded size.** A file can be small on the wire but still take lots of memory and decode time if its pixel dimensions are far larger than needed.

> [!WARNING]
> Don't add `loading="lazy"` to every `<img>` by default. Make lazy loading the default only for images you know start below the fold, and explicitly mark the hero or first visible product image as eager with high priority.

## Discussion questions

1. Why does the browser need the `sizes` attribute instead of measuring the image's CSS width?
2. When should you use `<picture>` with `media` instead of just `srcset`?
3. A designer insists on 3× images for all phones. How would you weigh visual quality against bytes?
4. What changes when the LCP image is a CSS background instead of an `<img>`?
5. Why might a lab test show a fast LCP while real users see a slow one?
6. What are the trade-offs between building image variants at build time and generating them in an image CDN on demand?

## FAQ

### Should I always use AVIF?

It's a good default with a WebP or JPEG fallback, and image CDNs handle the negotiation for you. For very small images the savings are tiny, and encoding is slower, so generate AVIF ahead of time or cache it.

### How many widths should I put in srcset?

Usually four to six, spread so neighbouring sizes differ by roughly 30–50% in file size. More candidates give a closer match but add cache variants and build time.

### Does loading="lazy" work for background images?

No, it only applies to `<img>` and `<iframe>`. For CSS backgrounds below the fold, you need an `IntersectionObserver` that adds a class or style when the element approaches the viewport.

### What is the difference between preload and fetchpriority?

`<link rel="preload">` makes the browser discover a resource early, before it finds it in the HTML or CSS. `fetchpriority="high"` changes its position in the download queue once discovered. For an `<img>` already in the HTML, `fetchpriority` alone is usually enough.

### Do I need responsive images if I use an image CDN?

Yes. The CDN can produce any size, but the browser still needs `srcset` and `sizes` to know which URL to request. Most CDNs and framework components generate the `srcset` for you.

## Key takeaways

- Images are often the heaviest resources and the LCP element, so they deserve deliberate handling.
- `srcset` lists the available widths, and `sizes` tells the browser the display width. Together they let it download just enough pixels.
- Use `<picture>` for different crops or format fallbacks. AVIF and WebP beat JPEG; PNG and SVG are for graphics.
- Give the LCP image high priority and never lazy-load it. Lazy-load what's below the fold.
- Always set dimensions or `aspect-ratio` to prevent layout shift.
- Image CDNs and framework components automate the tedious parts, but correct `sizes` and priorities are still your job.

## References

- MDN: [Responsive images](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images)
- MDN: [The picture element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/picture)
- MDN: [Lazy loading](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading)
- web.dev: [Optimize Largest Contentful Paint](https://web.dev/articles/optimize-lcp)
- web.dev: [Optimizing resource loading with the Fetch Priority API](https://web.dev/articles/fetch-priority)
- web.dev: [Optimize Cumulative Layout Shift](https://web.dev/articles/optimize-cls)
- HTTP Archive: Web Almanac, Media and Page Weight chapters (almanac.httparchive.org)
- HTML Standard: Images section (html.spec.whatwg.org/multipage/images.html)

---
summary: Why the browser blocks your fetch to another domain, and how servers grant exceptions. Covers what an origin is, what the same-origin policy actually restricts, simple requests vs preflights, credentials and cookies, caching with Vary, the misconfigurations that turn CORS into a security hole, and how to debug "blocked by CORS policy" errors.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** The **same-origin policy** stops JavaScript on one origin (scheme + host + port) from reading responses from another. **CORS** (Cross-Origin Resource Sharing) is the way a server opts out, per request, by sending `Access-Control-Allow-*` headers.
>
> - The browser still **sends** most cross-origin requests; it just refuses to let your script **read** the response unless the server allows it.
> - Requests that aren't "simple" (PUT, DELETE, JSON bodies, custom headers) trigger a **preflight** `OPTIONS` request that asks permission first.
> - With cookies, the server must name an **exact origin** and send `Allow-Credentials: true`; `*` is not allowed.
> - CORS protects **users' data in browsers**. It is not an API access control: curl, servers and scripts ignore it completely.

## The problem: your logged-in browser is a liability

Your browser holds cookies for your bank, your email and your company's admin panel. Every page you open can make requests, and the browser attaches cookies to them automatically. Without a rule, any page on the internet could run `fetch('https://mail.example.com/inbox')`, have your cookies sent along, and read the answer.

The **same-origin policy** (SOP) is that rule. A script may freely read responses from its own origin. For other origins, the browser lets the request happen in many cases (that's how images, forms and scripts from CDNs have always worked) but it hides the response from JavaScript.

That broke a common need: a frontend at `app.example.com` calling an API at `api.example.com`. Before CORS, people used hacks like JSONP (loading data as a `<script>`) or proxying everything through the same domain. CORS gave servers a standard way to say "this origin is allowed to read my responses."

## How it works

### What is an origin?

An origin is the triple **scheme + host + port**. Two URLs have the same origin only if all three match. The path, query string and fragment don't matter.

![Comparing URLs to https://app.example.com: only a different path keeps the same origin; scheme, host or port changes make it cross-origin](/figures/cors/origin.svg "Only the path can differ. A subdomain, another port or http instead of https is a different origin.")

Don't confuse **origin** with **site**. A site is the scheme plus the registrable domain (`https://example.com`), so `app.example.com` and `api.example.com` are *same-site* but *cross-origin*. Cookies' `SameSite` attribute uses sites; CORS uses origins.

### What the same-origin policy restricts

The SOP is not one rule but a family of them:

- **Reading responses** from `fetch`/`XMLHttpRequest`: blocked across origins unless CORS allows it.
- **Accessing the DOM** of another window or iframe: blocked across origins (`iframe.contentDocument` is `null`). `postMessage` is the sanctioned channel.
- **Storage** (localStorage, IndexedDB, Cache Storage): partitioned per origin.
- **Embedding** is mostly allowed: `<img>`, `<script>`, `<link rel=stylesheet>`, `<video>` and form submissions can all go cross-origin. Your script just can't read the bytes (a cross-origin image draws on a canvas but "taints" it so `getImageData` throws).

That last point matters: **the SOP doesn't stop requests from being sent**. A form on `evil.example` can POST to your bank. That is why CSRF protection exists separately, and why CORS is about *reading*, not *sending*.

### Simple requests

When your script makes a cross-origin request, the browser adds an `Origin` header saying who is asking. For a **simple request** it sends the request straight away, then looks at the response:

```http
GET /items HTTP/1.1
Host: api.example.com
Origin: https://app.example.com

HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://app.example.com
Content-Type: application/json
```

If `Access-Control-Allow-Origin` matches the page's origin (or is `*`), JavaScript gets the response. If not, `fetch` rejects with a `TypeError`, and the console shows "blocked by CORS policy". The server still received and processed the request.

A request is simple when it uses `GET`, `HEAD` or `POST`, sets only safelisted headers (like `Accept`, `Accept-Language`, `Content-Language`), and its `Content-Type`, if any, is `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`. These are exactly the requests an HTML form could already send before CORS existed, so allowing them to be sent doesn't add any new risk.

### Preflight requests

Anything else, such as `PUT`, `DELETE`, a JSON body, or an `Authorization` header, could be a request that old servers never expected from another site. So the browser asks first with an `OPTIONS` **preflight**:

![A simple cross-origin GET versus a PUT that first sends an OPTIONS preflight and only proceeds if the server allows the method and headers](/figures/cors/preflight.svg "Simple requests go straight through. Others first ask with OPTIONS; if the answer doesn't allow them, the real request is never sent.")

The server answers with what it allows:

- `Access-Control-Allow-Origin`: which origin may proceed.
- `Access-Control-Allow-Methods`: e.g. `GET, PUT, DELETE`.
- `Access-Control-Allow-Headers`: e.g. `content-type, authorization`.
- `Access-Control-Max-Age`: how many seconds the browser may cache this answer, so it doesn't preflight every call. Browsers cap it (Chromium at 2 hours, Firefox at 24 hours).

Only if the preflight succeeds does the browser send the actual request, and that response must *also* carry `Access-Control-Allow-Origin`.

A preflight adds a full round trip. On a high-latency mobile link, a chatty app that preflights every call can double its API latency. Setting `Max-Age`, avoiding unnecessary custom headers, or serving the API from the same origin (via a reverse proxy path like `/api`) all help.

### Credentials: cookies and auth

By default, cross-origin `fetch` does **not** send cookies. To include them, both sides must opt in:

![For credentialed CORS the client opts in with credentials include and the server must echo an exact origin, allow credentials and vary on Origin](/figures/cors/credentials.svg "Credentialed requests need opt-in on both sides and an exact origin, not a wildcard.")

```js
fetch('https://api.example.com/me', { credentials: 'include' })
```

```http
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
Vary: Origin
```

With credentials, `*` is forbidden in `Allow-Origin`, `Allow-Headers` and `Allow-Methods`. The server must name the exact origin. If it allows several origins, it checks the incoming `Origin` against an allowlist and echoes the matching one back, adding `Vary: Origin` so shared caches and CDNs don't serve a response meant for one origin to another.

The cookie itself also has to be sendable. Since browsers made `SameSite=Lax` the default, a cookie used from a different *site* needs `SameSite=None; Secure`. And browsers increasingly block or partition third-party cookies, so credentialed cross-site CORS is becoming less reliable than a token in an `Authorization` header.

### Reading response headers

Even on a successful CORS response, JavaScript can only see a few "safelisted" response headers (`Content-Type`, `Content-Length`, `Cache-Control`, `Expires`, `Last-Modified`, `Pragma`, `Content-Language`). To expose others, such as `X-Request-Id` or a pagination `Link` header, the server must list them in `Access-Control-Expose-Headers`.

### Related headers: CORP, COOP and COEP

CORS controls *reads by scripts*. A few newer headers deal with other leaks, especially after the Spectre attacks showed that a page might read cross-origin data from its own process memory:

- **Cross-Origin-Resource-Policy** (`CORP`): the resource says "don't let other origins even embed me" (`same-origin`, `same-site`).
- **Cross-Origin-Opener-Policy** (`COOP`): puts your page in its own browsing context group, cutting `window.opener` links to cross-origin popups.
- **Cross-Origin-Embedder-Policy** (`COEP`): your page promises to load only resources that opted in via CORS or CORP.

COOP plus COEP makes a page "cross-origin isolated", which unlocks `SharedArrayBuffer` and high-resolution timers.

## Where it's used

| Situation | What CORS looks like |
|---|---|
| SPA on `app.` calling API on `api.` | Allowlist of origins, credentials or bearer tokens, preflights cached with `Max-Age` |
| Public read-only API (e.g. open data) | `Access-Control-Allow-Origin: *`, no credentials |
| Fonts on a CDN | Browsers fetch web fonts in CORS mode, so the CDN must send `Allow-Origin` |
| Images drawn on a canvas | `<img crossorigin="anonymous">` + server `Allow-Origin` so the canvas isn't tainted |
| Scripts with Subresource Integrity | `<script crossorigin>` so error details and integrity checks work |
| Object storage (S3, GCS buckets) | Per-bucket CORS rules for browser uploads with pre-signed URLs |
| Local development | Vite/webpack dev-server proxy to avoid CORS entirely |

## Use case walk-through: moving an API to its own subdomain

A team moves their API from `example.com/api` to `api.example.com`. The frontend stays on `app.example.com` and uses a session cookie.

1. **First deploy:** every call fails with "No 'Access-Control-Allow-Origin' header". The requests do reach the server (logs show them), but the browser hides the responses.
2. **Quick fix attempt:** they add `Access-Control-Allow-Origin: *`. GETs without cookies work, but logged-in calls fail: `*` isn't allowed with credentials, and the frontend wasn't sending `credentials: 'include'` anyway.
3. **Proper config:** the server checks `Origin` against an allowlist (`https://app.example.com`, plus the staging origin), echoes it back, sets `Allow-Credentials: true` and `Vary: Origin`. The frontend adds `credentials: 'include'`.
4. **Preflights:** `PUT` and `DELETE` with JSON bodies now preflight. The `OPTIONS` route was behind the auth middleware, which returned 401 because preflights never carry cookies. They move CORS handling *before* auth.
5. **Cookie:** the session cookie was scoped to `example.com` with `SameSite=Lax`. Since `app.` and `api.` are same-site, that works without `SameSite=None`.
6. **Latency:** they set `Access-Control-Max-Age: 7200` so each page session preflights each endpoint at most once.

**Result:** the API works from the app and staging, other sites still can't read users' data, and the extra round trips are limited to the first call of each kind.

## Pitfalls

- **Reflecting any `Origin` with credentials.** Echoing back whatever `Origin` arrives, together with `Allow-Credentials: true`, lets any website read your logged-in users' data. It is one of the most common CORS vulnerabilities.
- **Sloppy origin matching.** Checking `origin.endsWith('example.com')` also allows `evilexample.com`; checking `startsWith('https://example.com')` allows `https://example.com.attacker.net`. Compare against an exact list.
- **Allowing `null`.** Sandboxed iframes and `file://` pages send `Origin: null`. Attackers can produce it too, so never allowlist `null`.
- **Missing `Vary: Origin`.** A CDN caches the response for origin A and serves it to origin B, which then fails (or, worse, succeeds when it shouldn't).
- **Auth before CORS.** Preflights carry no credentials. If middleware rejects unauthenticated `OPTIONS`, every non-simple request breaks.
- **Error responses without CORS headers.** If your 500 or 404 handler skips the CORS headers, the frontend sees a vague CORS error instead of the real status.
- **Treating CORS as security for your API.** CORS doesn't stop curl, a backend, or a malicious browser extension. Authentication and authorization still have to happen on every request.
- **`mode: 'no-cors'` as a "fix".** It sends the request but gives you an opaque response with no body or status. It's useful for fire-and-forget pings and caching, not for reading data.

> [!WARNING]
> "Blocked by CORS policy" does not mean the request wasn't sent. A cross-origin POST from a form or a simple `fetch` reaches your server and changes state even if the browser hides the response. State-changing endpoints still need CSRF protection (SameSite cookies, CSRF tokens, or checking `Origin`).

## Discussion questions

1. Why does the browser send simple cross-origin requests without asking first, but preflight a `PUT` with JSON?
2. Your API is called only by your own backend servers. Do you need CORS at all? What about if a mobile app calls it?
3. How would you design an origin allowlist that supports preview deployments like `pr-123.app.example.com` without opening a hole?
4. Why is `Access-Control-Allow-Origin: *` combined with credentials forbidden, and what attack would it allow?
5. What trade-offs come with avoiding CORS by putting the API behind a `/api` path on the same origin?
6. How do third-party cookie restrictions change the way you'd build cross-site authenticated APIs?

## FAQ

### Why does my request work in curl or Postman but fail in the browser?

CORS is enforced by browsers, not servers. curl and Postman don't run untrusted page scripts with your cookies, so they don't apply the same-origin policy. The server answered both; only the browser refused to hand the answer to your page.

### Can I fix CORS from the frontend?

No. The server (or a proxy you control) has to send the headers. On the frontend you can only change what you request: drop custom headers to avoid a preflight, or route calls through a same-origin proxy such as your dev server or an edge function.

### Is `Access-Control-Allow-Origin: *` unsafe?

Not on its own. It's fine for truly public data that needs no login, because browsers won't send cookies with it. It becomes a problem when the "public" endpoint actually relies on network location (an intranet service) or on cookies for access.

### Why do I see two requests in the Network tab?

The first is the `OPTIONS` preflight, the second is your real request. If you see the preflight every time, the server isn't sending `Access-Control-Max-Age`, or the request varies in a way that misses the preflight cache.

### Does CORS protect against CSRF?

Only partly. Preflights stop cross-site JSON `PUT`/`DELETE` requests from being sent without permission, but simple requests, including form-encoded POSTs, still go through. Use `SameSite` cookies and CSRF tokens or `Origin` checks for state-changing endpoints.

## Key takeaways

- An origin is scheme + host + port; the path never matters, and same-site is not same-origin.
- The same-origin policy blocks *reading* cross-origin responses, not sending requests.
- Servers grant read access with `Access-Control-Allow-Origin`; non-simple requests are preflighted with `OPTIONS`.
- Credentialed CORS needs `credentials: 'include'`, an exact echoed origin, `Allow-Credentials: true` and `Vary: Origin`.
- Validate origins against an exact allowlist; reflecting any origin with credentials is a serious vulnerability.
- CORS is a browser protection for users, not access control for your API.

## References

- MDN: [Cross-Origin Resource Sharing (CORS)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- MDN: [Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy)
- WHATWG: [Fetch Standard, CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol)
- web.dev: [Same-site and same-origin](https://web.dev/articles/same-site-same-origin)
- web.dev: [Making your website "cross-origin isolated" using COOP and COEP](https://web.dev/articles/coop-coep)
- PortSwigger Web Security Academy: CORS vulnerabilities (portswigger.net/web-security/cors)

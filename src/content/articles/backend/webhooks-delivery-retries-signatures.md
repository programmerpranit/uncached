---
summary: How to push events to systems you don't control — durable outbox, at-least-once delivery with backoff, HMAC signatures with replay protection, and consumers that ack fast and dedupe.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR** — A webhook is an HTTP POST you send to someone else's server when something happens. Make it reliable by writing the event durably *with* the business change (outbox), delivering asynchronously with exponential backoff and a dead-letter/disable path, and signing every request with an HMAC over a timestamp and the raw body. Consumers should verify, store the event ID, return 2xx within a second, and process later — expecting duplicates and out-of-order arrival.

## The problem: notifying servers you don't run

Polling an API to ask "did anything change?" is wasteful for both sides. Webhooks invert it: the provider calls the consumer. But the consumer's endpoint is outside your control — it may be down, slow, misconfigured, behind a firewall, or an attacker pretending to be you. The network may drop the response after the consumer already processed the request. And the consumer has no way to know whether a POST really came from you.

So a webhook system has to answer three questions: **Will the event definitely be sent?** (durability and retries), **Can the receiver trust it?** (signatures and replay protection), and **What happens when it arrives twice or late?** (idempotent consumers).

## How it works

### Durable, asynchronous delivery

![Webhook delivery pipeline](/figures/webhooks/delivery.svg "Commit the event with the domain write, then deliver from a queue with backoff retries")

Never send the webhook inline inside the request that changed the data. If you POST before committing, a rollback means you announced something that didn't happen; if you POST after committing, a crash in between means you never announce it. Instead, insert an event row in the **same transaction** as the domain change (the transactional outbox), and let a separate dispatcher read it and deliver.

The dispatcher:

- Looks up each subscription matching the event type and creates a delivery attempt per endpoint.
- Signs and POSTs the payload with a short timeout (5–30 s). Any 2xx is success; anything else, including timeouts and connection errors, is a failure.
- Schedules retries with **exponential backoff and jitter** — e.g. 1 min, 5 min, 30 min, 2 h, 8 h, 24 h — spread over a day or more so a consumer outage of a few hours loses nothing.
- After the final attempt, parks the delivery in a dead-letter store, notifies the endpoint owner, and, if an endpoint fails consistently, disables it automatically.
- Isolates endpoints from each other: per-endpoint queues or concurrency limits stop one slow customer from blocking everyone else's deliveries.

This gives **at-least-once** delivery. Exactly-once over HTTP is impossible: if the consumer processes the request and the response is lost, the sender must retry. Duplicates are therefore part of the contract, which is why every event carries a stable unique ID.

### Signing and replay protection

![Signature verification](/figures/webhooks/signature.svg "HMAC-SHA256 over timestamp and raw body; the receiver checks freshness, recomputes and compares in constant time")

Each endpoint gets its own shared secret. For every request the sender computes `HMAC-SHA256(secret, timestamp + "." + raw_body)` and sends the timestamp and signature as headers. The receiver:

1. **Checks freshness** — rejects the request if the timestamp is more than a few minutes old. Because the timestamp is inside the signed payload, an attacker can't replay a captured request later with a new timestamp.
2. **Recomputes the HMAC over the raw bytes** exactly as received. Parsing JSON and re-serialising changes whitespace and key order and breaks the signature — a very common bug.
3. **Compares in constant time** (`hmac.compare_digest`, `crypto.timingSafeEqual`) so the comparison doesn't leak how many bytes matched.
4. **Deduplicates** by event ID, which also catches replays inside the freshness window.

Secrets must be rotatable without downtime: for a period the sender includes signatures from both the old and new secrets (or the receiver accepts either), then the old one is retired. The open [Standard Webhooks](https://www.standardwebhooks.com/) specification codifies this scheme — `webhook-id`, `webhook-timestamp`, `webhook-signature` headers with multiple space-separated signatures — and is a good default if you're designing from scratch.

Some providers use asymmetric signatures (Ed25519, or signed JWTs) so consumers only need a public key; this avoids distributing shared secrets but costs more CPU per request. Mutual TLS is a further option for high-trust B2B integrations.

### Consumer-side handling

![Consumer handling](/figures/webhooks/consumer.svg "Verify, record the event ID, return 200 quickly, then process asynchronously")

The consumer's handler should do the minimum synchronously: verify the signature, insert the event (with a unique constraint on its ID) into a table or queue, and return 200. Doing heavy work inline risks exceeding the sender's timeout, which triggers a retry — of work that may already be half-done.

Because providers don't guarantee ordering (retries reorder by definition), treat events as **hints that something changed** rather than authoritative state. A robust pattern is "thin" events: the payload carries the object ID and type, and the worker fetches the current object from the provider's API. Alternatively, compare a version number or `updated_at` and ignore events older than what you already applied.

### Payload design and operations

- **Fat vs thin payloads.** Fat payloads (the full object) save a round trip but can be stale and may leak data to the wrong endpoint if misconfigured. Thin payloads force a fetch but are always fresh and keep sensitive fields behind normal API auth.
- **Versioning.** Pin each subscription to an API version and render the payload in that version, so schema changes don't break existing consumers.
- **SSRF protection.** Customer-supplied URLs can point at your internal network (`169.254.169.254`, `10.0.0.0/8`). Resolve DNS, block private and link-local ranges, and send from an egress proxy with fixed IPs that customers can allowlist.
- **Observability for customers.** A delivery log with request, response status, latency and a "resend" button removes most support tickets.

## Where it's used

| System | Delivery & retry | Signature scheme |
|---|---|---|
| Stripe | Retries with backoff for up to 3 days; disables after persistent failure | `Stripe-Signature`: `t=` timestamp + `v1=` HMAC-SHA256 |
| GitHub | Single attempt; manual redelivery from UI/API | `X-Hub-Signature-256`: HMAC-SHA256 of body |
| Shopify | Retries over 48 h; removes subscription after repeated failure | `X-Shopify-Hmac-Sha256`, base64 HMAC |
| Twilio | Configurable retries via connection overrides | `X-Twilio-Signature`, HMAC-SHA1 over URL + params |
| Svix / Standard Webhooks | Backoff schedule over ~1 day; endpoint disable | `webhook-signature` with multiple versioned signatures |
| Slack Events API | Retries 3 times with `X-Slack-Retry-Num` | `X-Slack-Signature` over `v0:timestamp:body` |

## Use case walk-through: payment events for an online store

A store relies on a payment provider's `payment.succeeded` webhook to mark orders paid and start fulfilment.

1. A customer pays. The provider commits the charge and an outbox event `evt_9f2` in one transaction.
2. The dispatcher signs and POSTs to `https://store.example/hooks/payments`. The store's server is mid-deploy and returns 503.
3. The provider retries after ~1 minute, then 5 minutes. On the third attempt the store responds.
4. The store's handler verifies the timestamp (within 5 minutes) and the HMAC over the raw body, inserts `evt_9f2` into `webhook_events` (unique on ID), enqueues a job, and returns 200 in 40 ms.
5. Due to a network blip, the provider never saw that 200 and sends `evt_9f2` again. The insert hits the unique constraint; the handler returns 200 and does nothing.
6. The worker fetches `GET /payments/pay_123` from the provider, sees `status=succeeded`, and marks the order paid — idempotently, keyed on the payment ID.
7. Meanwhile a `payment.refunded` event for a different order arrived *before* its `payment.succeeded`. Because the worker always reads current state, the order ends up correctly refunded.

**Result:** despite a deploy outage, a lost response and reordering, every order ends in the right state exactly once, and no forged or replayed request was accepted.

## Pitfalls

- **Sending inline in the request path.** Couples your latency to the slowest customer and loses events on crash. Always go through a durable queue.
- **Verifying against parsed JSON.** Frameworks that parse the body before your handler sees it break signatures. Capture the raw bytes.
- **Plain `==` for signature comparison.** Use a constant-time compare.
- **No timestamp check.** A captured request can be replayed forever.
- **Slow consumers.** Doing work synchronously causes timeouts, retries and duplicate processing.
- **Assuming order.** Retries and parallel delivery reorder events; design consumers for it.
- **Unbounded retries to dead endpoints.** Wastes capacity; disable and notify instead.
- **SSRF via customer URLs.** Validate destination IPs at connect time, not just at registration (DNS can change).

> [!TIP]
> When building a consumer, put a durable queue directly behind your webhook endpoint (or use a managed ingestion service). Your "receive" path then becomes trivially fast and reliable, and your processing path can fail, retry and be redeployed without the sender ever noticing.

## Discussion questions

1. Why is exactly-once delivery over HTTP impossible, and what does that imply for the consumer?
2. How would you prevent one customer's slow endpoint from delaying deliveries to all other customers?
3. What are the trade-offs between fat and thin payloads with respect to freshness, privacy and load on your API?
4. Design a zero-downtime secret rotation flow for both sender and receiver.
5. When would you choose asymmetric signatures over HMAC?
6. How should a consumer handle receiving `order.updated` with version 4 after it already applied version 5?

## FAQ

### Should I retry on 4xx responses?
Usually yes for most codes, since a misconfigured or temporarily broken endpoint often returns 4xx, and the owner may fix it within the retry window. Some providers stop on 410 Gone, treating it as an unsubscribe signal.

### How long should the consumer take to respond?
As little as possible — aim for under a second. Most providers time out somewhere between 5 and 30 seconds and treat a timeout as a failure, triggering a retry.

### Is HTTPS enough without signatures?
No. TLS proves the consumer's identity to the sender, not the sender's identity to the consumer. Anyone who learns the URL can POST to it. The signature authenticates the sender.

### Webhooks vs a message broker vs polling?
Webhooks suit cross-organisation integration where the consumer only exposes HTTP. Inside one organisation, a broker (Kafka, SQS, Pub/Sub) gives better ordering, replay and back-pressure. Polling or an events-list API is a useful complement: consumers can reconcile missed events by listing them.

### How do I test webhooks locally?
Use a tunnelling tool or the provider's CLI to forward events to localhost, and replay recorded payloads with valid signatures in automated tests. Many providers also offer a "send test event" button.

## Key takeaways

- Write the event in the same transaction as the change, then deliver asynchronously.
- Delivery is at-least-once: retry with exponential backoff and jitter, then dead-letter and disable.
- Sign `timestamp + raw body` with HMAC, check freshness, compare in constant time, support rotation.
- Consumers: verify, record the event ID, return 2xx fast, process later.
- Expect duplicates and reordering; treat events as hints and fetch current state.
- Protect the sender from SSRF and isolate endpoints from each other.

## References

- [Standard Webhooks specification](https://www.standardwebhooks.com/)
- [Stripe Docs — Receive Stripe events in your webhook endpoint](https://docs.stripe.com/webhooks)
- [GitHub Docs — Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Slack API — Verifying requests from Slack](https://api.slack.com/authentication/verifying-requests-from-slack)
- RFC 2104 — HMAC: Keyed-Hashing for Message Authentication (Krawczyk, Bellare, Canetti, 1997)
- [OWASP — Server-Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

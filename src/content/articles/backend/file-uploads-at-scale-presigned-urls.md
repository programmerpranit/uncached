---
summary: Presigned URLs let clients upload straight to object storage, so large files never pass through your app servers — but validation, cleanup and serving still need careful design.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — Don't stream user uploads through your API servers. Have the API **authorize** the upload and hand back a short-lived, narrowly scoped **presigned URL**; the client sends the bytes **directly to object storage** (S3, GCS, Azure Blob). For big files, use **multipart or resumable uploads** so a failed chunk is retried on its own. Treat every uploaded object as **untrusted** until an asynchronous worker has checked its size, real type and content, and only then move it somewhere it can be served.

## The problem: bytes through your app servers

The naive upload endpoint accepts `multipart/form-data`, buffers the file, and writes it to disk or object storage. It works in development and hurts in production:

- **Memory and disk.** A few concurrent 2 GB video uploads can exhaust an instance's memory or temp disk.
- **Timeouts.** Load balancers, gateways and serverless platforms cap request duration and body size (AWS API Gateway caps payloads at 10 MB; Lambda at 6 MB synchronous). A slow mobile connection uploading 500 MB will hit them.
- **Wasted capacity.** Threads or connections are held open for minutes doing nothing but copying bytes, so request-serving capacity drops.
- **Double bandwidth.** Bytes go client → server → storage, and you pay for both hops.
- **No resume.** If the connection drops at 95%, the user starts again.

Object stores are built to absorb huge numbers of concurrent large writes. The goal is to let them do that while your API keeps control over *who* may upload *what*.

## How it works

### The direct-to-storage flow

A **presigned URL** is a storage URL with a signature in the query string. The server creates it using its own credentials, and it grants one specific operation — "PUT this key, with this content type, until 10:15" — to whoever holds it. No storage credentials ever reach the client.

![Sequence: client asks the API for an upload, the API returns a presigned URL, the client PUTs bytes to object storage, storage emits an event, and a worker processes the file](/figures/presigned-uploads/flow.svg "The API only authorizes and records; the bytes go straight from the client to the bucket.")

1. **Request.** The client calls `POST /uploads` with the file name, size and declared type.
2. **Authorize and sign.** The API checks the user's permissions and quotas, creates an upload record in `pending` state, generates the object key itself (for example `uploads/{uuid}`), and returns a presigned URL valid for a few minutes.
3. **Upload.** The client PUTs the file directly to storage. The browser needs a bucket **CORS** rule allowing your origin and the `PUT` method.
4. **Notify.** Storage emits an object-created event (S3 Event Notifications, GCS Pub/Sub notifications, Azure Event Grid) into a queue — or the client calls `POST /uploads/{id}/complete`. Using both, with the event as the source of truth, is common.
5. **Process.** A worker validates the object, extracts metadata, makes thumbnails or transcodes, and marks the record `ready`.

### PUT URLs vs POST policies

There are two ways to sign an upload, and they differ in what you can enforce.

- **Presigned PUT.** Signs a single PUT to one key. You can bind the `Content-Type` and, for some stores, checksum headers into the signature. You **cannot** cap the body size with a plain S3 presigned PUT, so a client could upload far more than it declared.
- **Presigned POST (policy document).** Used with HTML-form-style uploads. The signed policy can include conditions such as `content-length-range` (min and max bytes), an exact key or key prefix, and an allowed content-type prefix. Storage rejects uploads that break any condition. GCS offers the same through signed policy documents, and its `x-goog-content-length-range` header can be signed into a URL.

Whichever you use, keep the scope narrow:

- **Short expiry** — minutes, not days.
- **Server-chosen keys.** Never let the client pick the path; user-supplied names allow overwrites and path tricks. Store the original filename as metadata instead.
- **One object per URL**, and only the operation needed.
- **Re-check after upload.** Signed conditions are a first filter, not a substitute for validation.

### Large files: multipart and resumable uploads

A single PUT of a multi-gigabyte file is fragile. Object stores offer chunked protocols where each piece is uploaded and retried independently.

![A 600 MB file split into six 100 MB parts uploaded in parallel; part 3 fails and only that part is retried before the upload is completed](/figures/presigned-uploads/multipart.svg "Parts upload in parallel and fail independently, so a dropped connection costs one part, not the whole file.")

- **S3 multipart upload.** The server calls `CreateMultipartUpload`, then presigns a URL for each `UploadPart`. The client uploads parts in parallel (each returns an ETag), and the server calls `CompleteMultipartUpload` with the list of part numbers and ETags. Parts are 5 MiB–5 GiB (the last may be smaller), with up to 10,000 parts and a 5 TiB maximum object.
- **GCS resumable uploads.** The server starts a session and gets a session URI; the client PUTs chunks and can ask the server how many bytes were received to resume after a failure.
- **tus.** An open HTTP protocol for resumable uploads, with client libraries for browsers and mobile and servers such as tusd that can write to object storage. Useful when you want one resumable protocol across storage providers.

Two operational details matter. Incomplete multipart uploads keep their parts (and you pay for them) until aborted, so add a lifecycle rule such as **AbortIncompleteMultipartUpload after 1 day**. And send **checksums** (`Content-MD5` or the newer CRC32C/SHA-256 checksum headers) so corruption is caught by storage, not discovered later by users.

### Validation, quarantine and serving

The presigned URL controls *who* uploads, not *what* they upload. Treat every object as hostile until checked.

![Upload lifecycle: pending, uploaded, scanning, then ready or rejected; expired pending uploads are cleaned up; objects move from a quarantine bucket to a serving bucket behind a CDN](/figures/presigned-uploads/lifecycle.svg "Nothing is served from the quarantine bucket; only files that pass checks are copied to where the CDN can see them.")

A processing worker typically:

- **Checks size** against the declared size and the user's limits.
- **Sniffs the real type** from magic bytes, ignoring the extension and the client's `Content-Type`.
- **Scans for malware** (for example ClamAV or a cloud scanning service) for anything others will download.
- **Re-encodes images** through a trusted library, which removes embedded payloads, normalizes formats, and strips **EXIF** metadata such as GPS location.
- **Records the outcome** — `ready` or `rejected` with a reason — and notifies the client.

Keep uploads in a **quarantine** bucket or prefix with no public access, and copy files that pass into the **serving** bucket. Serve public files through a CDN, ideally from a separate domain so uploaded HTML or SVG can't run scripts in your app's origin. Serve private files with short-lived **presigned GET** URLs (or CDN signed URLs/cookies), and set `Content-Disposition: attachment` for types that shouldn't render inline.

Finally, clean up: a scheduled job expires `pending` records older than, say, 24 hours and deletes any orphaned objects, and lifecycle rules remove rejected files.

## Where it's used

| Setting | Example |
|---|---|
| Social and messaging apps | Photo and video uploads straight to storage, then transcoding pipelines |
| SaaS document tools | Attachments uploaded via presigned POST with size limits |
| Video platforms | Resumable multi-gigabyte uploads with tus or GCS resumable sessions |
| Data platforms | Customers uploading large CSV or Parquet files for import jobs |
| Mobile apps | Background uploads that survive app restarts by resuming chunks |
| Serverless backends | Lambda signs URLs; bytes never touch the function's payload limit |

## Use case walk-through: a video-sharing feature

A team adds video uploads (up to 4 GB) to a product whose API runs behind a gateway with a 30-second timeout and 10 MB body limit.

1. **Start.** The app calls `POST /videos` with size and type. The API checks the user's storage quota, creates a `pending` record and starts an S3 multipart upload under `quarantine/{videoId}`.
2. **Sign parts.** The API returns presigned URLs for 64 MB parts, valid for 15 minutes; the client asks for fresh URLs if it runs long.
3. **Upload.** The client sends four parts at a time with CRC32C checksums. When a train goes into a tunnel, only the in-flight parts are retried.
4. **Complete.** The client posts the part ETags; the API calls `CompleteMultipartUpload` and marks the record `uploaded`.
5. **Process.** The object-created event lands in a queue. A worker checks the container format, scans it, and hands it to a transcoding job that writes renditions to the serving bucket.
6. **Serve and clean up.** The record moves to `ready` and the player streams through the CDN. A lifecycle rule aborts incomplete uploads after a day, and a nightly job expires stale `pending` records.

**Result:** API instances never see video bytes, uploads survive flaky networks, the gateway limits don't matter, and unprocessed files are never publicly reachable.

## Pitfalls

- **Trusting the client's type and name.** Extensions and `Content-Type` are claims, not facts; sniff and re-encode.
- **Long-lived or wide URLs.** A URL that lasts a week, or allows any key under a prefix, can be shared and abused.
- **No size cap.** A plain presigned PUT doesn't limit size; use POST policies or check right after upload and delete oversized objects.
- **Serving from the upload location.** Unscanned files, or user HTML/SVG served from your main domain, open the door to malware distribution and XSS.
- **Forgetting incomplete multipart uploads.** Orphaned parts are invisible in normal listings and quietly add to the bill.
- **Missing CORS.** Browser uploads fail with opaque errors until the bucket allows your origin, method and headers (and exposes `ETag` for multipart).
- **Ignoring egress.** Downloads cost more than uploads; serve through a CDN and cache aggressively.

> [!WARNING]
> Never serve user uploads from the same origin as your application. An uploaded `.html` or `.svg` rendered on `app.example.com` runs with your cookies. Use a separate, cookie-less domain and `Content-Disposition: attachment` for risky types.

## Discussion questions

1. Which upload limits (size, type, count, rate) should be enforced before signing, and which only after the upload completes?
2. How would you design the upload record's states so the client can show accurate progress and errors?
3. When would you choose tus over a storage provider's native multipart or resumable API?
4. How should the system behave if the object-created event is lost or delivered twice?
5. What is your plan if a malware scan service is down — block uploads, queue them, or serve them unscanned?
6. How would you migrate an existing proxy-based upload endpoint to presigned uploads without breaking old clients?

## FAQ

### Is a presigned URL secure if someone intercepts it?

Anyone holding it can perform the signed operation until it expires — that's the design. Keep expiry short, scope it to one key and operation, serve it only over HTTPS, and avoid logging full URLs.

### Should the client or storage events tell the backend the upload finished?

Both work. A client "complete" call gives immediate feedback; storage events are reliable even if the client disappears. Many systems accept either, and make processing idempotent so duplicates are harmless.

### How large should multipart parts be?

Big enough to keep request overhead low and stay under the 10,000-part limit, small enough that a retry is cheap — commonly 8–100 MB. On mobile networks, smaller parts reduce wasted work on failure.

### Can I resize images on the fly instead of preprocessing?

Yes. An image CDN or on-demand resizing service can generate variants from the original, cached at the edge. You should still validate and re-encode the original once, so the resizer never has to deal with malicious inputs.

### Do I still need my API for uploads at all?

Yes, for authorization, quotas, key generation, the upload record and processing. The API controls the upload; it just doesn't carry the bytes.

## Key takeaways

- Let clients upload **directly to object storage** with short-lived, narrowly scoped **presigned URLs**.
- Use **POST policies** or post-upload checks to enforce size and type; generate keys on the server.
- Use **multipart or resumable** uploads for large files, with checksums and a lifecycle rule to abort incomplete uploads.
- Treat uploads as **untrusted**: validate magic bytes, scan, re-encode and strip metadata in an async worker.
- Keep a **quarantine → serving** split and serve from a separate domain or CDN.

## References

- [Amazon S3 — Uploading objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
- [Amazon S3 — Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [Google Cloud Storage — Signed URLs](https://cloud.google.com/storage/docs/access-control/signed-urls)
- [Google Cloud Storage — Resumable uploads](https://cloud.google.com/storage/docs/resumable-uploads)
- [tus — resumable upload protocol](https://tus.io/protocols/resumable-upload)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- Amazon S3 documentation, "Creating a browser-based upload using HTTP POST (AWS Signature Version 4)."
- Amazon S3 documentation, "Configuring a bucket lifecycle configuration to delete incomplete multipart uploads."

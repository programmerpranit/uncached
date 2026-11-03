---
summary: How two strangers agree on secret keys over a hostile network, prove who the server is, and start sending encrypted data after a single round trip.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — In a **TLS 1.3** handshake, the client sends its **ClientHello** together with an ephemeral **key share** (an ECDHE public key), plus the hostname it wants (**SNI**) and the protocols it speaks (**ALPN**). The server answers with its own key share. Both sides then compute the same shared secret, and **HKDF** turns it into separate handshake and application keys. Still inside that first reply, the server sends its **certificate chain** and a **CertificateVerify** signature, which prove it holds the private key for the hostname. The client checks the chain against its trust store, sends **Finished**, and can send application data **one round trip** after it started. Because the key shares are ephemeral, a later leak of the server's long-term key cannot decrypt recorded traffic (**forward secrecy**).

## The problem: a private conversation over a public wire

Every packet between a browser and a server crosses networks you don't control: café Wi-Fi, ISPs, transit providers, and possibly a hostile middlebox. Any of them can **read**, **modify** or **impersonate**. A secure channel needs three properties:

- **Confidentiality.** Eavesdroppers see only ciphertext.
- **Integrity.** Any change to the bytes is detected.
- **Authentication.** The client is talking to the real `api.example.com`, not to someone sitting in the middle.

Symmetric ciphers such as AES-GCM and ChaCha20-Poly1305 provide the first two cheaply, but both sides need the **same secret key** first, and they have never met. The handshake solves that bootstrapping problem. It also has to be **fast**, because it adds latency before the first byte of every new connection. On a 100 ms mobile link, each extra round trip is user-visible.

## How it works

### The 1-RTT flow

![TLS 1.3 handshake sequence: ClientHello with key share, ServerHello with key share, encrypted certificate and Finished, then client Finished and application data](/figures/tls-handshake/sequence.svg "TLS 1.3 encrypts everything after ServerHello, including the certificate. TLS 1.2 needed a second round trip and sent certificates in the clear.")

1. **ClientHello.** The client sends:
   - a random nonce
   - the cipher suites it supports
   - its supported groups (e.g. X25519, P-256, and increasingly hybrid post-quantum groups like X25519MLKEM768)
   - a **key_share** for the group it guesses the server will pick
   - **SNI** (server name) and **ALPN** (`h2`, `http/1.1`)
2. **ServerHello.** The server picks a cipher suite and returns its own key share. Both sides now hold enough to compute a shared secret, so **everything after this point is encrypted**.
3. **EncryptedExtensions, Certificate, CertificateVerify, Finished.** The server:
   - confirms ALPN and other settings
   - sends its certificate chain
   - signs a hash of the whole handshake transcript with its certificate's private key (CertificateVerify)
   - sends a MAC over the transcript (Finished)
4. **Client Finished.** The client validates everything and sends its own Finished. It can attach application data (the HTTP request) in the same flight.

If the client guessed the wrong group, the server answers with a **HelloRetryRequest** naming the group it wants. That costs one extra round trip, which is why clients send a share for the most common group.

### From key shares to session keys

![Client and server exchange public key shares, compute the same shared secret, and HKDF derives handshake, application and resumption secrets](/figures/tls-handshake/keys.svg "Only the public shares cross the network. An eavesdropper sees A and B but cannot compute a·B without one of the private values.")

- **Elliptic-curve Diffie–Hellman (ECDHE).** The client picks a random private scalar *a* and sends *A = a·G*. The server picks *b* and sends *B = b·G*. Each computes the same point: *a·B = b·A*. Recovering *a* or *b* from the public values is the elliptic-curve discrete log problem, which is believed to be infeasible.
- **Ephemeral means forward secrecy.** *a* and *b* are fresh for every handshake and discarded afterwards. The server's certificate key is only used to **sign**, never to encrypt the secret. So stealing it later doesn't let anyone decrypt past recordings. TLS 1.3 removed static-RSA key exchange entirely for this reason.
- **HKDF key schedule.** The shared secret is fed through HKDF-Extract/Expand along with the running **transcript hash**. This yields separate secrets for:
  - client and server handshake traffic
  - client and server application traffic
  - a **resumption master secret**

  Binding keys to the transcript means any tampering with the hello messages, such as a downgrade attack that strips strong cipher suites, produces mismatched keys and a failed Finished check.
- **Record layer.** Data is split into records protected with an AEAD cipher. A per-record sequence number goes into the nonce, so reordered, replayed or dropped records are detected.

### Proving who the server is

Key exchange alone gives you a private channel to *someone*. Without authentication, an attacker in the middle can run one handshake with you and another with the real server. The certificate closes that gap.

![Leaf certificate signed by intermediate CA signed by root CA in the trust store, with the checks the client performs](/figures/tls-handshake/chain.svg "The server sends the leaf and intermediates; the root is already on the client. CertificateVerify proves the server holds the leaf's private key right now.")

The client checks that:

- **Signatures chain up** from the leaf, through any intermediates, to a root in its trust store (OS or browser store, or a custom CA bundle).
- **The hostname matches** a Subject Alternative Name on the leaf. This is why SNI matters: one IP can host many certificates, and the server needs the name to pick the right one.
- **The certificate is valid now** and not revoked. Revocation is checked via OCSP, OCSP stapling, CRLs or browser-pushed lists. In practice short lifetimes do much of this work.
- **It was logged in Certificate Transparency** (browsers require signed certificate timestamps), so misissued certificates are publicly detectable.
- **CertificateVerify is a valid signature** over the transcript, made with the leaf's private key. This proves possession of the key, not just possession of a public certificate.

In **mutual TLS (mTLS)** the server also sends a CertificateRequest. The client then presents its own certificate and CertificateVerify, which is common for service-to-service traffic inside a mesh.

### Resumption and 0-RTT

After a handshake, the server can send a **NewSessionTicket**. On the next connection the client offers that ticket as a **pre-shared key (PSK)**. This skips certificate validation and its signatures, and is usually combined with a fresh ECDHE exchange (`psk_dhe_ke`) to keep forward secrecy.

With **0-RTT (early data)** the client can encrypt a request under the PSK and send it in the very first flight, with zero added latency. The catch is that early data has **no replay protection** from the protocol: an attacker can capture and resend it. Servers should only accept idempotent requests (e.g. GET without side effects) as early data, or use anti-replay measures. CDNs typically mark such requests with a header such as `Early-Data: 1` so the origin can reject them with `425 Too Early`.

### What changed from TLS 1.2

| | TLS 1.2 | TLS 1.3 |
|---|---|---|
| Full handshake | 2 RTTs | 1 RTT (0-RTT with resumption) |
| Key exchange | RSA or (EC)DHE | (EC)DHE only, so always forward secret |
| Cipher suites | Many, including CBC, RC4, SHA-1 | Five AEAD suites |
| Certificate | Sent in plaintext | Encrypted |
| Renegotiation, compression | Supported (and attacked) | Removed |
| Downgrade protection | Weak | Transcript-bound keys plus a sentinel in ServerHello.random |

## Where it's used

| Setting | Role of the TLS handshake |
|---|---|
| HTTPS (HTTP/1.1, HTTP/2) | Every new TCP connection runs a TLS handshake; ALPN selects `h2` |
| HTTP/3 / QUIC | TLS 1.3 is built into the QUIC handshake, which combines transport and crypto setup in one RTT |
| Service meshes (Istio, Linkerd) | Sidecars run mTLS with short-lived workload certificates |
| Load balancers and CDNs | Terminate TLS at the edge, using SNI to choose certificates for thousands of hostnames |
| Databases and brokers | Postgres, MySQL, Kafka and Redis connections over TLS, often with client certificates |
| Email (SMTP STARTTLS), DNS over TLS/HTTPS | Upgrade or wrap plaintext protocols |
| VPNs and Zero Trust proxies | TLS-based tunnels and identity-aware access |

## Use case walk-through: cutting handshake latency for a mobile API

A mobile app talks to `api.example.com` through a regional load balancer still configured for TLS 1.2 with an RSA 4096 certificate. On high-latency networks, p75 time-to-first-byte for the first request is 900 ms, and CPU on the load balancers spikes during traffic surges.

1. **Measure.** Connection timing in the app and edge logs shows two RTTs of TLS on top of the TCP handshake. RSA-4096 signing is also the top CPU consumer on the load balancers.
2. **Enable TLS 1.3** on the load balancer, keeping TLS 1.2 for older clients. Most clients now finish the handshake in one RTT.
3. **Switch to an ECDSA P-256 certificate**, keeping RSA as a fallback for the rare client that needs it. Signatures are much cheaper, and the handshake bytes shrink.
4. **Trim the chain.** The server was sending the root as well as the intermediate. It now sends only leaf and intermediate, so the first flight fits in fewer packets.
5. **Staple OCSP** so clients don't make a separate revocation lookup.
6. **Enable session resumption** with tickets whose keys are rotated every few hours and shared across the load-balancer fleet. Returning clients skip certificate checks.
7. **Allow 0-RTT only for safe requests.** Early data is accepted for idempotent GETs. The origin rejects anything else carrying the early-data marker with `425 Too Early`.

**Result:** first-request TTFB at p75 drops by roughly one round trip (around 250 ms on mobile networks). Resumed connections are faster still, and edge CPU per handshake falls enough to absorb surges without scaling out.

## Pitfalls

- **Incomplete chains.** The server sends only the leaf. Browsers often cope via cached intermediates, but API clients and mobile stacks fail with "unable to get local issuer certificate."
- **Expired certificates.** These still cause major outages. Automate issuance and renewal (ACME) and alert well before expiry.
- **Disabling verification "temporarily".** `verify=False`, `InsecureSkipVerify` and `-k` in production code remove authentication entirely, which makes the encryption pointless against an active attacker.
- **0-RTT replay.** Accepting non-idempotent requests as early data lets an attacker repeat a payment or a state change.
- **Ticket key mismanagement.** Session-ticket keys that are never rotated, or that are stored on disk, undermine forward secrecy for resumed sessions.
- **SNI leaks the hostname.** The certificate is encrypted in 1.3, but SNI in the ClientHello is still visible. Encrypted Client Hello (ECH) addresses this where it is deployed.
- **Middleboxes and pinning.** Corporate TLS inspection breaks certificate pinning and mTLS. Hard pinning in apps can brick clients when certificates rotate.
- **Clock skew.** Devices with wrong clocks see valid certificates as expired or not yet valid.

> [!WARNING]
> Never ship code that skips certificate verification, even "just for staging." Encryption without authentication protects you only from passive eavesdroppers, and anyone able to run a man-in-the-middle will happily terminate both sides.

## Discussion questions

1. Why does TLS 1.3 sign the handshake transcript rather than encrypting a secret with the server's RSA key? What does that buy you?
2. What exactly can a passive observer still learn about a TLS 1.3 connection?
3. When is 0-RTT safe to enable, and how would you enforce that at a load balancer?
4. How would you design certificate rotation for 10,000 services using mTLS?
5. What breaks if a client's trust store is outdated, and how would you detect it in the field?
6. How does QUIC change where the TLS handshake lives, and why does that remove a round trip compared with TCP + TLS?

## FAQ

### Is SSL the same as TLS?

TLS is the successor to SSL. SSL 2.0 and 3.0 are broken and disabled everywhere, and TLS 1.0 and 1.1 are deprecated. People still say "SSL certificate" out of habit, but today the protocol is TLS 1.2 or 1.3.

### Why does HTTPS still feel slower than HTTP on the first request?

A new connection needs a TCP handshake (1 RTT) plus the TLS 1.3 handshake (1 RTT) before the request can be sent. Connection reuse, resumption, 0-RTT and HTTP/3 (which merges transport and TLS setup) all reduce this. Once established, symmetric encryption costs very little.

### What does the certificate actually prove?

That a certificate authority trusted by your client verified that whoever requested the certificate controlled the domain (or, for OV/EV, also the organization). CertificateVerify then proves the server you're talking to holds that certificate's private key. It doesn't prove the site is honest, just that it is the domain's owner.

### Does TLS 1.3 protect against quantum computers?

Classical ECDHE does not. Traffic recorded today could in principle be decrypted later by a large quantum computer ("harvest now, decrypt later"). Hybrid key exchanges such as X25519 combined with ML-KEM are being deployed in browsers and CDNs to address this, and they slot into the same key_share mechanism.

### Where should TLS be terminated?

At the edge (CDN or load balancer) for certificate management and performance, and ideally re-encrypted to the origin or service. Inside a cluster, mTLS between services prevents a compromised host or a network tap from reading or spoofing internal traffic.

## Key takeaways

- The handshake bootstraps **shared symmetric keys** with **ephemeral ECDHE** and authenticates the server with a **certificate chain plus a transcript signature**.
- TLS 1.3 sends the key share in the first message, so a full handshake takes **one round trip**, and everything after ServerHello is encrypted.
- **HKDF over the transcript** binds keys to everything both sides said, which defeats tampering and downgrades.
- **Forward secrecy** comes from discarding ephemeral keys. Long-term keys only sign.
- **Resumption** and **0-RTT** cut latency further, but early data is replayable and must be limited to safe requests.
- Most real-world TLS failures are operational: expired or incomplete chains, disabled verification, and unrotated ticket keys.

## References

- [RFC 8446 — The Transport Layer Security (TLS) Protocol Version 1.3](https://www.rfc-editor.org/rfc/rfc8446)
- [RFC 6962 — Certificate Transparency](https://www.rfc-editor.org/rfc/rfc6962)
- [RFC 8470 — Using Early Data in HTTP](https://www.rfc-editor.org/rfc/rfc8470)
- [Cloudflare — A Detailed Look at RFC 8446 (a.k.a. TLS 1.3)](https://blog.cloudflare.com/rfc-8446-aka-tls-1-3/)
- [Mozilla — Server Side TLS guidelines](https://wiki.mozilla.org/Security/Server_Side_TLS)
- [The Illustrated TLS 1.3 Connection](https://tls13.xargs.org/)
- Ivan Ristić, *Bulletproof TLS and PKI*, Feisty Duck, 2nd ed., 2022.
- Jean-Philippe Aumasson, *Serious Cryptography*, No Starch Press, 2017.

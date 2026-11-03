---
summary: How a hostname becomes an IP address — stub resolvers, recursive resolvers, root, TLD and authoritative servers, referrals and glue, caching, and the transports (UDP, TCP, DoT, DoH) that carry it all.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — Your app asks a local *stub resolver* one question. The stub forwards it to a *recursive resolver*, usually run by your ISP, company or a public service like 1.1.1.1. With a cold cache, the recursive resolver walks the hierarchy: the root points it to the TLD servers, the TLD points it to the domain's authoritative servers, and those return the answer. Every step is cached for its TTL, so most lookups never leave the resolver. Classic DNS runs over plaintext UDP; DoT and DoH encrypt the first hop.

## The problem: names for humans, numbers for routers

Routers forward packets by IP address. People and configuration files use names like `api.example.com`. Something has to translate between them, and it has to work for billions of names whose addresses change constantly and are owned by millions of independent organizations.

A single central directory would be a bottleneck, a single point of failure and an administrative nightmare. DNS (RFC 1034/1035, 1987) instead splits the namespace into a tree of **zones**, each run by whoever owns that part of the tree. Lookups follow **delegations** down the tree, and **caching** at every level absorbs most of the load.

## How it works

### The cast of characters

- **Stub resolver.** A small library in your OS (`getaddrinfo()` on Unix, the DNS Client service on Windows, `systemd-resolved` on many Linux systems). It doesn't walk the tree. It sends one *recursive* query ("give me the final answer") to a configured resolver and waits.
- **Recursive resolver** (also called a full-service or caching resolver). It does the real work and caches results. Examples are your home router's upstream, your ISP's resolver, corporate resolvers, and public ones like Cloudflare 1.1.1.1, Google 8.8.8.8 and Quad9 9.9.9.9.
- **Root servers.** The 13 named root server identities (a.root-servers.net to m.root-servers.net), served from well over a thousand anycast instances worldwide. They know only who runs each top-level domain.
- **TLD servers.** These run `com.`, `org.`, `uk.`, `io.` and so on. They know which name servers are authoritative for each registered domain.
- **Authoritative servers.** They hold the domain's actual records. Examples are your DNS provider (Route 53, Cloudflare, NS1) or your own BIND or PowerDNS.

### Walking the tree

![Cold-cache DNS lookup](/figures/dns-resolution/resolution-path.svg "One recursive query from the stub; iterative queries from the resolver to root, TLD and authoritative servers")

Here's what happens when nothing is cached and the browser needs `www.example.com`:

1. The stub sends `www.example.com A?` to the recursive resolver.
2. The resolver asks a root server, which it knows from a built-in *root hints* file. The root doesn't know the answer and returns a **referral**: the NS records for `com.` plus their addresses.
3. The resolver asks a `com.` server. It returns another referral: `example.com. NS ns1.example.com.` plus that server's address.
4. The resolver asks `ns1.example.com`, which is authoritative. It returns `www.example.com. 300 IN A 93.184.215.14`, with the `aa` (authoritative answer) flag set.
5. The resolver caches every record it learned, each for its own TTL, and returns the answer to the stub.

The resolver sends *iterative* queries: each server answers only from its own data and refers onward. Only the stub-to-resolver hop is recursive.

Resolvers also use **QNAME minimisation** (RFC 9156). The root is asked only about `com.`, not the full `www.example.com`, so servers higher in the tree learn less about what you're visiting.

### Delegation and glue

![DNS delegation](/figures/dns-resolution/delegation.svg "Zones delegate subtrees with NS records; glue records supply the addresses of in-zone name servers")

A **zone** is a contiguous piece of the namespace managed as one unit. The parent zone delegates a child by publishing NS records for it. When you register `example.com`, your registrar pushes your chosen name servers into the `com.` zone.

There's a chicken-and-egg problem. If `example.com`'s name server is `ns1.example.com`, the resolver must resolve `ns1.example.com` to reach it, and that requires asking `ns1.example.com`. **Glue records** break the loop: the parent zone also publishes the A/AAAA addresses of in-bailiwick name servers. That's why a domain's name-server IPs are configured at the registrar as well as in the zone itself.

### What's in an answer

Common record types:

| Type | Holds |
|---|---|
| `A` / `AAAA` | IPv4 / IPv6 address |
| `CNAME` | An alias: "this name is really that name". Can't coexist with other records at the same name, which is why you can't CNAME a zone apex |
| `NS` | Name servers for a zone |
| `MX` | Mail servers with priorities |
| `TXT` | Arbitrary text; used for SPF, DKIM and domain verification |
| `SOA` | Zone metadata, including the *negative* caching TTL |
| `HTTPS` / `SVCB` | Connection hints such as ALPN (`h3`), alternate ports and ECH keys |
| `CAA` | Which certificate authorities may issue for the domain |

A CNAME adds work. If `www.example.com` is a CNAME for `example.cdn-provider.net`, the resolver starts a new walk for that name, possibly through different TLD and authoritative servers. CDN setups often chain two or three CNAMEs.

Failures get cached too. An `NXDOMAIN` (name doesn't exist) is cached for the zone's SOA minimum TTL (RFC 2308). So "it didn't exist when I checked a minute ago" can outlive the moment you create the record.

### On the wire

![DNS transports](/figures/dns-resolution/transports.svg "Plain DNS over UDP/TCP port 53 versus encrypted DNS over TLS and HTTPS")

Classic DNS uses one UDP datagram for the query and one for the response. It's fast, with no handshake. If the response doesn't fit, the server sets the TC (truncated) bit and the client retries over TCP. EDNS(0) lets clients advertise larger buffers. The 2020 DNS Flag Day settled on 1232 bytes as a safe default to avoid IP fragmentation.

Plain DNS is unauthenticated and unencrypted. Anyone on the path can see every name you look up and can try to forge answers. Responses are matched only by a 16-bit query ID and a random source port, which is what the 2008 Kaminsky cache-poisoning attack exploited. Two independent defenses exist:

- **Encrypted transports.** DoT (DNS over TLS, port 853), DoH (DNS over HTTPS, port 443) and DoQ (DNS over QUIC) hide queries from the local network. They protect only the stub-to-resolver hop.
- **DNSSEC.** Zones sign their records, and resolvers verify a chain of signatures from the root's trust anchor down. This detects forgery but hides nothing.

## Where it's used

| Context | What DNS does there |
|---|---|
| Every web request | Hostname → IP, plus HTTPS records advertising HTTP/3 and ECH |
| CDNs and global load balancing | Authoritative servers return different answers by resolver location (GeoDNS) or health |
| Kubernetes | CoreDNS gives every Service a name like `api.default.svc.cluster.local` |
| Service discovery | Consul and AWS Cloud Map expose healthy instances as DNS records (A or SRV) |
| Email | MX finds mail servers; TXT carries SPF, DKIM and DMARC policies |
| Certificate issuance | ACME DNS-01 challenges and CAA records gate which CA can issue |

## Use case walk-through: why the new API name doesn't resolve

A team adds `api.shop.example` pointing to a new load balancer, and half the team's laptops can't reach it.

1. **Check the authoritative source.** `dig api.shop.example @ns1.dnsprovider.net` returns the right A record, so the zone is correct.
2. **Check the resolver.** `dig api.shop.example` through the office resolver returns `NXDOMAIN`. Someone queried the name *before* it was created, and the negative answer is cached for the SOA minimum TTL of 3600 seconds.
3. **Check the delegation.** `dig +trace api.shop.example` walks from the root. It shows the `shop.example` delegation in the parent still lists an old name server that no longer serves the zone. Resolvers that happen to pick that server get `REFUSED` and retry elsewhere, adding seconds of latency.
4. **Fix.** Update the NS set at the registrar to match the provider. Flush the office resolver's cache for that name (e.g. `unbound-control flush api.shop.example`). Lower the SOA negative TTL to 300 seconds for future changes.
5. **Verify from outside.** Query 1.1.1.1 and 8.8.8.8, plus a few regional resolvers via an online checker. Wait for the old delegation's NS TTL to expire everywhere.

**Result:** the name resolves consistently. The team now creates records *before* announcing them and keeps parent and child NS sets in sync.

## Pitfalls

- **Negative caching surprises.** Querying a name before creating it caches `NXDOMAIN`. Create records first, then use them.
- **CNAME at the apex.** `example.com` can't be a CNAME because it must also hold SOA and NS records. Use your provider's ALIAS/ANAME flattening, or A/AAAA records.
- **Lame delegations.** NS records in the parent that point to servers that don't serve the zone cause timeouts and retries. Keep parent and child NS sets identical.
- **Ignoring TTLs in clients.** Some runtimes cache DNS forever by default (older JVM settings, for example), so services keep calling a dead IP after a failover. Configure client cache TTLs explicitly.
- **Large responses and UDP.** Big TXT records or DNSSEC signatures can exceed 1232 bytes. If TCP port 53 is blocked by a firewall, those lookups silently fail.
- **Resolver as a single point of failure.** A dead or overloaded internal resolver looks like "the whole network is down". Run several, and monitor query latency and SERVFAIL rates.

> [!WARNING]
> Never run an *open* recursive resolver on the public internet. It will be used to amplify DDoS attacks: a small spoofed query yields a large response sent to the victim.

## Discussion questions

1. Why does the stub send a recursive query while the resolver sends iterative ones? What would break if every stub walked the tree itself?
2. How do root servers handle the load of the whole internet with only 13 names?
3. A CDN returns different A records depending on location, but it only sees the *resolver's* IP, not the user's. What problem does that cause, and how does EDNS Client Subnet address it, at what privacy cost?
4. DoH sends DNS over port 443 to a resolver chosen by the browser. What does that change for enterprise networks that rely on DNS filtering?
5. Design a migration of a domain to a new DNS provider with zero downtime. Which TTLs do you lower, when, and in what order do you change NS records?
6. What does DNSSEC protect against that DoH doesn't, and vice versa?

## FAQ

### Why does `dig` show a different answer than my browser?

They may use different resolvers and caches. Browsers can use their own DoH resolver, your OS has its own cache, and `dig` queries the resolver in `/etc/resolv.conf` directly, bypassing local caches. Use `dig @<server>` to compare specific resolvers.

### Are there really only 13 root servers?

There are 13 root server *identities* (letters A through M), a limit that dates from fitting all their addresses in a 512-byte UDP response. Each identity is served by many anycast instances, well over a thousand in total, operated by 12 organizations.

### What's the difference between a recursive and an authoritative server?

An authoritative server answers only for the zones it hosts, from its own data. A recursive resolver answers for any name by querying authoritative servers on your behalf and caching the results. Running both roles on one server is discouraged.

### Does DoH make me anonymous?

No. It hides your queries from the local network and ISP, but the DoH resolver sees all of them. The destination IPs you then connect to, and the TLS SNI unless ECH is in use, still reveal much of what you visit.

### Why do some lookups take hundreds of milliseconds?

A cold cache plus long chains: several CNAME hops, each needing its own TLD and authoritative queries, sometimes to distant or slow servers, plus retries after timeouts. A warm resolver cache usually answers in a few milliseconds. Browsers hide much of the cost with DNS prefetching.

## Key takeaways

- The stub asks once; the recursive resolver walks root → TLD → authoritative using referrals.
- Delegation via NS records lets each organization run its own part of the namespace; glue breaks circular dependencies.
- Caching at every layer, including negative answers, is what makes DNS scale, and also what makes changes slow to propagate.
- Classic DNS is plaintext UDP; DoT, DoH and DoQ encrypt the first hop, and DNSSEC authenticates the data.
- Most DNS incidents trace back to TTLs, lame delegations, negative caching or a single overloaded resolver.

## References

- [RFC 1034 — Domain Names: Concepts and Facilities](https://www.rfc-editor.org/rfc/rfc1034)
- [RFC 1035 — Domain Names: Implementation and Specification](https://www.rfc-editor.org/rfc/rfc1035)
- [RFC 2308 — Negative Caching of DNS Queries](https://www.rfc-editor.org/rfc/rfc2308)
- [RFC 9156 — DNS Query Name Minimisation to Improve Privacy](https://www.rfc-editor.org/rfc/rfc9156)
- [RFC 7858 — DNS over TLS](https://www.rfc-editor.org/rfc/rfc7858)
- [RFC 8484 — DNS Queries over HTTPS (DoH)](https://www.rfc-editor.org/rfc/rfc8484)
- [RFC 9460 — SVCB and HTTPS Resource Records](https://www.rfc-editor.org/rfc/rfc9460)
- [Root Servers — root-servers.org](https://root-servers.org/)
- [DNS Flag Day 2020](https://www.dnsflagday.net/2020/)
- Cricket Liu and Paul Albitz, *DNS and BIND*, 5th ed., O'Reilly, 2006.

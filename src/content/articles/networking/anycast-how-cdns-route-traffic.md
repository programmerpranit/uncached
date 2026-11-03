---
summary: Anycast announces one IP prefix from many locations and lets BGP deliver each user to the "nearest" one. How it works, why CDNs and DNS providers rely on it, and where it bites.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR:** With anycast, many servers in different places announce the *same* IP prefix over BGP. Each router on the internet keeps only its best route to that prefix, so each user's packets end up at whichever site is closest in routing terms. You get geographic load spreading and automatic failover with no client logic and no DNS tricks. The catches: "closest" means BGP-closest rather than physically closest, and a route that changes mid-connection can break long-lived TCP sessions.

## The problem: one address, a planet of users

A website at one IP in Virginia is about 150 ms round-trip from Jakarta. A TCP handshake plus a TLS handshake plus the first request costs several round trips, so a user there waits most of a second before seeing a single byte. Copying the content to Singapore helps only if you can get Jakarta users to Singapore and Boston users to Virginia.

The classic answer is **GeoDNS**: give different users different IPs. It works, but it relies on the resolver's location standing in for the user's, and on DNS TTLs being honoured during failover. Neither is reliable. **Anycast** moves the decision into the network itself: give every site the same address and let the routing system choose.

## How it works

### Same prefix, many origins

Normally an IP prefix (say `203.0.113.0/24`) is announced to the internet via BGP from one place. With anycast, the operator announces the identical prefix from every point of presence (PoP). To the rest of the internet this looks like a network with many entrances. Each autonomous system (AS) hears several routes to the prefix, picks one best route by its own policy, and forwards packets accordingly.

![Three PoPs announce the same prefix; users reach the nearest](/figures/anycast-cdn/one-ip-many-pops.svg "Every PoP announces the same /24. Routers keep one best path each, so users split across PoPs without knowing it.")

Two details matter in practice:

- **The prefix must be at least a /24 (IPv4) or /48 (IPv6).** Most networks filter longer prefixes, so anycast is done in /24 blocks even when only one address is actually used.
- **Best path is policy, not geography.** BGP prefers routes by local preference (often "customer routes beat peers beat transit"), then by shortest AS path, then by tie-breakers. A user in Paris whose ISP has a cheap peering link to Virginia may be sent across the Atlantic even though Frankfurt is next door. CDNs fix this with peering, selective announcements and "communities" that tell upstreams how to propagate a route.

### Anycast vs. GeoDNS vs. plain unicast

Anycast is one of several ways to steer users, and big networks mix them.

![Comparison of unicast, GeoDNS and anycast](/figures/anycast-cdn/steering-compared.svg "Who decides where a user goes, how fast that changes, and what each approach trades away.")

GeoDNS gives fine-grained control: you can send exactly 10% of Germany to another region. But it is only as accurate as the resolver's address (EDNS Client Subnet helps when supported), and failover waits on cached answers to expire. Anycast's control is coarse, because you can only influence BGP, but it reacts without any client cooperation. A common combined design: DNS hands out one of several anycast addresses (for example, per region or per customer tier), and anycast takes it from there.

Anycast is a natural fit for **stateless, short exchanges**. DNS over UDP is the classic case: one packet in, one out, so there is no connection to break. That is why all 13 root server identities and every major public resolver (1.1.1.1, 8.8.8.8, 9.9.9.9) are anycast, with hundreds of instances between them.

### Failover, draining and the TCP question

If a PoP fails its health checks, its routers **withdraw** the announcement. Within seconds to a few minutes BGP converges, and traffic that used to land there flows to the next-best PoP. Nobody has to update DNS or wait out a TTL.

![PoP withdrawal and convergence](/figures/anycast-cdn/failover.svg "Withdrawal moves users automatically. The neighbouring PoP must have the headroom to absorb them.")

The flip side: **routes can change while a connection is open.** If a flow's packets suddenly start arriving at a different PoP, that PoP has no TCP state for it and replies with a reset. For years this kept people from serving TCP over anycast. In practice:

- Routes are stable over the seconds-to-minutes life of most HTTP connections, and CDNs serve TCP and TLS over anycast at huge scale.
- Inside a PoP, packets are spread across servers by ECMP hashing on the 5-tuple, so one flow keeps hitting the same machine. Layer-4 load balancers (consistent hashing plus connection tracking) handle machines joining or leaving.
- Long-lived flows such as big downloads, WebSockets and video are the most exposed. Retries, resumable downloads and QUIC (whose connection IDs survive address changes) shrink the damage.
- Planned maintenance uses **draining**: make the PoP's route less attractive first (AS-path prepending, lower preference or communities), wait for traffic to bleed off, then withdraw.

## Where it's used

| System | What is anycast | Why it fits |
|---|---|---|
| DNS root servers | 13 identities (a–m), 1,900+ instances | Stateless UDP queries; resilience against DDoS |
| Public resolvers (1.1.1.1, 8.8.8.8, 9.9.9.9) | One memorable IP worldwide | Low latency to the nearest instance |
| CDNs (Cloudflare, Fastly, and others) | Edge IPs for HTTP/TLS/QUIC | Users hit a nearby PoP; DDoS spreads across all PoPs |
| Authoritative DNS hosting | Nameserver IPs | Fast answers and absorbing floods |
| DDoS scrubbing services | Customer prefixes re-announced | Attack traffic is split and cleaned near its sources |
| Cloud global load balancers | A single global frontend IP | Cross-region failover without DNS changes |

## Use case walk-through: absorbing a DDoS with anycast

A DNS provider runs authoritative nameservers on one anycast /24 announced from 60 PoPs. A botnet starts sending 800 Gbit/s of junk queries.

1. **The attack is spread out by geography.** Bots are scattered worldwide, and each one's packets go to *its* nearest PoP. Instead of one site taking 800 Gbit/s, sixty sites take an average of about 13 Gbit/s each, with hot spots near botnet clusters.
2. **Hot PoPs filter locally.** Each PoP rate-limits and drops obviously bad queries at line rate. Legitimate users in other regions never notice, because their PoPs are barely affected.
3. **An overwhelmed PoP withdraws.** One PoP near a dense cluster of infected devices saturates its uplinks. Operators withdraw it (or announce it only to local peers), and its share, attackers included, spreads across neighbouring PoPs.
4. **Recovery.** As the attack fades, the PoP is re-announced. DNS is UDP, so no client connections were broken along the way.

**Result:** the capacity that counts is the sum across all PoPs, not any single site, and failures stay regional. A unicast deployment would have had one place to saturate.

## Pitfalls

- **Assuming nearest means geographically nearest.** Measure real user-to-PoP mapping (RUM data, traceroutes from probes). Peering quirks routinely send users across oceans.
- **Uneven load.** BGP doesn't know about server load. A PoP that happens to be the best path for a big ISP can be swamped while others sit idle. Fix it with targeted announcements and communities, or by moving that ISP to a different anycast range via DNS.
- **No headroom for failover.** Withdrawing a PoP shifts its whole load onto its neighbours. Size PoPs for N-1 within each region.
- **Debugging is confusing.** "The server" is dozens of machines. Add an identifier to responses (for example, a header naming the PoP, or `CHAOS TXT id.server` for DNS) so you can tell which instance answered.
- **Stateful protocols across a flap.** Long TCP flows can reset when routes change. Design clients to retry and resume.

> [!WARNING]
> A health check that withdraws routes too eagerly can make things worse. If PoPs flap in and out, BGP route-flap damping on other networks may suppress your prefix for many minutes. Add hysteresis: require several consecutive failures before withdrawing and several successes before re-announcing.

## Discussion questions

1. Why is anycast an easy fit for DNS over UDP, and what changes when you run TCP or TLS over it?
2. A user in Paris is consistently served from Virginia. What BGP factors could cause this, and what levers does a CDN have to fix it?
3. Compare failover times for GeoDNS (60 s TTL) and anycast route withdrawal. Which caches or timers bound each one?
4. How does ECMP hashing inside a PoP interact with servers being added or removed, and what keeps existing connections alive?
5. Why do DDoS attacks hurt anycast networks less than unicast ones? When might anycast concentrate an attack instead of spreading it?
6. When would you combine GeoDNS with anycast rather than using either alone?

## FAQ

### Is anycast the same as load balancing?

Not exactly. Anycast decides *which site* a packet reaches, based on routing. It knows nothing about server load. Inside each site you still need ECMP and layer-4 or layer-7 load balancers to spread traffic across machines.

### Can I use anycast myself?

You need your own IP space (at least a /24 or /48), an AS number or a provider willing to announce for you, and presence in several locations. Many cloud and edge providers sell it as a product: global load balancers, "global accelerator" style services, or BYOIP with anycast. That saves you running BGP yourself.

### Does anycast break TCP?

Rarely, in practice. Breakage needs a route change *during* a connection, and internet routes are mostly stable on the timescale of web requests. Long-lived connections carry more risk, which is why clients should retry and why QUIC connection IDs help.

### How is anycast different from multicast?

Multicast sends one packet to *every* member of a group. Anycast sends each packet to *one* member of the group, the nearest. Unicast is one to one, and broadcast is one to all on a link.

### Why do the root servers have only 13 names but thousands of machines?

The original limit came from fitting all root server addresses into a 512-byte UDP response. Anycast lifted the capacity limit without changing the names: each of the 13 identities is served from many sites announcing the same address.

## Key takeaways

- Anycast is many sites announcing one prefix. BGP's best-path selection sends each user to one of them.
- "Nearest" is about routing policy and peering, not kilometres. Measure it.
- Failover is a route withdrawal. It needs no client or DNS changes, but neighbouring PoPs must have headroom.
- It is ideal for stateless UDP (DNS) and works well for HTTP and TLS. Long-lived flows need retry logic.
- CDNs pair anycast with DNS steering, ECMP and layer-4 load balancers inside each PoP.
- Anycast turns a DDoS into many small regional problems instead of one big one.

## References

- [RFC 4786 — Operation of Anycast Services](https://www.rfc-editor.org/rfc/rfc4786)
- [RFC 7094 — Architectural Considerations of IP Anycast](https://www.rfc-editor.org/rfc/rfc7094)
- [RFC 4271 — A Border Gateway Protocol 4 (BGP-4)](https://www.rfc-editor.org/rfc/rfc4271)
- [root-servers.org — Root server instances map](https://root-servers.org/)
- [Cloudflare Learning — What is Anycast?](https://www.cloudflare.com/learning/cdn/glossary/anycast-network/)
- Calder, M. et al. "Analyzing the Performance of an Anycast CDN." ACM IMC, 2015.
- Moura, G. et al. "Anycast vs. DDoS: Evaluating the November 2015 Root DNS Event." ACM IMC, 2016.

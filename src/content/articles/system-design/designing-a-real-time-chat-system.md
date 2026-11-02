---
summary: A design walk-through for a WhatsApp- or Slack-style chat service, covering persistent connections at scale, message ordering and sync across devices, delivery and read receipts, group fan-out, presence, push notifications and storage.
updated: 2026-11-02
---

> [!KEY]
> **TL;DR.** A chat system keeps a **persistent connection** (WebSocket or MQTT) from each online device to a fleet of **gateway** servers, which do nothing but hold connections. Stateless **chat services** validate messages, assign a **per-conversation sequence number**, **store** them durably, and then **deliver** them by looking up which gateway each recipient's devices are on, falling back to **push notifications** for offline devices. Each device syncs by asking "give me everything after seq N", which handles reconnects, multiple devices and ordering in one mechanism. Receipts (sent ✓, delivered ✓✓, read) are acknowledgements flowing back. The hard parts are **scale of connections**, **group fan-out**, **presence**, and **exactly-once-looking delivery** on top of at-least-once networks.

## Requirements

**Functional:**

- 1:1 and group conversations (groups up to, say, 1,000 members, and large channels).
- Real-time delivery when online. Messages waiting when offline, with push notifications.
- Multiple devices per user (phone, laptop, web), all in sync.
- Sent, delivered and read receipts. Typing indicators. Online/last-seen presence.
- History, search, media attachments.

**Non-functional:**

- Hundreds of millions of users, tens of millions of **concurrent connections**.
- Delivery latency under a few hundred milliseconds when both users are online.
- **No lost messages**, no visible duplicates, and the **same order** on every device.
- High availability: a gateway or service failure shouldn't drop messages.

## Architecture

![Clients connect over WebSockets to gateways; a chat service validates, sequences and stores messages, looks up the recipient's gateway in a session registry, and uses a push service for offline devices.](/figures/chat/architecture.svg "Separating connection-holding from message logic lets each scale on its own terms.")

- **Gateways (connection servers)** terminate WebSocket/MQTT connections and TLS. They hold per-connection state and little else, so they can handle hundreds of thousands to millions of connections each (WhatsApp famously ran around 2 million connections per Erlang server in 2012).
- **Session registry:** maps `user → devices → gateway`. Written on connect and disconnect, read on every delivery. Usually an in-memory store (Redis) or a consistent-hash ring of gateways.
- **Chat service (stateless):** authenticates, validates, checks membership, assigns the sequence number, writes to storage, and triggers delivery.
- **Message store:** an append-only log per conversation.
- **Push service:** sends APNs/FCM notifications to offline devices.
- **Supporting services:** media storage (object store + CDN), search indexing, abuse detection, and an event stream (Kafka) feeding them asynchronously.

## Sending and receiving

![A sequence: Alice sends with a client id; server stores and acks with id and seq (sent ✓); server delivers to Bob; Bob acks delivery; server tells Alice delivered ✓✓; Bob reports read up to seq 88; server tells Alice read.](/figures/chat/receipts.svg "Every tick is an acknowledgement that a specific step completed.")

1. Alice's client creates the message with a **client-generated ID** and shows it as "sending".
2. The chat service **persists** it, assigns a server ID and the next **sequence number** for the conversation, and acks to Alice: **sent ✓**.
3. It looks up Bob's devices in the session registry and forwards the message to each device's gateway. Offline devices get a push notification.
4. Bob's device acks receipt. The server records it and tells Alice: **delivered ✓✓**.
5. When Bob opens the chat, his client sends "read up to seq 88" (one ack covers everything before it). Alice sees **read**.

### Exactly once, from the user's point of view

Networks drop connections mid-send, so clients **resend** messages that weren't acked. The **client-generated ID** lets the server **deduplicate**: a resend of an already stored message gets the same ack. Delivery to devices is also at-least-once (a device may receive a message twice after reconnecting), so clients dedupe by message ID. At-least-once transport plus idempotent handling looks exactly-once to users.

## Ordering and multi-device sync

![A conversation log with sequence numbers 84–91; the phone has seen up to 91 and is up to date; the laptop has seen up to 86 and fetches 87–91.](/figures/chat/sync.svg "One integer per conversation per device is enough to catch up after any disconnection.")

Users expect every participant and every device to see messages in the **same order**. The simplest robust approach:

- Each conversation has a **monotonic sequence number**, assigned by the chat service when the message is committed (one writer per conversation at a time, e.g. by routing each conversation to a partition owner, or with a conditional increment in the database).
- Devices store the **last sequence number** they've seen per conversation.
- On reconnect, or when a gap is detected (received 90 but not 89), a device asks for **everything after N**.
- Real-time pushes are an optimization on top of sync. If a push is lost, the next sync fills the gap.

Sorting by **client timestamps** doesn't work: device clocks are wrong, and two people sending at once would see different orders. The client can show its own unsent messages optimistically, then move them into place when the server assigns a sequence number.

For a user's **inbox** (the list of conversations with unread counts), keep a per-user sequence of events ("new message in conversation X") so a device can also sync the conversation list with a single "after N" call.

## Group chat and fan-out

When a message is sent to a group, it must reach every member's devices:

- **Small groups** (up to hundreds): fan out on write. Store the message once in the conversation log, then deliver to each online member's gateway and push to offline ones. Each member's inbox gets a pointer.
- **Large channels** (thousands to millions of members, like Slack channels or Discord servers): **don't** deliver every message to every member. Store it once, notify only **currently connected** members who have the channel open or subscribed, and let others **pull** when they open the channel. Discord, for instance, routes each server ("guild") through a process that tracks which sessions are subscribed.
- **Store once, reference many:** never copy message bodies per recipient. Inboxes hold pointers, and media is stored once in object storage.

End-to-end encrypted systems (WhatsApp, Signal) change this: the sender encrypts per recipient device (or uses sender keys for groups), so the server stores and forwards ciphertexts it can't read.

## Presence and typing indicators

![Presence techniques: heartbeat every ~30 s, debounce flaps, push only for chats on screen, and counts instead of per-member status in large groups.](/figures/chat/presence.svg "Presence changes far more often than messages, and everyone wants to know.")

Presence is deceptively expensive: every online/offline change goes to every contact who might care, and mobile connections flap constantly.

- **Heartbeats:** clients ping every ~30 s, and a user goes offline after missing a couple.
- **Debounce:** ignore disconnects shorter than a few seconds (switching between Wi-Fi and cellular).
- **Subscribe on demand:** only send presence for contacts visible on the screen right now, instead of broadcasting to all contacts.
- **Degrade for large groups:** show "12 online" or nothing, rather than individual status.
- **Typing indicators** are **ephemeral**: send them best-effort through gateways, never store them, and expire them after a few seconds.

## Storage

- **Messages:** a wide-column or key-value store keyed by `(conversation_id, seq)` or `(conversation_id, message_id)` with time-sortable IDs. Writes are appends, reads are recent ranges. Discord stores trillions of messages this way (Cassandra, then ScyllaDB, partitioned by channel and time bucket to avoid huge partitions).
- **Inboxes and unread counts:** per-user state, updated on every message. Hot for active users. Often in a separate store from message bodies.
- **Media:** object storage + CDN, with only references in messages.
- **Retention:** some products delete messages from servers after delivery (WhatsApp stores undelivered messages temporarily), others keep full history (Slack, Discord).

## Connection management at scale

- **Load balancing long-lived connections:** use L4 balancing to gateways. On deploys, drain gateways gradually so millions of clients don't reconnect at once.
- **Reconnect storms:** when a gateway dies, its clients all reconnect. Use **jittered** reconnect backoff in clients.
- **Mobile constraints:** background apps can't keep sockets open on iOS/Android, so rely on **push notifications** to wake the app or show the message.
- **Protocols:** WebSockets for browsers. MQTT or custom binary protocols over TCP (or QUIC) on mobile for lower overhead. Facebook Messenger used MQTT.

## Where it's used

| Product | Notable design choices |
| --- | --- |
| **WhatsApp** | Erlang/BEAM servers holding millions of connections each, store-and-forward with end-to-end encryption, multi-device via per-device keys |
| **Slack** | Channel servers (consistent-hashed by channel) and gateway servers at the edge. Messages stored in sharded MySQL (Vitess). |
| **Discord** | Elixir gateways, guild processes for fan-out, Rust services, ScyllaDB for messages |
| **Facebook Messenger** | MQTT for mobile clients, Iris (a sync system with ordered queues per user) |
| **LinkedIn Messaging** | Real-time delivery via a server-sent-events / long-lived connection platform, with presence at scale |

### Use case walk-through: a message to a 50-person group

1. Alice sends "lunch?" with client ID `c9f…`. Her phone's gateway forwards it to a chat service instance.
2. The chat service checks Alice is a member, writes `(conv 551, seq 1203, msg 77f…)` to the message store, and acks Alice (✓).
3. It publishes a `MessageCreated` event and, for each of the other 49 members, looks up their devices in the session registry: 31 members have 44 online devices across 19 gateways, and 18 members are offline.
4. It sends one batched delivery per gateway (19 calls). Gateways push to the devices.
5. 18 offline members get a push notification, collapsed per conversation so a busy group doesn't buzz phones 50 times.
6. Devices ack. Delivered and read states are aggregated per message for the sender ("read by 12").
7. A laptop that was asleep reconnects later and calls `sync(conv 551, after = 1188)` to fetch the 15 messages it missed.

## Pitfalls

- **Ordering by client timestamps.** Different devices disagree. Use server-assigned sequence numbers.
- **Treating push as delivery.** Real-time pushes can be lost. The sync protocol is the source of truth.
- **Per-recipient copies of messages** in large groups. Store once.
- **Broadcasting presence to all contacts.** It dwarfs message traffic.
- **Reconnect storms** after a deploy or failure. Jitter, gradual draining.
- **Unbounded partitions:** one huge channel's history in a single storage partition. Bucket by time.

> [!WARNING]
> Never ack a message to the sender before it's **durably stored**. If the server acks first and then crashes, the sender sees "sent" for a message that no one will ever receive.

## Discussion questions

1. How would you guarantee the same message order on all devices of all participants?
2. A user's phone was offline for a week and is in 300 conversations. How should it sync efficiently?
3. Design read receipts for a 500-person group without overwhelming the sender.
4. How would you route deliveries if the session registry is temporarily unavailable?
5. What changes when messages are end-to-end encrypted?
6. How would you handle a channel with 1 million members where 5% are online?

## FAQ

### WebSockets, long polling, or server-sent events?

**WebSockets** are bidirectional and the common choice for chat in browsers. **Server-sent events** are one-way (server to client) over HTTP, with sends done via normal HTTP requests, which is simpler through some proxies. **Long polling** works everywhere but is less efficient. Mobile apps often use MQTT or custom TCP/QUIC protocols.

### How many connections can one server hold?

With careful tuning (epoll/kqueue, small per-connection memory, raised file-descriptor limits), hundreds of thousands to a few million idle connections per server. The practical limit is usually memory per connection and the cost of reconnect storms when a server dies.

### How do I store messages for fast history scrolling?

Partition by conversation (and time bucket for busy conversations), cluster by sequence or a time-sortable ID descending, and page with `WHERE conv = ? AND seq < :cursor ORDER BY seq DESC LIMIT 50`.

### How are unread counts computed?

Per user per conversation: `last_seq − last_read_seq`. Both are cheap to maintain. The total badge count is a sum over conversations, often cached and updated incrementally.

### Do I need Kafka?

Not for the delivery path itself, which needs low latency. A log like Kafka is useful **after** the write, to feed search indexing, notifications, analytics, moderation and other consumers asynchronously.

## Key takeaways

- Separate **connection gateways** (stateful, many connections) from **chat services** (stateless logic).
- **Persist, then ack.** Deduplicate with client-generated IDs, so at-least-once delivery looks exactly-once.
- Use **per-conversation sequence numbers** and **"sync after N"** for ordering, multi-device and reconnects.
- Fan out to **online devices** and **push** to offline ones. Store messages **once**.
- Presence and typing are **ephemeral** and must be throttled, debounced and subscribed on demand.

## References

1. R. Reed. [That's 'Billion' with a 'B': Scaling to the Next Level at WhatsApp](https://www.erlang-factory.com/upload/presentations/558/efsf2012-whatsapp-scaling.pdf). Erlang Factory, 2012.
2. Slack Engineering. [Real-time Messaging](https://slack.engineering/real-time-messaging/). 2023.
3. Discord Blog. [How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages). 2023.
4. Discord Blog. [How Discord Scaled Elixir to 5,000,000 Concurrent Users](https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users). 2017.
5. Meta Engineering. [Building Mobile-First Infrastructure for Messenger](https://engineering.fb.com/2014/10/09/production-engineering/building-mobile-first-infrastructure-for-messenger/). 2014.
6. LinkedIn Engineering. [Now You See Me, Now You Don't: LinkedIn's Real-Time Presence Platform](https://engineering.linkedin.com/blog/2018/01/now-you-see-me--now-you-dont--linkedins-real-time-presence-platf). 2018.
7. WhatsApp. [WhatsApp Encryption Overview (technical white paper)](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf).
8. IETF. [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455). 2011.

---
summary: Services and stored data outlive any single version of a message format. This explains backward and forward compatibility, how Protobuf and Avro each make evolution possible, what a schema registry enforces, and which changes are safe.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — In a distributed system, new code reads old data and old code reads new data, often at the same moment, because nobody can upgrade every service and rewrite every stored byte at once. **Backward compatibility** means new readers can handle old data. **Forward compatibility** means old readers can handle new data. Protobuf gets there by putting **field numbers** on the wire and skipping unknown ones. Avro gets there by **resolving the writer's schema against the reader's** by field name. In both, the safe moves are the same: add optional fields with defaults, never reuse an identifier, never change a field's meaning. A schema registry turns those rules into an automated gate.

## The problem: you can't upgrade everything at once

Say an `Order` event gains a `currency` field. In a real system:

- A rolling deploy means v1 and v2 of the producer run side by side for minutes.
- Twelve consumer teams upgrade on their own schedules, over weeks.
- Kafka topics, data lakes and backups hold years of v1 messages that will be re-read.
- Mobile clients on old app versions keep sending requests for months.

So any message may be read by code older or newer than the code that wrote it. JSON hides the problem until it doesn't: a renamed key silently becomes `undefined`, and a number that turns into a string breaks a parser in a service nobody remembered existed. Binary formats with schemas make the rules explicit and checkable.

## How it works

### Backward, forward, full

![A two-by-two grid of writer version versus reader version: new reader with old data is backward compatibility; old reader with new data is forward compatibility](/figures/schema-evolution/compat.svg "Compatibility is defined by which side of the conversation is newer")

- **Backward compatible**: a reader on the *new* schema can read data written with the *old* one. This is what you need when **consumers upgrade first**, and it's what lets you re-read historical data.
- **Forward compatible**: a reader on the *old* schema can read data written with the *new* one. This is what you need when **producers upgrade first**, which is the usual case because producers ship whenever they like.
- **Full**: both. Deploy order no longer matters.
- **Transitive** variants check against *every* earlier version, not just the previous one. Without that, v3 might be compatible with v2 and v2 with v1, yet v3 can't read v1. That matters for topics with long retention.

### Protobuf: tags on the wire

![Protobuf encodes each value prefixed by its field number; Avro encodes bare values and needs the writer schema to decode them](/figures/schema-evolution/encoding.svg "Protobuf is self-describing enough to skip; Avro is compact but needs the writer schema")

A Protobuf message is a sequence of `(field number, wire type, value)` entries. Field *names* never appear on the wire, only numbers. Evolution follows from that:

- **Unknown field number?** The wire type tells the parser how many bytes to skip. Old readers ignore new fields, which gives forward compatibility. Modern Protobuf runtimes even keep unknown fields and write them back out when re-serialising, so a middle service on an old schema doesn't strip them.
- **Field missing?** The reader uses the type's default (0, empty string, false), which gives backward compatibility. In proto3 you can't distinguish "unset" from "zero" for plain scalars unless you mark the field `optional`.
- **Renaming a field** is wire-safe because names aren't encoded. It can still break JSON mappings and generated code.
- **Changing a field number** or **reusing a deleted one** is catastrophic. Old data gets decoded into the wrong field with no error. Use `reserved 4; reserved "legacy_id";` to prevent it.

Some type changes are wire-compatible: `int32`, `int64`, `uint32` and `bool` all share the varint encoding, though values can be truncated. Others, such as `string` → `int32`, aren't.

proto3 removed `required` because a required field can never be safely removed. Every reader in the world would reject messages without it.

### Avro: schema resolution

Avro takes the opposite approach. The binary has **no field tags and no names**, just values in the order the schema declares them, which makes it very compact. Decoding is impossible without the **exact writer schema**. Avro then runs **schema resolution** between the writer schema and the reader schema:

- Fields are matched **by name** (with `aliases` for renames).
- A field in the writer but not the reader is **skipped**.
- A field in the reader but not the writer gets the reader's **default**, and if there is no default, resolution fails.
- Some type promotions are allowed (`int` → `long` → `float` → `double`, `string` ↔ `bytes`).

The practical rule follows: **only add or remove fields that have defaults.** Avro's rules are stricter than Protobuf's, but they're also more mechanical, which makes them easy for a tool to check.

The writer schema has to travel with the data. In Avro container files (Hadoop, data lakes) it sits in the file header. In a stream of individual messages, putting it in every message would waste a lot of space, so a registry is used instead.

### Schema registries

![Producer registers a schema, registry checks compatibility and returns an ID, messages carry the ID, consumers fetch the schema by ID](/figures/schema-evolution/registry.svg "The registry is both a schema lookup service and a compatibility gate")

A schema registry (Confluent Schema Registry, Apicurio, AWS Glue Schema Registry, or Buf Schema Registry for Protobuf) does two jobs:

1. **Lookup.** Each message starts with a small header: in Confluent's format, a magic byte and a 4-byte schema ID. The consumer fetches the writer schema for that ID once, caches it, and resolves it against its own reader schema.
2. **Gatekeeping.** When a producer registers a new version under a *subject* (for example `orders-value`), the registry checks it against the subject's compatibility mode. An incompatible change is rejected before a single message is written. Teams usually run the same check in CI, with tools like `buf breaking` for Protobuf or the registry's compatibility API, so the failure shows up in code review.

### The safe-change checklist

| Change | Protobuf | Avro |
|---|---|---|
| Add a field | Safe (new tag number) | Safe **with a default** |
| Remove a field | Safe if tag is `reserved` | Safe if it **had a default** |
| Rename a field | Wire-safe; breaks JSON / codegen | Use `aliases` |
| Change field type | Only within compatible encodings | Only allowed promotions |
| Reuse a number / name | **Never** | Breaks meaning |
| Add an enum value | Old readers see unknown value | Old readers fail unless enum has a `default` |
| Change semantics (cents → dollars) | **Not detectable — never do it** | **Same** |

The last row matters most. No tool can tell that `amount` used to mean cents and now means dollars. A change in meaning needs a **new field**.

## Where it's used

| System | Format and evolution strategy |
|---|---|
| **gRPC services** | Protobuf; tag-based evolution, `buf breaking` in CI |
| **Kafka at Confluent users (LinkedIn, Uber, Netflix-style pipelines)** | Avro or Protobuf with a schema registry and per-subject compatibility modes |
| **Hadoop / data lakes** | Avro container files embed the writer schema; Parquet and Iceberg have their own column-level schema evolution |
| **Google internal RPC and storage** | Protobuf, which was designed for exactly this, across a huge fleet of services and stored data |
| **Apache Thrift (Meta)** | Field-ID-based like Protobuf |
| **Event-sourced systems** | Events are stored forever, so they rely on *upcasters* that transform old event versions on read |

## Use case walk-through: adding currency to orders

An `OrderPlaced` event on Kafka, in Avro, with the subject set to `FULL_TRANSITIVE`. The team wants to support multiple currencies.

1. **First draft fails.** A developer adds `"currency": {"type": "string"}` with no default. The CI compatibility check fails: old messages have no `currency`, so the new reader would have nothing to fill in.
2. **Add a default.** The field becomes `{"name": "currency", "type": "string", "default": "USD"}`, since every historical order was in USD. The check passes.
3. **Deploy producers.** Producers start writing v2. Old consumers resolve v2 against their v1 reader schema and skip `currency`. They keep working, but they assume USD.
4. **Spot the semantic gap.** Old consumers now treat EUR orders as USD amounts. The schema is compatible, but the meaning isn't. The team gates non-USD orders behind a feature flag until the revenue and tax consumers have upgraded.
5. **Deploy consumers.** Each consumer upgrades on its own schedule and starts reading `currency`. Old messages resolve to `"USD"` through the default.
6. **Open non-USD orders.** Once the registry's consumer inventory shows that every critical consumer reads v2, the flag is turned on.

**Result:** The change rolled out with no lockstep deploy and no broken consumers. The one real risk, consumers misreading amounts, was found by thinking about meaning, which no compatibility checker can do.

## Pitfalls

- **Reusing a Protobuf field number.** Old data decodes into the new field without any error. Always `reserved` deleted numbers and names.
- **Avro fields without defaults.** They make the change both non-backward and impossible to remove later. Make "default required" a lint rule.
- **Enums.** Adding a value breaks old readers in Avro unless the enum declares a `default`. In Protobuf, old code sees an unrecognised number, so `switch` statements need a fallback.
- **Compatibility mode set too loose.** `NONE` or plain `BACKWARD` on a topic with long retention and replays lets incompatible history pile up. Use transitive modes for long-lived data.
- **Bypassing the registry.** A producer with `auto.register.schemas=true` in production can register any schema at all. Register schemas from CI and have producers only look them up.
- **JSON "schemas" that nothing enforces.** A JSON Schema that is checked nowhere is just documentation.

> [!TIP]
> Treat schemas as a public API. Keep them in a shared repo or registry, review changes like API changes, run breaking-change checks in CI, and prefer a *new field* or a *new message type* over changing an existing one's meaning.

## Discussion questions

1. Your producers deploy several times a day and consumers deploy weekly. Which compatibility mode do you need, and why?
2. Why did proto3 drop `required` fields? What did that cost, and how do teams validate required-ness now?
3. Avro needs the writer schema to decode. What happens to a Kafka consumer if the registry is unreachable at startup, and how would you design for that?
4. A topic is retained forever and replayed to build new read models. Why does `FULL_TRANSITIVE` matter more here than on a topic with 7-day retention?
5. How would you rename a widely used field without breaking anyone, in Protobuf and in Avro?
6. Where does compatibility checking end and contract testing between services begin?

## FAQ

### Protobuf or Avro — which should I pick?

Protobuf if you're doing RPC (gRPC), want strong code generation across many languages, or want messages that can be partly decoded without a registry. Avro if you're mostly in the Kafka or Hadoop ecosystem, want the most compact encoding, or want to work with dynamic or generic records without generated classes. Both evolve well if you follow the rules.

### Is JSON really that bad for evolution?

JSON evolves fine if every reader ignores unknown fields and tolerates missing ones, which is the "tolerant reader" pattern. The problem is that nothing enforces it, so one strict parser breaks the chain. JSON Schema with a registry and compatibility checks closes much of that gap, at the cost of larger messages.

### What's the difference between schema evolution and API versioning?

Schema evolution makes *compatible* changes inside one version, so readers and writers can drift apart. API versioning (`/v2`, a new message type) is for *breaking* changes you can't make compatibly. Good evolution practice means you need new versions much less often.

### How do I make a breaking change when I truly need one?

Create a new field, message type or topic. Write both old and new in parallel ("dual write"). Migrate consumers to the new one. Stop writing the old one, then retire it once nothing reads it. It's the expand/contract pattern from database migrations, applied to messages.

### Does the schema registry become a single point of failure?

It sits on the hot path only for cache misses. Clients cache schemas by ID, so a running service keeps working through an outage. New producers registering schemas and cold-starting consumers are what suffer. Run the registry highly available and back it up, because it's the source of truth for decoding your data.

## Key takeaways

- New and old code always coexist. Design every message change for **both directions**.
- **Backward** means new readers handle old data (consumers upgrade first). **Forward** means old readers handle new data (producers upgrade first). **Full** means both.
- Protobuf evolves through **field numbers**: unknown numbers are skipped and missing fields get defaults. Never reuse a number.
- Avro evolves through **writer/reader schema resolution by name**: only add or remove fields that have defaults.
- A **schema registry** plus CI checks turns these rules into an automatic gate. **Semantic** changes still need a human and a new field.

## References

- [Protocol Buffers documentation: "Updating a Message Type"](https://protobuf.dev/programming-guides/proto3/#updating), Google
- [Apache Avro specification: Schema Resolution](https://avro.apache.org/docs/current/specification/#schema-resolution), Apache Software Foundation
- [Confluent Schema Registry documentation: Schema Evolution and Compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)
- [Buf documentation: breaking change detection](https://buf.build/docs/breaking/)
- Martin Kleppmann, *Designing Data-Intensive Applications*, O'Reilly, 2017, Chapter 4 "Encoding and Evolution"
- Martin Kleppmann, "Schema evolution in Avro, Protocol Buffers and Thrift" (blog post, 2012)

---
summary: Store instants in UTC, store future and recurring events as local time plus an IANA zone, never convert plain dates, and measure durations with a monotonic clock.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — "Store everything in UTC" solves only one of three problems. **Instants** (when something happened) belong in UTC. **Future and recurring events** ("every Monday at 9:00 in New York") must be stored as **local time plus an IANA zone ID**, because the UTC offset for a future date can change with DST or new laws. **Plain dates** like birthdays have no zone at all. Resolve DST gaps and overlaps explicitly, keep the time-zone database up to date, convert to local time only at the edges, and measure durations with a **monotonic clock**, never the wall clock.

## The problem: time looks simple until it isn't

Every backend handles time: `created_at` columns, token expiry, billing periods, scheduled jobs, meeting invites, store opening hours. The naive approach — use the server's local time, or convert everything to UTC and call it done — produces a steady stream of bugs:

- A daily report runs twice, or not at all, on the night clocks change.
- A user in Sydney sees their birthday on the wrong day because a date was stored as midnight UTC.
- A recurring 9:00 meeting moves to 8:00 for half the year after it was stored as a UTC instant.
- A government changes its DST rules with a few weeks' notice, and already-booked appointments shift by an hour.
- A request timer reports a negative duration because NTP adjusted the clock mid-request.
- Two servers disagree about which event came first because their clocks differ by 300 ms.

These failures share a root cause: treating different *kinds* of time as the same thing, and trusting clocks more than they deserve.

## How it works

### Three kinds of time

![Three kinds of time: an instant stored as UTC, a local date-time with an IANA zone, and a plain date with no zone](/figures/time-zones/kinds.svg "Decide which kind of time a field represents before choosing how to store it.")

- **Instant** — a single point on the global timeline, the same everywhere: "the payment was captured at `2026-03-08T10:00:00Z`." Store as a UTC timestamp (`timestamptz` in PostgreSQL, epoch milliseconds, ISO 8601 with `Z`). Logs, audit trails, `created_at`, token expiry and event ordering are all instants.
- **Local date-time with a zone** — a wall-clock time in a particular place: "the dentist appointment is at 09:00 on 10 November in `America/New_York`." The instant it corresponds to depends on the zone's rules *for that date*, which may not be final yet. Store the local date-time and the zone ID separately, and compute the instant when needed.
- **Plain date or time** — no zone at all: a birthday, a public holiday, a hotel check-in date, "the shop opens at 09:00." Converting these to an instant is a bug; `1990-05-14` stored as `1990-05-14T00:00:00Z` becomes 13 May for anyone west of Greenwich.

Modern libraries model these distinctly: Java's `java.time` (`Instant`, `ZonedDateTime`, `LocalDate`), JavaScript's Temporal (`Temporal.Instant`, `ZonedDateTime`, `PlainDate`), Python's `datetime` with `zoneinfo`, and NodaTime in .NET. Using the right type makes the compiler catch mix-ups.

### Offsets are not zones

`-05:00` is an **offset**; `America/New_York` is a **zone**. A zone is a history of offsets and rules: New York is `-05:00` in winter and `-04:00` in summer, and the dates of the switch have changed several times. If you store only the offset, you can't correctly compute "same time next week" across a DST boundary.

Zones come from the **IANA Time Zone Database** (tzdata, also called the Olson database), which is updated several times a year as countries change their rules — sometimes with only weeks of notice. Your operating system, language runtime, database and browsers each ship a copy. Stale tzdata is a real source of production bugs: keep base images, JDKs and libraries current.

Use zone IDs (`Europe/Berlin`), not abbreviations (`CET`, `IST` — which means India, Israel or Ireland depending on who you ask).

### DST gaps and overlaps

![Daylight saving transitions in New York, with a skipped hour in spring and a repeated hour in autumn](/figures/time-zones/dst.svg "Local wall-clock time is not continuous: some local times never happen and some happen twice.")

Twice a year in zones with daylight saving:

- **The gap (spring forward).** In New York on 8 March 2026, clocks jump from 01:59:59 to 03:00:00. A local time of 02:30 *does not exist*. A job scheduled for 02:30 must be shifted (usually to 03:00 or 03:30) or skipped.
- **The overlap (fall back).** On 1 November 2026, 01:00–01:59 happens twice — first in EDT (`-04:00`), then in EST (`-05:00`). "01:30" is ambiguous; you must pick the earlier or later instant.

Libraries let you choose the policy (Temporal's `disambiguation: 'earlier' | 'later' | 'compatible' | 'reject'`, Java's `withEarlierOffsetAtOverlap()`). The important thing is to choose it deliberately for each use case: an alarm should fire once, a billing cut-off should not be counted twice.

Other consequences: a local "day" can be 23 or 25 hours long, so "add 24 hours" and "add 1 day" are different operations; and some zones shift by 30 or 45 minutes, not whole hours.

### Recurring and future events

The hardest case is "every Monday at 09:00 in the user's time zone":

1. Store the **rule** (an RFC 5545 RRULE like `FREQ=WEEKLY;BYDAY=MO`), the local start time, and the zone ID.
2. Expand occurrences **in local time**, then convert each to an instant using the zone rules current at expansion time.
3. Re-expand when tzdata changes or the user moves zones; don't precompute years of UTC instants and forget about them.

For a one-off future event, store local time and zone too — the instant becomes final only when the date arrives. Store a computed UTC instant alongside for indexing and querying, and recompute it when rules change.

### Converting at the edges

A simple, robust architecture:

- **Inside the system,** instants are UTC; local events carry an explicit zone; plain dates stay plain.
- **At input,** the client sends an ISO 8601 string with offset or zone, or a local time plus the user's zone. Never let the server's own time zone influence parsing — run servers with `TZ=UTC` and don't call APIs that use the default zone implicitly.
- **At output,** convert to the viewer's zone (from their profile or browser via `Intl.DateTimeFormat().resolvedOptions().timeZone`) and format with locale rules.
- **For "which day" questions** — daily limits, "today's orders", daily reports — decide *whose* day: the user's, the store's, or the company's. Then compute day boundaries in that zone.

### Clocks: wall vs monotonic

![A wall clock that jumps backwards when NTP corrects it, beside a monotonic clock that always increases](/figures/time-zones/clocks.svg "Measure elapsed time with the monotonic clock; record when things happened with the wall clock.")

Computers have (at least) two clocks:

- **The wall clock** (`System.currentTimeMillis()`, `Date.now()`, `time.time()`) tells you the current date and time. It can jump forwards or backwards when NTP corrects drift, an admin changes it, or a VM resumes from suspension. Use it for timestamps humans and other systems read.
- **The monotonic clock** (`System.nanoTime()`, `performance.now()`, `time.monotonic()`, Go's monotonic reading inside `time.Time`) only moves forward and has no meaningful epoch. Use it for timeouts, latency measurement, rate limiters and retry backoff.

Leap seconds add another twist. Rather than inserting a 61st second, Google, AWS and others **smear** it over many hours by slightly slowing their clocks. (The leap second is scheduled to be abolished by 2035.)

### Clocks across machines

Clocks on different servers drift apart, even with NTP — typically by milliseconds, sometimes much more on a misconfigured host. So:

- Don't use wall-clock timestamps to order events from different machines when correctness matters ("last write wins" can lose the write that actually happened last).
- Use **logical clocks** (Lamport timestamps, vector clocks), database-assigned sequence numbers, or **hybrid logical clocks** (used by CockroachDB and others) for ordering.
- Systems that need tight bounds use special hardware: Google Spanner's **TrueTime** exposes clock uncertainty as an interval and waits it out before committing; AWS offers a similar time-sync service with bounded error.
- For token expiry and signatures, allow a small **clock skew** tolerance (JWT libraries typically allow 30–60 seconds).

## Where it's used

| Domain | Time concern |
|---|---|
| Calendars (Google Calendar, Outlook) | RRULE recurrence expanded in local zones; iCalendar `VTIMEZONE` |
| Payments and billing | UTC instants for transactions; billing periods in the customer's or merchant's zone |
| Airlines and travel | Departure and arrival in different local zones; flight duration ≠ difference of local times |
| Cron and job schedulers | DST gaps and overlaps; Kubernetes CronJob's `timeZone` field |
| Distributed databases | Hybrid logical clocks, TrueTime, MVCC timestamps |
| Observability | Logs in UTC with high-resolution timestamps; durations from monotonic clocks |

## Use case walk-through: a global appointment-booking service

A booking platform lets clinics in 30 countries publish weekly availability; patients book slots. Support tickets complain that appointments drift by an hour twice a year, and that some clinics in Brazil were wrong for weeks after the country abolished DST.

1. **Classify the fields.** Booking creation time and payment time are instants. Clinic opening hours are plain times per weekday plus the clinic's zone. Appointments are local date-times in the clinic's zone. Patient date of birth is a plain date.
2. **Fix the schema.** Appointments gain `local_start` (timestamp without zone), `zone_id` (e.g. `America/Sao_Paulo`) and a derived `start_utc` used for indexing and reminders. Birthdays become a `date` column.
3. **Expand availability in local time.** Weekly slots are generated per clinic in its zone. Slots that fall in a DST gap are dropped; slots in an overlap are generated once, using the earlier offset.
4. **Recompute on tzdata updates.** When the base image ships new tzdata, a job recomputes `start_utc` for future appointments and notifies patients whose times changed in UTC terms (their local time stays the same).
5. **Display at the edges.** Patients see the appointment in the clinic's zone (it's an in-person visit), with their own local time shown as a hint when they're elsewhere.
6. **Fix reminders and timers.** Reminder jobs query by `start_utc`. Request timeouts and latency metrics switch from `Date.now()` differences to a monotonic clock.

**Result:** appointments stay at the clinic's wall-clock time across DST changes and rule changes, the twice-yearly tickets stop, and a future zone change becomes a data refresh instead of an incident.

## Pitfalls

- **Server local time.** A server in `America/Los_Angeles` silently skews every implicit conversion. Run with `TZ=UTC` and pass zones explicitly.
- **Storing future events as UTC instants.** They shift when DST rules change.
- **Dates as midnight UTC.** Birthdays and due dates move a day for half the world.
- **`timestamp without time zone` for instants** in PostgreSQL, so the meaning depends on whoever wrote the row. Use `timestamptz` for instants.
- **Adding 86,400 seconds to get "tomorrow"** in a local zone.
- **Time zone abbreviations** instead of IANA IDs.
- **Measuring durations with the wall clock**, producing negative or wildly wrong latencies.
- **Ordering cross-machine events by wall-clock timestamp.**
- **Stale tzdata** in containers, JDKs or phone OS versions.

> [!TIP]
> Make the current time an injectable dependency (a `Clock` object) rather than calling `now()` everywhere. Tests can then freeze time, jump across DST boundaries and simulate clock skew deterministically.

## Discussion questions

1. Go through the time fields in one of your schemas. Which are instants, which are local date-times, and which are plain dates?
2. If a country you operate in abolished DST next month, what data would be wrong and how would you fix it?
3. What should a scheduled job do when its run time falls in a DST gap? In an overlap?
4. For "maximum 3 withdrawals per day", whose day should it be, and why?
5. Where in your system do you compare timestamps produced by different machines?
6. How would you test date-handling code around DST transitions and leap years?

## FAQ

### Should I store times in UTC or with an offset?

Store **instants** in UTC (or as `timestamptz`, which normalizes to UTC). Store **future local events** as local time plus an IANA zone ID. An offset alone is a snapshot of a zone's rules at one moment and is not enough to compute recurring or future times correctly.

### What's the difference between `timestamp` and `timestamptz` in PostgreSQL?

`timestamptz` represents an instant: input is converted to UTC for storage and displayed in the session's zone. `timestamp` (without time zone) is a plain local date-time with no zone attached. Use `timestamptz` for instants; use `timestamp` plus a separate zone column for local events.

### Is Unix time affected by leap seconds?

Unix time pretends every day has exactly 86,400 seconds, so a leap second is either repeated or smeared. That makes Unix time convenient for calendars but slightly wrong for precise physical durations — another reason to use a monotonic clock for elapsed time.

### How do I get the user's time zone?

In browsers, `Intl.DateTimeFormat().resolvedOptions().timeZone` returns an IANA ID. Save it to the user's profile and let them change it. For location-bound things like a store or clinic, use the location's zone, not the viewer's.

### Can I trust timestamps from client devices?

Not for anything security- or ordering-sensitive — device clocks can be wrong or deliberately changed. Record server time for authority, and keep the client's time (with its offset) only as supplementary information, for example to show "sent at 09:14 your time."

## Key takeaways

- Distinguish **instants**, **local date-times with a zone**, and **plain dates** — and use types that keep them apart.
- Store instants in **UTC**; store future and recurring events as **local time + IANA zone**.
- Handle DST **gaps and overlaps** explicitly, and keep **tzdata** current.
- Convert to local time only **at the edges**, and decide whose "day" a rule refers to.
- Use the **monotonic clock** for durations and **logical or hybrid clocks** to order events across machines.

## References

- [IANA Time Zone Database](https://www.iana.org/time-zones)
- [TC39 — Temporal proposal documentation](https://tc39.es/proposal-temporal/docs/)
- [PostgreSQL documentation — Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html)
- [RFC 3339 — Date and Time on the Internet: Timestamps](https://www.rfc-editor.org/rfc/rfc3339)
- [RFC 5545 — Internet Calendaring and Scheduling (iCalendar)](https://www.rfc-editor.org/rfc/rfc5545)
- Leslie Lamport, "Time, Clocks, and the Ordering of Events in a Distributed System," Communications of the ACM, 1978.
- James C. Corbett et al., "Spanner: Google's Globally-Distributed Database," OSDI 2012.
- Martin Kleppmann, *Designing Data-Intensive Applications*, O'Reilly, 2017 — chapter 8, "Unreliable Clocks."

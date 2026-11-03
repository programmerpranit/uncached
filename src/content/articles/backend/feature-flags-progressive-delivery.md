---
summary: Feature flags let you ship code dark and turn it on gradually, for whom you choose, with an instant off switch. This covers how flag evaluation works, how progressive delivery uses it, and how to keep flags from becoming permanent debt.
updated: 2026-11-03
---

> [!KEY]
> **TL;DR** — A feature flag is a runtime conditional whose value comes from configuration, not code. That one trick separates **deploy** (putting code on servers) from **release** (exposing behaviour to users). Then you can merge unfinished work to trunk, turn features on for staff first, then 1%, 10% and 100% of users, and switch them off in seconds without a redeploy. The cost is complexity: every flag doubles a code path, and flags that are never removed turn into a combinatorial mess and a hidden source of risk.

## The problem: deploying and releasing are the same event

Without flags, getting code onto production servers *is* the moment users see it. That coupling causes three problems:

- **Big-bang risk.** A new checkout flow reaches 100% of users the instant the deploy finishes. If it breaks, you roll back the whole deploy, including any unrelated fixes that went out with it.
- **Long-lived branches.** Because merged code ships, teams keep unfinished features on branches for weeks. Merging them later gets painful.
- **Business timing is held hostage by deploy timing.** Marketing wants the feature live at 9 a.m. Tuesday. Engineering wants to deploy on a quiet Monday. You can't do both.

Feature flags break the coupling. Code ships continuously, switched off. Turning it on becomes a separate, reversible, targeted decision.

## How it works

### Deploy vs release

![Deploy lane with versions v41 to v44 shipping continuously, and a separate release lane where a flag ramps from staff to 1%, 10%, 50% and 100%](/figures/feature-flags/decouple.svg "Deploys happen on the engineering cadence; the release ramp is a separate, reversible control")

In a flag-driven workflow, the new checkout code lands in v41 wrapped in `if (flags.isEnabled("new-checkout", ctx))`. Versions v42–v44 keep shipping other changes. Meanwhile, someone ramps the flag through a series of audiences. If error rates climb at 10%, they flip it off. The rollback takes seconds, and v44 stays deployed with all its other fixes.

This is what makes **trunk-based development** practical. Everyone merges small changes to main at least daily. Incomplete features sit behind flags that default to off, so main stays releasable at all times.

### Evaluating a flag

![A flag service streams rules to an in-process SDK; the SDK evaluates targeting rules top to bottom against the request context and returns a variant](/figures/feature-flags/evaluate.svg "Server-side SDKs evaluate locally against cached rules — no network hop per check")

A flag isn't a boolean in a database row. It's a small **rule set**:

1. **Targeting rules**, checked in order: "users in segment `beta` → ON", "country = DE → OFF" (perhaps for a legal reason).
2. **Percentage rollout**: "10% of everyone else → ON".
3. **Default**: OFF.

Production SDKs (LaunchDarkly, Unleash, Flagsmith, GrowthBook, and OpenFeature providers) generally **evaluate locally**. The SDK downloads the full rule set at startup, keeps it fresh over a streaming connection or by polling, and evaluates each check in memory in microseconds. A flag check in a hot loop then costs no network call. If the flag service goes down, the SDK keeps serving the last rules it saw.

**Percentage rollouts must be sticky.** Picking at random on every request would flip a user between the old and new UI on each page load. Instead, the SDK hashes a stable key:

`bucket = hash(flagKey + userId) mod 100` → ON if `bucket < 10`

The same user always lands in the same bucket, so their experience stays consistent. Raising the percentage from 10 to 50 only *adds* users, because everyone in buckets 0–9 is still below 50. Salting the hash with the flag key keeps different flags' 10% cohorts independent, so the same unlucky users don't get every experiment at once.

Client-side flags (browser, mobile) work differently. You don't want to ship your whole rule set, which may contain customer names and targeting logic, to an untrusted client. So the server evaluates the flags for that user and sends only the results.

### Kinds of flags

Pete Hodgson's taxonomy, published on Martin Fowler's site, sorts flags by **how long they live** and **how dynamic** they are:

| Type | Purpose | Lifespan | Who flips it |
|---|---|---|---|
| **Release toggle** | Hide unfinished or unproven features | Days to weeks | Engineering |
| **Experiment toggle** | A/B test variants, measure conversion | Weeks | Product / data |
| **Ops toggle / kill switch** | Shed an expensive feature under load; disable a flaky dependency | Months to permanent | On-call |
| **Permission toggle** | Entitlements: premium plan, internal tools, early access | Permanent | Product / billing |

The type tells you how to manage the flag. A release toggle still around after three months is a bug. A permission toggle still around after three years is normal, and it arguably belongs in your entitlement system, not your flag tool.

### Progressive delivery

*Progressive delivery* is the general practice of exposing changes to growing audiences with checks at each step. Flags are one mechanism. Others work at the infrastructure layer:

- **Canary deploys.** Route a small share of traffic to new pods, compare their metrics with the baseline pods, then promote or abort. Argo Rollouts and Flagger automate this on Kubernetes.
- **Ring deployments.** Fixed, ordered audiences, such as internal staff → early adopters → one region → everyone. Microsoft has described rolling out Windows and Azure changes this way.
- **Percentage flag rollouts.** The same idea, but per feature rather than per binary, and without a redeploy.
- **Automated guardrails.** The rollout watches error rate, latency, and business metrics for the flagged cohort compared with the control. If a guardrail is breached, it halts or reverts on its own. Humans approve each ramp step; machines pull the brake.

Flags and canaries complement each other. Canaries catch problems in *the binary*, such as crashes, memory leaks and config errors. Flags catch problems in *the feature*: wrong behaviour, bad UX, a downstream service that can't handle the new load pattern.

### The flag lifecycle and flag debt

![Flag lifecycle from create with owner and expiry, through dark, ramp, full on, to removal, with a rollback arc back to off](/figures/feature-flags/lifecycle.svg "A release flag isn't done when it reaches 100% — it's done when the code is deleted")

Every flag adds a branch to the code. Ten flags that interact give you up to 2¹⁰ possible combinations, most of them never tested. Stale flags cause three problems:

- **Dead code.** The `else` branch of a flag that has been at 100% for a year still compiles, still shows up in grep results, and still confuses new hires.
- **Landmines.** Someone repurposes an old flag name, or an old flag gets toggled by mistake and wakes up long-dead behaviour.
- **Test-matrix blowup.** You can't test every combination, so you test the combinations you *think* happen in production.

The best-known cautionary tale is **Knight Capital** in 2012. During a deploy, the code for a new trading feature was installed on seven of eight servers. The new feature reused a flag that had once activated an obsolete function called "Power Peg". On the eighth server, the old code was still present, and turning the flag on woke it up. It sent millions of unintended orders, and the firm lost about $460 million in roughly 45 minutes. The SEC's findings describe the repurposed flag and the dead code behind it.

Practices that keep debt under control:

- **Every flag has an owner and an expiry date** when it's created. Expired flags raise alerts or fail CI.
- **Create the cleanup ticket when you create the flag.** Removal is part of the feature's definition of done.
- **Never reuse flag names.**
- **Track evaluation counts.** A flag that has returned the same value for 30 days is a removal candidate. Most commercial tools report this.
- **Limit work in progress.** Some teams cap the number of active release flags per team.
- **Automated removal.** Tools like Uber's Piranha rewrite code to delete stale flags and their dead branches, then open a PR.

## Where it's used

| Company / tool | How they use flags |
|---|---|
| **Facebook / Meta (Gatekeeper)** | Internal system that gates nearly every feature; code ships to production dark and is ramped by employee, country, or percentage |
| **LaunchDarkly, Split, Statsig** | Commercial flag platforms with streaming SDKs, targeting, experiments, and guardrail metrics |
| **Unleash, Flagsmith, GrowthBook, Flipt** | Open-source / self-hostable flag servers |
| **OpenFeature (CNCF)** | Vendor-neutral flag-evaluation API; code calls one SDK and a provider plugs in the backend |
| **Argo Rollouts, Flagger** | Kubernetes canary / blue-green controllers that promote or abort based on metrics |
| **Vercel, Netlify, Cloudflare** | Edge config stores and flag integrations for evaluating at the CDN |

## Use case walk-through: rolling out a new checkout

An e-commerce team is replacing its checkout flow.

1. **Create the flag.** Create `new-checkout` as a release toggle, default OFF. Owner: payments team. Expiry: six weeks. The cleanup ticket is filed and linked.
2. **Merge behind the flag.** Engineers merge small PRs to main every day. The new code is in production from week one but nobody sees it.
3. **Staff ring.** Add the targeting rule "segment `employees` → ON". Staff use the new flow for a week and file bugs, and nothing reaches customers.
4. **1% rollout, with guardrails.** Add the rule `bucket < 1`. The rollout tool compares checkout error rate, p95 latency and conversion between the 1% cohort and the 99%, and auto-reverts if errors rise by more than 0.5 percentage points.
5. **Hold at 10%.** At 10%, conversion drops for Safari users. Someone flips a targeting rule, "browser = Safari → OFF". Safari users go back to the old flow in seconds while the fix ships in the next ordinary deploy.
6. **50% → 100%.** Ramp over two days. Because the hash buckets are sticky, nobody bounces between flows.
7. **Remove.** A week at 100% with no incidents. The cleanup PR deletes the old checkout and the flag checks, then archives the flag. Total lifespan: five weeks.

**Result:** The rewrite reached every customer without an outage, the Safari regression affected only part of a 10% cohort for an hour, and nothing was left behind once the flag was removed.

## Pitfalls

- **Flag service as a single point of failure.** If every check makes a remote call, a flag-service outage takes down your app. Evaluate locally, cache rules on disk, and choose a safe default for every flag.
- **Defaults that fail open.** If the SDK can't load rules and `isEnabled` returns `true` for a half-built feature, you've just released it. The default should be the *old, safe* behaviour.
- **Non-sticky bucketing.** Randomising per request, or bucketing on session ID when users log in and out, makes users flicker between variants and ruins experiment data.
- **Flags in data migrations.** A flag can switch code paths back and forth, but a schema migration can't be un-run. Use expand/contract migrations so both code paths work against the same schema.
- **Nested flags.** `if (A) { if (B) ... }` makes flag B meaningless whenever A is off. That's hard to reason about and easy to misconfigure.
- **Experiment peeking.** Stopping an A/B test the moment it looks significant inflates false positives. Decide the sample size in advance or use sequential testing.
- **Using a flag tool as a config database.** Flags are for behaviour that changes. Timeouts, URLs and secrets belong in config management.

> [!WARNING]
> A flag flip is a production change. Give it the same audit log, access control and change review you'd give a deploy. "Who turned this on at 3 a.m.?" should have an answer in the flag tool's history.

## Discussion questions

1. Your flag service is down and a pod restarts with no cached rules. What should `isEnabled("new-checkout")` return, and how do you make sure every flag has a sensible answer?
2. Why does hashing `flagKey + userId` give better experiment isolation than hashing `userId` alone?
3. A flag has been at 100% for four months and nobody wants to remove it "in case we need to roll back". How would you argue for removal, and when is that fear actually justified?
4. Which failures would a canary deploy catch that a percentage flag rollout would miss, and the other way round?
5. How should a mobile app handle flags, given that old app versions stay in the wild for months and you can't remove code from them?
6. When should a permission toggle move out of the flag platform and into an entitlement or billing service?

## FAQ

### Isn't a feature flag just an `if` statement?

In code, yes. What makes it a flag is that the condition is controlled at runtime from outside the deploy, targeted per user or segment, audited, and reversible in seconds. A hard-coded `if (false)` gives you dark launching but none of the rest.

### Do flags slow down the application?

With local evaluation, hardly at all. A check is a hash and a few comparisons in memory, so it takes microseconds. The real cost is in maintenance and testing, not CPU. Remote evaluation (an HTTP call per check) is the setup that hurts latency, and you should avoid it on the server side.

### How do I test code behind flags?

Test the paths that will really run in production: the current default, and the state the flag is being ramped towards. Most SDKs offer an in-memory or test provider so unit tests can pin each flag's value. Don't try to test every combination. Keep the number of interacting flags small instead.

### Feature flag vs config value vs entitlement — what's the difference?

Config values tune *how* the system runs (timeouts, pool sizes) and rarely vary per user. Release and experiment flags control *whether* new behaviour is visible, and they are temporary. Entitlements control *what a customer has paid for*. They're permanent and tied to billing. The tooling can overlap, but each has a different lifecycle and a different owner.

### What is OpenFeature and why would I use it?

OpenFeature is a CNCF project that standardises the flag-evaluation API: `getBooleanValue`, evaluation context, hooks and providers. Your code calls the OpenFeature SDK, and a provider connects it to LaunchDarkly, Flagsmith, flagd or an in-house system. Switching vendors then means swapping the provider, not rewriting every flag check.

## Key takeaways

- Flags separate **deploy** from **release**, which enables trunk-based development, dark launches, targeted rollouts and instant kill switches.
- Evaluate flags **locally** from streamed rules. Bucket percentages with a **sticky hash** of flag key and user ID.
- Classify flags by lifespan: release and experiment flags are temporary, while ops and permission flags live much longer.
- Progressive delivery combines staged audiences with **automated metric guardrails**. Canaries test the binary; flags test the feature.
- A release flag is finished when its code is **deleted**. Give every flag an owner and an expiry, never reuse a name, and remember Knight Capital.

## References

- Pete Hodgson, ["Feature Toggles (aka Feature Flags)"](https://martinfowler.com/articles/feature-toggles.html), martinfowler.com
- [OpenFeature specification and documentation](https://openfeature.dev/docs/reference/intro), CNCF
- U.S. Securities and Exchange Commission, *In the Matter of Knight Capital Americas LLC*, Administrative Proceeding File No. 3-15570 (2013)
- [Unleash documentation: activation strategies and stickiness](https://docs.getunleash.io/)
- [Argo Rollouts documentation](https://argoproj.github.io/argo-rollouts/)
- Uber Engineering, "Piranha: Reducing Feature Flag Debt at Uber" (2020)
- Jez Humble and David Farley, *Continuous Delivery*, Addison-Wesley, 2010

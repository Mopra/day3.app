# Day3 Automations — design

Status: **design agreed, not implemented** (2026-08-03). Nothing here has shipped.

Decided: a **node canvas with branches**, not a linear list. Automations and
automation **runs are unlimited on every paid tier** — no per-tier metering —
protected by a documented fair-use rate ceiling and hard loop guards instead.

---

## 1. The model

An automation is a **directed graph of nodes** on a canvas, entered at one
trigger node. A single subscriber's progress through it is a **cursor sitting on
exactly one node** — one token, never split. Branch nodes route that token down
exactly one edge.

```
        ┌───────────────────────────────┐
        │ ▸ Trigger                     │
        │   joins "Product updates"     │
        └───────────────┬───────────────┘
                        │
                ┌───────▼───────┐
                │ ✉️  Welcome    │
                └───────┬───────┘
                        │
                ┌───────▼─────────────────────┐
                │ ⏳ Wait for: clicked Welcome │
                │    up to 3 days             │
                └──┬──────────────────────┬───┘
              matched                 timed out
                   │                      │
        ┌──────────▼─────────┐   ┌────────▼──────────┐
        │ ✉️  Next steps      │   │ ✉️  Still stuck?   │
        └──────────┬─────────┘   └────────┬──────────┘
                   │                      │
                   └──────────┬───────────┘
                     ┌────────▼────────┐
                     │ ⏱  Wait 4 days  │
                     └────────┬────────┘
                     ┌────────▼────────┐
                     │ ◆ plan is pro?  │
                     └──┬───────────┬──┘
                      yes           no
                       │            │
                  ┌────▼───┐   ┌────▼──────────┐
                  │ ■ End  │   │ ✉️  Upgrade    │
                  └────────┘   └───────────────┘
```

**One token, no parallel paths.** Every branching node routes to exactly one
outgoing edge, so there is no join/merge semantics to design, no "wait for all
inbound paths" state, and the enrollment cursor stays a single node id. Edges
converging on a node (as `Next steps` and `Still stuck?` do above) are free —
that's just two nodes pointing at the same next node, not a merge.

This is the one constraint that keeps a full canvas as cheap to *execute* as the
linear list would have been. Everything expressive lives in the node vocabulary.

### 1.1 Node vocabulary

| Node | Ports out | What it does |
|---|---|---|
| **Trigger** | `next` | Entry. Exactly one per automation. |
| **Send** | `next` | An email, authored in the existing campaign composer. |
| **Wait** | `next` | A duration, optionally clamped to a send window. |
| **Wait for event** | `matched`, `timeout` | Wait up to N days for a condition to become true — opened/clicked an earlier send, or matching a filter. Continues early the moment it's true. |
| **Branch** | `yes`, `no` | A `SegmentFilter` and/or engagement predicate. |
| **Split** | `a`, `b`, `c`… | Percentage split by deterministic hash of the subscriber id. This is A/B testing. |
| **Set field** | `next` | Write a value to `subscribers.attributes`. Lets the graph carry state. |
| **End** | — | Explicit terminal. Optional (a port with no edge ends too), but it reads better on a canvas. |

**Wait-for-event is the node that earns the canvas.** "Wait up to 3 days for them
to click, then branch" is the thing a linear list genuinely cannot express, and
it's what people actually want from onboarding flows. It's implemented as a wait
whose due time is the timeout and whose condition is re-checked on each tick —
cheap, because the tick is already visiting due enrollments.

**Set field** is what makes loops and state machines work without a graph
variable system: mark `onboarding_stage = 2`, branch on it later, and the
existing segment builder can already read it.

### 1.2 Loops are allowed, with two guards

A loop ("wait 30 days, re-check, nudge again") is a legitimate thing to draw and
devs will draw it. Rather than blocking cycles, we permit them under two
conditions:

1. **Every cycle must pass through a Wait node of ≥ 1 hour.** Validated at
   publish by finding cycles in the graph and checking each contains a
   sufficient wait. This makes a tight infinite loop unrepresentable.
2. **A per-enrollment visit cap (default 200 nodes) and per-enrollment send cap
   (default 50).** Exceeding either exits the enrollment with
   `exit_reason: 'loop_guard'` and notifies the account. This is the backstop
   that protects the *recipient*, independent of any rate limit.

The rate ceiling in §4 protects our infrastructure. These two guards protect the
person receiving the mail. Both are needed; they're not substitutes.

### 1.3 Conditions reuse `SegmentFilter` verbatim

Branch nodes, wait-for-event conditions, the entry condition, and the global exit
condition all take the **same** `SegmentFilter` from `lib/segment-filter.ts` —
same builder component, same Zod schema, same `segmentFilterCondition()` SQL.
Users already know it from the Segments tab; we write no new expression language,
no new validator, no new evaluator.

Plus a small set of **engagement predicates** over this automation's own earlier
send nodes: `opened <node>`, `didn't open <node>`, `clicked <node>`,
`clicked any`, `didn't click any`. These read `automation_sends.opened_at /
clicked_at` directly, so they cost nothing.

### 1.4 Global exit condition

Separate from any branch: **"stop the whole automation when they match X"**,
checked before every node execution. "Stop when `plan is pro`" is what prevents
a customer who just paid from receiving four more upgrade nudges. It's one filter
evaluation per tick and it should be prominent in the UI, not buried in a node.

---

## 2. Versions: the thing the canvas makes mandatory

With a linear list, editing a live automation was awkward. With a graph it's
unsafe: rewiring edges under a live enrollment can orphan the node someone is
sitting on, introduce a cycle mid-flight, or reroute them into a node they've
already been through.

**So published graphs are immutable, and enrollments pin a version.**

```
automation_versions
  id (aev_)   accountId   automationId   version (int)
  publishedAt?   publishedBy?
  status: draft | published | superseded
  unique (automationId, version)
```

- Editing the canvas mutates the **draft** version. The published version keeps
  running, untouched.
- **Publish** validates the draft (§2.1), runs risk review on every send node,
  snapshots it as version N+1, and points new enrollments at it.
- **Enrollments pin `versionId`** and run to completion on the version they
  entered on. Someone three nodes into v3 finishes v3.
- Node ids are **preserved across edits**, so an optional, explicit
  "move in-flight people to the new version" action can map most cursors cleanly
  — with a clear warning and a count of how many can't be mapped (their node was
  deleted) and will be exited.

This costs one table and a copy-on-publish, and it deletes an entire category of
"my automation broke and I don't know why". It also gives an honest changelog:
*"v4, published Aug 3 — 1,204 people still running v3."*

### 2.1 Publish-time validation

Drafts are allowed to be broken mid-edit; publish is the gate.

**Blocks publish:** no trigger node; trigger unreachable; a cycle with no
qualifying wait (§1.2); a send node with no subject or empty body; a send node
whose risk review returns `high`; a `Split` whose percentages don't total 100;
no verified sending domain; no company mailing address (same gate function
campaigns use).

**Warns only:** unreachable nodes (people draw scratch nodes off to the side);
ports with no outgoing edge (they just end); a branch where both edges go to the
same node.

---

## 3. Data model

Follows `src/db/schema.ts` conventions — prefixed text ids, `tstz`, `accountId`
on every row.

```ts
automations
  id (aut_)  accountId  audienceId  name
  status: draft | active | paused | archived
  triggerKind: audience_join | segment_join | topic_join | api
  triggerSegmentId?  triggerTopicId?  triggerFormId?
  entryFilterJson?   exitFilterJson?
  reentry: once | once_at_a_time | always            // default: once
  senderId  sendingDomainId  fromName  fromEmail  replyTo   // snapshot, as campaigns do
  themeJson  footerText  topicId?
  liveVersionId?  draftVersionId?
  createdAt  updatedAt

automation_nodes
  id (and_)  accountId  automationVersionId
  kind: trigger | send | wait | wait_for | branch | split | set_field | end
  configJson                        // per-kind config (validated by a discriminated Zod union)
  canvasX  canvasY                  // presentation only — never read by the engine
  label?                            // user-facing name, used in engagement predicates
  riskLevel?  riskSummary?  riskGuidanceJson?
  createdAt  updatedAt

automation_edges
  id (aee_)  accountId  automationVersionId
  fromNodeId  fromPort   toNodeId
  unique (fromNodeId, fromPort)     // a port has exactly one destination
```

Send-node content (subject, previewText, sectionsJson, htmlBody, textBody) lives
in `configJson` and is authored by the real composer, so `lib/sections.ts`,
`lib/theme.ts`, and `services/render.ts` are reused unchanged.

**Why normalized nodes/edges rather than one `graphJson` blob:**
`automation_sends` needs a stable FK to a node for per-node stats and for
engagement predicates. A blob makes node identity mushy and stats un-joinable.
Canvas coordinates live on the node row precisely because they are the *only*
part of the graph the engine never reads.

### 3.1 Enrollments and sends

```ts
automation_enrollments
  id (aen_)  accountId  automationId  automationVersionId  subscriberId
  status: active | waiting | completed | exited | failed
  currentNodeId?   nextRunAt?        // the entire scheduler, in one indexed column
  waitingForJson?                    // wait_for node: condition + hard deadline
  visitCount  sendCount              // loop guards (§1.2)
  enteredAt  completedAt?  exitedAt?  exitReason?
  index (status, nextRunAt) WHERE status IN ('active','waiting')   -- the hot path
  unique (automationId, subscriberId) WHERE reentry = 'once'

automation_sends
  id (asn_)  accountId  automationId  automationNodeId  enrollmentId  subscriberId  email
  status: pending | sending | sent | delivered | bounced | complained
        | unsubscribed | failed | skipped      -- same vocabulary as campaign_recipients
  skipReason?  lockedAt?  sentAt?  deliveredAt?  openedAt?  clickedAt?  …
  provider  providerMessageId?  error?
  unique (enrollmentId, automationNodeId)      -- THE duplicate-safety anchor
```

`automation_sends` is deliberately a near-clone of `campaign_recipients`, for the
same reason that table exists: it is the row whose status makes retries
duplicate-free (`AGENTS.md` hard rule 1). A send is claimed by flipping its row
to `sending` in one atomic statement before the provider call; a retried job only
re-claims rows still `pending`. Same proven pattern, nothing new invented.

The `unique (enrollmentId, automationNodeId)` constraint has one consequence
worth naming: **a loop cannot re-send the same node to the same enrollment.** For
a genuine recurring nudge, that's wrong — so looping send nodes carry an
`allowResend: true` flag, and those rows key on
`(enrollmentId, automationNodeId, visitCount)` instead. Default off, because
accidentally mailing someone the same thing twice is the more common bug.

### 3.2 Re-entry: `once` by default, with an index behind it

The classic automation disaster is a subscriber getting the welcome series four
times because a CSV re-import touched their row. `reentry: once` + a unique
partial index makes that structurally impossible rather than merely unlikely.

`once` (default) · `once_at_a_time` (re-enter after completing) · `always` (for
API events like "trial ending", which legitimately recur).

---

## 4. Unlimited runs, with a published ceiling

**Decision: no per-tier limit on automations, nodes, enrollments, or node
executions.** Every paid tier gets all of it. The only metered resource stays
what it has always been: **emails per month**.

### 4.1 Why this is the right call, and how to say it

Every competitor meters the wrong thing. Klaviyo, ActiveCampaign, HubSpot, and
Customer.io all bill on *contacts* or *profiles*, so growing your list raises your
bill whether or not you mail anyone — and automations are gated behind higher
tiers or capped by "active flows". Day3 already refuses the contact tax
(`PRODUCT.md §2`). Refusing the automation tax is the same argument applied once
more, and it's a genuinely sharp line:

> **Unlimited automations. Unlimited runs. You pay for emails, not for
> orchestration.**

It's also cheap to honour, because the expensive part *is* the email, and the
email is already metered. A branch evaluation costs us a few indexed queries. A
wait costs one `UPDATE`. Charging for those would be charging for nothing.

Automation emails draw on the plan's existing monthly allowance through the same
`reserveQuota()` — automations must never be a quota bypass. That's what makes
"unlimited runs" safe to promise: the thing that actually costs money is already
bounded by the plan the customer bought.

### 4.2 The safeguard: a fair-use rate ceiling, per org

The risk of "unlimited" is not cost, it's **one org's runaway graph degrading
everyone else's sending**. So the ceiling is a *rate*, not a *quota* — and it
never destroys work.

Recommended values, all as `envInt` knobs (matching `SEND_LANES` /
`SEND_BATCH_SIZE` convention) so ops can retune without a deploy:

| Limit | Recommended | Reasoning |
|---|---|---|
| **Node executions / min / org** | **10,000** (burst 20,000) | 600k/hour. No legitimate use gets near it: sending is the bottleneck long before this, and non-send nodes are microseconds of DB work. Tight enough that a runaway graph is a rounding error on the worker. |
| **Enrollments / min / org** | **50,000** | Shaped by the real burst case: a 50k-row CSV import all entering a welcome automation at once. Should absorb it in one minute, not throttle a legitimate migration. |
| **Sends / min / org** | *not separately capped* | Already bounded three ways: the monthly plan allowance, the platform's approved SES rate, and the `SEND_LANES` fan-out. A fourth cap would only add a confusing failure mode. |

**On hitting the ceiling, defer — never drop.** Push `next_run_at` forward ~1
minute and log it. An enrollment is never lost, never skipped, never failed
because of a rate limit. The user sees "catching up" rather than damage.

Metered in Redis via the existing `lib/rate-limit.ts`, fails **open** — a Redis
blip must not stop everyone's automations. The loop guards in §1.2 are the
correctness-critical protection; this ceiling is only load protection, so failing
open is the right tradeoff.

**Sustained ceiling contact is a bug signal, not a growth signal.** An org
pinned at the ceiling for 15 continuous minutes gets a notification ("an
automation is running much faster than expected — this usually means a loop")
plus an ops alert. In practice this fires on a misconfigured cycle, never on real
usage.

### 4.3 Publish the number

The ceiling goes in `PRODUCT.md` as a stated fair-use figure, not a hidden
throttle. "Unlimited, with a documented 10,000 runs/minute fair-use ceiling" is a
confident claim. "Unlimited*" with an asterisk nobody can find is the thing that
erodes trust — and since the ceiling is ~100× above real usage, saying it out
loud costs nothing.

### 4.4 Sanity ceilings (not tier limits)

Structural caps that exist so the UI and validator stay honest, applied equally
to every paid tier — comparable to the existing 25-segments / 20-topics caps:

- **100 nodes per automation** — beyond that a canvas is unreadable and the
  publish validator's cycle analysis stops being instant.
- **50 automations per account.**

Both are generous enough that hitting one means something has gone wrong, and
neither is a plan differentiator. The free tier keeps the existing rule: build
and draft freely, **cannot publish** (`planCanSend`).

---

## 5. Execution engine

### 5.1 Waits live in Postgres, not Redis

**Do not implement waits as BullMQ delayed jobs.** It looks natural and is wrong
twice over: it violates "Postgres is the source of truth" (`AGENTS.md` hard rule
2) — a Redis flush would silently drop every in-flight enrollment with no way to
reconstruct it — and a 5-day wait for 50,000 subscribers is 50,000 durable Redis
keys per node.

A wait is one column: `enrollments.next_run_at`, with a partial index on
`(status, next_run_at)`. Postgres holds the state; Redis only carries ID-only
"go do work now" messages, exactly as today.

### 5.2 A 60-second dispatcher tick

The existing sweep runs every 15 minutes (`worker/index.ts`, `SWEEP_SCHEDULER`).
A welcome email arriving up to 15 minutes after signup reads as broken, so
automations get their own repeatable job:

```
automation_tick — every 60s, upserted alongside the existing cron-15min scheduler
```

The tick is a **dispatcher only — it must never send.** It claims due
enrollments, advances the cheap node kinds inline (wait, branch, split,
set_field, wait_for re-check), and enqueues `automation_send_batch` jobs for send
nodes. Keeping it sub-second means it can never overrun its own cadence.

Enrollment also **enqueues immediately**, so a zero-wait welcome email goes out
in seconds. The tick is the durable backstop, not the latency path.

```
              ┌─ enrollment (form signup / confirm / import / API / segment write)
              │      └── immediate enqueue ──┐
automation_tick ─┴─ claim due enrollments ───┴─► advance node
   (60s)          FOR UPDATE SKIP LOCKED         ├─ wait/branch/split/set_field → inline
                  round-robin by account         └─ send → automation_send_batch ─► SES
```

### 5.3 Claiming, and fairness

The claim uses the pattern already proven in `send-batch.ts`:

```sql
UPDATE automation_enrollments SET … WHERE id IN (
  SELECT id FROM automation_enrollments
  WHERE status IN ('active','waiting') AND next_run_at <= now()
  LIMIT :n FOR UPDATE SKIP LOCKED
)
```

**But not with a plain global `ORDER BY next_run_at`** — that's the trap that
unlimited runs walks into. One org importing 50,000 contacts would occupy every
tick and starve every other tenant's welcome emails behind it. The dispatcher
claims **round-robin by account** with a per-account-per-tick cap (~2,000), then
moves to the next account. Fairness is a property of the dispatcher, not of the
rate ceiling — the ceiling bounds a single org's total, round-robin makes sure a
single org can't front-load the queue.

Stuck `sending` rows are swept to `failed` — **never back to `pending`** — by the
existing 15-minute sweep, mirroring the campaign rule exactly (re-sending could
duplicate).

### 5.4 Advancing one enrollment

One node per tick, so each transition is a small committed unit:

1. Load enrollment → pinned version → current node (+ its outgoing edges).
2. **Exit checks, in order:** subscriber no longer `subscribed`; now suppressed;
   global exit filter matches; visit/send cap exceeded (`loop_guard`). Any hit →
   `exited` with a reason. The unsubscribe check here is what guarantees an
   opt-out drops someone instantly.
3. `visitCount++`, then dispatch on node kind:
   - **wait** → compute `next_run_at`, clamp into the send window, commit.
   - **wait_for** → re-evaluate the condition. True → follow `matched`. Past
     deadline → follow `timeout`. Neither → re-arm `next_run_at`, commit.
   - **branch** → evaluate filter, follow `yes`/`no`.
   - **split** → `hash(subscriberId + nodeId) % 100` → bucket. Deterministic, so
     a retry lands the same person in the same arm.
   - **set_field** → write the attribute, follow `next`.
   - **send** → insert `automation_sends` as `pending`, hand to the batch sender;
     the batch advances the cursor on completion.
   - **end**, or a port with no edge → `completed`.

Cheap kinds chain inline within one tick (up to a small bound) so a
branch-into-branch-into-send resolves in one pass rather than three minutes.

### 5.5 Sending reuses the campaign send path

`automation_send_batch` is a thin variant of `sendCampaignBatch`. Body, theme,
and trackable-link extraction are prepared **once per node** (identical for every
recipient); only the per-recipient signed tokens differ — exactly today's
structure.

The one real refactor: `signUnsubscribeToken` / `signOpenToken` /
`signClickToken` currently take `{campaignId, campaignRecipientId}`. Generalize
to a discriminated `SendTarget` — `{kind:"campaign", …} | {kind:"automation", …}`
— so unsubscribe, open tracking, and click tracking all work unchanged. This is
the main non-trivial plumbing and it's contained to three functions plus their
verify side.

### 5.6 Quota exhaustion holds, it does not skip

When the monthly allowance is exhausted, the enrollment **holds**: push
`next_run_at` forward ~1h, surface "held: monthly limit reached". Do **not** skip
the node — a late welcome email is recoverable, a silently-dropped one is not.

But an unbounded hold is its own bug: an account that upgrades three weeks later
would blast a month of stale onboarding at everyone at once. So a node held past
a **staleness cutoff (7 days)** is marked `skipped` with reason `too_stale` and
the enrollment moves on. Both halves matter; most tools ship one and not the
other.

Same treatment for `subscriptionStatus !== 'active'`, `!sendingEnabled`, and
risk-paused accounts — hold, surface, don't destroy state.

---

## 6. Triggers

**Design rule: no trigger without an existing code path that already writes the
row.**

| Trigger | Fires when | Hook point (already exists) |
|---|---|---|
| **Someone joins an audience** | becomes `subscribed` in audience X | `submitFormSignup`, `services/form-confirm.ts`, manual add, `process-import.ts`, `POST /v1/audiences/:id/contacts` |
| **Someone joins a segment** | their data changes so they now match S | any subscriber write |
| **Someone joins a topic** | opt-in topic subscribe | `services/topic-subscription.ts` |
| **You enroll them** | `POST /v1/automations/:id/enroll` | new v1 endpoint |

Optional narrowing on the audience trigger: *"only signups from form `Pricing
page`"* (`subscribers.formId` is already stored).

### 6.1 The API-enroll trigger is the sleeper feature

A SaaS team's real lifecycle events — trial started, trial ending in 3 days,
feature never used — live in *their* database. We will never model those and
shouldn't try. One endpoint lets them fire an automation from their own backend:

```bash
curl -X POST https://day3.app/api/v1/automations/aut_x7k/enroll \
  -H "Authorization: Bearer $DAY3_API_KEY" \
  -d '{"email":"jane@acme.com","attributes":{"trial_ends":"2026-09-01"}}'
```

Near-zero build cost — it reuses the enrollment path everything else uses — and
combined with unlimited runs it makes Day3 genuinely useful to the developer
audience `PRODUCT.md §6.14` already targets. Phase 1.

### 6.2 Segment triggers without a membership snapshot

Segments are live SQL, never materialized, so "joined a segment" has no event to
hang off, and re-scanning an audience every tick can't distinguish "matches now"
from "newly matches".

The driver of a segment join is always a **subscriber write**, and we control
every one. So subscriber insert/update enqueues a cheap
`evaluate_automation_triggers { subscriberId }` job: evaluate the segment SQL for
that one subscriber against automations referencing it, enroll if matching. Cost
is O(writes), not O(subscribers), and `reentry: once` makes re-evaluation
harmless. A nightly bounded reconcile scan covers anything derived (a date
comparison crossing midnight).

---

## 7. Interaction with what exists

**Plans.** Free builds and drafts, cannot publish (`planCanSend`) — identical to
campaigns. Every paid tier gets unlimited automations and runs. No new SKU, no
pricing-table change.

**Compliance.** Automation emails are campaign emails in every respect that
matters: canonical footer, mailing address, one-click unsubscribe,
`List-Unsubscribe` headers, suppression re-checked at send time. All of it falls
out of reusing `renderCampaignEmail`. Topics apply too. Publishing requires a
verified domain and a company address — the same gate function.

**Risk review** runs **per send node at publish**, not per recipient (content is
fixed, sends are open-ended). A `high` verdict blocks publish with the same
fix-it guidance the campaign page shows. Without this, automations become the
obvious way to route around review entirely.

**Metrics and Activity, nearly for free.** Add three nullable columns to
`email_events` — `automationId`, `automationNodeId`, `automationSendId`. The
Activity page (`§6.11`) then troubleshoots automation mail with a filter change,
and Metrics picks up automation rates the same way. Highest-leverage 20 lines in
the feature.

**Rejected alternative: automations as hidden campaigns.** Model each send node
as a `campaigns` row and write `campaign_recipients` directly — metrics,
Activity, unsubscribe, and tracking would need no changes at all. Rejected
because the campaign lifecycle genuinely doesn't fit: a campaign is a one-shot
`draft → sending → sent`, while a send node runs forever, so `campaigns` fills
with permanently-`sending` phantom rows that break the campaigns list, the
reconcile sweep, and the completion notification. The `SendTarget` refactor buys
the same reuse without corrupting the campaign model.

---

## 8. The canvas UX

**Library: `@xyflow/react`** (React Flow) — MIT, React 19 compatible, the de
facto standard, and it gives pan/zoom, snapping, minimap, and edge routing for
free. Client component inside the App Router page; the graph loads as
nodes + edges from two queries and saves as a diff.

What we build on top of it is where the quality lives:

**Auto-layout on first render, manual thereafter.** Nobody should have to
arrange a template by hand. Templates ship with coordinates; a "Tidy up" button
re-runs top-down layout on demand. Coordinates persist per node, never read by
the engine.

**The node inspector is a side panel, not a modal.** Click a node → panel opens
on the right with that node's config; the canvas stays visible so you keep your
place in the flow. Send nodes open the full composer as an overlay (it needs the
width).

**Read the graph as prose.** A "Summary" toggle renders the published graph as an
indented outline — the same information as §1's diagram in text. It's how you
review a flow you didn't build, how support reasons about a customer's setup, and
how the AI assistant can describe or generate one.

**Templates do the heavy lifting.** Four starters, one click, prefilled nodes
**with draft copy already written** and laid out: *Welcome email* (one node — the
80% case), *Welcome series*, *Trial onboarding* (with a `plan is pro` exit), *Win
back inactive subscribers* (branching on engagement). This is seed data, not
engineering, and a blank canvas is exactly where a non-technical founder quits.

**Show what will happen before it happens.** Three cheap things, each removing a
distinct fear: a **live qualification count** while building ("412 people match
right now", reusing the segment editor's pattern); a **timeline preview** for a
sample subscriber with real dates and the send window applied; **"send me this
node"** per send node, reusing the existing test-email path.

**Live state on the canvas.** Once published, each node badges how many people
are sitting on it right now and how many have passed through — so the canvas
doubles as the report. Per-node stats: sent, opened, clicked, unsubscribed, and
skips **broken out by reason**, since "why didn't this send?" is the number-one
support question every automation product has ever had.

**Publishing is explicit and honest.** A diff-style summary before publish
("2 nodes added, 1 email edited, 1 edge rewired"), plus how many people are
mid-flight on the current version and what happens to them (§2). Draft edits
never affect anyone until you press it.

---

## 9. Phasing

**Phase 1 — the whole canvas, a smaller node set.** Trigger / send / wait /
branch / end nodes. Audience-join + API-enroll triggers. Entry and exit
conditions plus engagement predicates. Versions and publish validation. Tick
engine with quota holds, round-robin fairness, and the rate ceiling. Loop guards.
Once-only re-entry. Send windows. Four templates. Per-node live stats.
`SendTarget` refactor. Per-node risk review at publish.

**Phase 2 — the nodes that need more machinery.** Wait-for-event. Split (A/B)
with per-arm reporting. Set field. Segment-join and topic-join triggers (needs
the write-hook evaluator, §6.2). Date-field triggers. Automation endpoints in the
v1 API beyond `/enroll`. AI: "describe the flow you want" → generated graph.

**Later, deliberately.** HTTP-request node (real value for devs, but it's an SSRF
surface plus its own retry/timeout/secret-storage story — it deserves its own
design, not a bullet here).

---

## 10. Doc changes required

Per `AGENTS.md`, `PRODUCT.md` is the source of truth and must be updated in the
same PR as the implementation. Two of these are scope-rule removals that stand on
their own and are being made now:

**Being done now (the MVP-era scope fences, no longer wanted):**

1. `PRODUCT.md §2` — drop the "Deliberately excluded: marketing automation flows,
   A/B testing, drag-and-drop template builders" fence and the "refuses to become
   a marketing suite" framing.
2. `AGENTS.md` hard rule 5 — "No features outside the MVP scope" goes. The
   plan-gating facts it also carried (free tier can't send, 500-subscriber cap,
   where the gating lives) are true and stay, restated as their own rule.

**With the implementation:**

3. `PRODUCT.md §5` — new domain concepts: Automation, Version, Node, Edge,
   Enrollment, Automation send.
4. New `PRODUCT.md §6.x Automations` — canvas, node types, triggers, conditions,
   versioning, **and the unlimited-runs promise with its published fair-use
   ceiling (§4.3)**.
5. `PRODUCT.md §4` — automation emails draw on the same monthly allowance; free
   builds but can't publish; **no automation metering on any paid tier**. No
   table change.
6. `PRODUCT.md §7.1` — the tick engine alongside the send pipeline.
7. `PRODUCT.md §9` — add "set up a welcome email" as a key flow.
8. `AGENTS.md` Gotchas — three non-obvious engine rules: waits live in Postgres
   (never Redis delayed jobs); quota exhaustion holds rather than skips, bounded
   by a staleness cutoff; the dispatcher claims round-robin by account, because a
   global `ORDER BY next_run_at` lets one org starve every other tenant.
9. Bump *Last verified*.

---

## 11. Open questions

1. **Rate ceiling numbers.** 10,000 node-executions/min and 50,000
   enrollments/min per org are reasoned in §4.2 but not measured. Worth loading
   once against a real Supabase instance before publishing them, since §4.3
   commits to the figure in writing.
2. **Multiple trigger nodes per automation?** One keeps validation and the
   mental model simple. But "joins the audience *or* I enroll them via API" is a
   real want, and it's currently two automations with duplicated graphs.
3. **Should an automation target a segment directly** rather than an audience
   plus an entry filter? The filter covers it with one fewer concept, but "send
   this series to my Pro users" is how people say it out loud.
4. **Tick cadence.** 60s proposed. 30s makes "immediate" feel instant even
   without the enqueue-on-enroll shortcut, at double a trivial idle cost.

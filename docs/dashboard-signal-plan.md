# Plan B: the dashboard once you are sending

**Status:** proposed, not started. Agreed 2026-09-18.
**Companion:** `docs/dashboard-day-zero-plan.md` (Plan A), the first-run
experience. Both plans edit `app/(app)/dashboard/dashboard-view.tsx`, so land
Plan A's branch (A5) first and build these surfaces inside the "has sent" arm.

## The problem

The dashboard today shows plan, monthly quota, sending status, and the five most
recent campaigns. Three of those four describe the *account*. None describes the
*audience*, and none describes what the product just did on the user's behalf.

It is an honest admin panel. It is not a reason to open the app.

Everything below already exists in the database. This plan is almost entirely
about reading it and putting it where the user lands.

## Foundation

### B0. One dashboard read module

Add `src/services/dashboard.ts` exporting a single `loadDashboard(db, account)`
that runs every read concurrently and returns one typed object. The page stays a
small server component handing props to the view (AGENTS.md, page data loading).

Two constraints to respect while adding reads:

- The web tier runs `max: 1`, so concurrent reads pipeline onto one connection.
  Concurrency is still worth it (one network wait, not six) but every query here
  is paying real database CPU on each dashboard load. Index anything that scans.
- Functions are pinned to `fra1` to sit beside the pooler. Do not add a read that
  only performs acceptably from a colocated box.

## Workstreams

### B1. Live send progress

The single most exciting thing the app does, and it is currently invisible unless
you navigate to the campaign.

`app/(app)/campaigns/[id]/page.tsx` already has `SendingBanner`, the
`LaunchStream` animation, a 2.5s poll while status is in
`pending_review | approved | generating_recipients | sending`, and a `SentBanner`
celebration on completion. Reuse all of it.

- Server read: any campaign for this account in one of those four statuses, plus
  its recipient counts. Usually zero rows, so this is cheap.
- When present, the dashboard renders the live card at the top and polls a new
  `GET /api/dashboard/live` at the same 2.5s cadence until the campaign is
  terminal, then flips to the scorecard (B2) in place.
- **Stop polling when the tab is hidden** (`document.visibilityState`). A
  dashboard left open in a background tab must not be 24 requests a minute per
  user forever. The campaign detail page should get the same guard.

### B2. Last campaign scorecard

Opens, clicks, bounces for the most recent sent campaign, with one plain sentence
underneath.

- `accountCampaignMetrics` aggregates *every* campaign, which is more work than
  this needs. Add `lastSentCampaignScorecard(db, accountId)` to
  `src/services/metrics.ts` reusing `RECIPIENT_COUNT_FIELDS` against one campaign.
- The sentence compares this campaign's open rate to the account's own trailing
  average over its sent campaigns: "above your average", "in line", "below".
  **Compare only against the account's own history.** Do not invent industry
  benchmarks the product cannot stand behind.
- **Exclude sandbox campaigns from the average.** `campaigns.sandbox` is on the
  row already. A five-person team send must not set the bar for real sends, and a
  sandbox campaign's own card should say what it is.
- Language: "opened", never "read". Pixel-based opens are inflated by Apple Mail
  Privacy Protection. Keep the wording consistent with the metrics page.

### B3. What happens next

The dashboard is entirely rear-view today. Add a "next 7 days" card:

- scheduled campaigns (`campaigns.scheduled_at` in window, status scheduled),
- live automations and how many enrollments are due
  (`automation_enrollments.next_run_at` in window, which already has a partial
  index behind it),

rendered chronologically as one list. Account-scoped, like everything else.

Hide the card when the window is empty rather than showing an empty state. A
dashboard that says "nothing scheduled" every day trains the user to skip it.

### B4. Audience growth

For a newsletter owner this is *the* number, and there is currently not one
audience figure anywhere on the dashboard.

- Query: subscribers grouped by day over 30 days, scoped by `account_id`,
  counting `created_at` as joins and `unsubscribed_at` as leaves.
- **New index required:** `(account_id, created_at)` on `subscribers`. The
  existing indexes are `(account_id, audience_id)` and `(audience_id, status)`,
  neither of which serves an account-wide 30-day range scan. Schema change, so
  generate and migrate.
- Render a net number, the delta, and a small inline sparkline.
- **Load the `dataviz` skill before writing any chart code**, including the
  sparkline. It sets the palette, the mark specs, and the light/dark rules the
  rest of the app's charts follow.

### B5. What the automations did while you were away

Makes the flows the user built feel alive, and it is one query on the shared
ledger.

- `campaign_recipients` where `automation_id is not null` and `sent_at` within 7
  days, scoped by account. Per AGENTS.md this is an explicit choice: this query
  wants automation rows only, unlike `enforceAccountHealth`, which is deliberately
  unfiltered because reputation is account-wide. Say so in a comment at the query.
- One line: "Your 3 automations sent 412 emails this week." Links to
  `/automations`.
- Hide it entirely when the account has no live automations, so it never reads as
  an empty boast.

### B6. Sending confidence, not a binary light

The status tile is Enabled or Disabled, which a user cannot act on. Replace it
with a short readiness list, each row linking to its own fix:

- a verified sending domain,
- DMARC and Return-Path present (`domain-setup-guide.tsx` already generates and
  checks both, so this is a read, not new DNS work),
- a configured sender,
- reputation inside the warning line.

**The reputation row renders `computeAccountHealth`'s status verbatim.** Never
re-derive bounce or complaint thresholds here. There is exactly one place that
decides what "healthy" means (`src/services/health.ts`), and a second opinion on
the dashboard is a bug waiting to contradict the emails that service sends.

### B7. Top links (needs a fix first)

Click destinations *are* stored, in `email_events.payload_json` as `{"url": ...}`.
But `recordClick` inserts the event inside a CTE guarded on
`clicked_at IS NULL`, so **only the first click per recipient is ever recorded**.
A recipient who clicks two different links produces one row. Top-links built on
today's data would be quietly wrong.

The fix: keep the `clicked_at` guard (the recipient stamp must not inflate) but
insert the click event per distinct `(recipient, url)` instead of only on the
first click. Then build the card.

Query gotcha when you get there: `payload_json` is text and holds other event
shapes, so a `::jsonb` cast throws unless the query filters
`event_type = 'click'` first. This is the same trap documented in AGENTS.md for
the transactional bounce query.

Defer this one unless links matter to you now. It is the only item here that
needs a correctness fix before it can ship.

### B8. Command palette

Cmd+K over campaigns, audiences, automations, domains, settings, plus the common
actions (new campaign, import CSV, add your team). Client-side over the existing
list endpoints. Pure delight, no backend work, genuinely changes how the app
feels to a daily user.

## Sequencing

1. B0, then B1. Highest payoff, no schema change, reuses components that exist.
2. B2, then B6. Both are reads over existing data and both make the page feel
   like it knows something.
3. B4 (carries an index migration) and B3.
4. B5, B8.
5. B7 last, behind its `recordClick` fix.

## Layout note

Do not simply append six cards. The page has a hierarchy: what is happening right
now (B1), what just happened (B2), what happens next (B3), how things are trending
(B4, B5), and whether anything needs attention (B6). Build it in that order down
the page, and keep the existing `Reveal` sequence so the thing that says where you
are still paints first.

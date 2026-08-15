# Day3 — agent notes

Newsletter SaaS for small SaaS teams. A Next.js 16 (App Router) web app on Vercel
serves the UI and the API routes; a separate long-running Node worker
(`worker/index.ts`) drains the BullMQ queue and runs the cron sweeps.

> **`PRODUCT.md` is the product source of truth** (what Day3 is, features, pricing,
> flows). **After any change that affects what the product is or does — features,
> pricing/limits, integrations, core flows, or the domain model — update `PRODUCT.md`
> in the same PR** and bump its "Last verified" date. Skip purely internal
> refactors/bug-fixes that don't change product behavior.

## Stack

- Next.js 16 (App Router) on Vercel — serves the React 19 SPA-style UI and the API route handlers
- Postgres (Supabase) + Drizzle ORM (postgres.js driver), Zod
- BullMQ + Redis worker (`worker/index.ts`) — drains the send queue and runs the
  cron sweeps; replaces the old Cloudflare Queue consumer + `scheduled` handler.
  Run with `npm run worker` (tsx) under pm2/systemd/Docker.
- AWS SES (`@aws-sdk/client-sesv2`) for email delivery and identity/domain setup
- Supabase Storage for uploaded assets
- React 19: Tailwind 4, shadcn/ui (Base UI), react-hook-form
- Clerk: auth, Organizations (tenant boundary), Billing (bandwidth plans:
  `free_org` → `1m_plan`; the plan key is the Clerk slug — see `src/lib/plans-catalog.ts`)
- Vitest with pglite (Postgres-in-WASM) — a fresh in-memory database per test,
  migrations applied from `migrations/`

## Hard rules (from the product spec)

1. **Queue jobs must be idempotent** — a retried message must never duplicate an
   email send. `campaign_recipients.status` is the source of truth; sends are
   claimed via an atomic `UPDATE … WHERE id IN (SELECT … LIMIT n)`.
2. **Postgres is the source of truth.** Queue messages carry IDs only, never content.
3. **Every query is scoped by `account_id`** (resolved server-side from the
   Clerk org — never trust client-provided account ids). Admin routes are the
   only exception.
4. **Email goes through the `EmailProvider` interface** (`src/email/`).
   `EMAIL_PROVIDER=mock` logs instead of sending; `ses` uses AWS SES (sesv2).
5. **Pricing is bandwidth-based — you meter emails, never contacts.** The free
   tier (`free_org`) can configure everything, draft, and **send in sandbox mode**
   — 100 emails/month to the org's own members only — and is capped at 500
   subscribers. Paid tiers (`1k_plan` → `1m_plan`) unlock sending to anyone and
   **all include the AI assistant** — 1k/5k on a smaller credit allowance, 10k+ on
   the full one. Gating lives in `src/lib/plans-catalog.ts` (`planCanSend` /
   `planSandboxMode` / `planHasAI` / `aiAllowanceForPlan` / `maxSubscribersForPlan`),
   `src/services/sandbox.ts` (the roster restriction) and
   `src/services/subscriber-limit.ts`. See `PRODUCT.md §4`.
   When adding a feature, gate it on the plan's *send* allowance where it sends
   mail, and leave it unmetered where it doesn't — don't invent a second meter.
   **Every real send belongs on the one ledger**: sandbox surfaces reserve against
   `monthly_email_sent_count` via `reserveQuota`'s `limitOverride`, never a
   separate counter. Note `planSandboxMode` is deliberately NOT `!planCanSend` —
   an unrecognized plan string must fail closed rather than earn a sandbox.

5. **There are two front doors to every campaign action, and they must not
   diverge.** The app's session routes and the public v1 API (which the MCP
   server drives) both go through `src/services/campaign-send.ts` for
   test/submit/schedule and `src/api/v1/campaigns.ts` for create/update. Add a
   gate in the service, never in a route handler — "which checks ran before this
   email went out" may not have two answers.
6. **Sending over the API needs the `campaigns:send` scope**
   (`src/api/v1/scopes.ts`). Everything else a key can do is the base grant.
   When you add a public endpoint, ask whether it puts mail in a stranger's
   inbox: if so it is scoped, if not it isn't. Test sends deliberately are not.

## Page data loading

**A page reads its data on the server, not in a mount effect.** Each page under
`app/(app)/` is a small server component that resolves the account, runs its reads
concurrently, and hands the result to a `*-view.tsx` client component as props:

```tsx
export default async function CampaignsPage() {
  const { db, account } = await requireAccount();
  const [campaigns, onboarding] = await Promise.all([
    listCampaigns(db, account.id),
    computeOnboardingState(db, account),
  ]);
  return <CampaignsView initialCampaigns={campaigns} onboarding={onboarding} />;
}
```

Why: a client component that fetches on mount cannot start until the RSC navigation
has already finished — two serial round trips before anything the user came for
appears, on a DB that is a network hop away. Reading on the server collapses that to
one, and `requireAccount` is memoized with React `cache()`, so the layout and the
page share a single account lookup instead of one per caller.

- The view keeps its rows in `useState` seeded from the prop, with a
  `useEffect(() => setRows(initial), [initial])` resync. Mutations update locally and
  then call `router.refresh()` to re-run the server component.
- **List queries live in `src/api/lists.ts`** and are called by BOTH the server page
  and the `/api/*` route handler the view re-reads after a mutation — same rule as
  the campaign send path: one implementation, two front doors.
- Timestamps are `mode: "string"` (`tstz` in `schema.ts`), so rows are plain
  JSON-serializable values and cross the server/client boundary as-is. Do not
  introduce a `Date`-mode column without converting at the boundary.
- `app/(app)/loading.tsx` is what the router shows during the server read. Without
  it, a navigation leaves the *previous* page on screen and reads as a dead click.
- Still on client fetch, deliberately: the server-paginated views (suppressions,
  activity, emails) and the `[id]` detail pages, which own a `load(offset)` machine
  that server-rendering page 1 would duplicate.

## Gotchas

- **Function region is pinned to `fra1` (`vercel.json`)** to sit next to the Supabase
  pooler in `aws-1-eu-central-1`. Unpinned, Vercel defaults to `iad1`, which puts the
  Atlantic between the web tier and Postgres — ~90–100 ms on *every* query, and with
  the web tier's `max: 1` pool those waits serialize rather than overlap. If the DB
  ever moves, move this with it.
- Postgres allows max **65535 bound parameters per statement** — chunk multi-row
  inserts when the row count is large.
- Clerk: the React SDK is `@clerk/nextjs`; `@clerk/backend` is used server-side.
  Billing APIs are beta — pin versions.
- Recipients stuck in `sending` (crashed batch) are swept to `failed` by cron,
  never back to `pending` — resending could duplicate. The sweep also releases
  the swept rows' quota reservation, auto-resumes campaigns paused by machine
  codes (`rate_limit` / `daily_limit` / `quota` — see `campaigns.paused_code`;
  user pauses never auto-resume), and re-enqueues the driving job for campaigns
  stranded in `pending_review` / `approved` / `generating_recipients`.
- **Outbound mail is paced, and the pacer is the only thing that knows the rate.**
  SES enforces a max send *rate* (emails/second) separately from the 24-hour quota,
  and nothing else in the send path bounds it — the lanes send as fast as the
  socket allows. So every send goes through `withSendPacing`
  (`src/email/send-rate.ts`), a Redis-held GCRA limiter wrapped around the
  `EmailProvider` in `worker/index.ts`. Wrapped at the *provider*, not in the send
  loop, so campaign batches, transactional sends, and form confirmations are paced
  by construction and a new send path can't forget to opt in; Redis-held because
  the ceiling belongs to the AWS account, so every lane and replica draws down one
  budget. The rate is read live (`GetAccount` → `SendQuota.MaxSendRate`, hourly)
  because AWS raises it on its own as reputation builds; `SES_MAX_SEND_RATE`
  overrides. It fails open (unpaced, logged once) rather than blocking mail, and
  absorbs a stray throttle with a braked retry — but only a *plain* throttle.
  Daily-quota/suspension/misconfig still reach the handler and pause the campaign.
- The SES client deliberately runs with `maxAttempts: 1` — SDK-internal retries
  can silently double-send when a response is lost after SES accepted the
  message. Retry policy lives in the send-batch handler, where
  `campaign_recipients.status` keeps it duplicate-safe: only provably-unsent
  errors (connection-phase network failures, provider-rejected requests) ever
  return a recipient to `pending`; ambiguous errors (timeouts, 5xx) stay
  terminal for that recipient.
- **Suppression is add-only everywhere except one route.** `POST /v1/suppressions`
  (and `addSuppressions`) only ever adds; the single undo is
  `DELETE /api/suppressions/{email}` behind a session (the Suppressions page), so a
  leaked API key can't unblock a bounced address to mail it. That route clears every
  reason held against the address, restores contacts marked
  `bounced`/`complained`/`suppressed` to `subscribed`, and **deliberately leaves
  `unsubscribed` rows alone** — only the recipient reverses their own opt-out. Global
  (`scope='global'`) entries are never listed to a tenant (that would leak other
  accounts' recipients) and a tenant can never delete one.
- **A CSV import may only assert `subscribed` or `unsubscribed`** — the same rule the
  public API enforces. `parseSubscriberCsv` maps a `status` column's opt-out synonyms to
  `unsubscribed` (with `unsubscribed_at` for the original date), *drops* rows marked
  bounced/complained/`cleaned`/`pending` into `statusSkippedRows`, and falls back to
  `subscribed` for an unrecognized value — because `status` is a common header for
  unrelated data ("trial"/"paid") and a strict reading would silently swallow whole
  imports.
- Failed-import recovery: a `status='failed'` import is never auto-retried. A user
  re-uploads a corrected CSV via `POST /api/audiences/[id]/imports/[importId]/retry`,
  which overwrites the stored object, resets the row to `pending`, and re-enqueues
  `process_import` (dedup-safe via `onConflictDoNothing`). Operators see recent
  failed/dead-lettered work on the admin overview, or query directly:
  `SELECT * FROM job_logs WHERE status IN ('failed','dead_letter') ORDER BY created_at DESC;`
- The web tier (Vercel) and the worker share the same Postgres; the worker is the
  only process that consumes the BullMQ queue and runs cron. Keep queue messages
  ID-only so the worker re-reads content from Postgres.
- `drizzle.config.ts` points `migrate`/`push`/`studio` at `DATABASE_URL` — use the
  Supabase direct/session connection (port 5432) when running migrations.
- **After a schema change, `npm run db:generate` only WRITES the migration file — it
  does not touch any database.** You must also run `npm run db:migrate` to apply it to
  the real (Supabase) DB the dev server/web tier use. Tests pass without this because
  pglite applies `migrations/` automatically into its in-memory DB, so a forgotten
  `db:migrate` shows up only at runtime: Drizzle selects every schema column, so a
  column that exists in `schema.ts` but not in the live DB makes every query on that
  table 500. If you add a column, generate + migrate in the same change.
- **`statement_timeout` is not a hang guard.** It is a server-side parameter, so it
  only bounds queries the server actually receives, and postgres.js has no
  client-side query timeout. A half-open socket (peer gone, no FIN/RST — what a
  frozen-then-thawed serverless instance holds) swallows a query forever: no
  response, no error, and with `max: 1` the wedged connection takes every later
  request on that instance with it. Wrap web-tier queries that must not hang in
  `withDeadline` (`src/lib/deadline.ts`) and call `resetDb()` when one trips —
  abandoning a query does not free its connection. This caused weeks of phantom
  `/api/health` "outages"; see `docs/health-monitoring.md`.
- **`pending_review` is not a human review.** Submitting a campaign runs the
  automated AI risk review and, if it passes, delivery starts — there is no
  approval step in between. Anything described as "submit for review" in a UI or
  an API is a send; treat it as irreversible.
- The MCP server (`app/api/mcp`, `src/mcp/`) speaks the protocol directly rather
  than via the reference SDK — it is tools-only, so every exchange is one
  JSON-RPC request in, one JSON response out, and the SDK's transport wants
  Node req/res plus a session store. It is stateless: no session id, every
  request re-authenticates with the same bearer key the REST API uses.
- Campaign bodies written over the API arrive as **Day3 Markdown**
  (`src/lib/campaign-markdown.ts`) and are converted to real builder sections,
  so an externally-authored email stays editable in the composer.
  `markdownToSections` output is email-safe *by construction* (text is
  `escapeHtml`'d, only allowlisted tags are emitted) and must NOT be passed
  through `sanitizeHtml` — that pass double-escapes `&` in URLs. The one
  exception is the `:::html` passthrough, which is author-supplied and is
  sanitized.
- **Outbound webhooks emit from the choke point, not next to it.** `webhook_endpoints` /
  `webhook_deliveries` push delivery/bounce/complaint/suppression events to the
  tenant's own app (`src/services/webhook-events.ts`, `docs/webhooks.md`). Every
  emission sits INSIDE the guard that already makes its write idempotent — an
  `email_events` insert whose `onConflictDoNothing` actually returned a row, a
  status `UPDATE` whose `WHERE` actually matched — because SNS is at-least-once
  and jobs retry, so emitting *beside* that guard replays the event at the
  customer's endpoint on every redelivery. `addSuppression` is the single writer
  for `suppression.created`; don't add a second. Emission never throws (the real
  work already committed) and delivery rows are written before anything is
  enqueued, so Redis is a latency optimization over a Postgres outbox — the cron
  sweep recovers anything whose job was lost. Endpoint URLs are tenant-supplied
  and fetched by our worker: `src/lib/webhook-url.ts` is an SSRF boundary
  (public https only, validated at the socket's own DNS lookup, no redirects
  followed) — treat changes to it as security changes. Webhook config is
  app-UI-only on purpose; a leaked API key must not be able to attach a silent
  feed of every address the account mails.
- Liveness: `GET /api/health` (200 healthy / 503 if DB down) reports DB, cron-sweep
  freshness, and the worker's Redis heartbeat (`day3:worker:heartbeat`, written every
  30s by `worker/index.ts`). Wire monitors/supervisor per `docs/health-monitoring.md`.

## Commands

- `npm run dev` — `next dev` (web + API routes)
- `npm run worker` / `npm run worker:dev` — run the BullMQ worker (`worker/index.ts`)
- `npm test` — `vitest run` (pglite applies migrations automatically)
- `npm run typecheck` / `npm run lint` / `npm run build`
- `npm run db:generate` (drizzle-kit) → `npm run db:migrate`

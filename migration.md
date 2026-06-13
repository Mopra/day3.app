# Day3 — Stack Migration Plan

**Status:** planned, not started. This document is written to be picked up in a
fresh session. Read [AGENTS.md](AGENTS.md) and this file first.

## Why we're migrating

The app is a multi-tenant newsletter SaaS where **customers bring their own
sending domains**. The current stack is Cloudflare-only (Workers + D1 + Queues +
R2 + Cloudflare Email Service). It works and is fully built, but we hit a hard
wall:

> **Cloudflare Email Sending is zone-scoped** (`/zones/{zone_id}/email/sending/subdomains`)
> and onboards domains by *auto-adding* SPF/DKIM records — which only works for
> domains whose DNS is hosted on Cloudflare. It cannot verify and send on behalf
> of arbitrary customer domains hosted on external DNS, the way Amazon SES /
> Resend / Postmark do. That capability is the core of this product.

Once we accept a different email provider, the "Cloudflare-only" rationale for
the rest of the stack falls away. We're moving to infrastructure that does
multi-tenant email properly and removes the D1 scaling ceilings we'd already
flagged (10 GB/database cap, single-writer throughput, 100-bound-param limit).

## Target stack

| Concern | From | To |
| --- | --- | --- |
| Hosting / framework | Cloudflare Workers + Vite SPA | **Vercel + Next.js (App Router)** |
| API | Hono on Worker | **Next.js route handlers + server actions** (on Vercel) |
| Database | Cloudflare D1 (SQLite) | **Supabase Postgres** (Drizzle, pg dialect) |
| Queue | Cloudflare Queues | **Redis + BullMQ on the VPS** |
| Background workers | Worker `queue` consumer | **BullMQ worker processes on the VPS** (pm2 / systemd / Docker) |
| Cron | Worker `scheduled` | **BullMQ repeatable jobs on the VPS** |
| File storage | Cloudflare R2 | **Supabase Storage** |
| Email | Cloudflare Email Service | **Amazon SES** (SES v2 API) — see decision Q2 |
| Auth / Orgs / Billing | Clerk | **Clerk (unchanged)** — SDK swaps to `@clerk/nextjs` |

**Two-tier split.** The **web tier** (Next.js: pages, API route handlers, server
actions, webhooks) runs on **Vercel**. The **background tier** (Redis + BullMQ
queue, worker processes, cron sweeps) runs on the **VPS fleet**, reusing the
operator's existing multi-region provisioning, monitoring, and deploy tooling.
Postgres is managed **Supabase**.

The two tiers meet at **Redis**, hosted on the VPS and exposed over **TLS + auth**
(`rediss://`, ACL/password) so Vercel can reach it. Vercel API routes are the
*producer* (`queue.add(...)` when a campaign is submitted, a CSV is imported,
etc.); the VPS worker is the *consumer*. This split fits BullMQ cleanly — only
the consumer needs the persistent blocking connections, and that runs on the
long-lived VPS; the producer just pushes jobs.

## Decisions (all resolved)

**Guiding principle: keep the setup simple.** Single Next project, no monorepo,
no extra services beyond Supabase + VPS Redis + SES + Clerk. Prefer the
boring/obvious option whenever a sub-choice comes up.


- **Q1 — Queue.** Resolved: **Redis + BullMQ on the VPS.** BullMQ is the natural
  fit — our queue handlers are already typed `(data) => Promise<void>` functions,
  so each becomes a BullMQ worker processor with no logic change; retries, delays,
  repeatable (cron) jobs, and a DLQ are built in.
- **Q1b — Redis reachability.** Resolved: **VPS-hosted Redis over TLS + auth**
  (`rediss://`, ACL/password). Caveat to handle: Vercel functions don't have
  stable egress IPs on standard plans, so don't rely on IP allowlisting — secure
  with TLS + a strong ACL credential (and Vercel static-egress/secure-compute if
  that plan tier is available). The BullMQ `tls` connection option + the `rediss://`
  URL cover the client side.
- **Q2 — Email provider.** Resolved: **raw Amazon SES** (`@aws-sdk/client-sesv2`):
  cheapest, scales forever, has the per-domain identity verification API we need.
  Sits behind the existing `EmailProvider` interface as `SesEmailProvider`.
- **Q3 — Postgres column types.** Resolved: **native Postgres types** — `boolean`
  for the integer 0/1 flags (`sendingEnabled`, `adminOverrideVerified`, …) and
  `timestamptz` for the text ISO timestamps. This touches the code that reads/
  writes those fields (e.g. `sendingEnabled ? 1 : 0` → `sendingEnabled`); do that
  pass during the schema port.
- **Q4 — Supabase project.** Resolved: **reuse the existing project**
  `vvksahxtlyifubswonmu` ("supabase-bisque-flask"), already resumed. It still
  holds the **old day3 schema** (users/campaigns/tasks/credits from the first
  MVP) — drop those tables before applying the new migrations (see Phase 2).
- **Repo layout.** Resolved: **single Next project** (no monorepo). The VPS
  worker lives in the same repo as a separate entrypoint (`worker/index.ts`) that
  imports the shared `src/` modules; it's built/run on the VPS independently of
  the Vercel deploy.

## What ports vs. what gets rewritten

The domain logic we built is framework-agnostic TypeScript and **ports almost
as-is**. The infra binding layer is what changes. Estimated ~60–70% portable.

### Ports with only a DB-client/import change
- `src/worker/db/schema.ts` — change Drizzle dialect `sqlite-core` → `pg-core`.
  Table shapes identical; apply Q3 type decision. Prefixed text PKs stay.
- `src/worker/lib/ids.ts` — pure (Web Crypto is global in Node 20+). As-is.
- `src/worker/lib/csv.ts` — pure parser. As-is.
- `src/worker/services/plans.ts`, `risk.ts`, `render.ts`, `unsubscribe.ts`
  (HMAC via Web Crypto — fine on Node), `suppression.ts`, `health.ts`,
  `accounts.ts` (Clerk backend works server-side in Next). As-is + db import.
- `src/worker/lib/job-log.ts` — db import only.
- `src/worker/queue/messages.ts` — the typed `QueueMessage` union. As-is.
- `src/worker/queue/handlers/{process-import,review-campaign,generate-recipients,send-batch}.ts`
  — **the idempotent send logic ports directly.** Two edits: (1) the
  `env.JOBS_QUEUE.send(...)` calls become `queue.add(type, payload)` on a BullMQ
  queue; (2) reads/writes of integer-boolean/text-timestamp columns adjust per Q3.
  Postgres allows 65535 bind params, so the `INSERT_CHUNK` splitting can be
  relaxed/removed (keep batched event inserts for write efficiency though).
  BullMQ retries re-run a handler, so the existing status-based idempotency still
  applies; optionally set a deterministic `jobId` for enqueue-level dedup.
- `src/worker/email/provider.ts` (interface) + `mock.ts` — as-is.
- React UI in `src/app/pages/**`, `src/app/components/**`, `src/components/ui/**`
  — components port; routing + data-fetching layer changes (see Frontend below).

### Rewritten (mechanical, not redesign)
- `src/worker/db/client.ts` → Postgres client: `drizzle-orm/postgres-js` + the
  `postgres` driver. **Connection style differs by tier:** the Vercel web tier is
  serverless → use the **Supabase transaction pooler** (port 6543, `prepare: false`
  for pgbouncer). The VPS worker is long-lived → use a normal pool against the
  **direct/session** connection (port 5432). Expose one factory that picks the
  right URL/options per `DATABASE_URL` so both processes share the client code.
- `src/worker/api/**` (Hono routes) → Next route handlers under `app/api/**`.
  `requireAuth/requireAccount/requireAdmin` middleware → a small auth helper
  using `auth()` from `@clerk/nextjs/server` (cookie-based; no Bearer plumbing).
- `src/worker/queue/consumer.ts` → a standalone **BullMQ worker entrypoint**
  (e.g. `worker/index.ts`, a long-running Node process under pm2/systemd/Docker)
  that wraps `handleQueueMessage` in a `Worker(queueName, ...)`. This is closer
  to the original Cloudflare consumer than an HTTP endpoint — route by
  `message.type` exactly as today. Enqueue via a shared BullMQ `Queue` instance.
- `src/worker/scheduled.ts` → **BullMQ repeatable jobs** (or system cron) that
  run the same sweep logic (stuck-lock recovery, health checks, monthly reset,
  reconcile sending campaigns). Schedule a repeatable job at enqueue-setup time.
- `src/worker/email/cloudflare.ts` → `ses.ts` (`SesEmailProvider`); update
  `factory.ts`.
- `src/worker/api/webhooks.ts` — the `cloudflare-email` handler → an **SES/SNS
  bounce+complaint** handler (verify SNS signature; same DB effects: update
  recipient/subscriber status, add suppression, recompute account health). The
  Clerk webhook handler stays (swap `verifyWebhook` import to `@clerk/nextjs/server`).
- `src/worker/api/audiences.ts` CSV upload — R2 `put/get` → Supabase Storage.

### Deleted
- `src/worker/index.ts` (Next owns routing), `wrangler.jsonc`, `vite.config.ts`,
  `src/worker/types.d.ts`, `worker-configuration.d.ts`, Cloudflare-specific
  vitest pool config.

## The headline feature: domain verification with SES

This is the whole reason for the migration — design it deliberately.

1. **Add domain** → call SES `CreateEmailIdentity({ EmailIdentity: domain,
   DkimSigningAttributes: { NextSigningKeyLength } })` (Easy DKIM). SES returns 3
   DKIM **CNAME** tokens. Store them in `sending_domains.dns_records_json`.
   Optionally configure a custom MAIL FROM subdomain (adds an MX + SPF TXT
   record) for SPF alignment. Recommend a DMARC TXT record in the UI.
2. **Show records** on `/domains` — the customer adds them at *their own* DNS
   host (anywhere). This is the "manual method" that works for everyone.
3. **Check** → `GetEmailIdentity(domain)`; when `VerifiedForSendingStatus` is
   true and DKIM `Status === SUCCESS`, set `verification_status = verified`.
   (SES's own status is authoritative; an extra DNS-over-HTTPS pre-check is
   optional polish.) Keep the existing admin-override path as a testing fallback.
4. **Gate sends** on `verification_status = verified` OR `admin_override_verified`
   — already enforced in `submitCampaign`; keep it.
5. **Bounces/complaints (mandatory for SES reputation)** → SES configuration set
   → event destination → **SNS topic** → HTTPS subscription pointing at
   `POST /api/webhooks/ses`. Verify the SNS signature, then apply the same DB
   effects the current `cloudflare-email` webhook already implements. Our
   `email_events` + `suppression_entries` + `campaign_recipients` schema already
   models this.

## Phased execution

**Phase 0 — Decisions + provisioning.** Resolve Q2–Q4 (Q1 settled: BullMQ/Redis;
Q1b settled: VPS Redis over TLS+auth). Provision: Vercel project (web tier),
Supabase project, Redis on the VPS with TLS + ACL credential, the VPS worker
host(s) + process manager (pm2/systemd/Docker), AWS account + SES (request
production access early — SES starts sandboxed), reuse the existing Clerk app.

**Phase 1 — Scaffold + port shared logic.** `create-next-app` (App Router, TS,
Tailwind 4) — one project. Re-add shadcn/Base UI components. Port `db/schema.ts`
(pg, native types per Q3), `lib/`, `services/`, `email/provider.ts`+`mock.ts`,
`queue/messages.ts`, `queue/handlers/**`. Structure: `src/db`, `src/lib`,
`src/services`, `src/email`, `src/queue`, `app/` (Next), and `worker/index.ts`
(the VPS BullMQ entrypoint, importing from `src/`). Get it type-checking.

**Phase 2 — Database.** Reusing the existing Supabase project, so **first drop
the old day3 tables** (users/campaigns/tasks/credits and related) — confirm
nothing else depends on that project before dropping. Then `drizzle-kit generate`
against pg and apply. Add indexes; note (don't necessarily build yet) monthly
partitioning of `email_events` as the scaling lever. Port `seed.sql`.

**Phase 3 — API + auth.** Clerk Next: `clerkMiddleware()` in `middleware.ts`,
`<ClerkProvider>` in root layout, `auth()` helper for account resolution
(`getAccountByClerkOrgId` / lazy `syncCurrentOrganization`). Port each Hono
route group to `app/api/**` route handlers. Keep account-scoping invariant.

**Phase 4 — Queue + workers + cron.** Producer side (on Vercel): a shared BullMQ
`Queue` so API route handlers `queue.add(...)`. Consumer side (on the VPS): a
standalone worker process (`worker/index.ts`) running `handleQueueMessage` under
the process manager, plus repeatable jobs for the cron sweeps. Both connect to
the shared Redis. The Vercel app and the VPS worker import the same `src/`
modules but run as separate deployments.

**Phase 5 — SES + domain verification + bounce webhook.** `SesEmailProvider`
(used by the VPS worker for campaign sends, and by Vercel routes for domain
create/verify + test sends), the CreateEmailIdentity/GetEmailIdentity flow above,
and the SNS → `POST /api/webhooks/ses` handler (a Vercel route — inbound HTTP
lives on the web tier). Wire `EMAIL_PROVIDER` env to select mock vs ses.

**Phase 6 — Frontend.** Port pages to Next file-based routes. Replace
react-router with Next navigation; replace the `useApi`/Bearer hook with
server-component data loading or cookie-authed `fetch`. Clerk SPA components
(`SignIn`, `OrganizationSwitcher`, `PricingTable`, etc.) → `@clerk/nextjs`
equivalents. (Note: Clerk Billing must be enabled in the dashboard with an
**organization** plan slug `tiny` — see `PAID_PLAN_SLUG`.)

**Phase 7 — Tests, verify, deploy.** Port the vitest suites (the idempotency
tests are the crown jewels — keep them) to run against a test Postgres instead
of the Workers pool. Verify end-to-end with `EMAIL_PROVIDER=mock`, then a real
SES sandbox send. Deploy the web tier to **Vercel** (git push / `vercel`); deploy
the **worker** to the VPS under the process manager. Set Vercel env via
`vercel env`, and the VPS worker env via its `.env`/secrets.

## Invariants to preserve (do not regress)

1. **Idempotent queue jobs** — a retried message never double-sends. Recipients
   are claimed atomically (`UPDATE ... WHERE id IN (SELECT ... LIMIT n)`);
   `campaign_recipients.status` is the source of truth. Crashed `sending` claims
   are swept to `failed` by cron, never back to `pending`.
2. **`account_id` scoping** — every non-admin query is scoped to the account
   resolved server-side from the Clerk org. Never trust client-provided ids.
3. **`EmailProvider` interface** — no provider calls leak outside `src/email`.
4. **Postgres is the source of truth** — queue messages carry IDs only.
5. **Per-batch write flush** — the usage counter increments once per batch and
   events bulk-insert (the optimization in `send-batch.ts`); keep it.
6. **No free tier; MVP scope only.**

## Env var mapping

Web-tier env lives in **Vercel's env store** (`.env.local` for local dev); the
worker's env lives in **`.env`/secrets on the VPS**. The "Tier" column shows
which process needs each.

| Current (`.dev.vars` / wrangler) | New | Tier |
| --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Vercel |
| `CLERK_SECRET_KEY` | `CLERK_SECRET_KEY` | Vercel |
| `CLERK_WEBHOOK_SIGNING_SECRET` | `CLERK_WEBHOOK_SIGNING_SECRET` | Vercel |
| `UNSUBSCRIBE_SECRET` | `UNSUBSCRIBE_SECRET` | both (web renders links, worker signs sends) |
| `ADMIN_EMAILS` | `ADMIN_EMAILS` | Vercel |
| `APP_URL` (wrangler var) | `APP_URL` / `NEXT_PUBLIC_APP_URL` | both |
| D1 binding `DB` | `DATABASE_URL` — pooler (6543) on Vercel, direct (5432) on VPS | both |
| R2 binding | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (Storage) | both |
| Cloudflare Queue binding | `REDIS_URL` (BullMQ) | both |
| — (new) | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_CONFIGURATION_SET` | both |
| — (new) | SNS signing-cert verification needs no secret (validate against the AWS cert URL) | Vercel |

## Notes for the implementing session

- Verify current APIs against live docs before coding (they move): `@clerk/nextjs`
  (App Router middleware + `auth()`), Drizzle Postgres + `postgres-js`, BullMQ
  (`Queue`, `Worker`, repeatable jobs), SES v2
  `CreateEmailIdentity`/`GetEmailIdentity`/`SendEmail`.
- Two deployments share one repo: the **Next.js web tier on Vercel** and the
  **BullMQ worker on the VPS** (`worker/index.ts`). Keep domain logic
  (`services/`, `queue/handlers/`, `email/`) free of request/runtime-specific
  imports so both reuse it cleanly. The worker is built/run on the VPS (e.g.
  `tsx worker/index.ts` under the process manager, or a small `tsup`/`tsc` build);
  Vercel only builds the Next app and ignores `worker/`.
- The existing Cloudflare implementation stays in git history as the reference
  for the logic being ported — build the new stack fresh rather than mutating in
  place, but copy the proven domain modules over verbatim where possible.
- SES production access takes time to approve — request it in Phase 0.
- Keep `EMAIL_PROVIDER=mock` working throughout so the full pipeline is testable
  without real sends, exactly as it is today.
- Multi-region: Vercel serves the web tier globally; Redis, the worker(s), and
  Supabase Postgres are the central stateful tier, typically pinned to one region.
  Mind latency from Vercel functions to Supabase/Redis — keep the worker close to
  Postgres, and the Vercel functions' region near Supabase. Operator knows this
  topology better than the plan does; treat region placement as their call.

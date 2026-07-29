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
5. **No features outside the MVP scope.** Pricing is bandwidth-based. The free
   tier (`free_org`) is set-up-only: it can configure everything and draft, but
   **cannot send** and is capped at 500 subscribers. Paid tiers (`1k_plan` →
   `1m_plan`) unlock sending and **all include the AI assistant** — 1k/5k on a
   smaller credit allowance, 10k+ on the full one. Gating lives in
   `src/lib/plans-catalog.ts` (`planCanSend` / `planHasAI` / `aiAllowanceForPlan` /
   `maxSubscribersForPlan`) and `src/services/subscriber-limit.ts`. See `PRODUCT.md §4`.

## Gotchas

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
- The SES client deliberately runs with `maxAttempts: 1` — SDK-internal retries
  can silently double-send when a response is lost after SES accepted the
  message. Retry policy lives in the send-batch handler, where
  `campaign_recipients.status` keeps it duplicate-safe: only provably-unsent
  errors (connection-phase network failures, provider-rejected requests) ever
  return a recipient to `pending`; ambiguous errors (timeouts, 5xx) stay
  terminal for that recipient.
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
- Liveness: `GET /api/health` (200 healthy / 503 if DB down) reports DB, cron-sweep
  freshness, and the worker's Redis heartbeat (`day3:worker:heartbeat`, written every
  30s by `worker/index.ts`). Wire monitors/supervisor per `docs/health-monitoring.md`.

## Commands

- `npm run dev` — `next dev` (web + API routes)
- `npm run worker` / `npm run worker:dev` — run the BullMQ worker (`worker/index.ts`)
- `npm test` — `vitest run` (pglite applies migrations automatically)
- `npm run typecheck` / `npm run lint` / `npm run build`
- `npm run db:generate` (drizzle-kit) → `npm run db:migrate`

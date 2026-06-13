# Day3

Simple product update emails for small SaaS teams. No marketing suite. No
contact tax. No free tier. — [day3.app](https://day3.app)

Runs entirely on Cloudflare: one Worker serves the React dashboard (Workers
Assets), the Hono API, the Queue consumer that sends campaigns, and the cron
handler. D1 is the database, R2 stores CSV imports, Clerk handles auth,
organizations, and billing.

## Stack

| Layer | Tech |
| --- | --- |
| Compute | Cloudflare Workers (single Worker: fetch + queue + scheduled) |
| Frontend | React 19 SPA — Vite, react-router, Tailwind 4, shadcn/ui |
| API | Hono + Zod |
| Database | Cloudflare D1 (SQLite) + Drizzle ORM, migrations via wrangler |
| Jobs | Cloudflare Queues (`newsletter-jobs`) + Cron Triggers |
| Files | Cloudflare R2 (`newsletter-imports`) |
| Email | `EmailProvider` interface → mock (default) or Cloudflare Email Service |
| Auth/Billing | Clerk (Organizations = tenants, Billing plan `tiny` $9/mo) |

## Local development

```bash
npm install

# 1. Env: client + worker secrets
cp .env.example .env.local          # VITE_CLERK_PUBLISHABLE_KEY
cp .dev.vars.example .dev.vars      # Clerk keys, UNSUBSCRIBE_SECRET, ADMIN_EMAILS

# 2. Database (local SQLite under .wrangler/state)
npm run db:migrate:local
npm run db:seed                     # optional sample data

# 3. Run — emulates D1/R2/Queues/cron locally, mock email provider
npm run dev
```

Open http://localhost:5173. Sign in with Clerk, create an organization, and
you have a tenant. With `EMAIL_PROVIDER=mock` (default) sends are logged to
the dev console instead of delivering email — the full campaign pipeline
(review → generate recipients → batched queue sends → stats) works end to end.

Useful:

- `npm test` — vitest in workerd with real D1 (idempotency tests live here)
- `npm run typecheck` / `npm run lint` / `npm run build`
- `npm run db:generate` — new Drizzle migration after schema changes
- Trigger cron locally: `curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`

## Going to production (first deploy checklist)

1. `wrangler d1 create newsletter_mvp` → put the id in `wrangler.jsonc`
2. `wrangler queues create newsletter-jobs` (+ `newsletter-jobs-dlq`)
3. `wrangler r2 bucket create newsletter-imports`
4. Secrets: `wrangler secret put CLERK_SECRET_KEY` (+ publishable key,
   webhook secret, `UNSUBSCRIBE_SECRET`, `ADMIN_EMAILS`)
5. Set `APP_URL` in `wrangler.jsonc` vars to the production origin
6. Clerk dashboard: production instance, org Billing plan `tiny`,
   webhook endpoint `/api/webhooks/clerk`
7. Real email: `wrangler email sending enable <domain>`, uncomment the
   `send_email` binding, set `EMAIL_PROVIDER=cloudflare`
8. `npm run db:migrate:prod && npm run deploy`

## Architecture notes

- **Tenancy**: every Clerk organization maps to one `accounts` row; all
  queries are scoped by `account_id` resolved server-side from the session.
- **Send pipeline**: `submitCampaign` → queue `review_campaign` (risk rules)
  → `generate_campaign_recipients` (dedup + suppression filtering) →
  `send_campaign_batch` (claims 25 pending recipients atomically, sends,
  re-enqueues itself until done).
- **Idempotency**: recipients are claimed with a single atomic UPDATE; a
  retried queue message can never double-send. Crashed claims are swept to
  `failed` by cron — never re-sent.
- **Billing**: Clerk Billing entitlements are mirrored into D1 on dashboard
  load and via webhooks; sending requires an active subscription, sending
  enabled, and remaining monthly quota.
- **Safety**: deterministic risk review on submit (high risk blocks), bounce
  ≥4% / complaint ≥0.08% auto-pauses an account, admins (ADMIN_EMAILS) can
  approve/block campaigns, pause accounts, and override domain verification.

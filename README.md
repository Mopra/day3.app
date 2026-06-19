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

# 1. Env: web tier + worker secrets (see "Required environment variables" below)
cp .env.example .env.local          # Next.js web tier
cp .env.worker.example .env.worker  # BullMQ worker

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

- `npm test` — vitest against real Postgres (pglite); applies migrations from
  scratch every run and asserts schema/journal/snapshot agree (idempotency tests
  live here too)
- `npm run typecheck` / `npm run lint` / `npm run build`
- `npm run db:generate` — new Drizzle migration after schema changes
- Trigger cron locally: `curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`

## Migration discipline

`src/db/schema.ts` is the single source of truth; SQL under `migrations/` is
**forward-only** and generated, never edited by hand. The journal
(`migrations/meta/_journal.json`) and the per-migration `*_snapshot.json` files
are part of the migration — always commit them together.

Workflow when you change the schema:

1. Edit `src/db/schema.ts`.
2. `npm run db:generate` — writes the next `NNNN_*.sql`, its snapshot, and the
   journal entry.
3. Review the SQL (squash/rename within the same PR if the diff is noisy), then
   commit the SQL **and** the `meta/` changes in one commit.
4. `npm test` proves it applies cleanly from scratch.

CI enforces this: it re-runs `drizzle-kit generate` and fails the build if that
produces any diff — i.e. if `schema.ts` and the committed migrations disagree, or
a migration was added without its snapshot. Two contributors who both generate a
migration will collide on the next `NNNN` index; resolve by regenerating one off
the merged `schema.ts` so the journal stays linear.

**Apply order in production** is `drizzle-kit migrate` (see the deploy
checklist), which replays only the un-applied journal entries against
`DATABASE_URL` and records them in the `__drizzle_migrations` table — never
`db:push` (which diffs live and can drop columns).

## Required environment variables

Both processes validate their environment at startup (`src/lib/env.ts`) and
**refuse to boot** if a required variable is missing or a secret is too short
(min 16 chars). This prevents the empty-key failure mode where an unset
`UNSUBSCRIBE_SECRET` would sign HMAC tokens with `""` (forgeable unsubscribe /
one-click links) or an unset `OAUTH_STATE_SECRET` would void OAuth CSRF
protection. The Next web tier validates on first server module load
(`instrumentation.ts`); the worker validates in `worker/index.ts` before it
starts consuming.

| Variable | Web | Worker | Notes / generation |
| --- | :-: | :-: | --- |
| `DATABASE_URL` | ✓ | ✓ | Postgres connection string. |
| `UNSUBSCRIBE_SECRET` | ✓ | ✓ | HMAC key for unsubscribe / one-click tokens; MUST match across both tiers. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `OAUTH_STATE_SECRET` | ✓ | — | HMAC key for the Cloudflare OAuth state cookie (CSRF). `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DNS_TOKEN_ENC_KEY` | ✓† | — | base64 of 32 raw bytes (AES-256) encrypting Cloudflare DNS tokens at rest. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. †Or `DNS_TOKEN_ENC_KEYS` + `DNS_TOKEN_ENC_ACTIVE_KEY_ID` for rotation — see [docs/cloudflare-dns-oauth.md](docs/cloudflare-dns-oauth.md#key-rotation-encrypt-at-rest). |
| `CLERK_WEBHOOK_SIGNING_SECRET` | ✓ | — | Verifies Clerk webhooks. Use a ≥16-char placeholder locally. |
| `AWS_REGION` | ✓* | ✓* | *Required only when `EMAIL_PROVIDER=ses`. |

See `.env.example` (web) and `.env.worker.example` (worker) for the full list
including non-secret config (Clerk publishable/secret keys, Redis, Supabase
Storage, SES credentials).

## Going to production (first deploy checklist)

The web tier runs on **Vercel**, the BullMQ worker on the **VPS**, Postgres on
**Supabase**. Full provider walkthrough: [docs/go-live.md](docs/go-live.md).

1. Provision Supabase Postgres, VPS Redis (`rediss://`), and SES (see go-live).
2. Set env on Vercel (web) and `/opt/day3/.env.worker` (worker) — see
   `.env.example` / `.env.worker.example`.
3. Clerk dashboard: production instance, org Billing plan `tiny`, webhook
   endpoint `/api/webhooks/clerk`.
4. **Apply the database migrations before any new code serves traffic:**
   `DATABASE_URL=<supabase-direct-5432> npm run db:migrate`
   (`drizzle-kit migrate` — forward-only, idempotent; replays only un-applied
   journal entries). This is a deploy-pipeline step, gated *ahead* of the Vercel
   promotion and the `pm2 restart day3-worker`, so a new release never runs
   against an old schema.
5. Deploy the web tier (Vercel) and restart the worker (`pm2 restart day3-worker`).

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

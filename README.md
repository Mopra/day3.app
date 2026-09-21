# Day3

Marketing and transactional email, billed by sends. $1/mo. No contact tax, no
marketing suite to learn.

**[day3.app](https://day3.app)**

> **Source-available, not open source.** This code is published for
> transparency and reference. See [LICENSE](LICENSE) for terms.

This repository is the Day3 product itself: the app at
[go.day3.app](https://go.day3.app), the public REST API, the webhook and MCP
endpoints, and the worker that sends the mail.

## What it does

Day3 is a deliberately small email tool for small SaaS teams. Send product
updates and changelogs to your users, and send your app's transactional email
(password resets, receipts, magic links), through one verified domain, one
monthly allowance, and one place to see delivery.

- **Campaigns** with a block composer, optional AI assist, scheduling, and
  per-send stats
- **Audiences** with segments (saved filters), topics (subscription
  categories), CSV import, and hosted signup forms
- **Transactional email** over `POST /v1/emails`, Resend-compatible in shape,
  with per-email delivery status
- **Automations**: onboarding and lifecycle flows drawn on a node canvas,
  published as immutable versions, unlimited on every tier
- **Deliverability by default**: verified sending domains, double opt-in,
  one-click unsubscribe, automatic bounce and complaint suppression, account
  auto-pause on bad reputation
- **Metrics** for deliverability, reputation and engagement, plus a searchable
  log of every email you ever sent
- **Public API v1**, signed webhooks, and an **MCP server** so Claude Code,
  Cursor or VS Code can draft a campaign that lands in Day3 as editable blocks
- **Billed on sends, not subscribers.** Free accounts set up domains, build
  audiences and send for real in sandbox mode. Paid plans buy the allowance to
  reach everyone else.

[PRODUCT.md](PRODUCT.md) is the canonical description of what Day3 is, what it
costs, and how every feature behaves. Read it before the code.

## Tech stack

| Layer | Technology |
| --- | --- |
| Web framework | Next.js 16 (App Router) on Vercel |
| UI | React 19, Tailwind CSS 4, shadcn/ui on Base UI, react-hook-form, Zod |
| Rich text | TipTap |
| Database | Postgres (Supabase) via Drizzle ORM, postgres.js driver |
| Queue / jobs | BullMQ + Redis (ioredis), drained by the VPS worker |
| Email | AWS SES v2 (`eu-north-1`) for sending, AWS SNS for delivery events |
| Auth / tenancy / billing | Clerk (Organizations are the tenant boundary, plus Clerk Billing) |
| File storage | Supabase Storage (CSV imports) |
| AI (optional) | OpenRouter via the Vercel AI SDK |
| MCP server | Hand-rolled JSON-RPC over Streamable HTTP at `/api/mcp`, stateless and tools-only |
| DNS automation | Cloudflare OAuth, optional, for auto-configuring SES records |
| Testing | Vitest with pglite, an in-memory Postgres per test |

## Quick Links

| | | |
|---|---|---|
| **Website** | [day3.app](https://day3.app): what Day3 is, pricing, and the case for it | [Repo](https://github.com/Mopra/day3.app.website) |
| **App** | [go.day3.app](https://go.day3.app): sign in, write campaigns, send email | [Repo](https://github.com/Mopra/day3.app) |
| **Documentation** | [docs.day3.app](https://docs.day3.app): API reference, guides, webhooks, MCP | [Repo](https://github.com/Mopra/docs.day3.app) |

Built by [Pradsgaard Labs](https://pradsgaardlabs.com). Also from the same
workshop: [exit1.dev](https://github.com/Mopra/exit1.dev), uptime monitoring.

## Local development

```bash
npm install

# Env: web tier + worker (see "Required environment variables" below)
cp .env.example .env.local
cp .env.worker.example .env.worker

# Database
npm run db:migrate     # forward-only, applies un-applied journal entries
npm run db:seed        # optional sample data

npm run dev            # Next.js on http://localhost:3000
npm run worker         # BullMQ worker, in a second terminal
```

Sign in with Clerk and create an organization, and you have a tenant. The
campaign pipeline (review, generate recipients, batched queue sends, stats)
works end to end locally.

Useful:

- `npm test`: vitest against real Postgres (pglite). Applies migrations from
  scratch every run and asserts schema, journal and snapshots agree.
  Idempotency tests live here too.
- `npm run typecheck` / `npm run lint` / `npm run build`
- `npm run db:generate`: new Drizzle migration after schema changes
- `npm run db:studio`: browse the local database

## Migration discipline

`src/db/schema.ts` is the single source of truth. SQL under `migrations/` is
**forward-only** and generated, never edited by hand. The journal
(`migrations/meta/_journal.json`) and the per-migration `*_snapshot.json` files
are part of the migration, so always commit them together.

Workflow when you change the schema:

1. Edit `src/db/schema.ts`.
2. `npm run db:generate` writes the next `NNNN_*.sql`, its snapshot, and the
   journal entry.
3. Review the SQL (squash or rename within the same PR if the diff is noisy),
   then commit the SQL **and** the `meta/` changes in one commit.
4. `npm test` proves it applies cleanly from scratch.

CI enforces this: it re-runs `drizzle-kit generate` and fails the build if that
produces any diff, meaning `schema.ts` and the committed migrations disagree or
a migration was added without its snapshot. Two contributors who both generate
a migration will collide on the next `NNNN` index. Resolve it by regenerating
one off the merged `schema.ts` so the journal stays linear.

**Apply order in production** is `drizzle-kit migrate` (see the deploy
checklist), which replays only the un-applied journal entries against
`DATABASE_URL` and records them in the `__drizzle_migrations` table. Never
`db:push`, which diffs live and can drop columns.

## Required environment variables

Both processes validate their environment at startup (`src/lib/env.ts`) and
**refuse to boot** if a required variable is missing or a secret is too short
(min 16 chars). This prevents the empty-key failure mode where an unset
`UNSUBSCRIBE_SECRET` would sign HMAC tokens with `""` (forgeable unsubscribe
and one-click links) or an unset `OAUTH_STATE_SECRET` would void OAuth CSRF
protection. The Next web tier validates on first server module load
(`instrumentation.ts`). The worker validates in `worker/index.ts` before it
starts consuming.

| Variable | Web | Worker | Notes / generation |
| --- | :-: | :-: | --- |
| `DATABASE_URL` | ✓ | ✓ | Postgres connection string. |
| `UNSUBSCRIBE_SECRET` | ✓ | ✓ | HMAC key for unsubscribe and one-click tokens. MUST match across both tiers. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `OAUTH_STATE_SECRET` | ✓ | | HMAC key for the Cloudflare OAuth state cookie (CSRF). `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DNS_TOKEN_ENC_KEY` | ✓† | | base64 of 32 raw bytes (AES-256) encrypting Cloudflare DNS tokens at rest. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. †Or `DNS_TOKEN_ENC_KEYS` + `DNS_TOKEN_ENC_ACTIVE_KEY_ID` for rotation, see [docs/cloudflare-dns-oauth.md](docs/cloudflare-dns-oauth.md#key-rotation-encrypt-at-rest). |
| `CLERK_WEBHOOK_SIGNING_SECRET` | ✓ | | Verifies Clerk webhooks. Use a 16-char or longer placeholder locally. |
| `AWS_REGION` | ✓* | ✓* | *Required only when `EMAIL_PROVIDER=ses`. |

See `.env.example` (web) and `.env.worker.example` (worker) for the full list,
including non-secret config: Clerk publishable and secret keys, Redis, Supabase
Storage, and SES credentials.

## Going to production (first deploy checklist)

The web tier runs on **Vercel**, the BullMQ worker on the **VPS**, Postgres on
**Supabase**. Full provider walkthrough: [docs/go-live.md](docs/go-live.md).

1. Provision Supabase Postgres, VPS Redis (`rediss://`), and SES (see go-live).
2. Set env on Vercel (web) and `/opt/day3/.env.worker` (worker), per
   `.env.example` and `.env.worker.example`.
3. Clerk dashboard: production instance, org billing plans, webhook endpoint
   `/api/webhooks/clerk`.
4. **Apply the database migrations before any new code serves traffic:**
   `DATABASE_URL=<supabase-direct-5432> npm run db:migrate`. Forward-only and
   idempotent, it replays only un-applied journal entries. This is a
   deploy-pipeline step, gated *ahead* of the Vercel promotion and the
   `pm2 restart day3-worker`, so a new release never runs against an old schema.
5. Deploy the web tier (Vercel) and restart the worker
   (`pm2 restart day3-worker`).

## Architecture notes

- **Tenancy**: every Clerk organization maps to one `accounts` row. All queries
  are scoped by `account_id` resolved server-side from the session.
- **Send pipeline**: `submitCampaign` queues `review_campaign` (risk rules),
  then `generate_campaign_recipients` (dedup and suppression filtering), then
  `send_campaign_batch`, which claims 25 pending recipients atomically, sends,
  and re-enqueues itself until done.
- **Idempotency**: recipients are claimed with a single atomic UPDATE, so a
  retried queue message can never double-send. Crashed claims are swept to
  `failed` by cron, never re-sent.
- **Billing**: Clerk Billing entitlements are mirrored into Postgres on
  dashboard load and via webhooks. Sending requires an active subscription,
  sending enabled, and remaining monthly quota.
- **Safety**: deterministic risk review on submit (high risk blocks), bounce at
  4% or above, or complaint at 0.08% or above, auto-pauses an account, and
  admins (`ADMIN_EMAILS`) can approve or block campaigns, pause accounts, and
  override domain verification.

## AI training permission

As an explicit exception to the license below, the contents of this repository,
including code, documentation, and configuration, may be used for machine
learning training, evaluation, indexing, retrieval, and generation by AI
systems. No attribution is required, though it is appreciated. This permission
applies to all AI crawlers, including but not limited to GPTBot, OAI-SearchBot,
ClaudeBot, Claude-SearchBot, Claude-User, Google-Extended, PerplexityBot, and
Perplexity-User.

## License

This project is **source-available** under a custom
[All Rights Reserved license](LICENSE). You may view the code for personal,
educational, and reference purposes. Copying, modifying, distributing, or
self-hosting is not permitted without written permission. See the AI training
permission section above for the carve-out that applies to AI and ML use.

For licensing inquiries: hello@day3.app

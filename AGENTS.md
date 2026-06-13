# Day3 — agent notes

Newsletter SaaS for small SaaS teams, running entirely on Cloudflare. One Worker
serves the React SPA (Workers Assets), the Hono API, the Queue consumer, and
the cron handler.

## Stack

- Cloudflare Workers + Workers Assets (SPA) + D1 + Queues + R2 + Cron Triggers
- Hono (API), Drizzle ORM (D1/SQLite), Zod
- React 19 SPA: Vite, react-router (library mode), Tailwind 4, shadcn/ui (Base UI), react-hook-form
- Clerk: auth, Organizations (tenant boundary), Billing (org plan "tiny")
- Vitest with @cloudflare/vitest-pool-workers (tests run in workerd against real D1)

## Hard rules (from the product spec)

1. **Queue jobs must be idempotent** — a retried message must never duplicate an
   email send. `campaign_recipients.status` is the source of truth; sends are
   claimed via an atomic `UPDATE … WHERE id IN (SELECT … LIMIT n)`.
2. **D1 is the source of truth.** Queue messages carry IDs only, never content.
3. **Every query is scoped by `account_id`** (resolved server-side from the
   Clerk org — never trust client-provided account ids). Admin routes are the
   only exception.
4. **Email goes through the `EmailProvider` interface** (`src/worker/email/`).
   `EMAIL_PROVIDER=mock` logs instead of sending; `cloudflare` uses the
   Email Service `send_email` binding.
5. **No features outside the MVP scope.** No free tier.

## Gotchas

- D1 allows max **100 bound parameters per statement** — chunk multi-row inserts
  (see INSERT_CHUNK constants in queue handlers).
- Clerk Core 3: the React SDK is `@clerk/react` (NOT `@clerk/clerk-react`);
  `SignedIn/SignedOut` were replaced by `<Show>`. Billing APIs are beta — pin
  versions.
- Recipients stuck in `sending` (crashed batch) are swept to `failed` by cron,
  never back to `pending` — resending could duplicate.
- `wrangler types` regenerates `worker-configuration.d.ts` (runtime types only;
  the `Env` interface is hand-maintained in `src/worker/types.d.ts`).
- Local dev state lives in `.wrangler/state`; `wrangler d1 migrations apply
  newsletter_mvp --local` shares it with `vite dev`.

## Commands

- `npm run dev` — vite dev with full local Cloudflare emulation (D1/R2/Queues/cron)
- `npm test` — vitest in the Workers pool (applies migrations automatically)
- `npm run typecheck` / `npm run lint` / `npm run build`
- `npm run db:generate` (drizzle-kit) → `npm run db:migrate:local`
- Trigger cron locally: `curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`

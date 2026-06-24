# Pre-launch checklist — things only you can do

Code-side launch blockers are done (see `day3` git history / the 2026-06-24 sweep).
These remaining items are **config and content** — secrets I don't hold, legal text
that needs your review, and an external monitor. Work top to bottom.

---

## 1. Legal content to fill in

Both pages render but contain `[bracketed]` placeholders and a visible amber
"Template — not yet legal advice" banner. Have the copy reviewed by counsel, fill
every bracket, then **remove the banner** (delete the amber `<div>` block in
`src/components/legal-shell.tsx`).

### `app/privacy/page.tsx`
| Placeholder | What to put |
|---|---|
| `[legal entity name, address, country]` | The legal company operating Day3 |
| `[region]` (Supabase) | Where your Supabase project is hosted, e.g. "EU (Frankfurt)" |
| `[Redis host]` | Your Redis provider, e.g. "Upstash" or "self-hosted on our VPS" |
| `[retention period, e.g. 12 months]` | How long you keep open/click/event data |
| `[timeframe]` | How fast you delete data after an account/subscriber is deleted |
| `[postal address]` | A real contact postal address |

### `app/terms/page.tsx`
| Placeholder | What to put |
|---|---|
| `[legal entity name, address, country]` | Same operating company |
| `[Add refund/cancellation policy.]` | Your refund / cancellation terms |
| `[12]` (liability cap) | The liability-cap window, confirm with counsel |
| `[Confirm with counsel for your jurisdiction.]` | Review the whole liability clause |
| `[jurisdiction]` | Governing-law country/state |

### Both pages + footer
- The **"Last updated" date** in each page (`LegalShell` `lastUpdated` prop).
- The contact address **`support@day3.app`** appears in both pages and the footer
  (`src/components/site-footer.tsx`). Change it everywhere if that's not your real
  support inbox.
- Footer company line `© <year> Day3` — adjust if the legal name differs.

> Nice-to-have: also link `/privacy` from the email footer (right now it's only in
> the marketing footer). Tell me and I'll add it to `src/services/render.ts`.

---

## 2. Vercel env vars (web tier) — verify + add

My change made these **required to boot**. Most were already used by the web tier
(Redis for the queue, Supabase for uploads), so they're probably already set — just
confirm. The only genuinely new one is the error sink.

| Var | Value | Status |
|---|---|---|
| `APP_URL` | `https://go.day3.app` | verify it's set (now required) |
| `NEXT_PUBLIC_APP_URL` | `https://go.day3.app` | verify |
| `REDIS_URL` | your Redis connection string | likely already set |
| `SUPABASE_URL` | your Supabase project URL | likely already set |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service-role key | likely already set |
| `ERROR_REPORTING_DSN` | an HTTP collector URL (see §4 below) | **new — add this** |

Add/verify in the Vercel dashboard (Project → Settings → Environment Variables),
or with the CLI:

```bash
vercel env add ERROR_REPORTING_DSN production   # paste the value when prompted
vercel env ls                                   # confirm the others are present
```

(If a value is missing, `vercel env add <NAME> production`.) Re-deploy after
changing env vars so the new build picks them up.

**About `ERROR_REPORTING_DSN`** — it's any HTTP URL that accepts a JSON POST of
`{ message, error, context }`. It's **recommended, not a hard blocker**: without it,
errors / dead-lettered jobs / reputation auto-pauses still go to the normal logs
(Vercel logs + the worker's journald/pm2 logs) and the §4 monitor still catches a
dead worker — you just don't get *pushed* an alert. Easiest options:
- A **Make.com / Zapier "catch webhook"** that forwards the POST to Slack/email (5 min, no code).
- A tiny **Vercel function** that reposts to a Slack incoming webhook.
- Leave it unset for the soft-launch and add it in the first days — the boot
  warning is your reminder.

---

## 3. VPS worker `.env` — paste-and-fill

SSH to the worker box, edit `/opt/day3/.env.worker` (or wherever your pm2/systemd
unit's `EnvironmentFile` points), and fill these in. The throughput tunables at the
bottom are the new knobs — the defaults are safe starting points.

```dotenv
# --- Database (Supabase DIRECT/session connection, port 5432) ---
DATABASE_URL=postgres://postgres.<ref>:<password>@db.<ref>.supabase.co:5432/postgres

# --- Queue (Redis + BullMQ, TLS) ---
REDIS_URL=rediss://default:<password>@<vps-host>:6379

# --- App (REQUIRED — worker refuses to boot without these) ---
APP_URL=https://go.day3.app
UNSUBSCRIBE_SECRET=<same 32+ char secret as the web tier>

# --- Supabase Storage (reads uploaded CSVs during imports) ---
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role key>

# --- Email (Amazon SES v2) ---
EMAIL_PROVIDER=ses
AWS_REGION=eu-north-1
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
SES_CONFIGURATION_SET=day3-default

# --- Campaign risk review (deterministic checks always run) ---
AI_REVIEW_MODE=mock

# --- Error reporting (set the SAME value as Vercel) ---
ERROR_REPORTING_DSN=<HTTP collector URL — see §4>

# --- Send throughput (NEW — defaults are safe; raise for big lists) ---
# Effective parallelism = min(SEND_LANES, WORKER_CONCURRENCY).
# Rough rule once SES approves you at R emails/sec: SEND_LANES ≈ R × 0.15
#   SES ~50/s  → leave at 8
#   SES ~100/s → SEND_LANES=16, WORKER_CONCURRENCY=16, DB_POOL_MAX=24
WORKER_CONCURRENCY=8
SEND_LANES=8
SEND_BATCH_SIZE=100
DB_POOL_MAX=20
HEALTH_WINDOW_DAYS=14
```

After editing, restart the worker: `pm2 restart day3-worker` (or
`sudo systemctl restart day3-worker`). On boot it logs `worker ready` with the
concurrency; if anything required is missing it now fails loudly with the exact
var name.

> Start conservative. You can raise `SEND_LANES`/`WORKER_CONCURRENCY` any time once
> you see your real SES rate and that the worker box has CPU/connection headroom.

---

## 4. Uptime monitor — what "body-aware" means and how to set it up

`GET https://go.day3.app/api/health` returns HTTP **200** as long as the *web tier's
database* is reachable. Here's the catch: if the **worker** dies (campaigns silently
stop sending), the endpoint **still returns 200** — it just changes the JSON body to
`{"status":"degraded", ...}`. So a normal "alert me when the status code isn't 200"
monitor would stay green while sending is dead. That's the trap.

**"Body-aware" = the monitor also checks the response text, not just the status code.**
Set it up so the check FAILS when the body is missing `"status":"ok"`:

**Better Uptime / UptimeRobot / Pingdom (keyword monitors):**
1. Create an HTTP(S) monitor → URL: `https://go.day3.app/api/health`
2. Check interval: 60s
3. Add a **keyword / response-body rule**: *alert when the response does NOT contain*
   the text `"status":"ok"`
4. Save. Now a 503 (DB down) **and** a 200-but-`degraded` (worker down) both alert.

**Checkly (assertion monitors):** add an assertion on the JSON —
`$.status` `equals` `ok` — alongside the default 2xx status check.

That single keyword rule is the whole task. Without it, the most important failure
(worker down → no emails going out) is invisible.

---

## 5. Already-known launch items (unchanged)

- AWS SES production access (the main blocker) — lead the request with: opt-in,
  one-click unsubscribe, and bounce/complaint auto-suppression are already built in.
- Real Clerk Billing plan config; production `CLERK_WEBHOOK_SIGNING_SECRET`.
- A final human smoke test: sign-up → org → verify domain → send a real campaign.

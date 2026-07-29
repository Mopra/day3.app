# Day3 go-live runbook (SES + Clerk)

The app is deployed at **https://go.day3.app** with `EMAIL_PROVIDER=mock` (no real
email; the worker logs sends). This runbook flips it to real sending via Amazon
SES and finishes the Clerk webhook + billing wiring. Console-based, written for
someone doing it the first time.

Region everywhere: **Europe (Stockholm) = `eu-north-1`** (must match `AWS_REGION`).
Always check the AWS console region selector (top-right) is `eu-north-1`.

---

## Part 0 — Database migrations (run before serving traffic)

Apply the forward-only Drizzle migrations to Supabase **before** promoting a new
Vercel deployment or restarting the worker, so no release ever runs against an
old schema. This is the documented deploy-pipeline gate.

1. Point `DATABASE_URL` at the Supabase **direct/session** connection (port
   `5432`, not the pooler on `6543` — migrations need a real session).
2. Run:
   ```bash
   DATABASE_URL="postgres://…:5432/postgres" npm run db:migrate
   ```
   `drizzle-kit migrate` replays only the journal entries not yet recorded in the
   `__drizzle_migrations` table — it is idempotent, so re-running is safe.
3. Only after it succeeds: promote the Vercel deployment and
   `pm2 restart day3-worker` on the VPS.

CI guarantees the migrations match `src/db/schema.ts` (it re-runs
`drizzle-kit generate` and fails on any diff), so what you apply here is exactly
what the code expects. See [migration discipline](../README.md#migration-discipline).

---

## Part 1 — Amazon SES

### 1A. Create the configuration set `day3-default`
The app passes this name on every send; if it doesn't exist, sends fail.
1. AWS Console → **Amazon SES** → left nav **Configuration sets** → **Create set**.
2. Name: **`day3-default`** (exactly — it matches `SES_CONFIGURATION_SET`). Leave the
   rest default → **Create set**.

### 1B. Create an SNS topic for bounce/complaint events
1. AWS Console → **Amazon SNS** → **Topics** → **Create topic**.
2. Type **Standard**, Name **`day3-ses-events`** → **Create topic**.
3. Copy the **Topic ARN** (looks like `arn:aws:sns:eu-north-1:123456789012:day3-ses-events`).

### 1C. Point the config set's events at the topic
1. SES → **Configuration sets** → **day3-default** → **Event destinations** tab →
   **Add destination**.
2. Event types: tick **Bounces** and **Complaints** (Deliveries optional) → **Next**.
3. Destination: **Amazon SNS** → select **day3-ses-events** → name it `sns-dest` → **Add**.

### 1D. Subscribe the topic to the app webhook
1. SNS → **Topics** → **day3-ses-events** → **Create subscription**.
2. Protocol **HTTPS**, Endpoint **`https://go.day3.app/api/webhooks/ses`** →
   **Create subscription**.
3. SNS immediately POSTs a `SubscriptionConfirmation`; **the app auto-confirms it**
   (the webhook fetches the SubscribeURL). Refresh — status should go
   *Pending confirmation → Confirmed* within seconds.
4. (Recommended) Lock the webhook to this topic: set `SES_SNS_TOPIC_ARN` on Vercel
   to the Topic ARN, then redeploy. The webhook rejects messages from any other topic.

### 1E. Production access — ✅ GRANTED (2026-07-02)
Amazon SES production access has been approved: the account is **out of the sandbox**
and can send to any recipient (no per-address verification required). Nothing to do
here — proceed to 1F to flip the provider.

> Historical: while in sandbox you could only send to verified identities
> (SES → **Identities** → **Create identity** → verify your own address). No longer
> a constraint.

### 1F. Flip the provider to SES
- **Vercel:** set `EMAIL_PROVIDER=ses` (and `SES_SNS_TOPIC_ARN` from 1D) → redeploy.
- **VPS worker:** set `EMAIL_PROVIDER=ses` in `/opt/day3/.env.worker` → `pm2 restart day3-worker`.

### 1G. Test the headline domain-verification flow (in the app)
1. Sign in at https://go.day3.app, create/select an organization.
2. **Domains → Add domain** (e.g. `updates.yourdomain.com`). The app calls SES
   `CreateEmailIdentity` and shows **3 DKIM CNAME records**.
3. Add those CNAMEs at your DNS host (anywhere — that's the whole point vs Cloudflare).
4. Back in the app, click **Check**. When SES detects the records, status → **verified**
   (can take minutes to hours depending on DNS). The admin "override-verify" is a testing
   shortcut.
5. Create a campaign → **Send test email** to your own verified address → it goes out via
   SES. Bounces/complaints flow back through the SNS webhook → suppression + account-health
   auto-pause.

---

## Part 2 — Clerk webhook + billing

### 2A. Webhook (keeps local org/billing state in sync)
1. **dashboard.clerk.com** → your app → **Configure → Webhooks → Add Endpoint**.
2. Endpoint URL: **`https://go.day3.app/api/webhooks/clerk`**.
3. Subscribe to events: `organization.updated`, `organization.deleted`,
   `organizationMembership.created`, `organizationMembership.updated`,
   `organizationMembership.deleted`, `user.deleted`,
   `subscriptionItem.active`, `subscriptionItem.pastDue`, `subscriptionItem.ended`.
   > `user.deleted` and `organizationMembership.deleted` drive account/data erasure —
   > a member deleting their user is stripped from every org, and an org left with no
   > members is purged entirely. Without them, a deleted user's PII lingers and an
   > abandoned org is never erased.
4. **Create** → copy the **Signing Secret** (`whsec_…`).
5. Set `CLERK_WEBHOOK_SIGNING_SECRET` on Vercel → redeploy.

### 2B. Billing (bandwidth plans)
1. Clerk dashboard → **Configure → Billing** → enable (beta; backed by Stripe).
2. Create one plan **for Organizations** (not users) per paid tier, with slugs that
   **exactly match the plan keys** in `src/lib/plans-catalog.ts`: `1k_plan` ($1),
   `5k_plan` ($3), `10k_plan` ($5), `25k_plan` ($8), `50k_plan` ($14),
   `100k_plan` ($25), `250k_plan` ($60), `500k_plan` ($115), `1m_plan` ($220).
   The Free tier (`free_org`) is the default and needs no paid plan.
3. The app resolves the held tier from `has({ plan: "org:<slug>" })` (highest tier
   wins) and sets `monthlyEmailLimit` accordingly. The **Free tier is set-up-only**
   — an org can configure domains/senders/audiences and draft, but **cannot send**
   (and is capped at 500 subscribers) until it subscribes to a paid plan. A lapsed
   subscription gracefully downgrades back to Free rather than locking the account out.
4. **AI is included on every paid tier.** Only `free_org` accounts get the upgrade
   prompt and a 403 from the AI routes. The tiers differ in allowance size, not
   access: `1k_plan`/`5k_plan` carry a smaller credit budget than `10k_plan`+ (see
   `aiWindowCredits` / `aiMonthlyCredits` in `src/lib/plans-catalog.ts`). No Clerk
   configuration is involved — the allowance is enforced in-app. (AI also needs
   `OPENROUTER_API_KEY` configured.)

### Note on Clerk environments
**Production is live on the Clerk production instance** (frontend domain
`clerk.day3.app`, email/password only). On Vercel, the **Production** environment uses
the live keys (`pk_live_…` / `sk_live_…`) and the prod-instance webhook signing secret;
**Preview/Development still use the test instance** (`pk_test_…`, `expert-feline-46`) so
local/dev work is unaffected. The webhook (2A) and billing plans (2B) were recreated on
the prod instance.

To rotate any of these later, swap the Production env vars
(`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`)
and redeploy.

---

## What I can do for you (Vercel side)
Give me the values and I'll set + redeploy:
- the **SNS Topic ARN** → I set `SES_SNS_TOPIC_ARN` and flip `EMAIL_PROVIDER=ses`.

> Clerk production auth is already live — see "Note on Clerk environments" above.

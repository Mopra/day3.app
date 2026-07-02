# Day3 backlog (future work)

Tasks captured for later. Not started — design notes only, so the context doesn't
have to be re-derived when someone picks one up.

---

## Org deletion → real data erasure (GDPR right-to-erasure)

**Status:** not started · **Priority:** should-do before broad EU customer use

### Problem

Admins can already delete an organization — Clerk's `<OrganizationProfile>` (rendered
on the Settings page, [settings/page.tsx](../app/(app)/settings/page.tsx)) exposes a
"Delete organization" action. But deletion **erases nothing**:

- `organization.deleted` only soft-deactivates the account — sets
  `subscriptionStatus: "inactive"`, `sendingEnabled: false`, and drops the membership
  roster ([webhooks/clerk/route.ts:50-60](../app/api/webhooks/clerk/route.ts#L50-L60)).
  Every campaign, subscriber, import, domain, email event, and the `accounts` row
  itself stays in Postgres forever.
- There is **no DB-level cascade** to lean on: every `account_id` / `campaign_id` /
  `audience_id` in [schema.ts](../src/db/schema.ts) is a plain `text` column — no
  foreign keys, no `ON DELETE CASCADE`. A purge must be done explicitly in code.
- There is **no `user.deleted` handler** at all, so a deleted Clerk user leaves their
  email (PII) behind in `account_users`.

For an EU product storing customers' subscriber PII (names, emails), "delete" must
actually delete. Today it doesn't.

### Proposed design

The entry point exists; build the **erasure path** behind it.

1. **Keep the immediate soft-deactivate** on `organization.deleted` — it's the right
   safety stop (kills sending, drops the roster) and guards against an accidental click.
2. **Add a grace-window purge run by the existing cron sweep** (worker), not inline in
   the webhook:
   - Add `deleted_at` to `accounts` (migration). Set it on `organization.deleted`.
   - Cron sweeps accounts past a grace window (~14–30 days) **and** with no recipients
     still in `sending`. This gives an undo window, lets in-flight sends drain first
     (hard rule #1 — never risk a duplicate/partial send mid-purge), and reuses the
     worker's existing sweep infrastructure.
3. **Purge explicitly, in order, in a transaction** (child rows first):
   campaign_recipients → email_events → risk_reviews → campaigns → subscribers →
   imports → audiences → sending_domains → dns_integrations → account_users →
   suppression_entries (account-scoped only) → accounts.
   - **dns_integrations holds AES-256-GCM-encrypted OAuth tokens to the customer's DNS**
     ([schema.ts:101-124](../src/db/schema.ts#L101-L124)) — credentials. Delete them on
     purge, ideally revoke at Cloudflare too.
   - **Do NOT delete `scope='global'` suppression_entries** — global unsubscribe/
     complaint records must survive account deletion so we never re-email someone who
     opted out.
4. **Add a `user.deleted` webhook handler** — at minimum strip that user's
   `account_users` rows (their email is PII). Remember to also subscribe to
   `user.deleted` on the Clerk webhook endpoint (see go-live.md Part 2A — currently only
   `organization.*` and `subscriptionItem.*` are subscribed).

### Acceptance

- Deleting an org removes all of its subscriber/campaign PII from Postgres after the
  grace window, with no orphaned rows.
- In-flight sends are never interrupted mid-purge.
- Global suppressions and any legally-retained records survive.
- Deleting a Clerk user removes their PII from `account_users`.

---

## Deliverability onboarding & ESP-migration help

**Status:** not started · **Priority:** should-have before courting migrators from other ESPs

New sending domains get junked by Outlook for their first weeks (cold-start
reputation — our own first test send hit this with perfect SPF/DKIM/DMARC), and
migrators from other platforms lose their reputation if they mint a fresh
subdomain or skip importing their suppression list.

Full design in [deliverability-migration.md](deliverability-migration.md): four
features — migration copy in domain setup, suppression-list import (bulk-load
into the existing `suppression_entries` machinery), domain warm-up ramping
(daily caps reusing the send-batch pause/resume path), and a customer-facing
"getting into the inbox" doc. Build order and open questions in the doc.

# Day3 backlog (future work)

Tasks captured for later. Not started — design notes only, so the context doesn't
have to be re-derived when someone picks one up.

---

## Org deletion → real data erasure (GDPR right-to-erasure) — ✅ SHIPPED

Deleting an org (or the last member of an org deleting their user) now enqueues a
`purge_account` job that irreversibly erases every account-scoped row plus best-effort
external teardown (SES identities, uploaded files). **No grace window** — the product
decision was immediate, exception-free erasure. Global-scope suppression records are the
one deliberate survivor (legal duty to keep honoring opt-outs).

Implementation: [services/account-purge.ts](../src/services/account-purge.ts) (the
transactional DELETE-per-table), [queue/handlers/purge-account.ts](../src/queue/handlers/purge-account.ts)
(external teardown), `handleUserDeleted` / `removeMembershipAndMaybePurge` in
[services/accounts.ts](../src/services/accounts.ts), and the `organization.deleted` /
`user.deleted` / `organizationMembership.deleted` cases in
[webhooks/clerk/route.ts](../app/api/webhooks/clerk/route.ts). Tests in
[test/account-purge.test.ts](../test/account-purge.test.ts). Requires `user.deleted` +
`organizationMembership.deleted` subscribed on the Clerk webhook (see go-live.md Part 2A).

Possible follow-up (not required): revoke the Cloudflare OAuth token at the provider on
purge (today we just delete the encrypted `dns_integrations` row).

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

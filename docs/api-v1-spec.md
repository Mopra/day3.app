# Day3 Public API — v1 spec (draft)

Status: **implemented** (2026-07-06). Routes live under `app/api/v1/**`, the
shared layer under `src/api/v1/`, key management and the user-facing docs on the
**API keys** page (`app/(app)/api-keys/`, moved out of Settings 2026-07-29 —
see §4). Tests: `test/api-v1.test.ts`, `test/api-docs.test.ts`.
**Fixed 2026-07-29:** every timestamp was going out in Postgres' own text
rendering (`2026-07-29 11:37:42.401+01` — space separator, short offset, server
session timezone) rather than the ISO-8601 UTC promised in §1. `timestamptz`
columns are read in Drizzle's `mode: "string"`, so rows carry Postgres'
formatting straight through. Normalized in `src/api/v1/serialize.ts` (the
row → public-shape boundary); pagination cursors keep the raw column value.
Regression-pinned in `test/api-migration-flow.test.ts`.

**Added 2026-08-04: transactional email sending** (§2.0) — `POST /v1/emails`
plus its read endpoints, with a free-tier sandbox mode. Tests:
`test/transactional.test.ts`, `test/transactional-webhook.test.ts`.

Known deviations from the draft: contact `created_at`
backdating (open question 3) is not implemented; suppression GET lists only the
account's own entries (the single-email check also consults global entries).
Scope: transactional sending (§2.0), plus Audiences and everything inside them
(contacts, fields, segments, topics).
Goal: make migrating an audience from Resend / Mailchimp trivially easy, give
developers a Resend-grade DX with the migration gaps fixed (bulk upsert,
custom fields, suppression-state import), and let an app send its operational
email through the same verified domain as its newsletter.

Out of scope for v1: campaign (newsletter) sending, domains/senders,
customer-facing webhooks, OAuth. These get their own spec later; nothing below
should paint us into a corner on them.

---

## 1. Fundamentals

### Base URL & versioning

```
https://day3.app/api/v1
```

- Version in the path. `v1` is stable once shipped; breaking changes → `v2`.
- Additive changes (new fields, new endpoints, new enum values on *output*) are
  not breaking and can land in v1. Clients must ignore unknown response fields.
- Lives in `app/api/v1/**` — a separate namespace from the session-authenticated
  internal routes under `app/api/**`, which stay private and unversioned.

### Authentication — API keys

The internal API authenticates with Clerk session cookies; the public API uses
bearer keys:

```
Authorization: Bearer day3_live_x7Kj9mP2...
```

- **Format**: `day3_<env>_<40 chars base62>` where env is `live` or `test`.
  The prefix makes keys machine-identifiable in secret scanners (GitHub secret
  scanning partner format later).
- **Storage**: only a SHA-256 hash is stored; the full key is shown once at
  creation. First 8 chars after the prefix stored in plaintext for display
  ("`day3_live_x7Kj9mP2…`") in the settings UI.
- **Scoping**: a key belongs to one account (org). `requireApiKey()` resolves
  key → account and returns the same `AccountContext` shape as
  `requireAccount()` (src/api/context.ts), so services are reused unchanged and
  the account-scoping hard rule holds identically.
- **Schema**: new `api_keys` table — `id`, `account_id`, `name`, `key_hash`,
  `key_prefix`, `created_by` (Clerk user id), `last_used_at` (updated at most
  once/minute to avoid write amplification), `revoked_at`, `created_at`.
- **Scopes**: v1 ships a single implicit scope (full audience access). The
  column can be added later; the create endpoint takes no `scopes` param yet.
- **Management**: keys are created/revoked in the web app on the **API keys**
  page, admin-role only. No key-management endpoints in the public API itself (a
  key must not be able to mint keys).
- `test` keys: reserved in the format from day one, not implemented in v1
  (no sandbox mode yet). Rejected with a clear error if used.

### Request/response conventions

- JSON in, JSON out (`Content-Type: application/json`), UTF-8.
- All ids are strings with type prefixes (existing `newId` convention):
  `aud_…`, `sub_…`, `seg_…`, `top_…`, `fld_…`.
- Timestamps: ISO-8601 UTC (`2026-07-06T12:00:00.000Z`).
- Field naming: `snake_case` in the public API (matches Resend/Stripe
  conventions and survives non-JS clients well). Internal camelCase is mapped
  at the route layer by explicit serializers — **never** raw Drizzle rows out.
- Deletes return `200` with `{ "id": "...", "deleted": true }` (not 204 — a
  body confirms what was deleted and is friendlier to naive HTTP clients).

### Errors

One envelope everywhere:

```json
{
  "error": {
    "code": "contact_already_exists",
    "message": "A contact with this email already exists in this audience.",
    "request_id": "req_8fk2..."
  }
}
```

- `code` is the stable machine contract; `message` is human-readable and may
  change. Optional `param` field when a specific input field is at fault.
- `request_id` is always present (extends the existing correlation-id plumbing
  in `src/api/http.ts` from 500s to all error responses).

| HTTP | codes (non-exhaustive) |
|------|------------------------|
| 400 | `invalid_request`, `invalid_email`, `invalid_filter`, `batch_too_large` |
| 401 | `invalid_api_key`, `revoked_api_key` |
| 403 | `plan_limit_reached` (free-tier 500-subscriber cap), `test_keys_not_supported` |
| 404 | `not_found` (also returned for cross-account ids — never 403, don't leak existence) |
| 409 | `contact_already_exists`, `email_suppressed`, `idempotency_conflict` |
| 422 | `immutable_field` (e.g. changing a field's `key`) |
| 429 | `rate_limit_exceeded` (with `Retry-After`) |
| 500 | `internal_error` |

### Pagination

Cursor-based on every list endpoint (internal offset pagination is not exposed
— offsets break under concurrent writes, which is exactly the migration case):

```
GET /v1/audiences/aud_123/contacts?limit=100&after=sub_01h...
```

```json
{ "data": [ ... ], "has_more": true, "next_cursor": "sub_01h..." }
```

- `limit`: 1–100, default 50. `after`: opaque cursor from `next_cursor`.
- Stable ordering: `created_at DESC, id DESC` (cursor encodes both).

### Idempotency

Mutating endpoints (`POST`) accept an optional header:

```
Idempotency-Key: <client-generated, ≤255 chars>
```

- Scope: per account + endpoint. Replay within 24h returns the stored original
  response (same status + body) with `Idempotency-Replayed: true`.
- Same key with a **different** request body → `409 idempotency_conflict`.
- Backed by a small `idempotency_keys` table (Postgres, not Redis — must
  survive worker/Redis restarts; swept by the existing cron).
- The key row is a **claim**, written before the handler runs, so two
  *concurrent* requests with one key resolve to exactly one execution: the
  loser gets `409 idempotency_conflict` ("already in progress") and should
  retry in a moment. A claim abandoned by a crashed request is taken over
  after 5 minutes. `POST /v1/emails` completes its claim in the same
  transaction that writes the email row, so a crash mid-request either leaves
  no email (the retry re-executes) or an email whose response the retry
  replays — never a duplicate send.
- `PATCH`/`DELETE` are naturally idempotent and don't need the header.

### Rate limits

- Default: **10 requests/second** per account (sliding window, Redis — the
  worker's Redis is already provisioned), burst 20.
- Batch endpoints count as 1 request — this is the point: migrating 50k
  contacts is 50 batch calls, not 50k singles.
- Headers on every response: `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset` (IETF draft names), plus `Retry-After` on 429.

### Plan gating

The public API enforces exactly the same rules as the app (hard rule #5):

- Free tier (`free_org`): full API access, but subscriber writes respect the
  500-subscriber cap via `subscriberHeadroom` → `403 plan_limit_reached`.
  Batch requests that would cross the cap are rejected **whole** (never
  partially applied against a cap) with the headroom in the error message.
- Sending (`POST /v1/emails`) is gated by `planCanSend`, with a deliberate
  carve-out: a free org sends in **sandbox mode** — real sends, but only to
  addresses of its own organization's members, on a small monthly allowance
  (`SANDBOX_MONTHLY_ALLOWANCE`). Responses carry `"sandbox": true`. Recipients
  outside the org are `403 sandbox_recipient_not_allowed`; exhausting the
  allowance is `403 plan_limit_reached`. Upgrading lifts both with no code
  change. Transactional sends draw from the same monthly email allowance as
  campaigns.

---

## 2. Resources

Naming: internally these rows are `subscribers`; the public API says
**`contacts`** (matches the UI's Contacts tab and Resend/Mailchimp vocabulary).

### 2.0 Emails (transactional sending)

`POST /v1/emails` · `GET /v1/emails` · `GET /v1/emails/{id}`

The app's operational email — password resets, receipts, magic links.
Resend-compatible request shape. Implementation: `app/api/v1/emails/**`,
worker job `src/queue/handlers/send-transactional.ts`; product docs in
`PRODUCT.md §6.15`.

**`POST /v1/emails`** — request:

```json
{
  "from": "Acme <notifications@updates.acme.com>",
  "to": ["jane@example.com"],
  "subject": "Reset your password",
  "html": "<p>…</p>",
  "text": "…",
  "reply_to": "support@acme.com",
  "headers": { "X-Entity-Ref-ID": "abc" },
  "tags": { "type": "password-reset" }
}
```

- `from`, `to`, `subject`, and at least one of `html` / `text` are required.
- `from` accepts a bare address or `"Name <addr>"`, and must be on a **verified
  sending domain** of the account — any local-part works, no pre-created sender
  needed. Otherwise `403 domain_not_verified`.
- `to` is a string or an array of up to **50** addresses: ONE message whose To
  header lists them all (not 50 separate emails). Addresses are canonicalized
  and de-duplicated; each one counts against the monthly allowance.
- `headers`: up to 20. Reserved names are rejected with `400` —
  everything derived from the body (`from`/`to`/`subject`/`reply-to`/…), MIME
  plumbing, auth/trace headers (`DKIM-Signature`, `Authentication-Results`,
  `ARC-*`, `Received`, `Sender`, `Resent-*`), the unsubscribe headers, our
  `X-Account-ID` / `X-Transactional-Email-ID`, and any `X-SES-*`.
- Control characters are rejected in `subject`, header values, and addresses;
  a display name may not contain `< > " \` (header-injection defense).
- Aggregate size ceiling across html + text + headers + tags:
  `MAX_TOTAL_BYTES` (1.5 MB of UTF-8).
- Sending has its own rate bucket (`transactional_send`, default 120/min per
  account) inside the general API limit.

Response — the Email object, `202`-in-spirit but returned as `200`:

```json
{
  "id": "eml_…", "object": "email",
  "from": "Acme <notifications@updates.acme.com>",
  "to": ["jane@example.com"],
  "reply_to": null,
  "subject": "Reset your password",
  "status": "queued",
  "error": null,
  "tags": { "type": "password-reset" },
  "sandbox": false,
  "created_at": "2026-08-04T08:00:00.000Z",
  "sent_at": null, "delivered_at": null,
  "bounced_at": null, "complained_at": null
}
```

`status` walks `queued` → `sent` → `delivered`, or ends at `bounced`,
`complained`, `failed`, `suppressed`. Delivery is asynchronous (a
top-priority worker job — a transactional send never waits behind a campaign
drain) and normally completes within seconds. The internal `sending` state is
reported as `queued`.

**`GET /v1/emails/{id}`** adds `events`: the delivery timeline
(`[{ "type": "sent", "created_at": … }, { "type": "delivery", … }]`), fed by
the SES/SNS webhook. **`GET /v1/emails`** lists newest-first with cursor
pagination and `?status=queued|sent|delivered|bounced|complained|failed|suppressed`.

Suppression semantics differ from campaigns on purpose: a hard bounce,
complaint, or provider suppression blocks the send (`400 email_suppressed`),
but an **unsubscribe does not** — opting out of a newsletter must never block
a password reset. Bounces and complaints on transactional mail feed the
suppression list and count toward the account's reputation auto-pause exactly
like campaign sends.

Bodies (`html`/`text`) are pruned after
`TRANSACTIONAL_BODY_RETENTION_DAYS` (30); the metadata row is kept, and the
API/UI report the content as expired rather than empty.

### 2.1 Audiences

`GET /v1/audiences` · `POST /v1/audiences` · `GET /v1/audiences/{id}` ·
`PATCH /v1/audiences/{id}` · `DELETE /v1/audiences/{id}`

**Object**

```json
{
  "id": "aud_abc123",
  "object": "audience",
  "name": "Product newsletter",
  "contact_counts": { "subscribed": 4210, "unsubscribed": 130, "total": 4402 },
  "created_at": "2026-01-15T09:30:00.000Z",
  "updated_at": "2026-06-01T14:00:00.000Z"
}
```

- `POST` body: `{ "name": string (1–100) }`.
- `contact_counts` appears on `GET /{id}` only (list omits it — it's a count
  query per row).
- `DELETE` deletes the audience **and all contacts, fields, segments, topics in
  it** (matches internal behavior). Irreversible; documented loudly.

### 2.2 Contacts

```
GET    /v1/audiences/{audience_id}/contacts            list (+ filters)
POST   /v1/audiences/{audience_id}/contacts            create (or upsert)
POST   /v1/audiences/{audience_id}/contacts/batch      bulk create/upsert  ← the migration endpoint
GET    /v1/audiences/{audience_id}/contacts/{id_or_email}
PATCH  /v1/audiences/{audience_id}/contacts/{id_or_email}
DELETE /v1/audiences/{audience_id}/contacts/{id_or_email}
```

**Addressing**: `{id_or_email}` accepts a `sub_…` id **or** a URL-encoded email
(`…/contacts/jane%40acme.com`). Email is unique per audience (existing unique
index), so this is unambiguous — and it removes the "look up the id first"
round-trip that makes Resend/Mailchimp migrations painful.

**Object**

```json
{
  "id": "sub_xyz789",
  "object": "contact",
  "email": "jane@acme.com",
  "first_name": "Jane",
  "last_name": "Doe",
  "attributes": { "company": "Acme", "plan": "pro" },
  "status": "subscribed",
  "source": "api",
  "topics": null,
  "created_at": "2026-03-10T08:00:00.000Z",
  "updated_at": "2026-07-01T10:00:00.000Z"
}
```

- `attributes`: flat string→string bag, ≤50 keys, key matches the existing
  `FIELD_KEY_RE`, value ≤500 chars. **Unknown keys auto-register** in the
  audience's field registry (same behavior as CSV import / manual add) — no
  pre-declaring fields, unlike Mailchimp merge fields.
- `status` (writable subset): `subscribed` (default) and `unsubscribed` on
  create — **suppression-state import is first-class** so a migrating sender
  can carry over opt-outs and never re-mail them. `bounced` / `complained` /
  `suppressed` / `pending` are read-only (owned by the delivery pipeline and
  double opt-in flow). PATCH may flip `subscribed` ↔ `unsubscribed` only.
- `topics` on the contact object is `null` unless requested with
  `?expand=topics` (then: effective per-topic subscription map, defaults
  applied — see §2.5).
- `source` is set to `"api"` for API-created contacts.

**Create — `POST …/contacts`**

```json
{
  "email": "jane@acme.com",           // required
  "first_name": "Jane",
  "last_name": "Doe",
  "attributes": { "company": "Acme" },
  "status": "subscribed",             // or "unsubscribed" (migration)
  "unsubscribed_at": "2025-11-02T10:00:00.000Z"  // optional, only with status=unsubscribed
}
```

Query param `?upsert=true` switches conflict behavior:

| | email is new | email exists |
|---|---|---|
| default | `201` created | `409 contact_already_exists` |
| `upsert=true` | `201` created | `200` updated (merge semantics below) |

Upsert merge: provided fields overwrite; `attributes` is a **shallow merge**
(provided keys overwrite, absent keys survive, `null` value deletes a key).
Same semantics on PATCH.

Suppression check: an email on the account's suppression list → `409
email_suppressed` (identical to the internal route).

**Batch — `POST …/contacts/batch`**

The migration workhorse. Up to **1,000 contacts** per call, each item the same
shape as single create; top-level `"upsert": true|false` applies to all items.

```json
{
  "upsert": true,
  "contacts": [ { "email": "a@x.com", ... }, { "email": "b@y.com", ... } ]
}
```

Response `200` (even with item failures — per-row results, no all-or-nothing):

```json
{
  "object": "batch_result",
  "summary": { "created": 940, "updated": 55, "failed": 5 },
  "results": [
    { "index": 0, "status": "created", "id": "sub_..." },
    { "index": 1, "status": "updated", "id": "sub_..." },
    { "index": 2, "status": "failed",
      "error": { "code": "invalid_email", "message": "..." } }
  ]
}
```

- Whole-request rejections (nothing applied): >1,000 items
  (`400 batch_too_large`), duplicate emails **within** the payload
  (`400 invalid_request`, offending indexes listed), free-tier cap would be
  crossed (`403 plan_limit_reached`).
- Per-item failures: invalid email, suppressed email, non-upsert conflict.
- Executed synchronously in chunked multi-row inserts (existing 65535-bound-
  params rule) — 1,000 rows is comfortably one transaction. Field
  auto-registration runs once over the union of attribute keys.
- With `Idempotency-Key`, a network-failed batch can be retried safely — this
  plus per-row results is what makes a migration script dumb-simple:
  `while (page = fetch_from_old_provider()) day3.batch(page)`.
- Rationale for sync-over-async: 1,000-row inserts are fast; an async job
  handle would force every migration script to poll. The async path already
  exists for huge sets (CSV import); if we later expose it, it becomes
  `POST …/imports`, a separate resource, not a mode of this endpoint.

**List filters**: `?status=`, `?email=` (exact match), `?segment_id=`
(live segment evaluation, same as internal), plus cursor pagination.

**Delete** removes the row (GDPR erasure). Docs note: to stop mailing someone
*without* erasing them, PATCH `status=unsubscribed` instead.

### 2.3 Fields

```
GET/POST  /v1/audiences/{audience_id}/fields
GET/PATCH/DELETE /v1/audiences/{audience_id}/fields/{id_or_key}
```

**Object**

```json
{
  "id": "fld_123",
  "object": "field",
  "key": "company",
  "label": "Company",
  "type": "text",            // "text" | "number" | "date"
  "fallback": null,
  "created_at": "...", "updated_at": "..."
}
```

- `key` is immutable (renaming would orphan stored attribute values) —
  PATCH with `key` → `422 immutable_field`.
- Explicit `POST` is mostly for setting `label`/`type`/`fallback` up front;
  fields also appear automatically when contacts arrive with new attribute
  keys (auto-registration).
- `DELETE` removes the registry row only; stored values in contact
  `attributes` are untouched (matches internal semantics; documented).
- Addressable by `fld_…` id or by `key`.

### 2.4 Segments

```
GET/POST  /v1/audiences/{audience_id}/segments
GET/PATCH/DELETE /v1/audiences/{audience_id}/segments/{id}
GET       /v1/audiences/{audience_id}/segments/{id}/contacts   (live members, paginated)
```

**Object**

```json
{
  "id": "seg_456",
  "object": "segment",
  "name": "Pro-plan customers",
  "filter": {
    "match": "all",
    "conditions": [
      { "field": "plan", "op": "equals", "value": "pro" },
      { "field": "company", "op": "is_set" }
    ]
  },
  "created_at": "...", "updated_at": "..."
}
```

- `filter` is the existing `SegmentFilterSchema` (`src/lib/segment-filter.ts`)
  verbatim — it becomes **public contract**: `match: "all"|"any"`, 1–10
  conditions, ops `equals | not_equals | contains | not_contains | is_set |
  is_not_set | greater_than | less_than`, `field` = `email` / `first_name` /
  `last_name` or any custom key. Any future op additions are additive
  (accepting new ops in, never removing).
- Segments are live filters — membership is computed at read time, never
  materialized. `…/contacts` returns current matches with standard pagination.
- Invalid filter → `400 invalid_filter` with the offending condition index.

### 2.5 Topics

```
GET/POST  /v1/audiences/{audience_id}/topics
GET/PATCH/DELETE /v1/audiences/{audience_id}/topics/{id}

GET   /v1/audiences/{audience_id}/contacts/{id_or_email}/topics
PATCH /v1/audiences/{audience_id}/contacts/{id_or_email}/topics
```

**Topic object**

```json
{
  "id": "top_789",
  "object": "topic",
  "name": "Product updates",
  "description": "Release notes and changelogs",
  "default_subscribed": true,
  "created_at": "...", "updated_at": "..."
}
```

**Contact topic subscriptions** — `GET …/{id_or_email}/topics` returns the
*effective* state (explicit rows overlaid on defaults):

```json
{
  "data": [
    { "topic_id": "top_789", "name": "Product updates",
      "subscribed": false, "is_default": false },
    { "topic_id": "top_790", "name": "Promotions",
      "subscribed": true,  "is_default": true }
  ]
}
```

`PATCH` takes a partial map and records explicit deviations (absent topics
untouched — matches the internal sparse-row model):

```json
{ "topics": { "top_789": false, "top_790": true } }
```

This lets a Mailchimp migration carry over group/interest opt-ins in one call
per contact — or via the batch endpoint's optional per-contact
`"topics": { ... }` key (same shape, applied after upsert).

### 2.6 Suppressions (account-level)

```
GET  /v1/suppressions
GET  /v1/suppressions/{email}    → 200 (suppressed, with reason) | 404
POST /v1/suppressions            add entries (guardrailed — see below)
```

Not audience-scoped (suppression is account-wide). Reads let a migration
script check *why* a batch item failed with `email_suppressed` and let senders
audit their list.

**Writes are allowed** — importing the old provider's suppression list
(hard bounces, complaints, global unsubscribes) protects Day3's SES sender
reputation as much as the customer's: without it, their first send re-mails
addresses that already bounced or complained elsewhere. A suppression write is
account-wide and close to irreversible in practice, so it's the API's biggest
foot-gun (posting the wrong file — e.g. the full contact list instead of the
suppression export — silently makes the whole audience unmailable). Guardrails:

```json
{
  "reason": "bounced",              // required: "unsubscribed" | "bounced" | "complained"
  "emails": ["a@x.com", "b@y.com"]  // ≤1,000 per call
}
```

- **`reason` is required and explicit** — no default. It's stored per entry
  and shown in the app, so an accidental import is attributable and auditable.
- Response echoes the blast radius so scripts (and humans) can sanity-check:
  `{ "added": 950, "already_suppressed": 45, "invalid": 5,
     "total_suppressed_before": 200, "total_suppressed_after": 1150 }`.
- **API writes are add-only.** No `DELETE /v1/suppressions/{email}` in v1 —
  un-suppression is a deliberate act done in the app UI (per-entry, with the
  entry's reason and source visible), so a scripting mistake is recoverable
  but can't be script-reverted in bulk (and a compromised key can't unsuppress
  bounced addresses to force-mail them).
- Entries created via API are tagged `source: "api"` (with the key id), so the
  app can offer "undo this import" as a batch operation on exactly those rows.
- `Idempotency-Key` supported, same semantics as contact batch.
- Suppressing an email does **not** delete existing contact rows; those
  contacts simply become unmailable (and batch/create for that email returns
  `409 email_suppressed`), matching internal behavior.

---

## 3. What we deliberately do better than Resend / Mailchimp

| Pain point | Resend | Mailchimp | Day3 v1 |
|---|---|---|---|
| Bulk import | none — 1 contact/request at 2 req/s | batch API exists but async + awkward | 1,000/call sync batch, per-row results, idempotent retry |
| Upsert | no — GET id first, then PATCH | `PUT` with MD5(email) as id | `?upsert=true` + address by plain email |
| Custom fields | not supported | pre-declared merge fields, nested ceremony | free-form `attributes`, auto-registered |
| Bring opt-out state | no | partial (`unsubscribed` on import is fiddly) | `status: "unsubscribed"` first-class on create/batch |
| Bring suppression list (bounces/complaints) | no | no | `POST /v1/suppressions`, guardrailed (§2.6) |
| Contact id | ULID | MD5 of lowercased email | prefixed id **or** email, both addressable |
| Segments over API | not supported | complex, half-documented | full CRUD + live members endpoint |

---

## 4. Implementation notes (non-normative)

- New: `api_keys` + `idempotency_keys` tables (one migration; remember
  `db:generate` **and** `db:migrate`), `requireApiKey()` in `src/api/context.ts`,
  `src/api/v1/serialize.ts` (row → public shape), error-envelope helper
  extending `HttpError` with a `code`, Redis sliding-window rate limiter,
  Settings → API keys UI.
- Routes reuse existing services (`subscriber-limit`, `suppression`,
  `audience-fields`, `segment-filter`) — the v1 layer is auth + validation +
  serialization, not new business logic. The batch endpoint is the only
  substantial new service code.
- Tests: vitest + pglite as usual; key auth gets its own suite (hashing,
  revocation, cross-account 404s).
- ~~Docs site~~ — **shipped as the API keys page instead** (2026-07-29). For a
  migration-focused API the docs *are* the product, but a static docs site is the
  wrong shape: the assets people need are account-specific. `app/(app)/api-keys/`
  puts them directly under the key list, built by `src/lib/api-docs.ts` and
  filled in with the caller's real audience id and base URL:
  - quickstart (base URL → `export DAY3_API_KEY=…`, prefilled with the key just
    minted, held in memory only → verification request),
  - **AI-assistant prompts** — *integrate*, *migrate from another provider*,
    *keep my users in sync* — each with the complete reference appended, plus the
    reference alone as Markdown for a repo's `AGENTS.md`/`CLAUDE.md`. This
    replaces the planned per-provider migration guides: one prompt covers every
    source, because the assistant reads the user's actual export.
    **Prompts never embed a live key** — they instruct the assistant to read
    `DAY3_API_KEY` from the environment, since prompts get pasted into
    third-party chat tools.
  - cURL/JS/Python snippets for the five common tasks, and an endpoint map.
  - a **subscriber-cap warning** on capped plans, from
    `GET /api/account/subscriber-limit` (its own endpoint, not a field on
    `/api/account` — the app shell fetches that on every navigation and this
    needs a `count(*)`). The cap rejects an oversized import *whole* on the
    first batch, so the page states the exact headroom before anything is
    copied, and the same figure goes into the prompts' ground rules so the
    assistant counts source rows up front instead of reacting to a 403.
  `test/api-docs.test.ts` guards the two invariants: no snippet may carry a live
  key, and every `route.ts` under `app/api/v1/**` must appear in the reference —
  so a new endpoint can't ship undocumented.
  `test/subscriber-limit-route.test.ts` pins the headroom figure to what the
  write path enforces (all rows, every status, whole account) — a warning that
  disagreed with enforcement would be worse than none.
- `PRODUCT.md` gets a Public API section in the same PR that ships this.

## 5. Open questions

1. ~~**Key management UI placement**~~ — **resolved: a dedicated page**
   (2026-07-29). `/api-keys`, its own sidebar item below Billing. Settings keeps
   a one-line pointer. It outgrew a settings section the moment the docs moved
   in with it, and it's where webhooks will land when they ship.
2. ~~**Suppression writes**~~ — **resolved: allowed with guardrails** (required
   explicit `reason`, add-only via API with un-suppression reserved to the app
   UI, before/after counts in the response, `source: "api"` tagging for batch
   undo). See §2.6.
3. **Historical timestamps** — accept `created_at` on contact create so a
   migrated list keeps original signup dates? Useful (age-based segments),
   slightly weird (API writes history). Leaning yes, capped to past dates.
   Still open. Note the current behaviour is the bad kind of "no": `created_at`
   in a payload is **silently stripped** by the Zod schema rather than
   rejected, so a migration script that tries looks like it worked. The docs
   now say so explicitly (`src/lib/api-docs.ts`); if this stays unimplemented,
   consider rejecting the field outright instead.
4. **Rate-limit tiering** — flat 10 rps for all plans, or scale with plan?
   Flat is simpler and fine until proven otherwise.

---

*Last updated: 2026-07-29 · Author: draft by Claude for Morten's review*

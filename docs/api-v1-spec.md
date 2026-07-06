# Day3 Public API — v1 spec (draft)

Status: **draft for review — nothing here is built yet.**
Scope: Audiences and everything inside them (contacts, fields, segments, topics).
Goal: make migrating an audience from Resend / Mailchimp trivially easy, and give
developers a Resend-grade DX with the migration gaps fixed (bulk upsert,
custom fields, suppression-state import).

Out of scope for v1: campaigns/sending, domains/senders, webhooks, OAuth. These
get their own spec later; nothing below should paint us into a corner on them.

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
- **Management**: keys are created/revoked in the web app (Settings → API keys),
  admin-role only. No key-management endpoints in the public API itself (a key
  must not be able to mint keys).
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
- No send-related endpoints exist in v1, so `planCanSend` is not in play yet.

---

## 2. Resources

Naming: internally these rows are `subscribers`; the public API says
**`contacts`** (matches the UI's Contacts tab and Resend/Mailchimp vocabulary).

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
- Docs site with runnable curl examples ships with the endpoints — for a
  migration-focused API the docs *are* the product. Include a "Migrate from
  Resend" and "Migrate from Mailchimp" guide, each a complete ~30-line script.
- `PRODUCT.md` gets a Public API section in the same PR that ships this.

## 5. Open questions

1. **Key management UI placement** — Settings page vs. a dedicated Developers
   page (which would also house future webhooks + docs links)?
2. ~~**Suppression writes**~~ — **resolved: allowed with guardrails** (required
   explicit `reason`, add-only via API with un-suppression reserved to the app
   UI, before/after counts in the response, `source: "api"` tagging for batch
   undo). See §2.6.
3. **Historical timestamps** — accept `created_at` on contact create so a
   migrated list keeps original signup dates? Useful (age-based segments),
   slightly weird (API writes history). Leaning yes, capped to past dates.
4. **Rate-limit tiering** — flat 10 rps for all plans, or scale with plan?
   Flat is simpler and fine until proven otherwise.

---

*Last updated: 2026-07-06 · Author: draft by Claude for Morten's review*

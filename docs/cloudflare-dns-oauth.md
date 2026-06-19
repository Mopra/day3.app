# Auto-configure DNS via Cloudflare OAuth

Goal: when a user adds a sending domain, let them click **Connect Cloudflare** →
consent → and we write the SES verification records (DKIM CNAMEs, DMARC TXT)
directly into their Cloudflare zone. No copy-pasting. The existing SES poll then
flips the domain to verified. Vercel-style one-click.

This is possible because Cloudflare shipped **self-managed OAuth clients** on
2026-06-03 (authorization code + PKCE, scopes that mirror API-token permissions,
refresh tokens). Before that date, third-party OAuth for Cloudflare DNS did not
exist.

## What we already have (the hard part is done)

- SES already computes the exact records on domain add and stores them as a
  `DnsRecord[]` in `sending_domains.dns_records_json`
  (`src/services/ses-identity.ts`, `app/api/domains/route.ts`).
- The setup UI already renders those records as copy cards
  (`src/components/domain-setup-guide.tsx`) and polls
  `POST /api/domains/[id]/check` until SES reports verified.

So this feature is **a writer that consumes the records we already produce**, plus
an OAuth connection to authorize the write. The SES/verification half is untouched.

---

## Phase 0 — Cloudflare app registration (EXTERNAL — start immediately)

This is gated on Cloudflare, not on us, and has lead time. Start it in parallel
with Phase 1.

1. Cloudflare dash → **Manage account → OAuth clients** → create a self-managed
   client.
2. Configure:
   - **Redirect URIs** (exact match): `https://<prod-host>/api/integrations/cloudflare/callback`
     and a localhost URI for dev.
   - **Scopes**: minimum needed — DNS **edit** for zones + zone **read** (to look
     up the zone by domain name). Request nothing else.
3. **Domain-verify the app** so the consent screen shows a verified badge instead
   of an "unverified app" warning, then submit it for **public** visibility — apps
   start private (only your own CF account can authorize) until they meet the
   public prerequisites. **Treat this as a launch dependency with review lead
   time** (Google-OAuth-style). We can build and test against our own CF account
   while it's pending.
4. Capture `client_id`, `client_secret`.

> ⚠️ **Verify verbatim from the live docs before coding** (the feature is ~2 weeks
> old): the exact **authorize** and **token** endpoint URLs, the **scope
> identifiers**, refresh-token behaviour, and whether a token **revocation**
> endpoint exists. The flow below uses standard OAuth 2.0 + PKCE shapes; only the
> literal URLs/scope strings are TBD.

### Env / secrets to add
```
CLOUDFLARE_OAUTH_CLIENT_ID=
CLOUDFLARE_OAUTH_CLIENT_SECRET=
CLOUDFLARE_OAUTH_REDIRECT_URI=https://<host>/api/integrations/cloudflare/callback
DNS_TOKEN_ENC_KEY=            # 32-byte base64 key for AES-GCM token encryption
OAUTH_STATE_SECRET=          # HMAC secret for the signed PKCE/state cookie
# Endpoints are global; the code defaults to these, override only if needed:
CLOUDFLARE_OAUTH_AUTHORIZE_ENDPOINT=https://dash.cloudflare.com/oauth2/auth
CLOUDFLARE_OAUTH_TOKEN_ENDPOINT=https://dash.cloudflare.com/oauth2/token
CLOUDFLARE_OAUTH_REVOKE_ENDPOINT=https://dash.cloudflare.com/oauth2/revoke
CLOUDFLARE_OAUTH_USERINFO_ENDPOINT=https://dash.cloudflare.com/oauth2/userinfo   # best-effort "connected as" label
CLOUDFLARE_OAUTH_SCOPES=dns.write zone.read   # REQUIRED: Cloudflare 400s the consent if scope is empty
```
> Token Authentication Method is **client_secret_basic** (matches the code).
> Cloudflare **requires** the `scope` param at consent — an empty scope returns a
> 400 from `/oauth/consent-form/api/consent`. The exact scope ids (from
> `GET api.cloudflare.com/client/v4/oauth/scopes`) for this client are:
> **`dns.write`** (DNS edit) and **`zone.read`**. They must match the client's
> configured scopes. No `offline_access` scope exists — refresh tokens are issued
> by default.

---

## Phase 1 — Data model

New table `dns_integrations` (one Cloudflare connection per account):

| column            | type        | notes                                            |
|-------------------|-------------|--------------------------------------------------|
| id                | text PK     | `newId("dnsint")`                                |
| account_id        | text        | scoped like every other table                    |
| provider          | text        | `"cloudflare"`                                   |
| access_token_enc  | text        | AES-GCM ciphertext (iv prepended)                |
| refresh_token_enc | text        | AES-GCM ciphertext                               |
| expires_at        | timestamptz | access-token expiry                              |
| scope             | text        | granted scopes                                   |
| cf_account_label  | text        | e.g. connected user email, for UI display        |
| status            | text        | `connected` / `revoked` / `error`                |
| created_at / updated_at | timestamptz |                                            |

- Unique index on `(account_id, provider)` — one CF connection per account.

Add to `sending_domains`:
- `dns_zone_id` text — the resolved Cloudflare zone id.
- `dns_auto_configured` boolean default false — records were written by us.
- `dns_write_error` text — last write error surfaced to the UI (nullable).

Token encryption: `src/lib/crypto.ts` with AES-GCM via WebCrypto `subtle`
(`encryptSecret`/`decryptSecret`), key from `DNS_TOKEN_ENC_KEY`. Never store or
log plaintext tokens.

Migration: `npm run db:generate` then `npm run db:migrate:local`.

---

## Phase 2 — OAuth connect flow (3 route handlers)

Mirror the existing `route()` / `requireAccount()` / `HttpError` / `json`
conventions in `app/api/...`.

1. **`GET /api/integrations/cloudflare/connect`**
   - Generate `state` (CSRF) + PKCE `code_verifier` → `code_challenge` (S256).
   - Store `{state, code_verifier, accountId, returnTo}` in a short-lived
     (~10 min) **httpOnly, signed cookie** (stateless; no DB row needed).
   - Redirect to Cloudflare authorize endpoint with `response_type=code`,
     `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`,
     `code_challenge_method=S256`.

2. **`GET /api/integrations/cloudflare/callback`**
   - Read the cookie; validate `state` matches the query `state`.
   - Exchange `code` at the token endpoint (`client_id`, `client_secret`, `code`,
     `redirect_uri`, `code_verifier`).
   - Receive `access_token`, `refresh_token`, `expires_in`, `scope`.
   - Optionally fetch CF user/account info for `cf_account_label`.
   - Encrypt tokens, **upsert** `dns_integrations` for the account, clear the
     cookie, redirect back to `returnTo` (the domain page) with `?connected=1`.

3. **`DELETE /api/integrations/cloudflare`**
   - Revoke the token at Cloudflare (if a revocation endpoint exists), delete the
     row. Powers the "Disconnect" button.

---

## Phase 3 — Cloudflare API client (`src/services/cloudflare-dns.ts`)

- `getValidAccessToken(integration)` — if `expires_at` is past, refresh using the
  refresh token, persist the new encrypted tokens, return the access token.
- `findZone(token, domain)` — `GET /zones?name=<registrableRoot(domain)>`
  (reuse `registrableRoot` from `src/lib/domain.ts`). Returns the zone id, or
  `null` if the domain isn't in this CF account (UI message: "We couldn't find
  this domain in your Cloudflare account").
- `upsertRecord(token, zoneId, record)` — **idempotent** (house rule #1):
  - `GET /zones/{zoneId}/dns_records?type={type}&name={name}`.
  - If a matching record with identical content exists → **skip**.
  - If it exists with different content → `PATCH`.
  - Else → `POST`.
  - Always send `proxied: false` and `ttl: 1` (auto). **`proxied: false` is
    critical** — a proxied (orange-cloud) DKIM CNAME silently breaks mail auth.
- `writeRecords(token, zoneId, records)` — map each `DnsRecord` → CF payload
  (`{ type, name, content: value, proxied: false, ttl: 1 }`), run sequentially,
  return a per-record result (`created | updated | skipped | error`).

---

## Phase 4 — Wire into the domain flow

New route **`POST /api/domains/[id]/auto-configure`**:
1. `requireAccount()`, load the domain scoped by `account_id`.
2. Load the account's `dns_integrations` row → if none, `409 "Connect Cloudflare
   first"`.
3. If `dns_records_json` is empty, refresh it from SES first (reuse the
   `getDomainIdentity` path from `/check`).
4. `getValidAccessToken` → `findZone` → if `null`, return a clear error.
5. `writeRecords`; persist `dns_zone_id`, `dns_auto_configured = true`, and set or
   clear `dns_write_error`.
6. Return the updated domain + per-record results. The existing front-end poll
   (or an immediate `/check` call) then verifies via SES.

Log each write to the existing `job_logs` table (`job_type: "dns_write"`,
`entity_type: "domain"`, `entity_id: domainId`) — without tokens.

---

## Phase 5 — UI (`src/components/domain-setup-guide.tsx` + settings)

When a domain is unverified and records exist:
- **CF connected** → prominent **"Configure automatically with Cloudflare"**
  button → `POST .../auto-configure` → toast + per-record success → existing poll
  flips it to verified.
- **Not connected** → **"Connect Cloudflare to set this up automatically"** →
  redirects through the connect flow; on return (`?connected=1`) show the
  auto-configure button.
- Keep the manual copy-paste cards as an **"Add manually instead"** fallback for
  users not on Cloudflare.
- Optional nicety: detect the domain is on Cloudflare via a DoH NS lookup
  (`https://cloudflare-dns.com/dns-query?name=<root>&type=NS`) to decide whether
  to surface the CF option first. Not required for MVP — if the zone isn't found
  we tell them.

`settings/page.tsx`: a "Connections" section showing **Cloudflare — connected as
{label}** with a **Disconnect** button (`DELETE /api/integrations/cloudflare`).

---

## Key rotation (encrypt-at-rest)

DNS tokens are AES-256-GCM ciphertext tagged with the **key id** that produced
them: stored as `<keyId>.<base64(iv||ct+tag)>` (see `src/lib/crypto.ts`). The id
prefix lets multiple keys coexist, so the encryption key can be rotated — which
is mandatory after any suspected exposure — **without downtime and without
forcing customers to reconnect**.

Configure keys as a keyring (either form works; the keyring form enables
rotation):

- `DNS_TOKEN_ENC_KEY` — single key. Treated as key id `v1`. Pre-versioning
  ciphertext (no prefix) is also read as `v1`.
- `DNS_TOKEN_ENC_KEYS` — comma-separated `id:base64key` pairs (e.g.
  `v1:<base64>,v2:<base64>`). **Every listed key can decrypt.**
- `DNS_TOKEN_ENC_ACTIVE_KEY_ID` — which id **encrypts** new tokens.

Decryption selects the key by the ciphertext's id and **fails closed**: an
unknown id throws a clear error and never returns plaintext, so a key that was
retired too early surfaces loudly instead of leaking.

### Rotation procedure (zero downtime)

1. Generate a new key:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Add it to `DNS_TOKEN_ENC_KEYS` **alongside the old one**, e.g.
   `DNS_TOKEN_ENC_KEYS=v1:<old>,v2:<new>`. Both keys are now live, so every
   existing row still decrypts.
3. Set `DNS_TOKEN_ENC_ACTIVE_KEY_ID=v2` and deploy. New writes use `v2`; old
   rows are still read with `v1`.
4. Re-encrypt existing rows: `npm run keys:rotate-dns`. It decrypts each row with
   whichever key it carries and rewrites it under the active key. Idempotent —
   re-run until it reports `rotated=0`.
5. Once nothing is left on `v1`, drop it: `DNS_TOKEN_ENC_KEYS=v2:<new>` (and set
   the active id to `v2`), then deploy. The old key is now fully retired.

---

## Phase 6 — Security checklist

- Tokens encrypted at rest (AES-GCM), key in secrets, never in the DB plaintext
  or logs. The refresh token can edit the customer's DNS — treat like a password.
- Request the **minimum** scopes (DNS edit + zone read).
- CSRF via `state` + httpOnly signed cookie; exact-match redirect URI allowlist.
- PKCE S256 on the authorization code exchange.
- Visible disconnect that **revokes** server-side.
- Every domain query stays scoped by `account_id` (house rule #3).

---

## Phase 7 — Tests (Vitest)

- `crypto.ts` encrypt/decrypt round-trip.
- connect: state + PKCE challenge generation; cookie set.
- callback: token exchange (mocked CF), encrypted upsert, state mismatch rejected.
- `findZone`: match, subdomain→root match, not-found → null.
- `upsertRecord` idempotency: skip identical, patch changed, create missing, and
  **asserts `proxied: false`** on every write.
- `auto-configure`: end-to-end with mocked CF + SES check; `409` when not
  connected; zone-not-found error path.
- token refresh path when `expires_at` is past.
- disconnect revokes + deletes.

---

## Build order

1. Phase 0 (external, parallel — kick off now).
2. Phase 1 (schema + crypto + migration).
3. Phase 3 (CF client, unit-tested against mocks) — buildable before OAuth is live.
4. Phase 2 (OAuth routes).
5. Phase 4 (auto-configure route).
6. Phase 5 (UI).
7. Phase 7 throughout.

## Decisions (defaults chosen; flag if you disagree)

- **One Cloudflare connection per account** (not per domain) — simpler, matches
  how most teams run a single CF account.
- **Connect entry point on the domain setup page** (where the need arises), with a
  management/disconnect view in Settings.
- **Stateless cookie** for OAuth state/PKCE rather than a DB table.
- Keep manual records as a permanent fallback (not everyone is on Cloudflare).

## What I need from you

- The Cloudflare OAuth `client_id` / `client_secret` once the app is registered
  (Phase 0), plus confirmation of the verbatim authorize/token endpoints + scope
  strings.
- Where the production redirect URI should point (host).

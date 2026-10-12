# Review trust: sampling the AI pass on transactional mail

Transactional mail (`POST /v1/emails`) is content-reviewed per **content
fingerprint**, not per request (AGENTS.md hard rule 6). Two engines run on a new
fingerprint: the deterministic checks in `src/services/risk.ts`, which are free,
and the AI pass in `src/services/risk-ai.ts` (Claude Haiku 5.5 at low reasoning
effort via OpenRouter by default, overridable with `OPENROUTER_RISK_MODEL`), which
is not.

Review trust decides how often that AI pass runs on a new shape. Accounts earn a
tier from their history, and a trusted account's new shapes are **sampled**: one
in ten gets the AI pass. The code and the design note live in
`src/services/review-trust.ts`.

## Why it exists

Cost. In September and October 2026, Exit1.dev alone produced about **1,444
distinct shapes in 30 days**, which was roughly **97% of all AI review calls**.
Every SSL-expiry or downtime alert names a different monitored site, and link
hosts are part of the fingerprint on purpose (without them an approved verdict
would cover any email with the same words, whatever its button pointed at). So
each monitored site is a new shape, and each new shape was a model call.

## Why it is safe

For an established sender the AI verdict never refuses transactional mail
anyway. `isBlocking(review, account)` (`src/services/content-review.ts`) only
lets a phishing pair refuse an established sender; an AI or keyword `blocked`
lands in the admin queue and sends. On a trusted account the AI pass is
therefore monitoring, not protection. The things that do protect still run:

- The deterministic floor runs on every send, so the phishing pairs still refuse.
- Reputation (`src/services/health.ts`) still polices established senders on
  what recipients actually did.
- Trust is never extended to the accounts where the AI verdict can refuse mail:
  anything inside the new-account ramp is `new` and gets the full AI pass.

## The tiers

| Tier | When | AI pass on a new shape |
| --- | --- | --- |
| `new` | Inside the 14-day new-account ramp, **or** fewer than 1,000 delivered emails, **or** fewer than 25 AI-clean reviews | Every one |
| `watch` | Any hard block (a deterministic phishing pair) in the last 30 days, **or** at least 3 flagged (`high` or `blocked`) reviews in the last 30 days that are also at least 5% of the account's AI-reviewed shapes in that window, **or** reputation not normal (a `health.ts` warning or worse), **or** the account is risk-paused | Every one |
| `trusted` | Everything else | One in 10 |

"AI-clean" means a `content_reviews` row with `ai_review = 'reviewed'` and a
`low` or `medium` risk level. Delivered emails are counted up to the threshold
and no further (the admin panel shows the capped number).

`watch` is checked before `trusted`, so an account with plenty of history still
loses the discount when something goes wrong, and earns it back once the 30-day
window is clean.

A hard block puts an account on watch alone, because the deterministic phishing
pair is the one verdict that is never a model guess. A flagged AI or keyword
verdict needs company: at least 3 in the window **and** at least 5% of the shapes
the AI reviewed in it. A single flag used to be enough, and real data showed why
that fails: Exit1.dev's honest alerts draw an occasional AI false positive (about
4 `high` per 500 reviews), so one flag demoted the account for 30 days and it
could never be trusted. The count floor stops one bad day on a small account from
counting as a pattern; the rate stops a high-volume sender's background noise from
counting as one.

## What trust never changes

- **The deterministic checks run on every send, whatever the tier.** They are
  what refuses a phishing pair.
- **Campaigns and automations are always reviewed in full.** It is one call per
  campaign, which is cheap, and an AI `blocked` verdict still stops a campaign.
  Trust only applies to the transactional path.
- **A sampled-out shape is not approved for good.** Its row is stored with
  `ai_review = 'sampled_out'`. If the account later drops out of `trusted`, the
  next send of that shape gets the AI pass before it goes.
- **A flagged verdict is re-checked without waiting for the cache.** Storing a
  `high`, `blocked` or hard-block verdict calls `invalidateReviewTrust`, so the
  process that stored it recomputes the account's tier on its next send instead
  of trusting a stale cache. That is not global: other worker processes keep
  their cached tier until it expires, so demotion reaches every process within
  10 minutes (`TRUST_CACHE_TTL_MS`). Whether the recompute demotes depends on the
  watch rule above: a hard block always does, a single AI flag usually does not.

## The `ai_review` column

Every `content_reviews` row records whether the AI looked at it, and the tier the
account was in when the row was written (`trust_tier`: `new`, `watch` or
`trusted`). `trust_tier` is NULL on rows that predate trust tiers, and on every
row written while `AI_REVIEW_MODE` is not `ai`: trust only decides how often the
model runs, so with the AI off it is never computed.

| `ai_review` | Meaning |
| --- | --- |
| `reviewed` | The model returned a verdict, merged escalate-only into the deterministic one |
| `failed` | The model call failed; the deterministic verdict stands (fail open) |
| `sampled_out` | The account was trusted and this shape was not sampled. Re-reviewed on its next send if the account loses trust |
| `off` | `AI_REVIEW_MODE` is not `ai`, so the review was deterministic only |

## Caching

Trust is computed only when `AI_REVIEW_MODE=ai`, per worker process, and cached
for 10 minutes (`TRUST_CACHE_TTL_MS`). `invalidateReviewTrust` clears the cache of
the process that stored a flagged verdict and no other, so replicas can disagree
about an account's tier for up to ten minutes. That is acceptable: the worst case
is a few shapes sampled out for that long, the deterministic floor still runs on
every one of them, and each sampled-out row is re-reviewed by the AI on its next
send once the account has left `trusted`.

## Seeing it

- **Admin account page** (`/admin/accounts/<id>`): the **AI content review** panel
  shows the account's tier, the plain-language reasons for it, and progress
  against the thresholds (delivered emails, AI-clean reviews, last flagged review
  in the lookback window). The thresholds are sent with the payload
  (`reviewTrustTargets`) so the client never imports the service.
- **Verdict labels** (`AI_REVIEW_NOTE` in the same page): a stored verdict the
  AI did not look at carries a note: "AI skipped, trusted sender" (`sampled_out`), "AI failed" (`failed`) or "No AI"
  (`off`). `reviewed` is the normal case and gets no label. The note is what
  keeps a sampled-out row from reading as "the model passed this".

## Tuning

The thresholds are constants at the top of `src/services/review-trust.ts`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `TRUST_MIN_DELIVERED` | 1,000 | Delivered emails before an account can be trusted |
| `TRUST_MIN_AI_CLEAN` | 25 | AI-clean reviews before an account can be trusted |
| `TRUST_LOOKBACK_DAYS` | 30 | Window for flagged reviews (and the `watch` tier) |
| `TRUST_WATCH_MIN_FLAGGED` | 3 | Flagged (`high`/`blocked`) reviews in the window before flags alone put an account on watch |
| `TRUST_WATCH_FLAG_RATE` | 0.05 | Share of the window's AI-reviewed shapes those flags must also reach (5%) |
| `TRUSTED_SAMPLE_EVERY` | 10 | A trusted account gets the AI pass on one new shape in this many |
| `TRUST_CACHE_TTL_MS` | 10 min | Per-process trust cache |

The 14-day ramp is not a trust constant: it comes from `src/services/send-ramp.ts`.

These are product decisions. AGENTS.md hard rule 6 and this document restate
them, so **move all three together**. Before raising `TRUSTED_SAMPLE_EVERY`,
check the SQL below: the sampled rate is what tells you whether the model is
still catching anything on trusted accounts.

## Checking it in SQL

AI review outcomes per account over the last 30 days:

```sql
SELECT a.name,
       cr.account_id,
       count(*) FILTER (WHERE cr.ai_review = 'reviewed')    AS reviewed,
       count(*) FILTER (WHERE cr.ai_review = 'sampled_out') AS sampled_out,
       count(*) FILTER (WHERE cr.ai_review = 'failed')      AS failed,
       count(*) FILTER (WHERE cr.ai_review = 'off')         AS off,
       count(*)                                             AS shapes
FROM content_reviews cr
JOIN accounts a ON a.id = cr.account_id
WHERE cr.created_at > now() - interval '30 days'
GROUP BY a.name, cr.account_id
ORDER BY shapes DESC;
```

How many new shapes each tier produced, and what the AI did with them:

```sql
SELECT trust_tier, ai_review, count(*)
FROM content_reviews
WHERE created_at > now() - interval '30 days'
GROUP BY trust_tier, ai_review
ORDER BY trust_tier, ai_review;
```

Sampled reviews on trusted accounts that the model flagged (the signal that the
sample rate is too thin, or that a trusted account has turned):

```sql
SELECT account_id, risk_level, subject, from_email, created_at
FROM content_reviews
WHERE trust_tier = 'trusted'
  AND ai_review = 'reviewed'
  AND risk_level IN ('high', 'blocked')
  AND created_at > now() - interval '30 days'
ORDER BY created_at DESC;
```

# Content review v2 — stop hurting honest new users, then add Jev

Status: Part A shipped (2026-09-28). Part B planned.

## Why

The September 2026 anti-phishing work (AGENTS.md hard rule 6) closed the hole the
attackers used. An audit of the honest new-user journey afterwards showed the rules
were wider than the attacks required. Running `runDeterministicRiskChecks` on
realistic first-week mail produced these verdicts:

| Honest mail | Verdict before |
|---|---|
| Free tier, shared domain, "Acme" newsletter linking acme.com | `high`, so the campaign is blocked |
| Free tier, shared domain, welcome email saying "log in to your account" | phishing pair: 422, **workspace auto-paused** |
| "Please verify your account" linking `acme.vercel.app` | phishing pair: 422, **workspace auto-paused** |
| From `Acme <hi@getacme.com>`, verify link to acme.io | phishing pair |
| Dunning email: "…or your account will be suspended" | `blocked` (single keyword) |
| "Confirm your password change" | `blocked` (single keyword) |
| Dev newsletter about the Web Crypto API / "we're betting on edge" | `blocked` (prohibited industry) |
| Product update with more than 15 links plus "sign in to your account" | `high`, so the campaign is blocked |
| Day-0 campaign to 800 people | 500 sent, then paused with "Monthly email limit reached… upgrade" (wrong), then pause/resume every sweep until midnight UTC |
| Personalised reset ("Hi Alice" / "Hi Bob") | new fingerprint per recipient, so a model call per send |

## Part A — false-positive fixes (shipped)

Each item has a regression test in `test/content-review.test.ts` or
`test/risk-review.test.ts`. The two incident payloads (`HOTDOC_PHISH` and the
third account's trimmed variant) must still block.

1. **The shared sandbox domain is not impersonation.** On `SHARED_SANDBOX_DOMAIN`
   the From name is the account's own name and the recipients are provably the
   org's own members (`sharedDomainSendError`). A brand in the From name can't
   deceive anyone there, so `brand_impersonation` does not fire on that domain.
   The other signals still apply.
2. **App hosting is not a throwaway page when it is the sender's own app.**
   `DISPOSABLE_CTA_HOSTS` is split into:
   - **Funnel/form builders** (ClickFunnels, systeme.io, Google Forms, Typeform, …):
     unchanged.
   - **App-hosting platforms** (`vercel.app`, `netlify.app`, `pages.dev`,
     `github.io`, `web.app`, …): a link there counts as disposable *unless* the
     tenant subdomain names the sending domain (`acme.vercel.app` sent from
     `acme.com` or `getacme.com`).

   This adds no bypass: a sender who controls the sending domain can already host
   the page on it, and a payment ask on the sender's own domain was never blocked
   by the pair. The From name is deliberately *not* used for this match, so
   `HotDoc <x@globalcitiys.com>` linking `hotdoc.vercel.app` still pairs.
3. **Branded sending-domain variants are the brand.** A sending label that is the
   linked label plus a common SaaS affix (`get`, `try`, `use`, `join`, `go`,
   `my`, `hq`, `app`, `mail`, `team`, …) is treated as the same brand, so
   `getacme.com` linking `acme.io` is not impersonation. A lookalike with a
   free-form affix (`hotdoc-billing.com`) still is.
4. **No single phrase hard-blocks any more.** The old `phishing_like` keyword
   signal ("your account will be suspended", "confirm your password", "verify your
   account immediately") becomes `account_threat` (score 45). It is a pair
   partner in both rules (with impersonation, or with a throwaway host), so the
   threat-plus-fake-page shape still hard-blocks. The prohibited-industry lists
   lose the words with everyday developer meanings: bare `crypto`, `betting`,
   `airdrop`, `poker`, `jackpot`. Unambiguous phrases replace them ("crypto
   trading", "sports betting", "online poker", …), and `bitcoin`, `ethereum` and
   `casino` stay.
5. **Campaigns and automations no longer block on `high`.** They block on
   `blocked` only, and `high` approves and stays flagged in the admin queue like
   `medium`. Transactional has worked this way since the Exit1.dev fix, and the
   two phishing pairs now cover the variant the `high` rule existed for.
   Automation publish now passes the From name to the review.
6. **The new-account ramp explains itself on campaigns.**
   - A campaign batch refused by the ramp pauses with the ramp message
     (`rampExhaustedMessage`: "resumes at 00:00 UTC, no upgrade needed"), not
     "upgrade your plan".
   - The cron resume skips a quota pause while the ramp has no headroom left
     today, which ends the pause/resume flapping.
   - The usage card shows the day's ceiling while the ramp applies.
7. **Greetings don't split the review cache.** The fingerprint normaliser erases
   the one word after a greeting ("hi", "hello", "hey", "dear"), so "Hi Alice" and
   "Hi Bob" share one review. It erases one token only, so no payload can hide
   there.
8. Housekeeping: removed the unreachable `high` branch in `blockedMessage`.

What did **not** change: both phishing pairs still refuse everyone and still
auto-pause a ramped account; the ramp tiers; `isBlocking`; the banned-domain
rules; the escalate-only AI merge.

## Part B — Jev as a fast first-pass classifier (planned)

### What Jev is

A TypeSafe AI classifier on OpenRouter (`typesafe/jev-*`, beta). It is given typed
questions and returns structured answers with calibrated probabilities, without
generating text.

| | Figure |
|---|---|
| Vendor-quoted cost | ~$0.0001–0.0014 per run |
| Vendor-quoted latency | hundreds of ms |
| Context window | 64k tokens |
| Third-party test | 1,000 emails × 7 rules (including scam/phishing) in ~6s for $0.09 |
| Current Haiku pass | ~$0.005 and 2–6s per review |

It cannot explain itself. The accuracy claims are vendor-adjacent and unverified.

### Where it fits

Today the AI pass is Haiku via OpenRouter (`risk-ai.ts`). It runs once per
campaign and once per transactional fingerprint, and it is too slow and too
expensive to put on every message. Jev is cheap enough to score *every* send, and
its probabilities let us choose our own operating point instead of trusting a
model's "blocked".

**Invariants that do not change:**
- A model is a guess. It may refuse a *ramped* account's message. It never refuses
  an established sender (`isBlocking`) and never pauses a workspace
  (`enforceBlockedVerdict` requires a deterministic pair).
- Escalate-only merge (`mergeReviews`): content is attacker-controlled model input.
- Fail open on model errors, and page (`logger.reportError`).
- One engine: Jev plugs into `reviewCampaignRisk`, not a second path.

### Phases

**B1 — shadow mode (1–2 days of work, 2+ weeks of data)**
- Add a `jevClassify(input)` in `src/services/risk-jev.ts`. It calls OpenRouter
  with `OPENROUTER_API_KEY` and `OPENROUTER_JEV_MODEL` (default `typesafe/jev-1.13`).
  The request is the same untrusted-content envelope `risk-ai.ts` builds (From
  name, the from-name-matches-domain fact, sending domain, subject, link hosts,
  text body truncated to about 8k tokens).
- Ask it the typed questions below. Each returns a probability.

  | Question | Asks whether… |
  |---|---|
  | `is_phishing` | the email tries to get the recipient to enter credentials or payment details on a page not owned by the sender |
  | `impersonates_third_party` | the email presents itself as coming from an organisation other than the sender |
  | `is_scam_offer` | investment/crypto/prize/refund lures |
  | `is_transactional` | receipt, reset, alert, verification initiated by the recipient |
  | `is_prohibited_industry` | gambling, adult, crypto promotion |

- Env switch `JEV_REVIEW_MODE=off|shadow|enforce`, default `off`. In `shadow`
  mode, call Jev alongside the existing pass (never on the API request path; in
  the worker, same place as the Haiku call). Store the probabilities in a new
  nullable `jev_scores_json` column on `content_reviews` and `risk_reviews`. This
  needs `db:generate` **and** `db:migrate` in the same change.
- Also score per *send* rather than per fingerprint, but sampled (e.g. 10%) so we
  learn whether per-fingerprint caching is losing signal.
- Admin review queue: show the Jev scores next to the verdict.

**B2 — evaluate (offline script, `scripts/eval-jev.ts`)**
- Positives: the September 2026 incident bodies (16,642 + 475 messages, dedupe by
  fingerprint) plus every `content_reviews.hard_block = true` row.
- Negatives: a random sample of approved campaigns and transactional fingerprints
  from established accounts with clean health (bounce < 2%, complaints < 0.1%).
  Include the known false-positive shapes above (Exit1.dev alerts, dunning,
  Web Crypto newsletter, `*.vercel.app` verify links).
- Report precision/recall per question at thresholds 0.5 to 0.99, and cost/latency
  p50 and p99.
- Go/no-go for B3: at the chosen threshold, recall ≥ 95% on the incident set
  **and** a false-positive rate ≤ 0.1% on the established-sender set.

**B3 — enforce as a triage layer**
- Where B2 passes, Jev becomes the always-on first pass:
  - `p(is_phishing) < low_threshold` and the deterministic result is low/medium:
    **skip the Haiku call** (the cost and latency win on personalised transactional
    mail).
  - Otherwise: run the Haiku pass as today, because it produces the rationale and
    user guidance Jev cannot. Its verdict drives the outcome.
  - `p(is_phishing) ≥ high_threshold` on a ramped account: treat as `blocked`
    (refuses that message; never pauses, never refuses an established sender).
- Jev never sets `phishing_pair`/`hard_block`. Only the deterministic floor can.
- Thresholds live in env (`JEV_LOW`, `JEV_HIGH`) so they can be tuned without a
  deploy.

**B4 — optional per-send scoring for transactional**
If B1's sampled per-send data shows fingerprint caching misses real abuse (payloads
that vary per recipient), score every transactional send with Jev in the worker.
Cost: at ~$0.0003 per call, 1M emails ≈ $300/month.

### Risks

- **Beta vendor.** Pin the model version and fail open. The deterministic floor
  and the ramp remain the backstop.
- **No explanations.** User-facing guidance must still come from the
  deterministic fixes or Haiku, never "the model said no".
- **Prompt injection.** Same as today, and it is the reason the merge stays
  escalate-only.
- **Data processing.** Content goes to OpenRouter and TypeSafe. Check OpenRouter's
  zero-data-retention routing for the Jev endpoint before B1 and list the
  sub-processor in the privacy docs.

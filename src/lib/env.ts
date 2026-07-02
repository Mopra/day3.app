// Central environment validation. Both processes (the Next web tier and the VPS
// BullMQ worker) call validateEnv() at startup so a missing or weak secret fails
// fast and loud instead of silently degrading security — an unset
// UNSUBSCRIBE_SECRET would otherwise sign HMAC tokens with an empty key (anyone
// could forge unsubscribe / one-click links) and an unset OAUTH_STATE_SECRET
// would void the Cloudflare OAuth CSRF protection.
//
// Validation is profiled per process, because the two tiers don't use the same
// secrets:
//   "web" (Next.js): DATABASE_URL, UNSUBSCRIBE_SECRET, OAUTH_STATE_SECRET,
//     DNS_TOKEN_ENC_KEY, CLERK_WEBHOOK_SIGNING_SECRET, + AWS_REGION and
//     SES_SNS_TOPIC_ARN when ses. The topic ARN is required so the SES/SNS
//     webhook's topic allowlist is never silently skipped (unauthenticated
//     route — see app/api/webhooks/ses/route.ts).
//   "worker" (BullMQ): DATABASE_URL, UNSUBSCRIBE_SECRET, + AWS_REGION when ses.
//     The worker does no inbound auth, no Cloudflare OAuth, and no DNS-token
//     decryption, so it doesn't require those secrets.
//
// Individual accessors (requireSecret-style getters) are exported so production
// code never reaches for a `?? ""` fallback: an absent secret throws here.
import { z } from "zod";

// HMAC/encryption keys must be long enough to be meaningful. 16 bytes is the
// floor; our own examples generate 32-byte hex (64 chars). DNS_TOKEN_ENC_KEY is
// a base64-encoded 32-byte AES-256 key — its exact decoded length is checked
// when the key is imported (src/lib/crypto.ts), so here we only assert it is
// non-trivial.
const MIN_SECRET_LEN = 16;

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(MIN_SECRET_LEN, { message: `${name} must be at least ${MIN_SECRET_LEN} characters` });

const required = (name: string) =>
  z.string({ error: `${name} is required` }).min(1, `${name} is required`);

const fullSchema = z.object({
  DATABASE_URL: required("DATABASE_URL"),
  // Public base URL of the app. REQUIRED on every tier: the worker stamps it into
  // every campaign email's unsubscribe link and open/click tracking URLs, so a
  // missing value silently ships broken (relative) unsubscribe links — a direct
  // CAN-SPAM / SES-suspension risk. The web tier needs it for form + test-email
  // links. (Previously read with a `?? ""` fallback in the worker.)
  APP_URL: required("APP_URL"),
  // The BullMQ broker (both tiers enqueue) and Supabase Storage (web uploads
  // CSVs, worker reads them during imports). Hard runtime deps — fail fast rather
  // than surface as a confusing runtime error on the first import/send.
  REDIS_URL: required("REDIS_URL"),
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: secret("SUPABASE_SERVICE_ROLE_KEY"),
  UNSUBSCRIBE_SECRET: secret("UNSUBSCRIBE_SECRET"),
  OAUTH_STATE_SECRET: secret("OAUTH_STATE_SECRET"),
  // DNS token encryption accepts either the single-key form (DNS_TOKEN_ENC_KEY)
  // or the rotation-aware keyring (DNS_TOKEN_ENC_KEYS + DNS_TOKEN_ENC_ACTIVE_KEY_ID);
  // the cross-field check below requires at least one. Both are validated for
  // length/shape when present (the exact 32-byte decode is enforced at import).
  DNS_TOKEN_ENC_KEY: secret("DNS_TOKEN_ENC_KEY").optional(),
  DNS_TOKEN_ENC_KEYS: secret("DNS_TOKEN_ENC_KEYS").optional(),
  DNS_TOKEN_ENC_ACTIVE_KEY_ID: z.string().optional(),
  CLERK_WEBHOOK_SIGNING_SECRET: secret("CLERK_WEBHOOK_SIGNING_SECRET"),
  EMAIL_PROVIDER: z.string().optional(),
  AWS_REGION: z.string().optional(), // required only when EMAIL_PROVIDER=ses
  SES_SNS_TOPIC_ARN: z.string().optional(), // required only when EMAIL_PROVIDER=ses (web tier)
  // --- AI (OpenRouter) — OPTIONAL. Powers the campaign drafting/assist helpers.
  // When OPENROUTER_API_KEY is unset, the AI features are hidden and the app runs
  // exactly as before (the assist routes return 503), so this is never required
  // to boot. OPENROUTER_MODEL overrides the default model slug.
  OPENROUTER_API_KEY: secret("OPENROUTER_API_KEY").optional(),
  OPENROUTER_MODEL: z.string().optional(),
  // Campaign risk review (worker): "mock"/unset = deterministic checks only;
  // anything else layers the AI pass on top (escalate-only, fails open — see
  // src/services/risk-ai.ts). Needs OPENROUTER_API_KEY, enforced below.
  AI_REVIEW_MODE: z.string().optional(),
  OPENROUTER_RISK_MODEL: z.string().optional(),
  // Error sink (optional). When set, failed/dead-lettered jobs, 500s, and
  // reputation auto-pauses are POSTed here (see src/lib/logger.ts). Unset → no
  // error reporting; a production boot without it logs a loud warning below.
  ERROR_REPORTING_DSN: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof fullSchema>;
export type EnvProfile = "web" | "worker";

// The worker tier needs only DB + the shared unsubscribe secret (+ AWS_REGION
// when sending/checking via SES).
const workerSchema = fullSchema.pick({
  DATABASE_URL: true,
  APP_URL: true,
  REDIS_URL: true,
  SUPABASE_URL: true,
  SUPABASE_SERVICE_ROLE_KEY: true,
  UNSUBSCRIBE_SECRET: true,
  EMAIL_PROVIDER: true,
  AWS_REGION: true,
  AI_REVIEW_MODE: true,
  OPENROUTER_API_KEY: true,
  OPENROUTER_RISK_MODEL: true,
});

function sesRegionRefinement(
  env: { EMAIL_PROVIDER?: string; AWS_REGION?: string },
  ctx: z.RefinementCtx,
) {
  if (env.EMAIL_PROVIDER === "ses" && !env.AWS_REGION) {
    ctx.addIssue({
      code: "custom",
      path: ["AWS_REGION"],
      message: "AWS_REGION is required when EMAIL_PROVIDER=ses",
    });
  }
}

// The web tier owns the unauthenticated SES/SNS webhook, so it additionally
// requires SES_SNS_TOPIC_ARN under SES — that ARN is the topic allowlist the
// route enforces, and skipping it would let any caller's notifications through.
function sesTopicRefinement(
  env: { EMAIL_PROVIDER?: string; SES_SNS_TOPIC_ARN?: string },
  ctx: z.RefinementCtx,
) {
  if (env.EMAIL_PROVIDER === "ses" && !env.SES_SNS_TOPIC_ARN) {
    ctx.addIssue({
      code: "custom",
      path: ["SES_SNS_TOPIC_ARN"],
      message: "SES_SNS_TOPIC_ARN is required when EMAIL_PROVIDER=ses",
    });
  }
}

// The web tier must be able to decrypt DNS tokens, so it needs at least one of
// the two key forms configured. (The exact key bytes and the active-id presence
// are validated when the keyring is resolved — see src/lib/crypto.ts.)
function dnsKeyRefinement(
  env: { DNS_TOKEN_ENC_KEY?: string; DNS_TOKEN_ENC_KEYS?: string },
  ctx: z.RefinementCtx,
) {
  if (!env.DNS_TOKEN_ENC_KEY && !env.DNS_TOKEN_ENC_KEYS) {
    ctx.addIssue({
      code: "custom",
      path: ["DNS_TOKEN_ENC_KEY"],
      message: "Set DNS_TOKEN_ENC_KEY, or DNS_TOKEN_ENC_KEYS (+ DNS_TOKEN_ENC_ACTIVE_KEY_ID) for key rotation",
    });
  }
}

// The AI risk-review pass fails open at runtime (a model outage keeps campaigns
// moving on the deterministic result), but a mode without a key is a config
// error, not an outage — every review would silently skip AI. Fail the boot.
function aiReviewRefinement(
  env: { AI_REVIEW_MODE?: string; OPENROUTER_API_KEY?: string },
  ctx: z.RefinementCtx,
) {
  if (env.AI_REVIEW_MODE && env.AI_REVIEW_MODE !== "mock" && !env.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["OPENROUTER_API_KEY"],
      message: "OPENROUTER_API_KEY is required when AI_REVIEW_MODE is not 'mock' (the AI risk-review pass calls OpenRouter)",
    });
  }
}

const schemas = {
  web: fullSchema
    .superRefine(sesRegionRefinement)
    .superRefine(sesTopicRefinement)
    .superRefine(dnsKeyRefinement),
  worker: workerSchema.superRefine(sesRegionRefinement).superRefine(aiReviewRefinement),
} as const;

let cached: Partial<Record<EnvProfile, Env>> = {};

/**
 * Validate the required environment for the given process profile. Throws a
 * single aggregated Error listing every problem. Idempotent per profile: the
 * result is cached after the first success.
 */
export function validateEnv(
  profile: EnvProfile = "web",
  source: NodeJS.ProcessEnv = process.env,
): Env {
  const hit = cached[profile];
  if (hit) return hit;
  const result = schemas[profile].safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(
      `Invalid environment configuration (${profile}):\n${issues}\n` +
        "See .env.example / .env.worker.example for the required variables.",
    );
  }
  cached[profile] = result.data as Env;
  warnOnUnmonitoredProduction(profile, source);
  return cached[profile]!;
}

// A production boot with no error sink configured is a silent operability hole:
// failed jobs, 500s, and reputation auto-pauses would page nobody. Validation
// shouldn't *fail* on it (the sink is genuinely optional), but it must be loud.
// Fires at most once per profile (validateEnv memoizes) and never in dev/test.
function warnOnUnmonitoredProduction(profile: EnvProfile, source: NodeJS.ProcessEnv): void {
  if (source.NODE_ENV !== "production") return;
  if (source.ERROR_REPORTING_DSN || source.SENTRY_DSN) return;
  // Plain console (not the structured logger) to avoid any import cycle at the
  // very first lines of startup; this is an operator-facing boot warning.
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "No ERROR_REPORTING_DSN/SENTRY_DSN set in production: errors, dead-lettered jobs, and reputation auto-pauses will not be reported. Configure an error sink and a body-aware /api/health monitor before launch.",
      profile,
    }),
  );
}

/** Test-only: clear the memoized validation so a fresh env can be re-checked. */
export function resetEnvCache(): void {
  cached = {};
}

// --- Secret accessors (no `?? ""` fallbacks anywhere in production code) ----

function requireSecret(name: keyof Env): string {
  const value = process.env[name];
  if (!value || value.length < MIN_SECRET_LEN) {
    throw new Error(
      `${name} is missing or too short (min ${MIN_SECRET_LEN} chars). ` +
        "Refusing to use an empty/weak key — see .env.example.",
    );
  }
  return value;
}

export const requireUnsubscribeSecret = (): string => requireSecret("UNSUBSCRIBE_SECRET");
export const requireOAuthStateSecret = (): string => requireSecret("OAUTH_STATE_SECRET");

/**
 * The app's public base URL. Throws rather than returning an empty string, so a
 * misconfigured worker can never email broken (relative) unsubscribe links.
 */
export function requireAppUrl(): string {
  const value = process.env.APP_URL;
  if (!value || value.trim().length === 0) {
    throw new Error(
      "APP_URL is not set. Refusing to send: unsubscribe and tracking links need " +
        "an absolute base URL — see .env.worker.example.",
    );
  }
  return value;
}

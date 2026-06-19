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
//     DNS_TOKEN_ENC_KEY, CLERK_WEBHOOK_SIGNING_SECRET, + AWS_REGION when ses.
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
  UNSUBSCRIBE_SECRET: secret("UNSUBSCRIBE_SECRET"),
  OAUTH_STATE_SECRET: secret("OAUTH_STATE_SECRET"),
  DNS_TOKEN_ENC_KEY: secret("DNS_TOKEN_ENC_KEY"),
  CLERK_WEBHOOK_SIGNING_SECRET: secret("CLERK_WEBHOOK_SIGNING_SECRET"),
  EMAIL_PROVIDER: z.string().optional(),
  AWS_REGION: z.string().optional(), // required only when EMAIL_PROVIDER=ses
});

export type Env = z.infer<typeof fullSchema>;
export type EnvProfile = "web" | "worker";

// The worker tier needs only DB + the shared unsubscribe secret (+ AWS_REGION
// when sending/checking via SES).
const workerSchema = fullSchema.pick({
  DATABASE_URL: true,
  UNSUBSCRIBE_SECRET: true,
  EMAIL_PROVIDER: true,
  AWS_REGION: true,
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

const schemas = {
  web: fullSchema.superRefine(sesRegionRefinement),
  worker: workerSchema.superRefine(sesRegionRefinement),
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
  return cached[profile]!;
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

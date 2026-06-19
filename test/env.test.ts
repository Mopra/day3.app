import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  requireOAuthStateSecret,
  requireUnsubscribeSecret,
  resetEnvCache,
  validateEnv,
} from "../src/lib/env";

// A complete, valid set of required vars. Tests mutate copies of this.
const VALID = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  UNSUBSCRIBE_SECRET: "x".repeat(32),
  OAUTH_STATE_SECRET: "y".repeat(32),
  DNS_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_".padEnd(32, "z"),
};

const SECRET_KEYS = [
  "UNSUBSCRIBE_SECRET",
  "OAUTH_STATE_SECRET",
  "DNS_TOKEN_ENC_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
] as const;

const saved: Record<string, string | undefined> = {};
const ALL_KEYS = [
  ...Object.keys(VALID),
  "DNS_TOKEN_ENC_KEYS",
  "DNS_TOKEN_ENC_ACTIVE_KEY_ID",
  "EMAIL_PROVIDER",
  "AWS_REGION",
  "SES_SNS_TOPIC_ARN",
];

// A complete SES config: provider + region + the topic ARN the webhook pins to.
const SES_OK = {
  EMAIL_PROVIDER: "ses",
  AWS_REGION: "eu-north-1",
  SES_SNS_TOPIC_ARN: "arn:aws:sns:eu-north-1:123456789012:day3-ses-events",
} as const;

beforeEach(() => {
  for (const k of ALL_KEYS) saved[k] = process.env[k];
  resetEnvCache();
});

afterEach(() => {
  for (const k of ALL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

function applyEnv(env: Record<string, string | undefined>) {
  for (const k of ALL_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  resetEnvCache();
}

describe("validateEnv", () => {
  it("passes with a complete, strong set of secrets", () => {
    applyEnv({ ...VALID });
    expect(() => validateEnv()).not.toThrow();
  });

  for (const key of SECRET_KEYS) {
    it(`throws when ${key} is missing`, () => {
      const env = { ...VALID } as Record<string, string | undefined>;
      delete env[key];
      applyEnv(env);
      expect(() => validateEnv()).toThrow(new RegExp(key));
    });

    it(`throws when ${key} is too short`, () => {
      applyEnv({ ...VALID, [key]: "short" });
      expect(() => validateEnv()).toThrow(new RegExp(key));
    });
  }

  it("throws when DATABASE_URL is missing", () => {
    const env = { ...VALID } as Record<string, string | undefined>;
    delete env.DATABASE_URL;
    applyEnv(env);
    expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  });

  it("requires AWS_REGION only when EMAIL_PROVIDER=ses", () => {
    applyEnv({ ...VALID, EMAIL_PROVIDER: "ses", SES_SNS_TOPIC_ARN: SES_OK.SES_SNS_TOPIC_ARN });
    expect(() => validateEnv()).toThrow(/AWS_REGION/);

    applyEnv({ ...VALID, ...SES_OK });
    expect(() => validateEnv()).not.toThrow();

    // mock provider doesn't need AWS_REGION
    applyEnv({ ...VALID, EMAIL_PROVIDER: "mock" });
    expect(() => validateEnv()).not.toThrow();
  });

  it("requires SES_SNS_TOPIC_ARN only when EMAIL_PROVIDER=ses (web tier)", () => {
    // SES selected but topic ARN missing → reject. The webhook's topic
    // allowlist must never be silently skipped in production.
    applyEnv({ ...VALID, EMAIL_PROVIDER: "ses", AWS_REGION: SES_OK.AWS_REGION });
    expect(() => validateEnv()).toThrow(/SES_SNS_TOPIC_ARN/);

    applyEnv({ ...VALID, ...SES_OK });
    expect(() => validateEnv()).not.toThrow();

    // mock provider doesn't need the topic ARN
    applyEnv({ ...VALID, EMAIL_PROVIDER: "mock" });
    expect(() => validateEnv()).not.toThrow();

    // The worker tier doesn't serve the webhook, so it must not require the ARN.
    applyEnv({
      DATABASE_URL: VALID.DATABASE_URL,
      UNSUBSCRIBE_SECRET: VALID.UNSUBSCRIBE_SECRET,
      EMAIL_PROVIDER: "ses",
      AWS_REGION: SES_OK.AWS_REGION,
    });
    expect(() => validateEnv("worker")).not.toThrow();
  });

  it("accepts the rotation keyring (DNS_TOKEN_ENC_KEYS) in place of DNS_TOKEN_ENC_KEY", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const env = { ...VALID } as Record<string, string | undefined>;
    delete env.DNS_TOKEN_ENC_KEY;
    applyEnv({
      ...env,
      DNS_TOKEN_ENC_KEYS: `v1:${key},v2:${key}`,
      DNS_TOKEN_ENC_ACTIVE_KEY_ID: "v2",
    });
    expect(() => validateEnv()).not.toThrow();
  });

  it("rejects the web tier with neither DNS key form configured", () => {
    const env = { ...VALID } as Record<string, string | undefined>;
    delete env.DNS_TOKEN_ENC_KEY;
    applyEnv(env);
    expect(() => validateEnv()).toThrow(/DNS_TOKEN_ENC_KEY/);
  });

  it("aggregates multiple problems into one error", () => {
    applyEnv({ DATABASE_URL: VALID.DATABASE_URL });
    let message = "";
    try {
      validateEnv();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/UNSUBSCRIBE_SECRET/);
    expect(message).toMatch(/OAUTH_STATE_SECRET/);
  });

  it("worker profile needs only DATABASE_URL + UNSUBSCRIBE_SECRET", () => {
    // The worker does no OAuth / Clerk webhooks / DNS-token decryption, so it
    // must not require those secrets.
    applyEnv({
      DATABASE_URL: VALID.DATABASE_URL,
      UNSUBSCRIBE_SECRET: VALID.UNSUBSCRIBE_SECRET,
    });
    expect(() => validateEnv("worker")).not.toThrow();
  });

  it("worker profile still fails on a missing/weak UNSUBSCRIBE_SECRET", () => {
    applyEnv({ DATABASE_URL: VALID.DATABASE_URL, UNSUBSCRIBE_SECRET: "tiny" });
    expect(() => validateEnv("worker")).toThrow(/UNSUBSCRIBE_SECRET/);
  });

  it("worker profile requires AWS_REGION when EMAIL_PROVIDER=ses", () => {
    applyEnv({
      DATABASE_URL: VALID.DATABASE_URL,
      UNSUBSCRIBE_SECRET: VALID.UNSUBSCRIBE_SECRET,
      EMAIL_PROVIDER: "ses",
    });
    expect(() => validateEnv("worker")).toThrow(/AWS_REGION/);
  });
});

describe("secret accessors fail fast (no empty-key signer)", () => {
  it("requireUnsubscribeSecret throws on an unset secret", () => {
    const env = { ...VALID } as Record<string, string | undefined>;
    delete env.UNSUBSCRIBE_SECRET;
    applyEnv(env);
    expect(() => requireUnsubscribeSecret()).toThrow(/UNSUBSCRIBE_SECRET/);
  });

  it("requireUnsubscribeSecret throws on an empty secret rather than returning it", () => {
    applyEnv({ ...VALID, UNSUBSCRIBE_SECRET: "" });
    expect(() => requireUnsubscribeSecret()).toThrow(/UNSUBSCRIBE_SECRET/);
  });

  it("requireUnsubscribeSecret throws on a too-short secret", () => {
    applyEnv({ ...VALID, UNSUBSCRIBE_SECRET: "tiny" });
    expect(() => requireUnsubscribeSecret()).toThrow(/UNSUBSCRIBE_SECRET/);
  });

  it("requireOAuthStateSecret throws on an unset secret", () => {
    const env = { ...VALID } as Record<string, string | undefined>;
    delete env.OAUTH_STATE_SECRET;
    applyEnv(env);
    expect(() => requireOAuthStateSecret()).toThrow(/OAUTH_STATE_SECRET/);
  });

  it("requireOAuthStateSecret throws on an empty secret", () => {
    applyEnv({ ...VALID, OAUTH_STATE_SECRET: "" });
    expect(() => requireOAuthStateSecret()).toThrow(/OAUTH_STATE_SECRET/);
  });

  it("returns the secret when present and strong", () => {
    applyEnv({ ...VALID });
    expect(requireUnsubscribeSecret()).toBe(VALID.UNSUBSCRIBE_SECRET);
    expect(requireOAuthStateSecret()).toBe(VALID.OAUTH_STATE_SECRET);
  });
});

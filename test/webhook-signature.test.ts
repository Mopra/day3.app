import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeSignature,
  generateWebhookSecret,
  signatureHeader,
  signingPayload,
  verifySignature,
  WEBHOOK_SECRET_PREFIX,
} from "../src/lib/webhook-signature";

// The signing scheme is a published contract — receivers implement it from the
// docs and we can never quietly change it. These tests pin the algorithm, not
// just its self-consistency.
describe("webhook signatures", () => {
  const secret = "whsec_test_secret";
  const body = '{"id":"evt_1","type":"email.bounced"}';
  const t = 1_755_264_000;

  it("signs HMAC-SHA256 over `${timestamp}.${body}`", () => {
    expect(signingPayload(t, body)).toBe(`${t}.${body}`);
    // Independently computed, so a refactor of computeSignature that still
    // round-trips with verifySignature can't silently change the wire format.
    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(computeSignature(secret, t, body)).toBe(expected);
  });

  it("formats the header as t=…,v1=…", () => {
    expect(signatureHeader(secret, t, body)).toBe(`t=${t},v1=${computeSignature(secret, t, body)}`);
  });

  it("verifies a signature it produced", () => {
    const header = signatureHeader(secret, t, body);
    expect(verifySignature({ header, secret, rawBody: body, nowSeconds: t })).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a re-dated timestamp", () => {
    const header = signatureHeader(secret, t, body);
    expect(verifySignature({ header, secret, rawBody: body + " ", nowSeconds: t })).toBe(false);
    expect(verifySignature({ header, secret: "whsec_other", rawBody: body, nowSeconds: t })).toBe(false);
    // `t` is inside the signed string, so moving it invalidates the MAC — an
    // attacker cannot refresh a captured payload to defeat a freshness check.
    const restamped = header.replace(`t=${t}`, `t=${t + 10}`);
    expect(verifySignature({ header: restamped, secret, rawBody: body, nowSeconds: t + 10 })).toBe(false);
  });

  it("enforces the replay tolerance, and skips it when tolerance is 0", () => {
    const header = signatureHeader(secret, t, body);
    expect(verifySignature({ header, secret, rawBody: body, nowSeconds: t + 400 })).toBe(false);
    expect(
      verifySignature({ header, secret, rawBody: body, nowSeconds: t + 400, toleranceSeconds: 600 }),
    ).toBe(true);
    expect(
      verifySignature({ header, secret, rawBody: body, nowSeconds: t + 99_999, toleranceSeconds: 0 }),
    ).toBe(true);
  });

  it("accepts any one of several v1 elements (rotation), and rejects a malformed header", () => {
    const good = computeSignature(secret, t, body);
    expect(
      verifySignature({ header: `t=${t},v1=deadbeef,v1=${good}`, secret, rawBody: body, nowSeconds: t }),
    ).toBe(true);
    for (const header of ["", "garbage", `v1=${good}`, `t=${t}`, `t=nope,v1=${good}`]) {
      expect(verifySignature({ header, secret, rawBody: body, nowSeconds: t })).toBe(false);
    }
    expect(verifySignature({ header: null, secret, rawBody: body, nowSeconds: t })).toBe(false);
  });

  it("mints prefixed, high-entropy, unique secrets", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
  });
});

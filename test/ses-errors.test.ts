import { describe, expect, it } from "vitest";
import {
  E_ACCOUNT_SUSPENDED,
  E_DAILY_LIMIT_EXCEEDED,
  E_SENDER_NOT_VERIFIED,
  E_SENDING_MISCONFIGURED,
  mapSesError,
} from "../src/email/ses";

// The pause-vs-fail-vs-retry branching in send-batch hangs off these exact
// classifications, and duplicate-safety is the organizing rule: a status that
// allows a recipient to be retried (rate_limited, transient) may only be
// produced by errors that prove SES rejected or never received the request.
const sdkError = (name: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { name }, extra);
const networkError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

describe("mapSesError", () => {
  it("classifies throttling as rate_limited and detects the daily quota variant", () => {
    expect(mapSesError(sdkError("TooManyRequestsException", "Too many requests"))).toMatchObject({
      status: "rate_limited",
      error: "TooManyRequestsException",
    });
    expect(
      mapSesError(sdkError("LimitExceededException", "Daily message quota exceeded")),
    ).toMatchObject({ status: "rate_limited", error: E_DAILY_LIMIT_EXCEEDED });
  });

  it("marks account-level suspension as rate_limited with the suspension code (never plain throttle)", () => {
    for (const name of ["SendingPausedException", "AccountSuspendedException"]) {
      const result = mapSesError(sdkError(name, "sending disabled"));
      expect(result.status).toBe("rate_limited");
      expect(result.error).toContain(E_ACCOUNT_SUSPENDED);
    }
  });

  it("classifies a missing configuration set as a pause-worthy misconfiguration, not per-recipient failure", () => {
    const result = mapSesError(sdkError("NotFoundException", "Configuration set does not exist"));
    expect(result.status).toBe("rate_limited");
    expect(result.error).toContain(E_SENDING_MISCONFIGURED);
  });

  it("routes both unverified-identity shapes to the sender-not-verified contract", () => {
    expect(
      mapSesError(sdkError("MailFromDomainNotVerifiedException", "domain not verified")),
    ).toMatchObject({ status: "failed" });
    expect(
      mapSesError(sdkError("MailFromDomainNotVerifiedException", "domain not verified")).error,
    ).toContain(E_SENDER_NOT_VERIFIED);
    // The MessageRejected variant SES raises when the From identity itself is
    // unverified must hit the same pause-and-flip-domain path.
    const rejected = mapSesError(
      sdkError("MessageRejected", "Email address is not verified. The following identities..."),
    );
    expect(rejected.error).toContain(E_SENDER_NOT_VERIFIED);
  });

  it("keeps suppression-list rejections as suppressed and other rejections as failed", () => {
    expect(
      mapSesError(sdkError("MessageRejected", "Address is on the suppression list")),
    ).toMatchObject({ status: "suppressed" });
    expect(mapSesError(sdkError("MessageRejected", "Message rejected"))).toMatchObject({
      status: "failed",
    });
  });

  it("classifies connection-phase network errors (request provably never sent) as transient", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
      expect(mapSesError(networkError(code, `connect ${code}`))).toMatchObject({
        status: "transient",
      });
    }
  });

  it("keeps ambiguous transport errors terminal — a retry could duplicate", () => {
    // Reset/timeout after the request may have been written: the email may
    // already be queued at SES.
    expect(mapSesError(networkError("ECONNRESET", "socket hang up")).status).toBe("failed");
    expect(mapSesError(sdkError("TimeoutError", "Request timed out")).status).toBe("failed");
    // 5xx carries an HTTP status — the request reached SES; outcome unknown.
    expect(
      mapSesError(
        sdkError("InternalServiceErrorException", "internal error", {
          $metadata: { httpStatusCode: 500 },
        }),
      ).status,
    ).toBe("failed");
    // A network-looking code alongside an HTTP status is not connection-phase.
    expect(
      mapSesError(
        Object.assign(new Error("weird"), {
          code: "ENOTFOUND",
          $metadata: { httpStatusCode: 502 },
        }),
      ).status,
    ).toBe("failed");
  });

  it("handles non-Error throws without crashing", () => {
    expect(mapSesError("boom").status).toBe("failed");
    expect(mapSesError(undefined).status).toBe("failed");
  });
});

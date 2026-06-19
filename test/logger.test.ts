import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logger,
  newCorrelationId,
  redact,
  serializeError,
} from "../src/lib/logger";

// The known secret env names the service validates (see src/lib/env.ts). The
// logger must never print their values, even if a caller accidentally folds an
// env-shaped object into a log context.
const SECRET_ENV_NAMES = [
  "UNSUBSCRIBE_SECRET",
  "OAUTH_STATE_SECRET",
  "DNS_TOKEN_ENC_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
  "DATABASE_URL",
] as const;

function captured(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => out.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => err.push(line));
  return { out, err };
}

beforeEach(() => {
  process.env.LOG_LEVEL = "debug";
  delete process.env.ERROR_REPORTING_DSN;
  delete process.env.SENTRY_DSN;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
});

describe("structured logging", () => {
  it("emits a single JSON object with level, msg, time and context", () => {
    const { out } = captured();
    logger.info("hello", { accountId: "acc_1", campaignId: "cmp_2" });
    expect(out).toHaveLength(1);
    const obj = JSON.parse(out[0]);
    expect(obj.level).toBe("info");
    expect(obj.msg).toBe("hello");
    expect(typeof obj.time).toBe("string");
    expect(obj.accountId).toBe("acc_1");
    expect(obj.campaignId).toBe("cmp_2");
  });

  it("routes warn/error to stderr and info/debug to stdout", () => {
    const { out, err } = captured();
    logger.info("i");
    logger.debug("d");
    logger.warn("w");
    logger.error("e");
    expect(out).toHaveLength(2);
    expect(err).toHaveLength(2);
  });

  it("a child logger merges its bound context into every line (correlation id)", () => {
    const { out } = captured();
    const cid = newCorrelationId("req");
    const log = logger.child({ requestId: cid });
    log.info("first");
    log.info("second");
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.every((l) => l.requestId === cid)).toBe(true);
    expect(cid.startsWith("req_")).toBe(true);
  });

  it("respects LOG_LEVEL (debug suppressed at info)", () => {
    const { out } = captured();
    process.env.LOG_LEVEL = "info";
    logger.debug("noisy");
    logger.info("kept");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]).msg).toBe("kept");
  });
});

describe("secret redaction", () => {
  it("redacts known secret env names anywhere in the context", () => {
    const fakeEnv: Record<string, string> = {};
    for (const name of SECRET_ENV_NAMES) fakeEnv[name] = "super-secret-value";
    const redacted = redact({ env: fakeEnv }) as { env: Record<string, string> };
    for (const name of SECRET_ENV_NAMES) {
      expect(redacted.env[name]).toBe("[REDACTED]");
      expect(JSON.stringify(redacted)).not.toContain("super-secret-value");
    }
  });

  it("redacts secret-shaped keys in emitted log lines", () => {
    const { out } = captured();
    logger.info("with secrets", {
      authorization: "Bearer abc123",
      unsubscribeSecret: "hmac-key",
      cookie: "session=xyz",
      safe: "visible",
    });
    const line = out[0];
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("hmac-key");
    expect(line).not.toContain("session=xyz");
    expect(JSON.parse(line).safe).toBe("visible");
  });

  it("redacts nested secrets without dropping safe fields", () => {
    const r = redact({ a: { token: "t", value: 1 }, list: [{ password: "p", ok: true }] }) as {
      a: { token: string; value: number };
      list: { password: string; ok: boolean }[];
    };
    expect(r.a.token).toBe("[REDACTED]");
    expect(r.a.value).toBe(1);
    expect(r.list[0].password).toBe("[REDACTED]");
    expect(r.list[0].ok).toBe(true);
  });
});

describe("error serialization + reporting", () => {
  it("serializeError keeps name/message/stack for Errors", () => {
    const e = serializeError(new TypeError("boom"));
    expect(e.name).toBe("TypeError");
    expect(e.message).toBe("boom");
    expect(typeof e.stack).toBe("string");
  });

  it("reportError is a no-op sink when no DSN is configured", async () => {
    captured();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await logger.reportError("failed", new Error("x"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reportError POSTs a redacted report to the configured DSN", async () => {
    captured();
    process.env.ERROR_REPORTING_DSN = "https://sink.example/ingest";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    await logger
      .child({ requestId: "req_1", apiKey: "should-not-leak" })
      .reportError("failed", new Error("boom"), { campaignId: "cmp_9" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://sink.example/ingest");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.error.message).toBe("boom");
    expect(body.error.stack).toBeTruthy();
    expect(body.context.requestId).toBe("req_1");
    expect(body.context.campaignId).toBe("cmp_9");
    expect(body.context.apiKey).toBe("[REDACTED]");
    expect((init as RequestInit).body).not.toContain("should-not-leak");
  });

  it("reportError swallows a sink failure (never throws)", async () => {
    captured();
    process.env.ERROR_REPORTING_DSN = "https://sink.example/ingest";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(logger.reportError("failed", new Error("x"))).resolves.toBeUndefined();
  });
});

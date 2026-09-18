import { describe, expect, it } from "vitest";
import {
  fetchSesAccountHealth,
  metricsWindow,
  summarizeSesAccount,
} from "../src/services/ses-account-health";

describe("ses-account-health", () => {
  it("is unavailable, not an error, when the provider is not SES", async () => {
    const res = await fetchSesAccountHealth({ EMAIL_PROVIDER: "mock" });
    expect(res.available).toBe(false);
    if (!res.available) expect(res.reason).toMatch(/not SES/);
  });

  it("is unavailable when SES is selected without a region", async () => {
    const res = await fetchSesAccountHealth({ EMAIL_PROVIDER: "ses" });
    expect(res).toEqual({ available: false, reason: "AWS_REGION is not set" });
  });

  it("aligns the VDM window to whole UTC days ending yesterday", () => {
    const { start, end } = metricsWindow(new Date("2026-09-18T13:45:00Z"), 14);
    expect(end.toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(start.toISOString()).toBe("2026-09-04T00:00:00.000Z");
  });

  it("sums daily VDM values into counts and rates", () => {
    const h = summarizeSesAccount(
      "eu-north-1",
      {
        ProductionAccessEnabled: true,
        SendingEnabled: true,
        EnforcementStatus: "HEALTHY",
        SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 112 },
      },
      {
        Results: [
          { Id: "send", Values: [1000, 1000] },
          { Id: "delivery", Values: [980, 970] },
          { Id: "bounce", Values: [10, 20] },
          { Id: "complaint", Values: [0, 1] },
        ],
        Errors: [],
      },
      null,
      new Date("2026-09-18T12:00:00Z"),
    );
    expect(h.enforcementStatus).toBe("HEALTHY");
    expect(h.quota).toEqual({ max24Hour: 50000, sentLast24Hours: 112, maxSendRate: 14 });
    expect(h.metrics).toMatchObject({ sent: 2000, delivered: 1950, bounced: 30, complained: 1 });
    expect(h.metrics?.bounceRate).toBeCloseTo(0.015);
    expect(h.metrics?.complaintRate).toBeCloseTo(0.0005);
    expect(h.metricsError).toBeNull();
  });

  it("keeps account status when metrics are missing, and fails closed on flags", () => {
    const h = summarizeSesAccount("eu-north-1", {}, null, "VDM disabled");
    expect(h.productionAccess).toBe(false);
    expect(h.sendingEnabled).toBe(false);
    expect(h.enforcementStatus).toBe("UNKNOWN");
    expect(h.quota).toBeNull();
    expect(h.metrics).toBeNull();
    expect(h.metricsError).toBe("VDM disabled");
  });

  it("surfaces a per-query error returned inside a 200", () => {
    const h = summarizeSesAccount(
      "eu-north-1",
      { SendingEnabled: true },
      {
        Results: [{ Id: "send", Values: [5] }],
        Errors: [{ Id: "bounce", Code: "INTERNAL_FAILURE", Message: "boom" }],
      },
      null,
    );
    expect(h.metricsError).toBe("bounce: boom");
    expect(h.metrics?.sent).toBe(5);
  });
});

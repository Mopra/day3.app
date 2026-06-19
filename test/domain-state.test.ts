import { describe, expect, it } from "vitest";
import {
  domainState,
  isVerified,
  parseDnsRecords,
  recheckWindowExpired,
  DOMAIN_RECHECK_WINDOW_DAYS,
} from "../src/lib/domain";
import type { SendingDomain } from "../src/lib/types";

// These pure helpers decide what the domain setup guide renders (the hero state,
// per-record grouping, and the "needs attention" stale state). Covering them here
// pins the verified / partial / failed / stale rendering branches without a DOM.

const DAY_MS = 24 * 60 * 60 * 1000;

function makeDomain(overrides: Partial<SendingDomain> = {}): SendingDomain {
  const now = new Date().toISOString();
  return {
    id: "dom_1",
    domain: "updates.test.co",
    fromName: "Test",
    fromEmail: "hi@updates.test.co",
    verificationStatus: "pending",
    dkimStatus: "pending",
    mailFromStatus: "pending",
    adminOverrideVerified: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("domainState (drives the status hero)", () => {
  it("is verified when SES reports verified", () => {
    expect(domainState(makeDomain({ verificationStatus: "verified" }))).toBe("verified");
    expect(isVerified(makeDomain({ verificationStatus: "verified" }))).toBe(true);
  });

  it("is verified when an admin override is set, even if SES is still pending", () => {
    expect(
      domainState(makeDomain({ verificationStatus: "pending", adminOverrideVerified: true })),
    ).toBe("verified");
  });

  it("is failed when SES reports failed", () => {
    expect(domainState(makeDomain({ verificationStatus: "failed" }))).toBe("failed");
  });

  it("is pending otherwise", () => {
    expect(domainState(makeDomain())).toBe("pending");
  });
});

describe("partial state: verified domain with a pending Return-Path", () => {
  // The guide shows a verified hero but keeps the deliverability section / helper
  // around because mailFromStatus hasn't gone live. domainState stays "verified".
  it("is verified even when the custom MAIL FROM is still pending", () => {
    const d = makeDomain({ verificationStatus: "verified", mailFromStatus: "pending" });
    expect(domainState(d)).toBe("verified");
    expect(d.mailFromStatus).not.toBe("success");
  });

  it("reports a broken Return-Path via mailFromStatus without affecting verification", () => {
    const d = makeDomain({ verificationStatus: "verified", mailFromStatus: "failed" });
    expect(domainState(d)).toBe("verified");
    expect(d.mailFromStatus).toBe("failed");
  });
});

describe("recheckWindowExpired (drives the 'needs attention' stale state)", () => {
  it("is false for a freshly-updated pending domain", () => {
    expect(recheckWindowExpired(makeDomain())).toBe(false);
  });

  it("is true once a pending domain is older than the recheck window", () => {
    const old = new Date(Date.now() - (DOMAIN_RECHECK_WINDOW_DAYS + 1) * DAY_MS).toISOString();
    expect(recheckWindowExpired(makeDomain({ updatedAt: old }))).toBe(true);
  });

  it("is never true for a verified or failed domain, however old", () => {
    const old = new Date(Date.now() - 365 * DAY_MS).toISOString();
    expect(recheckWindowExpired(makeDomain({ verificationStatus: "verified", updatedAt: old }))).toBe(
      false,
    );
    expect(recheckWindowExpired(makeDomain({ verificationStatus: "failed", updatedAt: old }))).toBe(
      false,
    );
  });

  it("falls back to createdAt when updatedAt is absent", () => {
    const old = new Date(Date.now() - (DOMAIN_RECHECK_WINDOW_DAYS + 1) * DAY_MS).toISOString();
    const d = makeDomain({ updatedAt: undefined, createdAt: old });
    expect(recheckWindowExpired(d)).toBe(true);
  });

  it("treats an unparseable timestamp as not-stale (no false alarm)", () => {
    expect(recheckWindowExpired(makeDomain({ updatedAt: "not-a-date" }))).toBe(false);
  });
});

describe("parseDnsRecords grouping (drives verify vs deliverability sections)", () => {
  it("defaults legacy records to required + verify group", () => {
    const json = JSON.stringify([
      { type: "CNAME", name: "a._domainkey.updates.test.co", value: "a.dkim.amazonses.com" },
    ]);
    const [rec] = parseDnsRecords(json);
    expect(rec.required).toBe(true);
    expect(rec.group).toBe("verify");
  });

  it("preserves an explicit deliverability group and MX priority", () => {
    const json = JSON.stringify([
      {
        type: "MX",
        name: "send.updates.test.co",
        value: "feedback-smtp.us-east-1.amazonses.com",
        group: "deliverability",
        priority: 10,
        required: false,
      },
    ]);
    const [rec] = parseDnsRecords(json);
    expect(rec.group).toBe("deliverability");
    expect(rec.priority).toBe(10);
    expect(rec.required).toBe(false);
  });

  it("returns an empty list for missing or malformed json", () => {
    expect(parseDnsRecords(null)).toEqual([]);
    expect(parseDnsRecords("{not json")).toEqual([]);
    expect(parseDnsRecords(JSON.stringify({ not: "an array" }))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { parseSubscriberCsv, isValidEmail } from "../src/lib/csv";
import { runDeterministicRiskChecks } from "../src/services/risk";
import { renderCampaignEmail } from "../src/services/render";
import { checkSendEligibility } from "../src/services/plans";
import type { Account } from "../src/db/schema";

describe("csv parsing", () => {
  it("requires an email column", () => {
    expect(() => parseSubscriberCsv("name\nAlice")).toThrow(/email/);
  });

  it("handles quoted fields, aliases, and case", () => {
    const result = parseSubscriberCsv(
      'Email,First Name,Last Name\njane@example.com,"Smith, Jane ""JJ""",Smith\nBOB@X.CO,Bob,',
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      email: "jane@example.com",
      firstName: 'Smith, Jane "JJ"',
      lastName: "Smith",
    });
    expect(result.rows[1]).toEqual({ email: "bob@x.co", firstName: "Bob" });
  });

  it("counts invalid emails as skipped", () => {
    const result = parseSubscriberCsv("email\ngood@x.co\nbad\n@also-bad");
    expect(result.rows).toHaveLength(1);
    expect(result.invalidRows).toBe(2);
    expect(result.totalRows).toBe(3);
  });

  it("validates emails", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("a b@c.co")).toBe(false);
    expect(isValidEmail("nope")).toBe(false);
  });
});

describe("risk checks", () => {
  const base = {
    fromEmail: "news@updates.test.co",
    sendingDomain: "updates.test.co",
    textBody: null,
  };

  it("approves a normal product update", () => {
    const result = runDeterministicRiskChecks({
      ...base,
      subject: "June product update",
      htmlBody: "<p>We shipped a new dashboard and fixed bugs.</p>",
    });
    expect(result.riskLevel).toBe("low");
    expect(result.recommendedAction).toBe("approve");
  });

  it("blocks prohibited industries", () => {
    const result = runDeterministicRiskChecks({
      ...base,
      subject: "Win big",
      htmlBody: "<p>Best casino bonuses and bitcoin doubling!</p>",
    });
    expect(result.riskLevel).toBe("blocked");
    expect(result.recommendedAction).toBe("block");
    expect(result.categories).toContain("prohibited_industry");
  });

  it("flags from-domain mismatch", () => {
    const result = runDeterministicRiskChecks({
      ...base,
      fromEmail: "news@other-domain.com",
      subject: "Update",
      htmlBody: "<p>Hello</p>",
    });
    expect(result.categories).toContain("missing_sender_identity");
  });
});

describe("email rendering", () => {
  const input = {
    campaign: {
      subject: "Hi {{first_name}}",
      htmlBody: "<p>Hello {{first_name}} {{last_name}} ({{email}})</p>",
      textBody: null,
    },
    subscriber: { email: "alice@x.co", firstName: "Alice", lastName: null },
    companyName: "Test Co",
    companyAddress: "1 Main St",
    unsubscribeUrl: "https://app.test/unsubscribe?token=abc",
  };

  it("substitutes variables, blanking missing values", () => {
    const out = renderCampaignEmail(input);
    expect(out.subject).toBe("Hi Alice");
    expect(out.html).toContain("Hello Alice  (alice@x.co)");
  });

  it("always appends the footer with unsubscribe link and address", () => {
    const out = renderCampaignEmail(input);
    expect(out.html).toContain("https://app.test/unsubscribe?token=abc");
    expect(out.html).toContain("Test Co");
    expect(out.html).toContain("1 Main St");
    expect(out.text).toContain("https://app.test/unsubscribe?token=abc");
  });

  it("generates a text body from HTML when none is provided", () => {
    const out = renderCampaignEmail(input);
    expect(out.text).toContain("Hello Alice");
    expect(out.text).not.toContain("<p>");
  });
});

describe("send eligibility", () => {
  const account = {
    subscriptionStatus: "active",
    sendingEnabled: true,
    monthlyEmailSentCount: 0,
    monthlyEmailLimit: 100,
    pausedReason: null,
  } as unknown as Account;

  it("allows an active, enabled, under-quota account", () => {
    expect(checkSendEligibility(account).allowed).toBe(true);
  });

  it("blocks without active subscription", () => {
    const result = checkSendEligibility({
      ...account,
      subscriptionStatus: "inactive",
    } as Account);
    expect(result.allowed).toBe(false);
  });

  it("blocks when sending disabled or over quota", () => {
    expect(checkSendEligibility({ ...account, sendingEnabled: false } as Account).allowed).toBe(false);
    expect(
      checkSendEligibility({ ...account, monthlyEmailSentCount: 100 } as Account).allowed,
    ).toBe(false);
  });
});

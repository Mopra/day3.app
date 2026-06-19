import { describe, expect, it } from "vitest";
import {
  parseSubscriberCsv,
  isValidEmail,
  validateCsvUpload,
  countCsvDataRows,
  MAX_IMPORT_BYTES,
} from "../src/lib/csv";
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

describe("csv upload validation", () => {
  const ok = { name: "subs.csv", size: 100, type: "text/csv" };

  it("accepts a real csv upload", () => {
    expect(validateCsvUpload(ok)).toBeNull();
    expect(validateCsvUpload({ ...ok, type: "application/octet-stream" })).toBeNull();
    expect(validateCsvUpload({ ...ok, type: "text/csv; charset=utf-8" })).toBeNull();
    expect(validateCsvUpload({ ...ok, type: "" })).toBeNull();
  });

  it("rejects a missing filename", () => {
    expect(validateCsvUpload({ ...ok, name: "" })).toEqual({
      status: 400,
      message: expect.stringMatching(/filename/i),
    });
  });

  it("rejects a non-csv extension", () => {
    expect(validateCsvUpload({ ...ok, name: "subs.xlsx" })?.status).toBe(400);
  });

  it("rejects a disallowed content-type", () => {
    expect(validateCsvUpload({ ...ok, type: "application/pdf" })).toEqual({
      status: 400,
      message: expect.stringMatching(/csv/i),
    });
  });

  it("rejects an empty file before storing", () => {
    expect(validateCsvUpload({ ...ok, size: 0 })).toEqual({
      status: 400,
      message: expect.stringMatching(/empty/i),
    });
  });

  it("rejects an oversized file with 413", () => {
    expect(validateCsvUpload({ ...ok, size: MAX_IMPORT_BYTES + 1 })?.status).toBe(413);
  });

  it("counts data rows excluding the header", () => {
    expect(countCsvDataRows("email\na@x.co\nb@x.co")).toBe(2);
    expect(countCsvDataRows("email")).toBe(0);
    expect(countCsvDataRows("")).toBe(0);
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

  it("strips <script> tags and event handlers from the HTML", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody:
          '<p onclick="steal()">Hi</p><script>alert(1)</script><img src="javascript:evil()">',
      },
    });
    expect(out.html).not.toMatch(/<script/i);
    expect(out.html).not.toContain("alert(1)");
    expect(out.html).not.toMatch(/onclick/i);
    expect(out.html).not.toMatch(/javascript:/i);
    expect(out.html).toContain("Hi");
    // The script body must not leak into the text fallback either.
    expect(out.text).not.toContain("alert(1)");
  });

  it("strips on* handlers hidden behind a '>' inside a quoted attribute", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody:
          '<img alt="x>" src=y onerror=alert(document.cookie)>',
      },
    });
    expect(out.html).not.toMatch(/onerror/i);
    expect(out.html).not.toContain("alert(document.cookie)");
  });

  it("rejects javascript: URLs that are HTML-entity-encoded", () => {
    const decimal = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody: '<a href="&#106;avascript:alert(1)">x</a>',
      },
    });
    const hex = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody: '<a href="&#x6a;avascript:alert(1)">x</a>',
      },
    });
    expect(decimal.html).not.toMatch(/javascript/i);
    expect(decimal.html).not.toContain("alert(1)");
    expect(hex.html).not.toMatch(/javascript/i);
    expect(hex.html).not.toContain("alert(1)");
  });

  it("HTML-escapes attacker-controlled merge values so they cannot inject markup", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        subject: "Hi {{first_name}}",
        htmlBody: "<p>Hello {{first_name}}</p>",
        textBody: null,
      },
      subscriber: {
        email: "e@x.co",
        firstName: "<img src=x onerror=alert(1)>",
        lastName: null,
      },
    });
    // The dangerous markup must be neutralized into inert escaped text, never a
    // live <img> tag with an onerror handler.
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).not.toMatch(/<img[^>]*onerror/i);
    expect(out.html).toContain("&lt;img src=x");
    // Subject is a plain-text header, not HTML, so it is not escaped there.
    expect(out.subject).toBe("Hi <img src=x onerror=alert(1)>");
  });

  it("guarantees exactly one functioning unsubscribe link", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody:
          '<p>Body</p><a href="{{unsubscribe_url}}">Opt out</a>',
      },
    });
    const links = out.html.match(/href="https:\/\/app\.test\/unsubscribe\?token=abc"/g) ?? [];
    expect(links).toHaveLength(1);
    // The substituted footer link must be present and functional.
    expect(out.html).toContain('href="https://app.test/unsubscribe?token=abc"');
    expect(out.html).not.toContain("{{unsubscribe_url}}");
    // Exactly one unsubscribe entry in the text fallback as well.
    const textLinks = out.text.match(/https:\/\/app\.test\/unsubscribe\?token=abc/g) ?? [];
    expect(textLinks).toHaveLength(1);
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

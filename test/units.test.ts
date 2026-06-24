import { describe, expect, it } from "vitest";
import {
  parseSubscriberCsv,
  isValidEmail,
  validateCsvUpload,
  countCsvDataRows,
  MAX_IMPORT_BYTES,
} from "../src/lib/csv";
import { runDeterministicRiskChecks } from "../src/services/risk";
import { renderCampaignEmail, personalizationFieldsUsed } from "../src/services/render";
import {
  checkSendEligibility,
  entitlementsFor,
  firstAiPlan,
  firstSendingPlan,
  maxSubscribersForPlan,
  monthlyEmailLimitForPlan,
  nextPlanUp,
  planCanSend,
  planFromEntitlements,
  planFromSlug,
  planHasAI,
  recommendedPlanFor,
  subscriptionStatusForLifecycle,
} from "../src/services/plans";
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

describe("personalizationFieldsUsed", () => {
  it("reports each personalizable field used, with its fallback", () => {
    const used = personalizationFieldsUsed(
      "Hi {{first_name|there}}",
      "<p>Welcome {{last_name|aboard}} ({{email}})</p>",
    );
    expect(used).toEqual([
      { field: "first_name", fallback: "there" },
      { field: "last_name", fallback: "aboard" },
    ]);
  });

  it("reports a bare tag with no fallback (renders blank)", () => {
    expect(personalizationFieldsUsed("Hi {{first_name}}")).toEqual([
      { field: "first_name", fallback: null },
    ]);
  });

  it("prefers the worst case: a bare usage wins over a fallback usage", () => {
    const used = personalizationFieldsUsed("Hi {{first_name|there}}", "Bye {{first_name}}");
    expect(used).toEqual([{ field: "first_name", fallback: null }]);
  });

  it("ignores email and unknown tags (only blankable subscriber fields count)", () => {
    expect(personalizationFieldsUsed("{{email}} {{company_name}} plain text")).toEqual([]);
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

  it("uses a token fallback when the field is empty, so copy never breaks", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        subject: "Hi {{first_name|there}}",
        htmlBody: "<p>Hi {{first_name|there}}, welcome {{last_name|aboard}}</p>",
        textBody: null,
      },
      subscriber: { email: "noname@x.co", firstName: null, lastName: null },
    });
    expect(out.subject).toBe("Hi there");
    expect(out.html).toContain("Hi there, welcome aboard");
    expect(out.text).toContain("Hi there, welcome aboard");
  });

  it("prefers the real value over the fallback when the field is present", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        subject: "Hi {{first_name|there}}",
        htmlBody: "<p>Hi {{first_name|there}}</p>",
        textBody: null,
      },
      subscriber: { email: "alice@x.co", firstName: "Alice", lastName: null },
    });
    expect(out.subject).toBe("Hi Alice");
    expect(out.html).toContain("Hi Alice");
  });

  it("escapes a fallback so it cannot inject markup", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody: "<p>Hi {{first_name|<b>hi</b>}}</p>",
        textBody: null,
      },
      subscriber: { email: "noname@x.co", firstName: null, lastName: null },
    });
    expect(out.html).not.toContain("<b>hi</b>");
    expect(out.html).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("always appends the footer with unsubscribe link and address", () => {
    const out = renderCampaignEmail(input);
    expect(out.html).toContain("https://app.test/unsubscribe?token=abc");
    expect(out.html).toContain("Test Co");
    expect(out.html).toContain("1 Main St");
    expect(out.text).toContain("https://app.test/unsubscribe?token=abc");
  });

  it("uses the campaign's editable footer wording when provided", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: { ...input.campaign, footerText: "Thanks for reading, {{first_name}}!" },
    });
    expect(out.html).toContain("Thanks for reading, Alice!");
    expect(out.text).toContain("Thanks for reading, Alice!");
    // It replaces the default wording entirely.
    expect(out.html).not.toContain("you subscribed to updates");
  });

  it("keeps the locked address + unsubscribe link even with custom/empty footer wording", () => {
    // Editable wording must never strip the legally-required address and link.
    const blank = renderCampaignEmail({
      ...input,
      campaign: { ...input.campaign, footerText: "   " },
    });
    expect(blank.html).toContain("1 Main St");
    expect(blank.html).toContain('href="https://app.test/unsubscribe?token=abc"');

    // A user who tries to smuggle their own unsubscribe placeholder into the
    // wording can't add a second link — it's stripped, leaving exactly one.
    const sneaky = renderCampaignEmail({
      ...input,
      campaign: { ...input.campaign, footerText: "Bye — {{unsubscribe_url}}" },
    });
    const links = sneaky.html.match(/https:\/\/app\.test\/unsubscribe\?token=abc/g) ?? [];
    expect(links.length).toBe(1);
  });

  it("escapes HTML in the editable footer wording (no markup injection)", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: { ...input.campaign, footerText: "<script>alert(1)</script>" },
    });
    expect(out.html).not.toMatch(/<script/i);
    expect(out.html).toContain("&lt;script&gt;");
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

  it("drops tags with an unterminated attribute quote instead of leaking them verbatim", () => {
    // An unterminated quote makes a quote-aware tag regex fail to find the tag's
    // closing '>', so a naive sanitizer passes the whole tag through verbatim —
    // and the appended footer's href="..." closes the dangling quote, leaving a
    // live onerror handler in the delivered email (stored XSS).
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody: '<img src="x" onerror="alert(document.cookie)" alt="',
      },
    });
    expect(out.html).not.toMatch(/onerror/i);
    expect(out.html).not.toContain("alert(document.cookie)");
    // No raw <img ...> tag may survive into the output.
    expect(out.html).not.toMatch(/<img\b/i);
    // The footer must still render correctly (i.e. the dangling quote did not
    // swallow or corrupt the appended unsubscribe link).
    expect(out.html).toContain("https://app.test/unsubscribe?token=abc");
  });

  it("keeps verbatim javascript: hrefs out via the same unterminated-quote vector", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody: '<a href="javascript:alert(1)" "',
      },
    });
    expect(out.html).not.toMatch(/javascript:/i);
    expect(out.html).not.toContain("alert(1)");
    expect(out.html).not.toMatch(/<a\b[^>]*javascript/i);
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

  it("blocks javascript: in an href supplied via a merge variable", () => {
    // The href passes isSafeUrl() during sanitization (it looks like the
    // relative URL "{{first_name}}"), but substitution then injects an
    // attacker-controlled scheme. escapeHtml() does not encode ':' so without a
    // dedicated guard the delivered HTML would be href="javascript:...".
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody: '<a href="{{first_name}}">click</a>',
      },
      subscriber: {
        email: "e@x.co",
        firstName: "javascript:alert(document.cookie)",
        lastName: null,
      },
    });
    expect(out.html).not.toMatch(/href="javascript:/i);
    expect(out.html).not.toMatch(/javascript:/i);
    expect(out.html).not.toContain("alert(document.cookie)");
  });

  it("blocks javascript: in an img src supplied via a merge variable", () => {
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody: '<img src="{{first_name}}">',
      },
      subscriber: {
        email: "e@x.co",
        firstName: "javascript:alert(document.cookie)",
        lastName: null,
      },
    });
    expect(out.html).not.toMatch(/src="javascript:/i);
    expect(out.html).not.toMatch(/javascript:/i);
    expect(out.html).not.toContain("alert(document.cookie)");
  });

  it("drops href/src that embed a merge tag even with a literal prefix", () => {
    // A partially-literal URL (https://host/?u={{email}}) is still refused,
    // because the merge value is uncontrolled and substitution happens against
    // the whole HTML string, defeating any post-substitution re-validation.
    const out = renderCampaignEmail({
      ...input,
      campaign: {
        ...input.campaign,
        htmlBody: '<a href="https://h.test/?u={{email}}">x</a>',
      },
      subscriber: { email: "javascript:alert(1)", firstName: null, lastName: null },
    });
    expect(out.html).not.toMatch(/javascript:/i);
    expect(out.html).not.toContain("alert(1)");
    // The anchor's text content is preserved even though the href is dropped.
    expect(out.html).toContain(">x</a>");
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

describe("plan slug -> entitlement mapping", () => {
  it("maps a known plan slug to its key and everything else to the free tier", () => {
    expect(planFromSlug("5k_plan")).toBe("5k_plan");
    expect(planFromSlug("10k_plan")).toBe("10k_plan");
    expect(planFromSlug("100k_plan")).toBe("100k_plan");
    expect(planFromSlug("free_org")).toBe("free_org");
    expect(planFromSlug("unknown")).toBe("free_org");
    expect(planFromSlug(undefined)).toBe("free_org");
    expect(planFromSlug(null)).toBe("free_org");
    expect(planFromSlug("")).toBe("free_org");
  });

  it("resolves the held plan from session billing claims, highest tier first", () => {
    const held = (slugs: string[]) => (p: { plan: string }) => slugs.includes(p.plan);
    expect(planFromEntitlements(held([]))).toBe("free_org");
    expect(planFromEntitlements(held(["org:5k_plan"]))).toBe("5k_plan");
    // Overlapping grants resolve to the most generous tier.
    expect(planFromEntitlements(held(["org:5k_plan", "org:50k_plan"]))).toBe("50k_plan");
  });

  it("centralizes the per-plan monthly email limit (free cannot send)", () => {
    expect(monthlyEmailLimitForPlan("free_org")).toBe(0);
    expect(monthlyEmailLimitForPlan("1k_plan")).toBe(1_000);
    expect(monthlyEmailLimitForPlan("5k_plan")).toBe(5_000);
    expect(monthlyEmailLimitForPlan("10k_plan")).toBe(10_000);
    expect(monthlyEmailLimitForPlan("100k_plan")).toBe(100_000);
  });

  it("gates sending: only paid tiers can send", () => {
    expect(planCanSend("free_org")).toBe(false);
    expect(planCanSend("1k_plan")).toBe(true);
    expect(planCanSend("100k_plan")).toBe(true);
    expect(planCanSend("bogus")).toBe(false);
    expect(firstSendingPlan()).toBe("1k_plan");
  });

  it("gates AI: only 10k and up include the assistant", () => {
    expect(planHasAI("free_org")).toBe(false);
    expect(planHasAI("1k_plan")).toBe(false);
    expect(planHasAI("5k_plan")).toBe(false);
    expect(planHasAI("10k_plan")).toBe(true);
    expect(planHasAI("100k_plan")).toBe(true);
    expect(firstAiPlan()).toBe("10k_plan");
  });

  it("caps free-tier subscribers, paid tiers are unlimited", () => {
    expect(maxSubscribersForPlan("free_org")).toBe(500);
    expect(maxSubscribersForPlan("1k_plan")).toBeNull();
    expect(maxSubscribersForPlan("100k_plan")).toBeNull();
    // An unknown/legacy plan falls back to the free cap (can't hoard).
    expect(maxSubscribersForPlan("bogus")).toBe(500);
  });

  it("suggests the next tier up for upgrade CTAs", () => {
    expect(nextPlanUp("free_org")).toBe("1k_plan");
    expect(nextPlanUp("1k_plan")).toBe("5k_plan");
    expect(nextPlanUp("25k_plan")).toBe("50k_plan");
    expect(nextPlanUp("100k_plan")).toBeNull();
  });

  it("recommends the smallest plan that covers an expected volume", () => {
    expect(recommendedPlanFor(0)).toBe("free_org");
    expect(recommendedPlanFor(1)).toBe("1k_plan");
    expect(recommendedPlanFor(1_001)).toBe("5k_plan");
    expect(recommendedPlanFor(12_000)).toBe("25k_plan");
    expect(recommendedPlanFor(10_000_000)).toBe("100k_plan");
  });

  it("maps each lifecycle to a deterministic subscription status", () => {
    expect(subscriptionStatusForLifecycle("active")).toBe("active");
    expect(subscriptionStatusForLifecycle("past_due")).toBe("past_due");
    expect(subscriptionStatusForLifecycle("ended")).toBe("inactive");
  });

  it("active enables sending on a paid plan with the plan's limit", () => {
    expect(entitlementsFor("10k_plan", "active")).toEqual({
      plan: "10k_plan",
      subscriptionStatus: "active",
      monthlyEmailLimit: 10_000,
      sendingEnabled: true,
    });
  });

  it("the free tier is active but cannot send (set-up only)", () => {
    expect(entitlementsFor("free_org", "active")).toEqual({
      plan: "free_org",
      subscriptionStatus: "active",
      monthlyEmailLimit: 0,
      sendingEnabled: false,
    });
  });

  it("past_due keeps the plan visible but blocks sending", () => {
    expect(entitlementsFor("10k_plan", "past_due")).toEqual({
      plan: "10k_plan",
      subscriptionStatus: "past_due",
      monthlyEmailLimit: 10_000,
      sendingEnabled: false,
    });
  });

  it("never re-enables sending on a risk-paused account, even when active", () => {
    expect(entitlementsFor("10k_plan", "active", { riskPaused: true }).sendingEnabled).toBe(false);
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

  it("blocks a past_due account with a payment-specific reason", () => {
    const result = checkSendEligibility({
      ...account,
      subscriptionStatus: "past_due",
      sendingEnabled: false,
    } as Account);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/past due/i);
  });

  it("blocks when sending disabled or over quota", () => {
    expect(checkSendEligibility({ ...account, sendingEnabled: false } as Account).allowed).toBe(false);
    expect(
      checkSendEligibility({ ...account, monthlyEmailSentCount: 100 } as Account).allowed,
    ).toBe(false);
  });

  it("tells a free-tier account to upgrade (vs a risk pause)", () => {
    const free = checkSendEligibility({
      ...account,
      plan: "free_org",
      sendingEnabled: false,
      riskStatus: "normal",
      monthlyEmailLimit: 0,
    } as Account);
    expect(free.allowed).toBe(false);
    if (!free.allowed) expect(free.reason).toMatch(/free plan/i);

    const paused = checkSendEligibility({
      ...account,
      plan: "10k_plan",
      sendingEnabled: false,
      riskStatus: "paused",
      pausedReason: "High bounce rate",
    } as Account);
    expect(paused.allowed).toBe(false);
    if (!paused.allowed) expect(paused.reason).toMatch(/paused/i);
  });

  it("over-limit reason points at upgrading", () => {
    const result = checkSendEligibility({ ...account, monthlyEmailSentCount: 100 } as Account);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/upgrade/i);
  });
});

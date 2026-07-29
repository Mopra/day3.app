import { describe, expect, it } from "vitest";
import {
  parseSubscriberCsv,
  toSubscriberCsv,
  isValidEmail,
  validateCsvUpload,
  countCsvDataRows,
  MAX_IMPORT_BYTES,
} from "../src/lib/csv";
import { runDeterministicRiskChecks } from "../src/services/risk";
import {
  renderCampaignEmail,
  personalizationFieldsUsed,
  sanitizeHtml,
} from "../src/services/render";
import {
  MAX_AI_MONTHLY_CREDITS,
  PLANS,
  PLAN_ORDER,
  TOP_PLAN,
  aiAllowanceForPlan,
  checkSendEligibility,
  entitlementsFor,
  firstAiPlan,
  firstSendingPlan,
  isUnknownPlanSlug,
  maxSubscribersForPlan,
  missingClerkPlanSlugs,
  monthlyEmailLimitForPlan,
  nextPlanUp,
  planCanSend,
  planFromEntitlements,
  planFromSlug,
  planHasAI,
  planMeta,
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

describe("csv export", () => {
  it("serializes subscribers with a header and the union of attribute keys", () => {
    const csv = toSubscriberCsv([
      { email: "a@x.co", firstName: "Ann", lastName: null, status: "subscribed", attributes: { phone: "123" } },
      { email: "b@x.co", firstName: null, lastName: "Bee", status: "unsubscribed", attributes: { company: "Acme" } },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("email,first_name,last_name,status,company,phone");
    expect(lines[1]).toBe("a@x.co,Ann,,subscribed,,123");
    expect(lines[2]).toBe("b@x.co,,Bee,unsubscribed,Acme,");
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    const csv = toSubscriberCsv([
      { email: "c@x.co", firstName: 'Jo, "JJ"', lastName: "Line\nBreak", status: "subscribed" },
    ]);
    const dataLine = csv.trimEnd().split("\r\n")[1];
    expect(dataLine).toBe('c@x.co,"Jo, ""JJ""","Line\nBreak",subscribed');
  });

  it("round-trips through the parser, ignoring the export-only status column", () => {
    const csv = toSubscriberCsv([
      { email: "RT@X.co", firstName: "Ray", lastName: "Tee", status: "unsubscribed", attributes: { phone: "555" } },
    ]);
    const parsed = parseSubscriberCsv(csv);
    expect(parsed.rows).toEqual([
      { email: "rt@x.co", firstName: "Ray", lastName: "Tee", attributes: { phone: "555" } },
    ]);
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

describe("sanitizer layout attributes (column sections)", () => {
  it("keeps presentational table/td attributes the section builder emits", () => {
    const html =
      '<table role="presentation" width="100%"><tbody><tr>' +
      '<td valign="top" width="50%"><p>Left</p></td>' +
      '<td valign="top" width="50%"><p>Right</p></td>' +
      "</tr></tbody></table>";
    // The serialized column layout must survive sanitization byte-for-byte, so the
    // builder's WYSIWYG promise holds for multi-column sections.
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("still strips style, class, and event handlers from table cells", () => {
    const out = sanitizeHtml(
      '<table style="position:absolute" class="x" onclick="evil()">' +
        '<tbody><tr><td style="background:url(x)" class="c" onmouseover="y()" width="50%">Hi</td></tr></tbody>' +
        "</table>",
    );
    expect(out).not.toMatch(/style=/i);
    expect(out).not.toMatch(/class=/i);
    expect(out).not.toMatch(/onclick|onmouseover/i);
    // The allowlisted presentational attribute (and the content) is retained.
    expect(out).toContain('width="50%"');
    expect(out).toContain("Hi");
  });

  it("keeps the allowlisted d3-col class but drops any other class", () => {
    // d3-col is the responsive-stacking hook the serializer emits on multi-column
    // cells; it must survive so the document <style>'s @media rule can target it.
    expect(sanitizeHtml('<td class="d3-col" width="50%">x</td>')).toBe(
      '<td class="d3-col" width="50%">x</td>',
    );
    // d3-quote-round is the callout-roundness hook; it must survive on both the
    // quote table and its cell so the document <style> can round the corners.
    expect(sanitizeHtml('<table class="d3-quote-round"><tbody><tr><td bgcolor="#eee" class="d3-quote-round">x</td></tr></tbody></table>')).toBe(
      '<table class="d3-quote-round"><tbody><tr><td bgcolor="#eee" class="d3-quote-round">x</td></tr></tbody></table>',
    );
    // Anything not on ALLOWED_CLASSES is dropped (content kept), so a class can never
    // smuggle an arbitrary style hook into the delivered email.
    expect(sanitizeHtml('<td class="evil">x</td>')).toBe("<td>x</td>");
    // A token list is kept only if every token is allowlisted (all-or-nothing).
    expect(sanitizeHtml('<td class="d3-col evil">x</td>')).toBe("<td>x</td>");
  });

  it("keeps validated bgcolor and <font color> (filled buttons / shaded callouts)", () => {
    const html =
      '<table role="presentation" bgcolor="#f4f4f5"><tbody><tr>' +
      '<td bgcolor="#2563eb" height="40"><font color="#ffffff">Go</font></td>' +
      "</tr></tbody></table>";
    // The serialized button/callout markup must survive sanitization byte-for-byte.
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("accepts rgb()/named colors but drops CSS-function or junk color values", () => {
    expect(sanitizeHtml('<td bgcolor="rgb(37,99,235)">x</td>')).toBe('<td bgcolor="rgb(37,99,235)">x</td>');
    expect(sanitizeHtml('<font color="white">x</font>')).toBe('<font color="white">x</font>');
    // url()/expression() and other non-color junk are stripped, content kept.
    expect(sanitizeHtml('<td bgcolor="url(http://evil)"><font color="expression(alert(1))">x</font></td>')).toBe(
      "<td><font>x</font></td>",
    );
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
    expect(planFromEntitlements(held(["org:1m_plan", "org:10k_plan"]))).toBe("1m_plan");
  });

  it("centralizes the per-plan monthly email limit (free cannot send)", () => {
    expect(monthlyEmailLimitForPlan("free_org")).toBe(0);
    expect(monthlyEmailLimitForPlan("1k_plan")).toBe(1_000);
    expect(monthlyEmailLimitForPlan("5k_plan")).toBe(5_000);
    expect(monthlyEmailLimitForPlan("10k_plan")).toBe(10_000);
    expect(monthlyEmailLimitForPlan("100k_plan")).toBe(100_000);
    expect(monthlyEmailLimitForPlan("250k_plan")).toBe(250_000);
    expect(monthlyEmailLimitForPlan("500k_plan")).toBe(500_000);
    expect(monthlyEmailLimitForPlan("1m_plan")).toBe(1_000_000);
  });

  // The ladder drives recommendedPlanFor, nextPlanUp and the "highest tier wins"
  // resolution in planFromEntitlements — all of which silently misbehave if a tier
  // is added out of order or a price/limit is fat-fingered.
  it("keeps the ladder strictly ascending in both allowance and price", () => {
    const paid = PLAN_ORDER.filter((p) => p !== "free_org");
    for (let i = 1; i < paid.length; i++) {
      const prev = planMeta(paid[i - 1]);
      const curr = planMeta(paid[i]);
      expect(curr.monthlyEmailLimit).toBeGreaterThan(prev.monthlyEmailLimit);
      expect(curr.monthlyPriceUsd).toBeGreaterThan(prev.monthlyPriceUsd);
    }
    // Every catalog entry is on the ladder, and vice versa.
    expect([...PLAN_ORDER].sort()).toEqual(Object.keys(PLANS).sort());
    expect(TOP_PLAN).toBe(PLAN_ORDER[PLAN_ORDER.length - 1]);
  });

  // Cost floor is SES at $0.10/1k, so a tier priced under that loses money on
  // every send. Cheap by design, never below cost.
  it("prices every paid tier above raw delivery cost", () => {
    for (const plan of PLAN_ORDER.filter((p) => p !== "free_org")) {
      const meta = planMeta(plan);
      const sesCostUsd = (meta.monthlyEmailLimit / 1000) * 0.1;
      expect(meta.monthlyPriceUsd).toBeGreaterThan(sesCostUsd);
    }
  });

  // The AI allowance is metered real spend, so a cheap tier handing out a big
  // allowance quietly inverts its own margin.
  it("never lets a cheaper tier carry a larger AI allowance than a dearer one", () => {
    const paid = PLAN_ORDER.filter((p) => p !== "free_org");
    for (let i = 1; i < paid.length; i++) {
      expect(planMeta(paid[i]).aiMonthlyCredits).toBeGreaterThanOrEqual(
        planMeta(paid[i - 1]).aiMonthlyCredits,
      );
      expect(planMeta(paid[i]).aiWindowCredits).toBeGreaterThanOrEqual(
        planMeta(paid[i - 1]).aiWindowCredits,
      );
    }
  });

  // A Clerk dashboard slug that doesn't match a catalog key fails silently: the
  // tier stops resolving and the org reads as Free. These two guards are what make
  // that state observable.
  it("flags a Clerk slug the catalog doesn't know, but not an absent one", () => {
    expect(isUnknownPlanSlug("1M_plan")).toBe(true); // wrong case — the classic typo
    expect(isUnknownPlanSlug("1m-plan")).toBe(true);
    expect(isUnknownPlanSlug("some_removed_plan")).toBe(true);
    // Absent/blank means "no subscription", which is a legitimate state.
    expect(isUnknownPlanSlug(undefined)).toBe(false);
    expect(isUnknownPlanSlug(null)).toBe(false);
    expect(isUnknownPlanSlug("")).toBe(false);
    // Every real key is, of course, known.
    for (const plan of PLAN_ORDER) expect(isUnknownPlanSlug(plan)).toBe(false);
  });

  it("reports paid tiers Clerk has no plan for", () => {
    const allPaid = PLAN_ORDER.filter((p) => p !== "free_org");
    // Clerk fully configured → nothing missing. free_org is never expected.
    expect(missingClerkPlanSlugs(allPaid)).toEqual([]);
    // A typo'd slug in the dashboard shows up as the tier being absent.
    const typo = allPaid.filter((p) => p !== "1m_plan").concat("1M_plan");
    expect(missingClerkPlanSlugs(typo)).toEqual(["1m_plan"]);
    // Nothing configured at all → every paid tier is missing, in ladder order.
    expect(missingClerkPlanSlugs([])).toEqual(allPaid);
  });

  it("gates sending: only paid tiers can send", () => {
    expect(planCanSend("free_org")).toBe(false);
    expect(planCanSend("1k_plan")).toBe(true);
    expect(planCanSend("100k_plan")).toBe(true);
    expect(planCanSend("bogus")).toBe(false);
    expect(firstSendingPlan()).toBe("1k_plan");
  });

  it("gates AI: every paid tier includes the assistant, free does not", () => {
    expect(planHasAI("free_org")).toBe(false);
    expect(planHasAI("1k_plan")).toBe(true);
    expect(planHasAI("5k_plan")).toBe(true);
    expect(planHasAI("10k_plan")).toBe(true);
    expect(planHasAI("100k_plan")).toBe(true);
    expect(planHasAI("bogus")).toBe(false);
    expect(firstAiPlan()).toBe("1k_plan");
  });

  it("scales the AI allowance with the tier, and gives free none", () => {
    expect(aiAllowanceForPlan("free_org")).toEqual({ windowCredits: 0, monthlyCredits: 0 });
    // The allowance climbs with the price: 1k < 5k < 10k < the full 25k+ one.
    const starter = aiAllowanceForPlan("1k_plan");
    const mid = aiAllowanceForPlan("5k_plan");
    const upper = aiAllowanceForPlan("10k_plan");
    const full = aiAllowanceForPlan("25k_plan");
    expect(starter.monthlyCredits).toBeGreaterThan(0);
    expect(starter.monthlyCredits).toBeLessThan(mid.monthlyCredits);
    expect(mid.monthlyCredits).toBeLessThan(upper.monthlyCredits);
    expect(upper.monthlyCredits).toBeLessThan(full.monthlyCredits);
    expect(full.monthlyCredits).toBe(MAX_AI_MONTHLY_CREDITS);
    // 25k and every tier above it share the full allowance.
    expect(aiAllowanceForPlan("100k_plan")).toEqual(full);
    expect(aiAllowanceForPlan("1m_plan")).toEqual(full);
    // An unknown/legacy plan degrades to no AI, never to the full allowance.
    expect(aiAllowanceForPlan("bogus")).toEqual({ windowCredits: 0, monthlyCredits: 0 });
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
    expect(nextPlanUp("100k_plan")).toBe("250k_plan");
    // Only the top of the ladder has nowhere to go (the "contact us" card).
    expect(nextPlanUp("1m_plan")).toBeNull();
  });

  it("recommends the smallest plan that covers an expected volume", () => {
    expect(recommendedPlanFor(0)).toBe("free_org");
    expect(recommendedPlanFor(1)).toBe("1k_plan");
    expect(recommendedPlanFor(1_001)).toBe("5k_plan");
    expect(recommendedPlanFor(12_000)).toBe("25k_plan");
    expect(recommendedPlanFor(120_000)).toBe("250k_plan");
    // Past the top of the ladder we still return the largest tier (the UI shows
    // the "contact us" card alongside it).
    expect(recommendedPlanFor(10_000_000)).toBe("1m_plan");
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

import { describe, expect, it } from "vitest";
import {
  normalizeFields,
  normalizeAttributes,
  splitSubmittedFields,
  slugifyFieldKey,
  type FormField,
} from "../src/lib/form-fields";
import { parseSubscriberCsv } from "../src/lib/csv";
import { renderCampaignEmail } from "../src/services/render";

describe("slugifyFieldKey", () => {
  it("derives merge-tag-safe keys from labels", () => {
    expect(slugifyFieldKey("Phone number")).toBe("phone_number");
    expect(slugifyFieldKey("Company / Org")).toBe("company_org");
    expect(slugifyFieldKey("  First name  ")).toBe("first_name");
    expect(slugifyFieldKey("!!!")).toBe("");
  });
});

describe("normalizeFields", () => {
  it("drops malformed, reserved-email, and duplicate-key entries", () => {
    const fields = normalizeFields([
      { key: "first_name", label: "First name", type: "text", required: false },
      { key: "first_name", label: "Dup", type: "text", required: true }, // dup key dropped
      { key: "email", label: "Email", type: "email", required: true }, // reserved → dropped
      { key: "phone", label: "Phone", type: "tel", required: true },
      { key: "", label: "No key", type: "text", required: false }, // empty key dropped
      { label: "No key field", type: "text", required: false }, // missing key dropped
      "garbage",
    ]);
    expect(fields.map((f) => f.key)).toEqual(["first_name", "phone"]);
    expect(fields.find((f) => f.key === "phone")?.type).toBe("tel");
  });

  it("falls back to a text type for unknown types and returns [] for non-arrays", () => {
    expect(normalizeFields("nope")).toEqual([]);
    const [f] = normalizeFields([{ key: "x", label: "X", type: "weird", required: false }]);
    expect(f.type).toBe("text");
  });
});

describe("splitSubmittedFields", () => {
  const fields: FormField[] = [
    { key: "first_name", label: "First name", type: "text", required: false },
    { key: "last_name", label: "Last name", type: "text", required: false },
    { key: "phone", label: "Phone", type: "tel", required: false },
    { key: "company", label: "Company", type: "text", required: false },
  ];

  it("routes reserved keys to columns and the rest to attributes", () => {
    const out = splitSubmittedFields(fields, {
      first_name: "Alex",
      last_name: "Rivera",
      phone: "+1 555",
      company: "Acme",
    });
    expect(out.firstName).toBe("Alex");
    expect(out.lastName).toBe("Rivera");
    expect(out.attributes).toEqual({ phone: "+1 555", company: "Acme" });
  });

  it("ignores keys not declared on the form (no arbitrary attribute injection)", () => {
    const out = splitSubmittedFields(fields, { phone: "1", is_admin: "true", evil: "x" });
    expect(out.attributes).toEqual({ phone: "1" });
  });

  it("returns null attributes when nothing custom was provided", () => {
    const out = splitSubmittedFields(fields, { first_name: "Sam" });
    expect(out.attributes).toBeNull();
  });
});

describe("normalizeAttributes", () => {
  it("slugs keys, trims values, drops blanks and reserved keys", () => {
    expect(
      normalizeAttributes({ "Phone Number": " 555 ", first_name: "no", empty: "", company: "Acme" }),
    ).toEqual({ phone_number: "555", company: "Acme" });
  });

  it("returns null when nothing usable remains", () => {
    expect(normalizeAttributes({ "": "x", first_name: "y" })).toBeNull();
    expect(normalizeAttributes(null)).toBeNull();
  });
});

describe("parseSubscriberCsv with custom columns", () => {
  it("maps unknown columns into attributes keyed by a slug of the header", () => {
    const csv = "email,First Name,Phone Number,Company\nalex@example.com,Alex,555-1234,Acme\n";
    const { rows, invalidRows } = parseSubscriberCsv(csv);
    expect(invalidRows).toBe(0);
    expect(rows[0]).toMatchObject({
      email: "alex@example.com",
      firstName: "Alex",
      attributes: { phone_number: "555-1234", company: "Acme" },
    });
  });

  it("still requires an email column", () => {
    expect(() => parseSubscriberCsv("name,phone\nAlex,555\n")).toThrow(/email/);
  });
});

describe("renderCampaignEmail custom merge tags", () => {
  const base = {
    campaign: { subject: "Hi {{first_name}}", htmlBody: "<p>Your plan: {{plan|free}}. Call {{phone}}.</p>" },
    companyName: "Acme",
    companyAddress: "1 St",
    unsubscribeUrl: "https://x/unsub",
  };

  it("substitutes custom attribute tags from the subscriber", () => {
    const out = renderCampaignEmail({
      ...base,
      subscriber: { email: "a@b.com", firstName: "Alex", attributes: { plan: "Pro", phone: "555" } },
    });
    expect(out.html).toContain("Your plan: Pro. Call 555.");
    expect(out.subject).toBe("Hi Alex");
  });

  it("uses the fallback when a custom tag has no value", () => {
    const out = renderCampaignEmail({
      ...base,
      subscriber: { email: "a@b.com", firstName: "Alex", attributes: { phone: "555" } },
    });
    expect(out.html).toContain("Your plan: free.");
  });

  it("never lets a subscriber attribute shadow a reserved built-in tag", () => {
    const out = renderCampaignEmail({
      campaign: { subject: "s", htmlBody: "<p>{{company_name}}</p>" },
      subscriber: {
        email: "a@b.com",
        attributes: { company_name: "EVIL" },
      },
      companyName: "Acme",
      companyAddress: "1 St",
      unsubscribeUrl: "https://x/unsub",
    });
    expect(out.html).toContain("Acme");
    expect(out.html).not.toContain("EVIL");
  });
});

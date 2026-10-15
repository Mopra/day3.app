import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapBeehiivStatus } from "../../src/importers/beehiiv";
import { mapKitStatus } from "../../src/importers/kit";
import { mailchimpDataCenter, mapMailchimpStatus } from "../../src/importers/mailchimp";
import { mapMailerLiteStatus } from "../../src/importers/mailerlite";
import { buildRecord, providerGet, retryDelayMs, toIso } from "../../src/importers/http";
import { csvHeaderError, parseSubscriberCsv } from "../../src/lib/csv";

const CSV = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "importers", "csv");
const csv = (name: string) => readFileSync(join(CSV, name), "utf8");

// Every status value each provider's spec enumerates, and what Day3 makes of it.
// The rule under test: only the provider's own "active" is ever `subscribed`;
// its opt-out is `unsubscribed`; everything else (bounced, complained, cleaned,
// unconfirmed, and any value we have never seen) is skipped.
describe("provider status mapping covers every documented status", () => {
  it("beehiiv SubscriptionExpandedStatus", () => {
    expect(
      Object.fromEntries(
        ["validating", "invalid", "pending", "active", "inactive", "needs_attention", "paused", "brand_new"].map(
          (s) => [s, mapBeehiivStatus(s)],
        ),
      ),
    ).toEqual({
      validating: "skip",
      invalid: "skip",
      pending: "skip",
      active: "subscribed",
      inactive: "unsubscribed",
      needs_attention: "skip",
      paused: "unsubscribed",
      brand_new: "skip",
    });
  });

  it("Kit subscriber state", () => {
    expect(
      Object.fromEntries(
        ["active", "cancelled", "bounced", "complained", "inactive", "brand_new"].map((s) => [s, mapKitStatus(s)]),
      ),
    ).toEqual({
      active: "subscribed",
      cancelled: "unsubscribed",
      bounced: "skip",
      complained: "skip",
      inactive: "skip",
      brand_new: "skip",
    });
  });

  it("Mailchimp member status", () => {
    expect(
      Object.fromEntries(
        ["subscribed", "unsubscribed", "cleaned", "pending", "transactional", "archived", "brand_new"].map((s) => [
          s,
          mapMailchimpStatus(s),
        ]),
      ),
    ).toEqual({
      subscribed: "subscribed",
      unsubscribed: "unsubscribed",
      cleaned: "skip",
      pending: "skip",
      transactional: "skip",
      archived: "skip",
      brand_new: "skip",
    });
  });

  it("MailerLite subscriber status", () => {
    expect(
      Object.fromEntries(
        ["active", "unsubscribed", "unconfirmed", "bounced", "junk", "brand_new"].map((s) => [s, mapMailerLiteStatus(s)]),
      ),
    ).toEqual({
      active: "subscribed",
      unsubscribed: "unsubscribed",
      unconfirmed: "skip",
      bounced: "skip",
      junk: "skip",
      brand_new: "skip",
    });
  });
});

describe("provider plumbing", () => {
  it("reads the Mailchimp data center strictly from the key", () => {
    expect(mailchimpDataCenter("fake-key-us21")).toBe("us21");
    expect(mailchimpDataCenter("abc-us1")).toBe("us1");
    expect(mailchimpDataCenter("abc")).toBeNull();
    // Never a host name an attacker chooses.
    expect(mailchimpDataCenter("abc-evil.com/x")).toBeNull();
    expect(mailchimpDataCenter("abc-us21.attacker")).toBeNull();
  });

  it("computes 429 waits from Retry-After, RateLimit-Reset (epoch or delta), or backoff", () => {
    const now = 1_700_000_000_000;
    const r = (h: Record<string, string>) => new Response(null, { status: 429, headers: h });
    expect(retryDelayMs(r({ "Retry-After": "119" }), 0, now)).toBe(119_000);
    expect(retryDelayMs(r({ "RateLimit-Reset": String(now / 1000 + 30) }), 0, now)).toBe(30_250);
    expect(retryDelayMs(r({ "RateLimit-Reset": "5" }), 0, now)).toBe(5000);
    const fallback = retryDelayMs(r({}), 3, now);
    expect(fallback).toBeGreaterThanOrEqual(8000);
    expect(fallback).toBeLessThan(8250);
  });

  it("maps HTTP failures to codes and never leaks the key", async () => {
    const respond = (status: number) =>
      (async () => new Response(JSON.stringify({ echo: "key-123456789" }), { status })) as unknown as typeof fetch;
    const ctx = (status: number) => ({ apiKey: "key-123456789", fetch: respond(status), sleep: async () => {}, maxAttempts: 2 });
    const codeOf = async (status: number) => {
      try {
        await providerGet("beehiiv", ctx(status), "https://api.beehiiv.com/v2/publications", {});
        return "ok";
      } catch (err) {
        expect((err as Error).message).not.toContain("key-123456789");
        return (err as { code: string }).code;
      }
    };
    expect(await codeOf(401)).toBe("bad_key");
    expect(await codeOf(403)).toBe("no_access");
    expect(await codeOf(404)).toBe("not_found");
    expect(await codeOf(429)).toBe("rate_limited");
    expect(await codeOf(503)).toBe("upstream");
    expect(await codeOf(422)).toBe("bad_request");
  });

  it("builds records: canonical email, names from fields, attributes slugged", () => {
    expect(
      buildRecord({
        email: "  Ada@Example.COM ",
        status: "subscribed",
        fields: [
          { name: "First Name", value: "Ada" },
          { name: "Last Name", value: "Lovelace" },
          { name: "Favourite colour", value: "blue" },
          { name: "Empty", value: "" },
        ],
        createdAt: 1666800076,
      }),
    ).toEqual({
      kind: "row",
      row: {
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        status: "subscribed",
        unsubscribedAt: undefined,
        attributes: { favourite_colour: "blue" },
        createdAt: "2022-10-26T16:01:16.000Z",
      },
    });
    expect(buildRecord({ email: "nope", status: "subscribed" })).toEqual({ kind: "skip", reason: "invalid" });
    expect(buildRecord({ email: "a@b.co", status: "skip" })).toEqual({ kind: "skip", reason: "status" });
    expect(toIso("2021-09-01 14:03:50")).toBe("2021-09-01T14:03:50.000Z");
  });
});

// The CSV path is the fallback when a key cannot reach the API (beehiiv's free
// plan). Each provider's real export must import without editing the file, and
// never turn an opt-out, bounce or unconfirmed address into a subscriber.
describe("CSV import reads each provider's export as it comes", () => {
  it("beehiiv export: status column, tiers as fields, UTC dates", () => {
    const parsed = parseSubscriberCsv(csv("beehiiv-export.csv"));
    expect(parsed.totalRows).toBe(7);
    // pending, validating, invalid, needs_attention
    expect(parsed.statusSkippedRows).toBe(4);
    const byEmail = Object.fromEntries(parsed.rows.map((r) => [r.email, r]));
    expect(byEmail["ada@example.com"]).toMatchObject({
      status: "subscribed",
      firstName: "Ada",
      lastName: "Lovelace",
      createdAt: "2023-03-24T10:23:10.000Z",
      attributes: { tier: "premium", stripe_customer_id: "cus_123", free_tier: "No", gold_tier: "Yes" },
    });
    expect(byEmail["left@example.com"]).toMatchObject({
      status: "unsubscribed",
      unsubscribedAt: "2023-05-05T12:00:00.000Z",
    });
    expect(byEmail["paused@example.com"].status).toBe("unsubscribed");
  });

  it("Mailchimp export: the subscribed, unsubscribed and cleaned files", () => {
    for (const f of ["mailchimp-subscribed.csv", "mailchimp-unsubscribed.csv", "mailchimp-cleaned.csv"]) {
      expect(csvHeaderError(csv(f)), f).toBeNull();
    }
    const subscribed = parseSubscriberCsv(csv("mailchimp-subscribed.csv"));
    expect(subscribed.rows).toHaveLength(1);
    expect(subscribed.rows[0]).toMatchObject({
      email: "urist@example.com",
      firstName: "Urist",
      lastName: "McVankab",
      createdAt: "2019-06-01T10:00:00.000Z", // CONFIRM_TIME, OPTIN_TIME was empty
    });
    expect(subscribed.rows[0].status ?? "subscribed").toBe("subscribed");
    // Mailchimp bookkeeping columns are dropped; real merge fields and tags stay.
    expect(subscribed.rows[0].attributes).toEqual({ company: "Dwarf Fortress", tags: '"VIP"' });

    // No status column: UNSUB_TIME is what says "everyone here left".
    const unsub = parseSubscriberCsv(csv("mailchimp-unsubscribed.csv"));
    expect(unsub.rows).toHaveLength(1);
    expect(unsub.rows[0]).toMatchObject({
      email: "gone@example.com",
      status: "unsubscribed",
      unsubscribedAt: "2021-03-04T05:06:07.000Z",
    });
    expect(unsub.rows[0].attributes).toEqual({ unsub_reason: "I no longer want to receive these emails" });

    // Cleaned = hard bounced at Mailchimp: skipped, never imported.
    const cleaned = parseSubscriberCsv(csv("mailchimp-cleaned.csv"));
    expect(cleaned.rows).toHaveLength(0);
    expect(cleaned.statusSkippedRows).toBe(1);
  });

  it("Kit export: status words from the app", () => {
    const parsed = parseSubscriberCsv(csv("kit-export.csv"));
    const byEmail = Object.fromEntries(parsed.rows.map((r) => [r.email, r]));
    expect(Object.keys(byEmail).sort()).toEqual([
      "alice@convertkit.dev",
      "benito@convertkit.dev",
      "cancelled@convertkit.dev",
      "cold@convertkit.dev",
    ]);
    expect(byEmail["alice@convertkit.dev"]).toMatchObject({ status: "subscribed", firstName: "Alice", createdAt: "2023-01-27T11:43:55.000Z" });
    expect(byEmail["benito@convertkit.dev"].status).toBe("unsubscribed");
    expect(byEmail["cancelled@convertkit.dev"].status).toBe("unsubscribed");
    expect(byEmail["cold@convertkit.dev"].status).toBe("subscribed");
    expect(parsed.statusSkippedRows).toBe(3); // complained, unconfirmed, bounced
  });

  it("MailerLite export: 'Subscriber' is the email column", () => {
    const active = parseSubscriberCsv(csv("mailerlite-active.csv"));
    expect(active.rows).toEqual([
      {
        email: "dummy@example.com",
        firstName: "Dummy",
        lastName: "Testerson",
        createdAt: "2021-09-01T14:03:50.000Z",
        attributes: { company: "Acme" },
      },
    ]);
    const withStatus = parseSubscriberCsv(csv("mailerlite-with-status.csv"));
    expect(withStatus.rows).toHaveLength(1);
    expect(withStatus.rows[0]).toMatchObject({ email: "left@example.com", status: "unsubscribed" });
    expect(withStatus.statusSkippedRows).toBe(1); // junk
  });

  it("a plain CSV is read exactly as before", () => {
    const parsed = parseSubscriberCsv("email,first_name,plan\na@x.co,A,trial\nb@x.co,,paid");
    expect(parsed.rows).toEqual([
      { email: "a@x.co", firstName: "A", attributes: { plan: "trial" } },
      { email: "b@x.co", attributes: { plan: "paid" } },
    ]);
  });
});

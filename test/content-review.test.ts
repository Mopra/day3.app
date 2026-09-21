// Pre-send safety review for transactional content, and the new-account ramp.
//
// The anchor of this file is `HOTDOC_PHISH`: the real body of a phishing run
// that went out through POST /v1/emails in September 2026. 16,642 messages
// reached Australian inboxes impersonating a healthcare booking service, and
// every check the platform had at the time passed it, because every one of them
// was on the campaign path and this never touched a campaign. Any change that
// makes that payload sendable again is a regression, whatever else it fixes.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { accounts, contentReviews } from "../src/db/schema";
import {
  contentFingerprint,
  findContentReview,
  reviewAndStoreContent,
  screenTransactionalContent,
} from "../src/services/content-review";
import { runDeterministicRiskChecks } from "../src/services/risk";
import { reserveQuota, releaseReservation, quotaBlockReason } from "../src/services/quota";
import { rampDailyLimit, rampRemaining } from "../src/services/send-ramp";
import { seedAccount, testDb } from "./helpers";

// Trimmed from the real message: the From name of a brand the mail is not sent
// by, that brand's own site linked as the logo, the original SendGrid tracking
// pixel left in from the template it was copied out of, a Medicare refund lure,
// and a "sign in" button pointing at a ClickFunnels page.
const HOTDOC_PHISH = {
  subject: "Please Confirm Your Medicare Billing and Payment Information",
  fromEmail: "news@globalcitiys.com",
  fromName: "HotDoc",
  sendingDomain: "globalcitiys.com",
  html: `
    <div>
      <a href="https://www.hotdoc.com.au" title="HotDoc">
        <img alt="HotDoc" src="https://d1l6ddaqkjdc5s.cloudfront.net/assets/logo-email.png" />
      </a>
      <p>Hi Customer,</p>
      <p>We've made it easier to manage your Medicare claims and pay backs.</p>
      <p>Claim Type: Medicare Consultation Pay Back</p>
      <p>Status: Awaiting Patient Verification</p>
      <p>Estimated Amount: Up to $150.00 AUD</p>
      <p>To make sure your details are ready, please sign in to your account and review your pay back profile.</p>
      <a href="https://johnnyalfredosteamwfea48.myclickfunnels.com/hotdoc">Sign In to HotDoc</a>
      <img src="https://u7465326.ct.sendgrid.net/wf/open?upn=u001.7-2FXfiwRL03oG" />
      <p>Thanks, HotDoc — www.hotdoc.com.au</p>
    </div>`,
  text: null,
};

describe("deterministic screen: the September 2026 phishing run", () => {
  it("blocks the real payload", () => {
    const review = screenTransactionalContent(HOTDOC_PHISH);
    expect(review.riskLevel).toBe("blocked");
    expect(review.categories).toContain("brand_impersonation");
    expect(review.categories).toContain("credential_harvest");
    expect(review.categories).toContain("foreign_tracking");
  });

  it("blocks it on the strength of the From name alone", () => {
    // Strip the copied tracking pixel and the funnel link — the two most
    // obviously dodgy artefacts — and the impersonation plus the ask is still
    // the whole of phishing, so it must still be refused.
    const cleaned = HOTDOC_PHISH.html
      .replace(/<img src="https:\/\/u7465326[^>]*>/, "")
      .replace("https://johnnyalfredosteamwfea48.myclickfunnels.com/hotdoc", "https://example.com/x");
    const review = screenTransactionalContent({ ...HOTDOC_PHISH, html: cleaned });
    expect(review.riskLevel).toBe("blocked");
  });

  it("stops impersonating once the mail is actually sent by the brand", () => {
    // Same words, same links, but now sent from hotdoc.com.au. Nothing about
    // this is phishing, and the rule has to know the difference — otherwise
    // every company that links to its own website is blocked.
    const review = screenTransactionalContent({
      ...HOTDOC_PHISH,
      fromEmail: "news@hotdoc.com.au",
      sendingDomain: "hotdoc.com.au",
    });
    expect(review.categories).not.toContain("brand_impersonation");
    expect(review.riskLevel).not.toBe("blocked");
  });
});

describe("deterministic screen: legitimate transactional mail", () => {
  const legit = {
    fromEmail: "noreply@acme.com",
    fromName: "Acme",
    sendingDomain: "acme.com",
    text: null,
  };

  it("allows a password reset that says all the phishing words", () => {
    // "verify your account" and "sign in to your account" are what a real
    // password-reset email says. Blocking on that phrase alone would break
    // every customer's auth flow, which is why the rule needs a PAIR.
    const review = screenTransactionalContent({
      ...legit,
      subject: "Reset your password",
      html: `<p>Click below to verify your account and sign in to your account again.</p>
             <a href="https://acme.com/reset?token=abc123">Reset password</a>`,
    });
    expect(review.riskLevel).not.toBe("blocked");
  });

  it("allows a receipt", () => {
    const review = screenTransactionalContent({
      ...legit,
      subject: "Your receipt from Acme",
      html: `<p>Thanks for your payment of $19.00.</p><a href="https://acme.com/invoices/9">View invoice</a>`,
    });
    expect(review.riskLevel).toBe("low");
  });

  it("does not treat a generic From name as a brand", () => {
    // "Support" and "Notifications" must never be what matches a linked
    // domain, or any company linking to a partner gets flagged.
    const review = screenTransactionalContent({
      ...legit,
      fromName: "Support Team",
      subject: "Your ticket was updated",
      html: `<p>See the update.</p><a href="https://status.stripe.com">Status page</a>`,
    });
    expect(review.categories).not.toContain("brand_impersonation");
  });
});

describe("content fingerprint", () => {
  it("is stable across per-recipient variation", () => {
    // A password reset differs on every send: different token, different
    // expiry, different name. If each of those were a new fingerprint the
    // cache would never hit and every reset email would pay for a model call.
    const a = contentFingerprint({
      subject: "Reset your password",
      fromEmail: "noreply@acme.com",
      fromName: "Acme",
      sendingDomain: "acme.com",
      html: `<p>Hi alice@example.com, your code is 448210.</p><a href="https://acme.com/r?token=aaaaaaaaaaaaaaaaaaaa">Reset</a>`,
      text: null,
    });
    const b = contentFingerprint({
      subject: "Reset your password",
      fromEmail: "noreply@acme.com",
      fromName: "Acme",
      sendingDomain: "acme.com",
      html: `<p>Hi bob@example.com, your code is 913772.</p><a href="https://acme.com/r?token=bbbbbbbbbbbbbbbbbbbb">Reset</a>`,
      text: null,
    });
    expect(a).toBe(b);
  });

  it("changes when the words change", () => {
    const base = {
      subject: "Reset your password",
      fromEmail: "noreply@acme.com",
      fromName: "Acme",
      sendingDomain: "acme.com",
      text: null,
    };
    const a = contentFingerprint({ ...base, html: "<p>Reset your password.</p>" });
    const b = contentFingerprint({ ...base, html: "<p>Confirm your billing details.</p>" });
    expect(a).not.toBe(b);
  });

  it("changes when the link host changes", () => {
    // The normaliser erases query strings; it must NOT erase where a link
    // points, or an attacker could swap the destination for free.
    const base = {
      subject: "Sign in",
      fromEmail: "noreply@acme.com",
      fromName: "Acme",
      sendingDomain: "acme.com",
      text: null,
    };
    const a = contentFingerprint({ ...base, html: `<a href="https://acme.com/go">Go</a>` });
    const b = contentFingerprint({ ...base, html: `<a href="https://evil.example/go">Go</a>` });
    expect(a).not.toBe(b);
  });
});

describe("review cache", () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
  });

  it("stores a verdict once and reuses it", async () => {
    const account = await seedAccount(db);
    const first = await reviewAndStoreContent(db, account.id, HOTDOC_PHISH, undefined);
    expect(first.riskLevel).toBe("blocked");

    const second = await reviewAndStoreContent(db, account.id, HOTDOC_PHISH, undefined);
    expect(second.id).toBe(first.id);

    const all = await db.select().from(contentReviews).where(eq(contentReviews.accountId, account.id));
    expect(all).toHaveLength(1);
  });

  it("scopes verdicts per account", async () => {
    // One tenant's blocked content must not become another tenant's cached
    // verdict — the fingerprint is derived from body text, so a shared cache
    // would let an account probe what a different account has been sending.
    const a = await seedAccount(db);
    const b = await seedAccount(db);
    await reviewAndStoreContent(db, a.id, HOTDOC_PHISH, undefined);

    const fingerprint = contentFingerprint(HOTDOC_PHISH);
    expect(await findContentReview(db, a.id, fingerprint)).not.toBeNull();
    expect(await findContentReview(db, b.id, fingerprint)).toBeNull();
  });

  it("survives a concurrent first review of the same content", async () => {
    const account = await seedAccount(db);
    const [x, y] = await Promise.all([
      reviewAndStoreContent(db, account.id, HOTDOC_PHISH, undefined),
      reviewAndStoreContent(db, account.id, HOTDOC_PHISH, undefined),
    ]);
    expect(x.id).toBe(y.id);
    const all = await db.select().from(contentReviews).where(eq(contentReviews.accountId, account.id));
    expect(all).toHaveLength(1);
  });
});

describe("new-account send ramp", () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it("caps a brand new account well below its plan limit", async () => {
    // The exact shape of the incident: a paid plan bought minutes after
    // signup. The plan says 100,000; day one says 500.
    const account = await seedAccount(db, {
      rampLiftedAt: null,
      createdAt: nowMinus(0),
      monthlyEmailLimit: 100_000,
    });
    expect(rampDailyLimit(account)).toBe(500);

    const granted = await reserveQuota(db, account.id, 10_000);
    expect(granted).toBe(500);

    const after = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(after!.dailySentCount).toBe(500);
    // The plan counter only moved by what was actually granted.
    expect(after!.monthlyEmailSentCount).toBe(500);
  });

  it("relaxes as the account ages and lifts entirely after two weeks", async () => {
    const day2 = await seedAccount(db, { rampLiftedAt: null, createdAt: daysAgo(2) });
    expect(rampDailyLimit(day2)).toBe(2_000);

    const day5 = await seedAccount(db, { rampLiftedAt: null, createdAt: daysAgo(5) });
    expect(rampDailyLimit(day5)).toBe(10_000);

    const old = await seedAccount(db, { rampLiftedAt: null, createdAt: daysAgo(30) });
    expect(rampDailyLimit(old)).toBeNull();
    expect(rampRemaining(old)).toBeNull();

    const granted = await reserveQuota(db, old.id, 9_000);
    expect(granted).toBe(9_000);
  });

  it("lets an operator lift the ramp", async () => {
    const account = await seedAccount(db, {
      rampLiftedAt: new Date().toISOString(),
      createdAt: nowMinus(0),
      monthlyEmailLimit: 100_000,
    });
    expect(rampDailyLimit(account)).toBeNull();
    expect(await reserveQuota(db, account.id, 10_000)).toBe(10_000);
  });

  it("still enforces the plan limit under the ramp", async () => {
    // The ramp only ever LOWERS the ceiling. It must never grant more than the
    // plan does, or it becomes a second meter (AGENTS.md: one ledger).
    const account = await seedAccount(db, {
      rampLiftedAt: null,
      createdAt: daysAgo(30),
      monthlyEmailLimit: 100,
    });
    expect(await reserveQuota(db, account.id, 5_000)).toBe(100);
  });

  it("resets the daily counter on a new UTC day", async () => {
    const account = await seedAccount(db, { rampLiftedAt: null, createdAt: daysAgo(1) });
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);

    expect(await reserveQuota(db, account.id, 2_000, undefined, today)).toBe(2_000);
    expect(await reserveQuota(db, account.id, 100, undefined, today)).toBe(0);
    // A new day starts from zero without any scheduled reset having to run.
    expect(await reserveQuota(db, account.id, 100, undefined, tomorrow)).toBe(100);
  });

  it("credits the daily counter when a reservation is released", async () => {
    const account = await seedAccount(db, { rampLiftedAt: null, createdAt: nowMinus(0) });
    await reserveQuota(db, account.id, 500);
    await releaseReservation(db, account.id, 200);

    const after = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(after!.dailySentCount).toBe(300);
    // Abandoned reservations must not eat a young account's ramp.
    expect(await reserveQuota(db, account.id, 500)).toBe(200);
  });

  it("explains the ramp rather than telling a young account to upgrade", async () => {
    const account = await seedAccount(db, {
      rampLiftedAt: null,
      createdAt: nowMinus(0),
      monthlyEmailLimit: 100_000,
    });
    await reserveQuota(db, account.id, 500);

    const reason = await quotaBlockReason(db, account.id);
    expect(reason.limitedBy).toBe("ramp");
    // Upgrading would not help, so the message must not suggest it.
    expect(reason.message).not.toMatch(/upgrade/i);
  });

  it("reports a plan block as a plan block", async () => {
    const account = await seedAccount(db, {
      rampLiftedAt: null,
      createdAt: daysAgo(30),
      monthlyEmailLimit: 10,
    });
    await reserveQuota(db, account.id, 10);
    const reason = await quotaBlockReason(db, account.id);
    expect(reason.limitedBy).toBe("plan");
    expect(reason.message).toBeNull();
  });
});

// seedAccount sets createdAt itself, so ramp tests need an explicit timestamp.
function nowMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("risk engine still reads campaigns the same way", () => {
  it("keeps the existing deterministic categories working", () => {
    const review = runDeterministicRiskChecks({
      subject: "Re: your invoice",
      htmlBody: `<a href="https://bit.ly/x">click</a>`,
      textBody: null,
      fromEmail: "a@b.com",
      fromName: "Acme",
      sendingDomain: "b.com",
    });
    expect(review.categories).toContain("misleading_subject");
    expect(review.categories).toContain("link_mismatch");
  });
});

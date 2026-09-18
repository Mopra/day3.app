import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { audiences, sendingDomains, senders, subscribers } from "../src/db/schema";
import { campaignSendGateError } from "../src/api/campaigns";
import { footerAddress } from "../src/services/footer-address";
import {
  ensureSharedDomain,
  findSharedDomain,
  sharedDomainSendError,
  sharedSandboxDomain,
} from "../src/services/shared-domain";
import { addTeamToAudience, ensureTeamAudience, findTeamAudience } from "../src/services/team-audience";
import { computeOnboardingState } from "../src/services/onboarding";
import {
  seedAccount,
  seedAudience,
  seedDomain,
  seedMember,
  seedSubscribers,
  testDb,
} from "./helpers";

const SHARED = "sandbox.day3.test";

beforeEach(() => {
  process.env.SHARED_SANDBOX_DOMAIN = SHARED;
  process.env.DAY3_POSTAL_ADDRESS = "Day3 ApS, 1 Example Way, Copenhagen";
});

afterEach(() => {
  delete process.env.SHARED_SANDBOX_DOMAIN;
  delete process.env.DAY3_POSTAL_ADDRESS;
});

describe("the shared-domain rule", () => {
  // The invariant the whole day-one feature rests on: the Day3 identity is one
  // we own and every tenant draws on, so it may only ever carry sandbox mail.
  it("refuses a non-sandbox send", () => {
    const domain = { shared: true, sharedDisabledAt: null };
    expect(sharedDomainSendError(domain, { sandbox: false })).toMatch(/only sends to your own team/i);
    expect(sharedDomainSendError(domain, { sandbox: true })).toBeNull();
  });

  it("leaves a customer's own domain alone", () => {
    const domain = { shared: false, sharedDisabledAt: null };
    expect(sharedDomainSendError(domain, { sandbox: false })).toBeNull();
    expect(sharedDomainSendError(domain, { sandbox: true })).toBeNull();
  });

  it("refuses a disabled shared row even in sandbox", () => {
    const domain = { shared: true, sharedDisabledAt: "2026-09-18T00:00:00.000Z" };
    expect(sharedDomainSendError(domain, { sandbox: true })).toMatch(/no longer send/i);
  });

  // Fail closed: the gate takes a boolean, and anything that is not exactly true
  // must lose access rather than earn it. Guards against a caller that passes an
  // undefined/absent sandbox flag through a widened type.
  it("fails closed on a non-boolean sandbox flag", () => {
    const domain = { shared: true, sharedDisabledAt: null };
    const opts = { sandbox: undefined } as unknown as { sandbox: boolean };
    expect(sharedDomainSendError(domain, opts)).not.toBeNull();
  });
});

describe("campaignSendGateError on the shared domain", () => {
  it("blocks a paid (non-sandbox) account from sending on it", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { plan: "10k_plan" });
    const domainId = await ensureSharedDomain(db, account);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, ["someone@example.com"]);

    const error = await campaignSendGateError(
      db,
      account.id,
      { sendingDomainId: domainId!, audienceId: audience.id },
      { sandbox: false },
    );
    expect(error).toMatch(/only sends to your own team/i);
  });

  it("allows a sandbox send to a teammate", async () => {
    const db = await testDb();
    const account = await seedAccount(db, {
      plan: "free_org",
      monthlyEmailLimit: 0,
      sendingEnabled: false,
    });
    await seedMember(db, account.id, "founder@example.com");
    const domainId = await ensureSharedDomain(db, account);
    const audienceId = await ensureTeamAudience(db, account);

    const error = await campaignSendGateError(
      db,
      account.id,
      { sendingDomainId: domainId!, audienceId: audienceId! },
      { sandbox: true },
    );
    expect(error).toBeNull();
  });

  // The address carve-out: on our domain, Day3 is the sender of record, so the
  // account's own postal address is not required. It still is on their domain.
  it("does not require a mailing address on the shared domain", async () => {
    const db = await testDb();
    const account = await seedAccount(db, {
      plan: "free_org",
      monthlyEmailLimit: 0,
      sendingEnabled: false,
      companyAddress: null,
    });
    await seedMember(db, account.id, "founder@example.com");
    const domainId = await ensureSharedDomain(db, account);
    const audienceId = await ensureTeamAudience(db, account);

    const error = await campaignSendGateError(
      db,
      account.id,
      { sendingDomainId: domainId!, audienceId: audienceId! },
      { sandbox: true },
    );
    expect(error).toBeNull();
  });

  it("still requires a mailing address on the account's own domain", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { companyAddress: null });
    const domain = await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, ["someone@example.com"]);

    const error = await campaignSendGateError(
      db,
      account.id,
      { sendingDomainId: domain.id, audienceId: audience.id },
      { sandbox: false },
    );
    expect(error).toMatch(/mailing address/i);
  });
});

describe("footerAddress", () => {
  it("uses Day3's address on the shared domain", () => {
    expect(footerAddress({ companyAddress: null }, { shared: true })).toBe(
      "Day3 ApS, 1 Example Way, Copenhagen",
    );
  });

  it("uses the account's address on its own domain", () => {
    expect(footerAddress({ companyAddress: "5 Customer Rd" }, { shared: false })).toBe(
      "5 Customer Rd",
    );
  });

  it("falls back to the account's address when no domain is known", () => {
    expect(footerAddress({ companyAddress: "5 Customer Rd" }, null)).toBe("5 Customer Rd");
  });
});

describe("provisioning", () => {
  it("is idempotent: a second call adds nothing", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedMember(db, account.id, "founder@example.com");

    await ensureSharedDomain(db, account);
    await ensureTeamAudience(db, account);
    await ensureSharedDomain(db, account);
    await ensureTeamAudience(db, account);

    const domainRows = await db
      .select()
      .from(sendingDomains)
      .where(eq(sendingDomains.accountId, account.id));
    expect(domainRows).toHaveLength(1);

    const audienceRows = await db
      .select()
      .from(audiences)
      .where(eq(audiences.accountId, account.id));
    expect(audienceRows).toHaveLength(1);

    const subs = await db.select().from(subscribers).where(eq(subscribers.accountId, account.id));
    expect(subs).toHaveLength(1);
  });

  it("provisions a sender so the From dropdown needs no special case", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await ensureSharedDomain(db, account);
    const rows = await db.select().from(senders).where(eq(senders.accountId, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].fromEmail).toContain(`@${SHARED}`);
    // Never the default: the user's own sender must win once they have one.
    expect(rows[0].isDefault).toBe(false);
  });

  it("does not seed a team audience for an account that already has one", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedMember(db, account.id, "founder@example.com");
    const existing = await seedAudience(db, account.id);

    const seeded = await ensureTeamAudience(db, account);
    expect(seeded).toBeNull();
    const rows = await db.select().from(audiences).where(eq(audiences.accountId, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existing.id);
    expect(await findTeamAudience(db, account.id)).toBeNull();
  });

  it("does nothing when the feature is unconfigured", async () => {
    delete process.env.SHARED_SANDBOX_DOMAIN;
    const db = await testDb();
    const account = await seedAccount(db);
    expect(sharedSandboxDomain()).toBeNull();
    expect(await ensureSharedDomain(db, account)).toBeNull();
    expect(await findSharedDomain(db, account.id)).toBeNull();
  });

  it("adds the org roster to an audience without duplicating on re-run", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedMember(db, account.id, "a@example.com");
    await seedMember(db, account.id, "b@example.com", "member");
    const audience = await seedAudience(db, account.id);

    const first = await addTeamToAudience(db, account, audience.id);
    expect(first).toEqual({ ok: true, added: 2, teamSize: 2 });
    const second = await addTeamToAudience(db, account, audience.id);
    expect(second).toEqual({ ok: true, added: 0, teamSize: 2 });

    const subs = await db.select().from(subscribers).where(eq(subscribers.accountId, account.id));
    expect(subs).toHaveLength(2);
  });
});

describe("onboarding state", () => {
  it("opens the day-one path for a freshly provisioned free account", async () => {
    const db = await testDb();
    const account = await seedAccount(db, {
      plan: "free_org",
      monthlyEmailLimit: 0,
      sendingEnabled: false,
      companyAddress: null,
    });
    await seedMember(db, account.id, "founder@example.com");
    await ensureSharedDomain(db, account);
    await ensureTeamAudience(db, account);

    const state = await computeOnboardingState(db, account);
    expect(state.canSendFirstEmail).toBe(true);
    expect(state.teamAudienceSize).toBe(1);
    // Our domain must not tick the user's own "verify a domain" step, and the
    // seeded team must not tick "build an audience".
    expect(state.hasVerifiedDomain).toBe(false);
    expect(state.hasOwnSubscribers).toBe(false);
    expect(state.hasSubscribers).toBe(true);
    // Neither the address nor the domain is a blocker while that path is open.
    expect(state.sendBlockedReason).toBeNull();
  });

  it("keeps the domain step open until the user verifies their own", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedMember(db, account.id, "founder@example.com");
    await ensureSharedDomain(db, account);
    await ensureTeamAudience(db, account);
    await seedDomain(db, account.id, { verificationStatus: "verified" });

    const state = await computeOnboardingState(db, account);
    expect(state.hasVerifiedDomain).toBe(true);
  });

  it("closes the day-one path for a past-due account", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { subscriptionStatus: "past_due" });
    await seedMember(db, account.id, "founder@example.com");
    await ensureSharedDomain(db, account);
    await ensureTeamAudience(db, account);

    const state = await computeOnboardingState(db, account);
    expect(state.canSendFirstEmail).toBe(false);
  });
});

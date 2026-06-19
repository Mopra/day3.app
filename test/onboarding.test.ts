import { describe, expect, it } from "vitest";
import { computeOnboardingState } from "../src/services/onboarding";
import {
  TEST_EMAILS,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";

describe("computeOnboardingState", () => {
  it("reports a fresh account as fully un-onboarded and unable to send", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { subscriptionStatus: "inactive", sendingEnabled: false });

    const state = await computeOnboardingState(db, account);

    expect(state.billingActive).toBe(false);
    expect(state.hasVerifiedDomain).toBe(false);
    expect(state.hasSubscribers).toBe(false);
    expect(state.hasCampaign).toBe(false);
    expect(state.hasSentCampaign).toBe(false);
    expect(state.canSend).toBe(false);
    // Billing is the first blocker.
    expect(state.sendBlockedReason).toMatch(/subscription/i);
  });

  it("blocks on the unverified domain once billing is active", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedDomain(db, account.id, { verificationStatus: "pending" });

    const state = await computeOnboardingState(db, account);

    expect(state.billingActive).toBe(true);
    expect(state.hasVerifiedDomain).toBe(false);
    expect(state.sendBlockedReason).toMatch(/domain/i);
    expect(state.canSend).toBe(false);
  });

  it("counts an admin-overridden domain as verified", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedDomain(db, account.id, {
      verificationStatus: "pending",
      adminOverrideVerified: true,
    });

    const state = await computeOnboardingState(db, account);

    expect(state.hasVerifiedDomain).toBe(true);
    // Now the next blocker is the missing audience.
    expect(state.sendBlockedReason).toMatch(/subscriber/i);
  });

  it("clears the send block once a verified domain and subscribers exist", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, TEST_EMAILS);

    const state = await computeOnboardingState(db, account);

    expect(state.hasVerifiedDomain).toBe(true);
    expect(state.hasSubscribers).toBe(true);
    expect(state.canSend).toBe(true);
    expect(state.sendBlockedReason).toBeNull();
  });

  it("does not count unsubscribed-only audiences as having subscribers", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, TEST_EMAILS, "unsubscribed");

    const state = await computeOnboardingState(db, account);

    expect(state.hasSubscribers).toBe(false);
    expect(state.sendBlockedReason).toMatch(/subscriber/i);
  });

  it("reflects a paused account as blocked and not sendable", async () => {
    const db = await testDb();
    const account = await seedAccount(db, {
      riskStatus: "paused",
      sendingEnabled: false,
      pausedReason: "High bounce rate",
    });
    await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, TEST_EMAILS);

    const state = await computeOnboardingState(db, account);

    expect(state.accountPaused).toBe(true);
    expect(state.canSend).toBe(false);
    expect(state.sendBlockedReason).toMatch(/paused/i);
  });

  it("tracks campaign creation and sent state", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, TEST_EMAILS);
    await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sent",
    });

    const state = await computeOnboardingState(db, account);

    expect(state.hasCampaign).toBe(true);
    expect(state.hasSentCampaign).toBe(true);
  });
});

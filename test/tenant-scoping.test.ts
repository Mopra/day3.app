import { describe, expect, it } from "vitest";
import { findAudience, findCampaign, findDomain, findSubscriber } from "../src/api/finders";
import {
  TEST_EMAILS,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";

// Two fully-populated accounts. The invariant under test: a resource id that
// belongs to account B must be invisible to account A. The route handlers all
// resolve the account server-side (requireAccount) and then look the resource up
// through these finders, so a finder that returns undefined for a foreign id is
// exactly the 404 the handler raises.
async function twoAccounts() {
  const db = await testDb();

  const me = await seedAccount(db, { name: "Mine" });
  const myDomain = await seedDomain(db, me.id);
  const myAudience = await seedAudience(db, me.id);
  const [mySubscriber] = await seedSubscribers(db, me.id, myAudience.id, [TEST_EMAILS[0]]);
  const myCampaign = await seedCampaign(db, {
    accountId: me.id,
    audienceId: myAudience.id,
    sendingDomainId: myDomain.id,
  });

  const other = await seedAccount(db, { name: "Theirs" });
  const otherDomain = await seedDomain(db, other.id);
  const otherAudience = await seedAudience(db, other.id);
  const [otherSubscriber] = await seedSubscribers(db, other.id, otherAudience.id, [TEST_EMAILS[1]]);
  const otherCampaign = await seedCampaign(db, {
    accountId: other.id,
    audienceId: otherAudience.id,
    sendingDomainId: otherDomain.id,
  });

  return {
    db,
    me,
    other,
    mine: {
      domain: myDomain,
      audience: myAudience,
      subscriber: mySubscriber,
      campaign: myCampaign,
    },
    theirs: {
      domain: otherDomain,
      audience: otherAudience,
      subscriber: otherSubscriber,
      campaign: otherCampaign,
    },
  };
}

describe("tenant scoping: account-scoped finders", () => {
  it("finds my own resources", async () => {
    const { db, me, mine } = await twoAccounts();
    expect(await findCampaign(db, me.id, mine.campaign.id)).toBeTruthy();
    expect(await findAudience(db, me.id, mine.audience.id)).toBeTruthy();
    expect(await findDomain(db, me.id, mine.domain.id)).toBeTruthy();
    expect(await findSubscriber(db, me.id, mine.subscriber.id)).toBeTruthy();
  });

  it("refuses another account's campaign id (would 404)", async () => {
    const { db, me, theirs } = await twoAccounts();
    expect(await findCampaign(db, me.id, theirs.campaign.id)).toBeUndefined();
  });

  it("refuses another account's audience id (would 404)", async () => {
    const { db, me, theirs } = await twoAccounts();
    expect(await findAudience(db, me.id, theirs.audience.id)).toBeUndefined();
  });

  it("refuses another account's domain id (would 404)", async () => {
    const { db, me, theirs } = await twoAccounts();
    expect(await findDomain(db, me.id, theirs.domain.id)).toBeUndefined();
  });

  it("refuses another account's subscriber id (would 404)", async () => {
    const { db, me, theirs } = await twoAccounts();
    expect(await findSubscriber(db, me.id, theirs.subscriber.id)).toBeUndefined();
  });
});

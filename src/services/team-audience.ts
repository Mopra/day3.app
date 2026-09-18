import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accountUsers, audiences, subscribers } from "../db/schema";
import { canonicalizeEmail, isValidEmail } from "../lib/csv";
import { newId, nowIso } from "../lib/ids";
import { enrollAudienceJoin } from "./automation-enroll";
import { subscriberHeadroom } from "./subscriber-limit";
import { getSuppressedEmails } from "./suppression";

// Adding the org's own members to an audience as contacts.
//
// This exists because of sandbox mode: on the free tier a campaign only reaches
// the org's own members, so an audience of strangers imported from a CSV has
// nobody a first send can go to. It has two front doors and therefore lives here
// rather than in either of them (AGENTS.md: one implementation, two doors):
//
//   1. POST /api/audiences/[id]/subscribers/team, the "Add your team" button.
//   2. Account provisioning, which seeds one audience with the roster so a brand
//      new org can send itself a real email without importing anything at all.
//
// The roster is always read server-side from account_users. No caller passes
// addresses in, so this can never be used to inject arbitrary contacts.

export const TEAM_AUDIENCE_NAME = "Your team";

export type AddTeamResult =
  | { ok: true; added: number; teamSize: number }
  | { ok: false; reason: "no_members" | "all_suppressed" | "no_headroom" };

/**
 * Add every member of the org to `audienceId` as a subscribed contact.
 *
 * Idempotent: members already present are left alone (onConflictDoNothing), so
 * this is safe to call from a plain button with no confirmation and safe to
 * re-run during provisioning.
 */
export async function addTeamToAudience(
  db: Db,
  account: { id: string; plan: string },
  audienceId: string,
): Promise<AddTeamResult> {
  const members = await db
    .select({ email: accountUsers.email })
    .from(accountUsers)
    .where(eq(accountUsers.accountId, account.id));

  const emails = [
    ...new Set(
      members.map((m) => canonicalizeEmail(m.email)).filter((email) => isValidEmail(email)),
    ),
  ];
  if (emails.length === 0) return { ok: false, reason: "no_members" };

  // A teammate who hard-bounced or complained stays off the list. The
  // suppression list outranks convenience, exactly as it does on import.
  const suppressed = await getSuppressedEmails(db, account.id, emails);
  const addable = emails.filter((email) => !suppressed.has(email));
  if (addable.length === 0) return { ok: false, reason: "all_suppressed" };

  // Free-tier subscriber cap still applies; adding the team is the one case
  // where an account at its cap should get a clear message rather than a
  // silently short insert.
  const headroom = await subscriberHeadroom(db, account.id, account.plan);
  if (headroom < 1) return { ok: false, reason: "no_headroom" };

  const now = nowIso();
  const inserted = await db
    .insert(subscribers)
    .values(
      addable.slice(0, headroom).map((email) => ({
        id: newId("sub"),
        accountId: account.id,
        audienceId,
        email,
        firstName: null,
        lastName: null,
        attributes: null,
        status: "subscribed" as const,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: subscribers.id });

  // Each new member row is an audience join for the live automations on this
  // audience (a welcome flow the team can watch arrive). Best-effort.
  await enrollAudienceJoin(db, null, {
    accountId: account.id,
    audienceId,
    subscriberIds: inserted.map((r) => r.id),
  });

  // `added` counts only the rows that were really new; the rest were already
  // contacts. Callers need both numbers to say something true either way.
  return { ok: true, added: inserted.length, teamSize: emails.length };
}

/**
 * Provision the account's seeded team audience, once, and fill it with the org
 * roster. Returns the audience id, or null when nothing was seeded.
 *
 * Only seeds an account that has NO audiences at all. That is what makes this
 * naturally idempotent without a new unique index, and it means an existing
 * tenant can never wake up to an audience it did not create. A failure here is
 * swallowed by the caller: provisioning must never be what stops someone
 * signing in.
 */
export async function ensureTeamAudience(
  db: Db,
  account: { id: string; plan: string },
): Promise<string | null> {
  const existing = await db.query.audiences.findFirst({
    where: eq(audiences.accountId, account.id),
    columns: { id: true, seededTeam: true },
  });
  if (existing) return existing.seededTeam ? existing.id : null;

  const now = nowIso();
  const id = newId("aud");
  await db.insert(audiences).values({
    id,
    accountId: account.id,
    name: TEAM_AUDIENCE_NAME,
    seededTeam: true,
    createdAt: now,
    updatedAt: now,
  });
  await addTeamToAudience(db, account, id);
  return id;
}

/**
 * The account's seeded team audience, if it has one.
 *
 * Read with `limit 1` on an indexed account scan rather than assuming there is
 * at most one: `seeded_team` has no unique constraint, and a partial unique
 * index would be a migration for a guarantee this query already gives us.
 */
export async function findTeamAudience(db: Db, accountId: string): Promise<string | null> {
  const row = await db.query.audiences.findFirst({
    columns: { id: true },
    where: and(eq(audiences.accountId, accountId), eq(audiences.seededTeam, true)),
  });
  return row?.id ?? null;
}

/**
 * Add one newly-joined member to the seeded team audience, if there is one.
 *
 * Called from membership reconciliation, so a teammate invited on day two can
 * still receive the sandbox sends everyone else gets. Deliberately touches ONLY
 * the seeded audience: a new hire appearing in a customer list nobody put them
 * on would be a bug, not a convenience.
 */
export async function addMemberToTeamAudience(
  db: Db,
  account: { id: string; plan: string },
  email: string,
): Promise<void> {
  const canonical = canonicalizeEmail(email);
  if (!isValidEmail(canonical)) return;

  const audienceId = await findTeamAudience(db, account.id);
  if (!audienceId) return;

  // Ordered so the steady state is cheap. This runs from reconcileMembership,
  // which runs on every session sync, and the answer is "already there" every
  // time after the first. Two indexed lookups (the audience, then the unique
  // (audience, email) index) settle it; the suppression and cap checks below
  // only run on the one sync where somebody is genuinely new.
  const already = await db.query.subscribers.findFirst({
    columns: { id: true },
    where: and(eq(subscribers.audienceId, audienceId), eq(subscribers.email, canonical)),
  });
  if (already) return;

  const suppressed = await getSuppressedEmails(db, account.id, [canonical]);
  if (suppressed.has(canonical)) return;

  const headroom = await subscriberHeadroom(db, account.id, account.plan);
  if (headroom < 1) return;

  const now = nowIso();
  const inserted = await db
    .insert(subscribers)
    .values({
      id: newId("sub"),
      accountId: account.id,
      audienceId,
      email: canonical,
      firstName: null,
      lastName: null,
      attributes: null,
      status: "subscribed" as const,
      source: "manual",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: subscribers.id });

  await enrollAudienceJoin(db, null, {
    accountId: account.id,
    audienceId,
    subscriberIds: inserted.map((r) => r.id),
  });
}

/**
 * How many contacts the seeded team audience holds (0 when there is none).
 *
 * Takes the audience id rather than looking it up: the one caller
 * (computeOnboardingState) has already resolved it, and this runs on nearly
 * every page load.
 */
export async function teamAudienceSize(
  db: Db,
  accountId: string,
  audienceId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`.as("count") })
    .from(subscribers)
    .where(and(eq(subscribers.audienceId, audienceId), eq(subscribers.status, "subscribed")));
  return Number(row?.count ?? 0);
}

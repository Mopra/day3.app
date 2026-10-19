// Repeat-fraud guard: a new workspace that shares a card or an owner with a
// risk-paused one is paused too, before it can send.
//
// On 2026-10-19 "Service Inc" was paused for phishing, and a few hours later the
// same person came back as "Service spt": a new Clerk org, a new Gmail
// (malikweldi42 -> malikweldi27), a new domain, and the same Visa 2709. Domain
// bans (blocked-domains.ts) cannot catch that, since every comeback brings a
// fresh domain. The card and the owner's address are what stay the same.
//
// Two doors, both automatic. The admin resume button lifts the pause for good:
//   - checkout: Clerk's paymentAttempt webhook gives the card's brand and last 4
//     (Clerk exposes no expiry or Stripe fingerprint) and the payer's email.
//   - workspace creation: the creating member is compared with the members of
//     every paused workspace, and any card already recorded for the org.
//
// Brand + last 4 alone is a weak identifier across all cards, but it is only
// ever compared with the handful of cards that paid for a paused workspace, so a
// collision with an honest customer is rare, and the pause says why it happened.
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accountUsers, accounts, jobLogs, paymentCards, type Account } from "../db/schema";
import { nowIso } from "../lib/ids";
import { logJob } from "../lib/job-log";
import { logger } from "../lib/logger";

// Shorter stems ("john", "info") are shared by too many honest people to mean
// "same owner".
const MIN_STEM_LENGTH = 5;

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * The part of an address that survives the usual ways of minting a fresh one:
 * case, a +tag, Gmail's ignored dots, and a changed trailing number. Returns
 * null when what is left is too short to identify anyone.
 */
export function emailStem(email: string): string | null {
  const raw = email.trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0) return null;
  let local = raw.slice(0, at).split("+")[0];
  let domain = raw.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = local.replace(/\./g, "");
  }
  const stem = local.replace(/[\d._-]+$/, "");
  if (stem.length < MIN_STEM_LENGTH || !domain) return null;
  return `${stem}@${domain}`;
}

type Match = { account: Pick<Account, "id" | "name">; why: string };

// Only a pause with an operator audit row counts as fraud: a manual pause or ban,
// the phishing auto-pause (content-review.ts) and this guard's own. A reputation
// pause (health.ts) writes none, and is an honest customer with a stale list.
const pausedForAbuse = and(
  eq(accounts.riskStatus, "paused"),
  sql`exists (select 1 from job_logs j where j.job_type = 'admin_action' and j.entity_id = ${accounts.id}
    and (j.payload_json::json)->>'action' in ('account.pause', 'domains.block'))`,
);

// An operator who resumed a workspace has looked at it. Without this, its next
// renewal would match the same card and pause it again.
async function wasResumed(db: Db, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ id: jobLogs.id })
    .from(jobLogs)
    .where(
      and(
        eq(jobLogs.jobType, "admin_action"),
        eq(jobLogs.entityId, accountId),
        sql`(${jobLogs.payloadJson}::json)->>'action' = 'account.resume'`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function pausedMembers(db: Db, excludeAccountId: string) {
  return db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      clerkUserId: accountUsers.clerkUserId,
      email: accountUsers.email,
    })
    .from(accountUsers)
    .innerJoin(accounts, eq(accounts.id, accountUsers.accountId))
    .where(and(pausedForAbuse, ne(accounts.id, excludeAccountId)));
}

async function findOwnerMatch(
  db: Db,
  accountId: string,
  person: { clerkUserId?: string | null; email?: string | null },
): Promise<Match | null> {
  const stem = person.email ? emailStem(person.email) : null;
  if (!stem && !person.clerkUserId) return null;
  for (const m of await pausedMembers(db, accountId)) {
    const account = { id: m.accountId, name: m.accountName };
    if (person.clerkUserId && m.clerkUserId === person.clerkUserId) {
      return { account, why: `its owner is a member of paused workspace ${m.accountName} (${m.accountId})` };
    }
    if (stem && emailStem(m.email) === stem) {
      return {
        account,
        why: `its owner's address ${person.email} matches ${m.email} of paused workspace ${m.accountName} (${m.accountId})`,
      };
    }
  }
  return null;
}

async function findCardMatch(db: Db, clerkOrgId: string): Promise<Match | null> {
  const ours = await db.select().from(paymentCards).where(eq(paymentCards.clerkOrgId, clerkOrgId));
  for (const card of ours) {
    const [hit] = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(paymentCards)
      .innerJoin(accounts, eq(accounts.clerkOrgId, paymentCards.clerkOrgId))
      .where(
        and(
          eq(paymentCards.brand, card.brand),
          eq(paymentCards.last4, card.last4),
          ne(paymentCards.clerkOrgId, clerkOrgId),
          pausedForAbuse,
        ),
      )
      .limit(1);
    if (hit) {
      return { account: hit, why: `it paid with the same card (${card.brand} ${card.last4}) as paused workspace ${hit.name} (${hit.id})` };
    }
  }
  return null;
}

// Flips normal -> paused exactly once, with the same audit row and alert as the
// other automatic pauses (content-review.ts, health.ts).
async function pauseForRepeat(db: Db, account: Account, match: Match): Promise<boolean> {
  const reason = `Automated: repeat of a paused workspace, ${match.why}.`;
  const flipped = await db
    .update(accounts)
    .set({ sendingEnabled: false, riskStatus: "paused", pausedReason: reason, updatedAt: nowIso() })
    .where(and(eq(accounts.id, account.id), eq(accounts.riskStatus, "normal")))
    .returning({ id: accounts.id });
  if (flipped.length === 0) return false;

  await logJob(db, {
    jobType: "admin_action",
    entityType: "account",
    entityId: account.id,
    status: "completed",
    payload: {
      action: "account.pause",
      actorEmail: "system:repeat-fraud",
      actorUserId: "system",
      reason,
      matchedAccountId: match.account.id,
    },
  });
  void logger.reportError("new account auto-paused: repeat of a paused workspace", new Error(reason), {
    accountId: account.id,
    accountName: account.name,
    matchedAccountId: match.account.id,
  });
  return true;
}

async function check(
  db: Db,
  account: Account,
  person: { clerkUserId?: string | null; email?: string | null },
): Promise<boolean> {
  if (account.riskStatus !== "normal" || (await wasResumed(db, account.id))) return false;
  const match =
    (await findCardMatch(db, account.clerkOrgId)) ?? (await findOwnerMatch(db, account.id, person));
  return match ? pauseForRepeat(db, account, match) : false;
}

/**
 * Called once when a workspace is first created. Pauses it when its creator, or
 * a card already seen for the org, belongs to a paused workspace. Returns true
 * when it paused.
 */
export async function checkNewWorkspace(
  db: Db,
  account: Account,
  creator: { clerkUserId: string; email: string },
): Promise<boolean> {
  try {
    return await check(db, account, creator);
  } catch (err) {
    void logger.reportError("repeat-fraud new-workspace check failed", err, { accountId: account.id });
    return false;
  }
}

/**
 * Called for every Clerk paymentAttempt webhook. Records the card against the
 * org (even before the account row exists), then pauses the org's account when
 * the card or the payer's address belongs to a paused workspace.
 */
export async function recordPaymentAttempt(
  db: Db,
  input: { clerkOrgId: string; brand?: string; last4?: string; payerEmail?: string },
): Promise<boolean> {
  if (input.brand && input.last4) {
    await db
      .insert(paymentCards)
      .values({
        clerkOrgId: input.clerkOrgId,
        brand: input.brand.trim().toLowerCase(),
        last4: input.last4.trim(),
        payerEmail: input.payerEmail?.trim().toLowerCase() ?? null,
        createdAt: nowIso(),
      })
      .onConflictDoNothing();
  }
  const account = await db.query.accounts.findFirst({ where: eq(accounts.clerkOrgId, input.clerkOrgId) });
  if (!account) return false;
  return check(db, account, { email: input.payerEmail });
}

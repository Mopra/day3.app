import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accountUsers } from "../db/schema";
import { canonicalizeEmail } from "../lib/csv";
import { planSandboxMode } from "../lib/plans-catalog";

// Sandbox mode — how the free tier sends, instead of not sending at all.
//
// A free org can run the *real* send path end to end: real SES delivery, real
// recipient rows, real open/click tracking, real metrics. Two things are
// restricted, and they are the two that protect the shared SES reputation:
//
//   1. Recipients must be the org's own members (the local roster synced from
//      Clerk). You can only mail yourself and your teammates.
//   2. Volume is capped at SANDBOX_MONTHLY_ALLOWANCE per month, reserved against
//      the same atomic `monthly_email_sent_count` ledger as every paid send (see
//      reserveQuota's `limitOverride`) — one meter, not two.
//
// Campaigns, the transactional API (POST /v1/emails) and test sends all run in
// this mode on the free tier and share the one monthly allowance between them.
// Enforcement lives where each send is accepted; this module is the shared
// vocabulary. The pure, client-safe half (the allowance, the mode predicate, the
// exhausted-copy) lives in lib/plans-catalog and is re-exported here.

export {
  SANDBOX_EXHAUSTED_MESSAGE,
  SANDBOX_MONTHLY_ALLOWANCE,
  planSandboxMode,
} from "../lib/plans-catalog";

// Whether an account sends in sandbox mode. Keyed off the plan alone: every
// other reason a send might be blocked (past due, risk pause, allowance used up)
// is a separate check, so this stays a stable answer to "which mode is this
// account in?" rather than "may it send right now?".
export function accountSandboxMode(account: { plan: string }): boolean {
  return planSandboxMode(account.plan);
}

// The org's own member addresses — the only recipients a sandbox send may reach.
// Canonicalized so the comparison matches how subscriber and recipient emails
// are stored.
export async function orgMemberEmails(db: Db, accountId: string): Promise<Set<string>> {
  const members = await db
    .select({ email: accountUsers.email })
    .from(accountUsers)
    .where(eq(accountUsers.accountId, accountId));
  return new Set(members.map((m) => canonicalizeEmail(m.email)));
}

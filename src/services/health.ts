import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, campaignRecipients } from "../db/schema";
import { nowIso } from "../lib/ids";

export const BOUNCE_RATE_WARNING = 0.03;
export const BOUNCE_RATE_PAUSE = 0.04;
export const COMPLAINT_RATE_WARNING = 0.0005;
export const COMPLAINT_RATE_PAUSE = 0.0008;

// Below this many attempted sends, rates are too noisy to act on.
const MIN_ATTEMPTED_FOR_ENFORCEMENT = 50;

export type AccountHealth = {
  attempted: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  status: "normal" | "warning" | "paused";
  reason?: string;
};

export async function computeAccountHealth(db: Db, accountId: string): Promise<AccountHealth> {
  const rows = await db
    .select({
      status: campaignRecipients.status,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.accountId, accountId),
        inArray(campaignRecipients.status, [
          "sent",
          "delivered",
          "bounced",
          "complained",
          "unsubscribed",
        ]),
      ),
    )
    .groupBy(campaignRecipients.status);

  const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  const bounced = counts.bounced ?? 0;
  const complained = counts.complained ?? 0;
  const attempted =
    (counts.sent ?? 0) + (counts.delivered ?? 0) + bounced + complained + (counts.unsubscribed ?? 0);

  const bounceRate = attempted > 0 ? bounced / attempted : 0;
  const complaintRate = attempted > 0 ? complained / attempted : 0;

  let status: AccountHealth["status"] = "normal";
  let reason: string | undefined;

  if (attempted >= MIN_ATTEMPTED_FOR_ENFORCEMENT) {
    if (bounceRate >= BOUNCE_RATE_PAUSE) {
      status = "paused";
      reason = `Bounce rate ${(bounceRate * 100).toFixed(2)}% exceeded ${BOUNCE_RATE_PAUSE * 100}%`;
    } else if (complaintRate >= COMPLAINT_RATE_PAUSE) {
      status = "paused";
      reason = `Complaint rate ${(complaintRate * 100).toFixed(3)}% exceeded ${COMPLAINT_RATE_PAUSE * 100}%`;
    } else if (bounceRate >= BOUNCE_RATE_WARNING || complaintRate >= COMPLAINT_RATE_WARNING) {
      status = "warning";
    }
  }

  return { attempted, bounced, complained, bounceRate, complaintRate, status, reason };
}

// Pauses the account if its health thresholds are exceeded. Returns the health.
export async function enforceAccountHealth(db: Db, accountId: string): Promise<AccountHealth> {
  const health = await computeAccountHealth(db, accountId);
  if (health.status === "paused") {
    await db
      .update(accounts)
      .set({
        sendingEnabled: false,
        riskStatus: "paused",
        pausedReason: health.reason,
        updatedAt: nowIso(),
      })
      .where(and(eq(accounts.id, accountId), eq(accounts.riskStatus, "normal")));
  }
  return health;
}

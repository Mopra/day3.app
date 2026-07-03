import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  accountUsers,
  accounts,
  campaignRecipients,
  notifications,
  type Account,
  type NotificationKind,
} from "../db/schema";
import { emailProviderFromEnv } from "../email/factory";
import { newId, nowIso } from "../lib/ids";

// Account-level notifications: things a user must learn about even with the tab
// closed — a scheduled send that failed to release, a finished import, signups
// turned away at the plan cap. Two channels, both best-effort:
//   1. An email to the account's admins (the point of "closed tab" reach).
//   2. A row in `notifications` for the in-app bell.
// This never throws: a notification failing must never break the flow that
// triggered it (a cron sweep, a form submit). Errors are logged and swallowed.

const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
// Reuse the support identity — the day3.app domain is a verified SES sender.
const FROM_EMAIL = process.env.SUPPORT_FROM_EMAIL ?? process.env.SUPPORT_EMAIL ?? "connect@day3.app";

export type NotifyInput = {
  kind: NotificationKind;
  title: string;
  // Plain-text body (one or two short sentences). Rendered into both the email
  // and the in-app row.
  body: string;
  // Optional in-app path (e.g. "/campaigns/cmp_123"); turned into an absolute URL
  // for the email button.
  ctaHref?: string;
  ctaLabel?: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmail(input: NotifyInput): { html: string; text: string } {
  const absoluteCta = input.ctaHref
    ? input.ctaHref.startsWith("http")
      ? input.ctaHref
      : `${APP_URL}${input.ctaHref.startsWith("/") ? "" : "/"}${input.ctaHref}`
    : null;

  const button =
    absoluteCta && input.ctaLabel
      ? `<p style="margin:24px 0"><a href="${escapeHtml(absoluteCta)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(input.ctaLabel)}</a></p>`
      : "";

  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111">` +
    `<h2 style="font-size:18px;margin:0 0 8px">${escapeHtml(input.title)}</h2>` +
    `<p style="font-size:15px;line-height:1.5;color:#333;margin:0">${escapeHtml(input.body)}</p>` +
    button +
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0" />` +
    `<p style="font-size:12px;color:#999;margin:0">You're receiving this because you're an admin of a Day3 workspace.</p>` +
    `</div>`;

  const text =
    `${input.title}\n\n${input.body}\n` + (absoluteCta ? `\n${input.ctaLabel ?? "Open"}: ${absoluteCta}\n` : "");

  return { html, text };
}

// Admin emails for an account, from the local membership roster (no Clerk call).
// Falls back to all members if no admin is recorded (shouldn't happen, but a
// notification with no recipient is worse than over-notifying).
async function adminEmails(db: Db, accountId: string): Promise<string[]> {
  const rows = await db
    .select({ email: accountUsers.email, role: accountUsers.role })
    .from(accountUsers)
    .where(eq(accountUsers.accountId, accountId));
  const admins = rows.filter((r) => r.role === "admin").map((r) => r.email);
  const recipients = admins.length > 0 ? admins : rows.map((r) => r.email);
  return [...new Set(recipients.filter(Boolean))];
}

export async function notifyAccount(db: Db, account: Account, input: NotifyInput): Promise<void> {
  // 1. Persist the in-app row first — it's the durable record even if email fails.
  try {
    await db.insert(notifications).values({
      id: newId("ntf"),
      accountId: account.id,
      kind: input.kind,
      title: input.title,
      body: input.body,
      ctaLabel: input.ctaLabel ?? null,
      ctaHref: input.ctaHref ?? null,
      createdAt: nowIso(),
    });
  } catch (err) {
    console.error("[notifications] failed to persist in-app notification", err);
  }

  // 2. Email the admins. Best-effort, per-recipient — one bad address must not
  // block the others, and a provider outage must not break the caller.
  try {
    const recipients = await adminEmails(db, account.id);
    if (recipients.length === 0) return;
    const { html, text } = renderEmail(input);
    const provider = emailProviderFromEnv();
    await Promise.all(
      recipients.map((toEmail) =>
        provider
          .send({
            accountId: account.id,
            fromEmail: FROM_EMAIL,
            fromName: "Day3",
            toEmail,
            subject: input.title,
            html,
            text,
          })
          .catch((err) => console.error(`[notifications] email to ${toEmail} failed`, err)),
      ),
    );
  } catch (err) {
    console.error("[notifications] failed to send notification emails", err);
  }
}

// Has this account been notified of `kind` within the last `hours`? Used to
// throttle high-frequency triggers (e.g. every capped form signup) down to one
// notification per window, so we never spam the admins' inbox.
export async function hasRecentNotification(
  db: Db,
  accountId: string,
  kind: NotificationKind,
  hours: number,
): Promise<boolean> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.accountId, accountId),
        eq(notifications.kind, kind),
        gt(notifications.createdAt, since),
      ),
    )
    .limit(1);
  return !!row;
}

// notifyAccount, but a no-op if the same kind fired within `throttleHours`.
export async function notifyAccountThrottled(
  db: Db,
  account: Account,
  input: NotifyInput,
  throttleHours: number,
): Promise<void> {
  try {
    if (await hasRecentNotification(db, account.id, input.kind, throttleHours)) return;
  } catch (err) {
    console.error("[notifications] throttle check failed", err);
    return; // fail closed on the throttle so a broken check can't spam
  }
  await notifyAccount(db, account, input);
}

// Notify an account that one of its campaigns finished sending. Called from
// whichever path completes the send (the last send batch, or the cron reconcile),
// guarded by the caller so it fires exactly once. Computes the reached count for
// a concrete headline.
export async function notifyCampaignSent(
  db: Db,
  campaign: { id: string; name: string; accountId: string },
): Promise<void> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, campaign.accountId),
  });
  if (!account) return;
  const [row] = await db
    .select({ n: sql<number>`count(*)`.as("n") })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaign.id),
        inArray(campaignRecipients.status, ["sent", "delivered"]),
      ),
    );
  const reached = Number(row?.n ?? 0);
  await notifyAccount(db, account, {
    kind: "campaign_sent",
    title: `"${campaign.name}" is out 🎉`,
    body: `Delivered to ${reached.toLocaleString()} ${reached === 1 ? "subscriber" : "subscribers"}. See how it's performing.`,
    ctaHref: `/campaigns/${campaign.id}`,
    ctaLabel: "View results",
  });
}

// Reads for the in-app bell. Account-scoped, newest-first.
export async function listNotifications(
  db: Db,
  accountId: string,
  limit = 20,
): Promise<(typeof notifications.$inferSelect)[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.accountId, accountId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function markNotificationRead(
  db: Db,
  accountId: string,
  id: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: nowIso() })
    .where(and(eq(notifications.accountId, accountId), eq(notifications.id, id)));
}

export async function markAllNotificationsRead(db: Db, accountId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: nowIso() })
    .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)));
}

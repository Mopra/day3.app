import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { emailProviderFromEnv } from "@/email/factory";

const SupportSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(5000),
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Where the in-app Help widget delivers messages. Sender defaults to the same
// address (the day3.app domain must be a verified SES identity); Reply-To is set
// to the requesting user so the team can reply straight back.
const SUPPORT_TO = process.env.SUPPORT_EMAIL ?? "contact@day3.app";
const SUPPORT_FROM = process.env.SUPPORT_FROM_EMAIL ?? SUPPORT_TO;

// In-app "Help" widget: relays a short message to the support inbox, with the
// signed-in user as Reply-To. Available on every plan.
export const POST = route(async (req) => {
  const { account, auth } = await requireAccount();
  await enforceRateLimit("support", account.id);

  const { message } = await parseJson(req, SupportSchema);

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(auth.userId);
  const userEmail = user.emailAddresses
    .find((e) => e.id === user.primaryEmailAddressId)
    ?.emailAddress;
  const userName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

  const html =
    `<p><strong>From:</strong> ${escapeHtml(userName || "—")} &lt;${escapeHtml(userEmail ?? "unknown")}&gt;</p>` +
    `<p><strong>Workspace:</strong> ${escapeHtml(account.name)} (${escapeHtml(account.id)})</p>` +
    `<hr />` +
    `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`;
  const text =
    `From: ${userName || "—"} <${userEmail ?? "unknown"}>\n` +
    `Workspace: ${account.name} (${account.id})\n\n` +
    message;

  const result = await emailProviderFromEnv().send({
    accountId: account.id,
    fromEmail: SUPPORT_FROM,
    fromName: "Day3 Help",
    replyTo: userEmail,
    toEmail: SUPPORT_TO,
    subject: `Help request — ${account.name}`,
    html,
    text,
  });

  if (result.status !== "sent") {
    throw new HttpError(502, result.error ?? "Could not send your message. Please email us directly.");
  }
  return json({ ok: true });
});

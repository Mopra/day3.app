import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { sendingDomains, senders } from "../db/schema";

export const SenderFieldsSchema = z.object({
  sendingDomainId: z.string().min(1),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.email().toLowerCase(),
  // Optional default Reply-To suggested into the composer; "" means none.
  replyTo: z.union([z.literal(""), z.email().toLowerCase()]).optional(),
});
export type SenderFields = z.infer<typeof SenderFieldsSchema>;

// Confirms the sending domain belongs to the account and the from address lives
// on it (mirrors validateOwnershipAndSender in api/campaigns.ts). Returns an
// error string or null.
export async function validateSenderDomain(
  db: Db,
  accountId: string,
  fields: Pick<SenderFields, "sendingDomainId" | "fromEmail">,
): Promise<string | null> {
  const domain = await db.query.sendingDomains.findFirst({
    where: and(
      eq(sendingDomains.id, fields.sendingDomainId),
      eq(sendingDomains.accountId, accountId),
    ),
  });
  if (!domain) return "Sending domain not found";
  if (!fields.fromEmail.endsWith(`@${domain.domain}`)) {
    return "From email must use the selected sending domain";
  }
  return null;
}

// Account's senders joined to their domain, so the UI can show the domain and its
// verification state alongside each sender.
export async function listSendersWithDomain(db: Db, accountId: string) {
  return db
    .select({
      id: senders.id,
      sendingDomainId: senders.sendingDomainId,
      fromName: senders.fromName,
      fromEmail: senders.fromEmail,
      replyTo: senders.replyTo,
      isDefault: senders.isDefault,
      createdAt: senders.createdAt,
      domain: sendingDomains.domain,
      verificationStatus: sendingDomains.verificationStatus,
      adminOverrideVerified: sendingDomains.adminOverrideVerified,
    })
    .from(senders)
    .innerJoin(sendingDomains, eq(senders.sendingDomainId, sendingDomains.id))
    .where(eq(senders.accountId, accountId))
    .orderBy(desc(senders.isDefault), desc(senders.createdAt));
}

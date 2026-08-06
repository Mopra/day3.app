import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findGlobalSuppression, removeAccountSuppression } from "@/services/suppression";

// DELETE /api/suppressions/{email} — un-suppress an address for this account.
//
// This is deliberately the ONLY un-suppression path in the product: the public
// API is add-only (see app/api/v1/suppressions/route.ts), so a leaked key can
// never unblock addresses that bounced or complained in order to mail them, and a
// scripted mistake can't be scripted away in bulk. Un-suppressing here also lets
// contacts our own machinery had marked bounced/complained/suppressed be mailed
// again — but never resurrects someone who unsubscribed themselves.
export const DELETE = route<{ params: Promise<{ email: string }> }>(async (_req, { params }) => {
  const { email: raw } = await params;
  const { db, account } = await requireAccount();
  const email = decodeURIComponent(raw);

  const { removed, restoredContacts } = await removeAccountSuppression(db, account.id, email);
  if (removed === 0) {
    // Nothing of ours to remove. If it's blocked platform-wide, say so plainly
    // rather than reporting a phantom success — a tenant cannot lift a global
    // entry (it outlives individual accounts by design).
    const global = await findGlobalSuppression(db, email);
    if (global) {
      throw new HttpError(
        409,
        "This address is suppressed platform-wide and can't be removed here. Contact support if you believe that's wrong.",
      );
    }
    throw new HttpError(404, "This address isn't on your suppression list");
  }

  return json({ ok: true, removed, restoredContacts });
});

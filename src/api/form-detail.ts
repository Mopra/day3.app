import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sendingDomains, type Account, type Form } from "../db/schema";
import { resolveFormDesign } from "../lib/form-design";
import { ensureAccountSlug } from "../lib/slug";
import { buildFormInstall } from "../services/form-install";

async function accountHasVerifiedDomain(db: Db, accountId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, accountId));
  return rows.some(
    (d) => d.fromEmail && (d.verificationStatus === "verified" || d.adminOverrideVerified),
  );
}

// The form editor's data: the form plus ready-to-paste install assets and whether
// the account can actually send confirmation emails (double opt-in needs a
// verified domain). Read by the server page (first paint) and GET /api/forms/[id]
// (the refresh after an autosave), so the two can't drift.
export async function readFormDetail(db: Db, account: Account, form: Form) {
  const [accountSlug, hasVerifiedDomain] = await Promise.all([
    ensureAccountSlug(db, account),
    accountHasVerifiedDomain(db, account.id),
  ]);
  // Hand the editor a complete, resolved design object (it edits it directly); the
  // stored column is a partial JSON string.
  return {
    form: { ...form, design: resolveFormDesign(form.design) },
    install: buildFormInstall(form, accountSlug),
    hasVerifiedDomain,
    companyName: account.name ?? "this sender",
  };
}

import { and, eq } from "drizzle-orm";
import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { dnsIntegrations } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { getCloudflareOAuthConfig, revokeToken } from "@/services/cloudflare-oauth";

// Connection status for the settings/domain UI. Never leaks tokens — only the
// display label, scope, and when it was connected.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const row = await db.query.dnsIntegrations.findFirst({
    where: and(eq(dnsIntegrations.accountId, account.id), eq(dnsIntegrations.provider, "cloudflare")),
  });
  return json({
    connection: row
      ? { status: row.status, label: row.cfAccountLabel, scope: row.scope, connectedAt: row.createdAt }
      : null,
  });
});

// Disconnect: revoke the token at Cloudflare (best-effort) and delete our record.
export const DELETE = route(async () => {
  const { db, account } = await requireAccount();
  const row = await db.query.dnsIntegrations.findFirst({
    where: and(eq(dnsIntegrations.accountId, account.id), eq(dnsIntegrations.provider, "cloudflare")),
  });
  if (row) {
    try {
      const token = await decryptSecret(row.accessTokenEnc);
      await revokeToken(token, getCloudflareOAuthConfig());
    } catch (err) {
      console.error("[cloudflare] disconnect: revoke failed (continuing)", err);
    }
    await db.delete(dnsIntegrations).where(eq(dnsIntegrations.id, row.id));
  }
  return json({ ok: true });
});

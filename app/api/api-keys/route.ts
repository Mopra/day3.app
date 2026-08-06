import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount, type AccountContext } from "@/api/context";
import { generateApiKey } from "@/api/v1/auth";
import { API_SCOPES, parseScopes, serializeScopes, type ApiScope } from "@/api/v1/scopes";
import { apiKeys } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";

// Public-API key management. Session-authenticated (this is the app's settings
// page, not the public API) and org-admin only — a member must not be able to
// mint credentials that outlive their own access. The public API deliberately
// has no key endpoints: a leaked key can't create quieter replacements.

function requireOrgAdmin(ctx: AccountContext): void {
  if (ctx.auth.orgRole !== "org:admin") {
    throw new HttpError(403, "Only organization admins can manage API keys");
  }
}

function serializeKey(k: typeof apiKeys.$inferSelect) {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    scopes: parseScopes(k.scopes),
    createdBy: k.createdBy,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
  };
}

// GET /api/api-keys — every key on the account, newest first (revoked included
// so the history stays auditable).
export const GET = route(async () => {
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const rows = await ctx.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.accountId, ctx.account.id))
    .orderBy(desc(apiKeys.createdAt));
  return json({ keys: rows.map(serializeKey) });
});

// Scopes are chosen at creation and never edited: a key's powers stay visible in
// the key list instead of drifting behind an edit. Granting `campaigns:send`
// later means minting a new key and revoking the old one — deliberately.
const CreateKeySchema = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(z.enum(API_SCOPES)).max(API_SCOPES.length).optional(),
});
const MAX_ACTIVE_KEYS = 10;

// POST /api/api-keys — mint a key. The full key appears ONCE in this response;
// only its hash is stored.
export const POST = route(async (req) => {
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const { name, scopes } = await parseJson(req, CreateKeySchema);

  const existing = await ctx.db
    .select({ revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.accountId, ctx.account.id));
  if (existing.filter((k) => !k.revokedAt).length >= MAX_ACTIVE_KEYS) {
    throw new HttpError(400, `An account may have at most ${MAX_ACTIVE_KEYS} active API keys`);
  }

  const { key, keyHash, keyPrefix } = generateApiKey();
  const now = nowIso();
  const [created] = await ctx.db
    .insert(apiKeys)
    .values({
      id: newId("key"),
      accountId: ctx.account.id,
      name,
      keyHash,
      keyPrefix,
      scopes: serializeScopes((scopes ?? []) as ApiScope[]),
      createdBy: ctx.auth.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return json({ key, apiKey: serializeKey(created) }, 201);
});

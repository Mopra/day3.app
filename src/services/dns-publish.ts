// Publish a sending domain's records into an account's already-connected
// Cloudflare zone.
//
// `services/cloudflare-dns` is deliberately pure (bearer token in, fetch out) so
// its idempotency logic stays unit-testable. This module is the thin DB-aware
// bridge: it looks up the account's `dns_integrations` row, decrypts/refreshes the
// OAuth token, and writes. The interactive auto-configure route does its own zone
// lookup and surfaces per-record errors to the user; this is for background
// re-publishes where the zone is already known and failure must never be fatal.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { dnsIntegrations } from "../db/schema";
import type { DnsRecord } from "../lib/types";
import { writeRecords, type RecordWriteResult } from "./cloudflare-dns";
import { getValidAccessToken } from "./cloudflare-oauth";

// Write `records` into `zoneId` using the account's stored Cloudflare token.
// Returns null when the account has no Cloudflare connection (nothing to do);
// throws only if Cloudflare itself rejects the write — per-record failures come
// back inside the results array.
export async function publishToCloudflare(
  db: Db,
  accountId: string,
  zoneId: string,
  records: DnsRecord[],
): Promise<RecordWriteResult[] | null> {
  const integration = await db.query.dnsIntegrations.findFirst({
    where: and(eq(dnsIntegrations.accountId, accountId), eq(dnsIntegrations.provider, "cloudflare")),
  });
  if (!integration) return null;
  const token = await getValidAccessToken(db, integration);
  return writeRecords(token, zoneId, records);
}

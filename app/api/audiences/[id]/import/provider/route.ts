import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { imports } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { encryptSecret } from "@/lib/crypto";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getQueue } from "@/queue/producer";
import { getImportProvider, PROVIDER_CATALOG, PROVIDER_IDS } from "@/importers";
import {
  WEB_PROVIDER_CTX,
  apiKeySchema,
  providerErrorResponse,
} from "@/api/provider-import";
import { subscriberHeadroom, subscriberLimitMessage } from "@/services/subscriber-limit";
import { maxSubscribersForPlan } from "@/services/plans";

const bodySchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  apiKey: apiKeySchema,
  sourceId: z.string().trim().min(1).max(200),
});

// Start an "Import from another provider" job for this audience. The key is
// checked against the provider first (so a bad key fails here, not inside the
// worker), stored AES-GCM encrypted on the import row for the job's duration
// only, and the job is queued like a CSV import (process_import).
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("import", account.id);
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  const { provider, apiKey, sourceId } = await parseJson(req, bodySchema);
  const meta = PROVIDER_CATALOG[provider];

  // One provider import per audience at a time: two would race the same rows
  // and each would report the other's contacts as duplicates.
  const running = await db.query.imports.findFirst({
    where: and(
      eq(imports.accountId, account.id),
      eq(imports.audienceId, audience.id),
      ne(imports.source, "csv"),
      inArray(imports.status, ["pending", "processing"]),
    ),
  });
  if (running) {
    throw new HttpError(409, "An import into this audience is already running. Wait for it to finish.");
  }

  let source;
  try {
    const sources = await getImportProvider(provider).listSources({ ...WEB_PROVIDER_CTX, apiKey });
    source = sources.find((s) => s.id === sourceId);
  } catch (err) {
    return providerErrorResponse(err);
  }
  if (!source) {
    return Response.json(
      { error: `That ${meta.sourceNoun} is not visible to this ${meta.label} key.`, code: "not_found" },
      { status: 422 },
    );
  }

  // Free plan: refuse up front when the provider already says the list will not
  // fit, like the CSV route does with its row count. The cap counts every stored
  // contact (opt-outs too), so prefer the all-status total. The worker enforces
  // the cap again as a backstop either way.
  if (maxSubscribersForPlan(account.plan) !== null) {
    const incoming = source.totalCount ?? source.subscribedCount;
    if (incoming !== null) {
      const headroom = await subscriberHeadroom(db, account.id, account.plan);
      if (incoming > headroom) {
        throw new HttpError(
          403,
          `${subscriberLimitMessage(account.plan)} This ${meta.sourceNoun} has ${incoming.toLocaleString()} contacts but only ${headroom.toLocaleString()} slots remain.`,
        );
      }
    }
  }

  const importId = newId("imp");
  const now = nowIso();
  await db.insert(imports).values({
    id: importId,
    accountId: account.id,
    audienceId: audience.id,
    r2Key: "",
    filename: `${meta.label}: ${source.name}`.slice(0, 200),
    status: "pending",
    totalRows: source.totalCount ?? source.subscribedCount ?? 0,
    source: provider,
    sourceRef: source.id,
    sourceCredential: await encryptSecret(apiKey),
    createdAt: now,
    updatedAt: now,
  });

  await getQueue().send({ type: "process_import", importId, accountId: account.id });

  return json({ importId }, 202);
});

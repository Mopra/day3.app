import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { idempotencyKeys } from "../../db/schema";
import { newId, nowIso } from "../../lib/ids";
import type { ApiContext } from "./auth";
import { ApiError } from "./errors";

// Idempotency-Key support for v1 POST endpoints. Postgres-backed (must survive
// Redis restarts); scope is (account, endpoint, key). A replay within the TTL
// returns the stored original response verbatim; the same key with a different
// body is rejected. Expired rows are treated as absent and deleted lazily on
// the next lookup — no cron dependency.

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LEN = 255;

function hashRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body) ?? "null").digest("hex");
}

// Wrap a POST handler's execution. `body` is the parsed+validated request body
// (hashed to detect key reuse with a different payload); `exec` produces the
// real response. Responses ≥500 are not stored — a retry should re-attempt.
export async function withIdempotency(
  ctx: ApiContext,
  req: NextRequest,
  endpoint: string,
  body: unknown,
  exec: () => Promise<Response>,
): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key) return exec();
  if (key.length > MAX_KEY_LEN) {
    throw new ApiError(400, "invalid_request", `Idempotency-Key must be at most ${MAX_KEY_LEN} characters`);
  }

  const { db, account } = ctx;
  const requestHash = hashRequest(body);
  const scope = and(
    eq(idempotencyKeys.accountId, account.id),
    eq(idempotencyKeys.endpoint, endpoint),
    eq(idempotencyKeys.key, key),
  );

  const existing = await db.query.idempotencyKeys.findFirst({ where: scope });
  if (existing) {
    if (Date.parse(existing.createdAt) + TTL_MS < Date.now()) {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
    } else if (existing.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This Idempotency-Key was already used with a different request body.",
      );
    } else {
      return new Response(existing.responseBody, {
        status: existing.responseStatus,
        headers: { "content-type": "application/json", "Idempotency-Replayed": "true" },
      });
    }
  }

  const res = await exec();
  if (res.status < 500) {
    const responseBody = await res.clone().text();
    await db
      .insert(idempotencyKeys)
      .values({
        id: newId("idem"),
        accountId: account.id,
        endpoint,
        key,
        requestHash,
        responseStatus: res.status,
        responseBody,
        createdAt: nowIso(),
      })
      // A concurrent duplicate raced us to the insert; its stored response wins
      // for future replays, which is fine — both executions succeeded.
      .onConflictDoNothing();
  }
  return res;
}

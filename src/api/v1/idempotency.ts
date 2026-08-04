import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { idempotencyKeys } from "../../db/schema";
import { newId, nowIso } from "../../lib/ids";
import type { ApiContext } from "./auth";
import { ApiError } from "./errors";

// Idempotency-Key support for v1 POST endpoints. Postgres-backed (must survive
// Redis restarts); scope is (account, endpoint, key).
//
// The key row is a CLAIM, inserted (responseStatus null) BEFORE the handler
// runs — the unique index makes two concurrent requests with the same key
// resolve to exactly one execution: the loser gets a 409 "in progress" (or the
// replay, once the winner stored its response). This matters most for
// POST /v1/emails, where a client-timeout retry racing its own first attempt
// must never produce two real sends. A replay within the TTL returns the
// stored original response verbatim; the same key with a different body is
// rejected. Expired rows are treated as absent and deleted lazily on the next
// lookup — no cron dependency.
//
// Handlers with side effects that must be exactly-once can complete the claim
// themselves, atomically with their own writes: `exec` receives the claim row
// id (null when no key was sent), and the wrapper only stores the response for
// claims still unfinished after exec. See POST /v1/emails, which updates the
// claim inside the same transaction that inserts the email row — so a crash
// either leaves no email (retry re-executes) or a stored response (retry
// replays), never an email the caller was told nothing about.

const TTL_MS = 24 * 60 * 60 * 1000;
// A claim with no response after this long is a crashed request (the process
// died between claim and store) — a retry may take it over. Generous: Vercel
// functions can run up to 5 minutes.
const IN_FLIGHT_TTL_MS = 5 * 60 * 1000;
const MAX_KEY_LEN = 255;

function hashRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body) ?? "null").digest("hex");
}

// Wrap a POST handler's execution. `body` is the parsed+validated request body
// (hashed to detect key reuse with a different payload); `exec` produces the
// real response and receives the claim id (null when the caller sent no key).
// Responses ≥500 are not stored — a retry should re-attempt.
export async function withIdempotency(
  ctx: ApiContext,
  req: NextRequest,
  endpoint: string,
  body: unknown,
  exec: (claim: { id: string } | null) => Promise<Response>,
): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key) return exec(null);
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

  // Two passes: the second runs after clearing an expired/abandoned row. A
  // fresh conflict on both passes means genuinely concurrent duplicates.
  for (let attempt = 0; attempt < 2; attempt++) {
    const claimed = await db
      .insert(idempotencyKeys)
      .values({
        id: newId("idem"),
        accountId: account.id,
        endpoint,
        key,
        requestHash,
        responseStatus: null,
        responseBody: null,
        createdAt: nowIso(),
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });

    const claim = claimed[0];
    if (claim) {
      let res: Response;
      try {
        res = await exec({ id: claim.id });
      } catch (err) {
        // Nothing is replayable from a throw — release the claim so a retry
        // re-executes. Guarded on "still unfinished": if exec completed the
        // claim in its own committed transaction and only failed afterwards,
        // the stored response must survive for the retry to replay.
        try {
          await db
            .delete(idempotencyKeys)
            .where(and(eq(idempotencyKeys.id, claim.id), isNull(idempotencyKeys.responseStatus)));
        } catch {
          // Releasing is best-effort; the in-flight TTL frees it eventually.
        }
        throw err;
      }
      if (res.status < 500) {
        const responseBody = await res.clone().text();
        // No-op when exec already completed the claim transactionally.
        await db
          .update(idempotencyKeys)
          .set({ responseStatus: res.status, responseBody })
          .where(and(eq(idempotencyKeys.id, claim.id), isNull(idempotencyKeys.responseStatus)));
      } else {
        await db
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.id, claim.id), isNull(idempotencyKeys.responseStatus)));
      }
      return res;
    }

    // Conflict — someone holds (or held) this key.
    const existing = await db.query.idempotencyKeys.findFirst({ where: scope });
    if (!existing) continue; // deleted between insert and read — claim again

    const ageMs = Date.now() - Date.parse(existing.createdAt);

    if (existing.responseStatus === null) {
      if (ageMs > IN_FLIGHT_TTL_MS) {
        // Abandoned claim (crashed request) — clear it and take over.
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
        continue;
      }
      throw new ApiError(
        409,
        "idempotency_conflict",
        "A request with this Idempotency-Key is already in progress. Retry in a moment.",
      );
    }

    if (ageMs > TTL_MS) {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
      continue;
    }
    if (existing.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This Idempotency-Key was already used with a different request body.",
      );
    }
    return new Response(existing.responseBody ?? "", {
      status: existing.responseStatus,
      headers: { "content-type": "application/json", "Idempotency-Replayed": "true" },
    });
  }

  // Both claim passes lost to concurrent churn on the same key.
  throw new ApiError(
    409,
    "idempotency_conflict",
    "A request with this Idempotency-Key is already in progress. Retry in a moment.",
  );
}

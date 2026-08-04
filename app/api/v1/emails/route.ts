import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { withIdempotency } from "@/api/v1/idempotency";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { serializeEmail } from "@/api/v1/serialize";
import {
  accountUsers,
  idempotencyKeys,
  sendingDomains,
  transactionalEmails,
  type TransactionalEmailStatus,
} from "@/db/schema";
import { canonicalizeEmail } from "@/lib/csv";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { planCanSend } from "@/lib/plans-catalog";
import { checkRateLimit } from "@/lib/rate-limit";
import { getQueue } from "@/queue/producer";
import { releaseReservation, reserveQuota } from "@/services/quota";
import { getSuppressedEmails } from "@/services/suppression";
import {
  MAX_CUSTOM_HEADERS,
  MAX_HTML_BYTES,
  MAX_SUBJECT_LENGTH,
  MAX_TAGS,
  MAX_TEXT_BYTES,
  MAX_TOTAL_BYTES,
  MAX_TRANSACTIONAL_RECIPIENTS,
  SANDBOX_MONTHLY_ALLOWANCE,
  TRANSACTIONAL_SUPPRESSION_REASONS,
  emailDomain,
  isReservedHeader,
  isSendableAddress,
  parseFromAddress,
} from "@/services/transactional";

// Header values and the subject must not carry control characters — CR/LF is
// the header-injection vector, and the rest never appear in legitimate mail.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// POST /api/v1/emails — send a transactional email (Resend-compatible shape).
// The route validates everything synchronously (the HTTP response is a
// transactional caller's only feedback loop), persists the email as `queued`,
// reserves quota, and enqueues the high-priority send job. The worker sends;
// GET /v1/emails/{id} reports the delivery lifecycle.
//
// Exactly-once shape: the whole handler runs inside the Idempotency-Key claim
// (a replayed key returns the stored response without re-validating), and the
// email row + the claim's stored response commit in ONE transaction. So a
// crash anywhere leaves either no email (a retry re-executes cleanly) or an
// email whose 200 the retry replays — never a delivered email the caller was
// told nothing about. Enqueue failure after that commit is deliberately NOT an
// error: the row is already accepted and the cron sweep re-enqueues stale
// queued rows, so a Redis outage degrades to delayed delivery instead of a
// 5xx that invites a duplicating retry.
//
// Sandbox: free (set-up-only) orgs can use this for real — restricted to their
// own org members' addresses and a small monthly allowance — so a developer
// can integrate and test before paying.

const SendSchema = z.object({
  from: z.string().trim().min(1).max(400),
  to: z.union([
    z.string().trim().max(320),
    z.array(z.string().trim().max(320)).min(1).max(MAX_TRANSACTIONAL_RECIPIENTS),
  ]),
  subject: z.string().min(1).max(MAX_SUBJECT_LENGTH),
  html: z.string().max(MAX_HTML_BYTES).optional(),
  text: z.string().max(MAX_TEXT_BYTES).optional(),
  reply_to: z.string().trim().max(320).optional(),
  headers: z.record(z.string().min(1).max(200), z.string().max(2000)).optional(),
  tags: z.record(z.string().min(1).max(100), z.string().max(256)).optional(),
});

export const POST = apiRoute(async (req, ctx) => {
  const { db, account, apiKey } = ctx;
  const body = await readJson(req, SendSchema);

  return withIdempotency(ctx, req, "POST /v1/emails", body, async (claim) => {
  // ---- Validation ----

  const from = parseFromAddress(body.from);
  if (!from) {
    throw new ApiError(
      400,
      "invalid_request",
      'from must be an email address or "Name <email@domain.com>"',
      { param: "from" },
    );
  }

  const rawTo = Array.isArray(body.to) ? body.to : [body.to];
  const to: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTo) {
    const email = canonicalizeEmail(raw);
    if (!isSendableAddress(email)) {
      throw new ApiError(400, "invalid_email", `to: "${raw}" is not a valid email address`, {
        param: "to",
      });
    }
    if (seen.has(email)) continue; // in-payload duplicate — harmless, dedupe
    seen.add(email);
    to.push(email);
  }

  if (!body.html && !body.text) {
    throw new ApiError(400, "invalid_request", "Provide html, text, or both", { param: "html" });
  }

  if (CONTROL_CHARS.test(body.subject)) {
    throw new ApiError(400, "invalid_request", "subject must not contain control characters", {
      param: "subject",
    });
  }

  if (body.reply_to && !isSendableAddress(canonicalizeEmail(body.reply_to))) {
    throw new ApiError(400, "invalid_email", "reply_to is not a valid email address", {
      param: "reply_to",
    });
  }

  if (body.headers) {
    const names = Object.keys(body.headers);
    if (names.length > MAX_CUSTOM_HEADERS) {
      throw new ApiError(400, "invalid_request", `At most ${MAX_CUSTOM_HEADERS} custom headers`, {
        param: "headers",
      });
    }
    for (const name of names) {
      if (isReservedHeader(name)) {
        throw new ApiError(
          400,
          "invalid_request",
          `Header "${name}" is reserved — set it via the request body instead`,
          { param: `headers.${name}` },
        );
      }
      if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) {
        throw new ApiError(400, "invalid_request", `Header name "${name}" is not valid`, {
          param: `headers.${name}`,
        });
      }
      if (CONTROL_CHARS.test(body.headers[name])) {
        throw new ApiError(
          400,
          "invalid_request",
          `Header "${name}" must not contain control characters`,
          { param: `headers.${name}` },
        );
      }
    }
  }

  if (body.tags && Object.keys(body.tags).length > MAX_TAGS) {
    throw new ApiError(400, "invalid_request", `At most ${MAX_TAGS} tags`, { param: "tags" });
  }

  // Aggregate size ceiling in real UTF-8 bytes. Zod's per-field `.max()` counts
  // UTF-16 code units, so multibyte content can be several times larger than
  // the field caps suggest — this is what actually bounds what one request can
  // write to Postgres.
  const totalBytes =
    Buffer.byteLength(body.html ?? "", "utf8") +
    Buffer.byteLength(body.text ?? "", "utf8") +
    Buffer.byteLength(JSON.stringify(body.headers ?? {}), "utf8") +
    Buffer.byteLength(JSON.stringify(body.tags ?? {}), "utf8");
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new ApiError(
      400,
      "invalid_request",
      `Email content is too large (${totalBytes} bytes; the limit is ${MAX_TOTAL_BYTES} across html, text, headers and tags)`,
      { param: "html" },
    );
  }

  // ---- Account eligibility & mode ----

  if (account.riskStatus === "paused") {
    throw new ApiError(403, "sending_disabled", account.pausedReason ?? "Sending is paused for this account.");
  }
  const sandbox = !planCanSend(account.plan);
  if (!sandbox && (!account.sendingEnabled || account.subscriptionStatus !== "active")) {
    throw new ApiError(
      403,
      "sending_disabled",
      "Sending is disabled for this account — check your subscription in the dashboard.",
    );
  }

  // The From address must belong to one of the account's verified sending
  // domains (any local-part on a verified domain works — no pre-created sender
  // required). This is what protects the shared SES reputation.
  const domain = await db.query.sendingDomains.findFirst({
    where: and(
      eq(sendingDomains.accountId, account.id),
      eq(sendingDomains.domain, emailDomain(from.email)),
    ),
  });
  if (!domain || (domain.verificationStatus !== "verified" && !domain.adminOverrideVerified)) {
    throw new ApiError(
      403,
      "domain_not_verified",
      `"${emailDomain(from.email)}" is not a verified sending domain on this account. Verify it under Domains in the dashboard first.`,
      { param: "from" },
    );
  }

  // Sandbox recipients must be the org's own members (the local roster synced
  // from Clerk) — real sends, but only to yourself and your teammates.
  if (sandbox) {
    const members = await db
      .select({ email: accountUsers.email })
      .from(accountUsers)
      .where(eq(accountUsers.accountId, account.id));
    const memberEmails = new Set(members.map((m) => canonicalizeEmail(m.email)));
    const outside = to.filter((email) => !memberEmails.has(email));
    if (outside.length > 0) {
      throw new ApiError(
        403,
        "sandbox_recipient_not_allowed",
        `Free plans send in sandbox mode: recipients must be members of your organization. Not allowed: ${outside.join(", ")}. Upgrade to a paid plan to send to anyone.`,
        { param: "to" },
      );
    }
  }

  // Deliverability suppressions block (hard bounce / complaint / provider
  // list); unsubscribes deliberately do NOT — this is transactional mail.
  const suppressed = await getSuppressedEmails(db, account.id, to, TRANSACTIONAL_SUPPRESSION_REASONS);
  const blocked = to.filter((email) => suppressed.has(email));
  if (blocked.length > 0) {
    throw new ApiError(
      400,
      "email_suppressed",
      `Suppressed recipient(s): ${blocked.join(", ")}. These addresses hard-bounced or complained and cannot be emailed.`,
      { param: "to" },
    );
  }

  // Per-account send throttle (tighter than the general public_api limit —
  // every accepted request is a real provider send).
  const rate = await checkRateLimit("transactional_send", account.id);
  if (!rate.allowed) {
    throw new ApiError(429, "rate_limit_exceeded", "Sending rate limit exceeded. Slow down and retry.", {
      headers: { "Retry-After": String(rate.retryAfterSeconds) },
    });
  }

  // ---- Accept: reserve quota, persist (+ complete the claim), enqueue ----

  // Atomic reservation against the shared monthly counter. Sandbox sends
  // count against a small fixed allowance instead of the plan limit (which
  // is 0 on free tiers). Reserved before the insert: a crash in between
  // over-counts by one request until the period resets — the safe side of a
  // billing/abuse boundary (same tradeoff as campaign batches).
  const granted = await reserveQuota(
    db,
    account.id,
    to.length,
    sandbox ? SANDBOX_MONTHLY_ALLOWANCE : undefined,
  );
  if (granted < to.length) {
    await releaseReservation(db, account.id, granted);
    throw new ApiError(
      403,
      "plan_limit_reached",
      sandbox
        ? `Sandbox allowance (${SANDBOX_MONTHLY_ALLOWANCE} emails/month) is used up. Upgrade to a paid plan to keep sending.`
        : "Monthly email limit reached. Upgrade your plan to send more.",
    );
  }

  const now = nowIso();
  const row: typeof transactionalEmails.$inferSelect = {
    id: newId("eml"),
    accountId: account.id,
    apiKeyId: apiKey.id,
    fromEmail: from.email,
    fromName: from.name,
    replyTo: body.reply_to ? canonicalizeEmail(body.reply_to) : null,
    to,
    subject: body.subject,
    htmlBody: body.html ?? null,
    textBody: body.text ?? null,
    headers: body.headers ?? null,
    tags: body.tags ?? null,
    sandbox,
    status: "queued",
    error: null,
    provider: null,
    providerMessageId: null,
    lockedAt: null,
    sentAt: null,
    deliveredAt: null,
    bouncedAt: null,
    complainedAt: null,
    bodyPrunedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  // The email row and the idempotency claim's stored response commit together:
  // after this transaction, a client retry with the same key REPLAYS this 200
  // instead of creating a second email — which is also what makes the sweep's
  // stale-queued rescue safe (a rescued row can never belong to a request
  // whose caller was told "not accepted").
  const responseBody = JSON.stringify(serializeEmail(row));
  await db.transaction(async (tx) => {
    await tx.insert(transactionalEmails).values(row);
    if (claim) {
      await tx
        .update(idempotencyKeys)
        .set({ responseStatus: 200, responseBody })
        .where(eq(idempotencyKeys.id, claim.id));
    }
  });

  try {
    await getQueue().send({ type: "send_transactional", emailId: row.id, accountId: account.id });
  } catch (err) {
    // The email is already accepted and committed; failing the request now
    // would invite a duplicating retry, and "enqueue threw" doesn't even prove
    // the command didn't land (timeouts are ambiguous). The cron sweep
    // re-enqueues stale queued rows, so a Redis outage means delayed delivery,
    // not a lie to the caller. Loud, because sends are visibly slow until
    // Redis is back.
    void logger.reportError("transactional enqueue failed; sweep will rescue", err, {
      transactionalEmailId: row.id,
      accountId: account.id,
    });
  }

  return new Response(responseBody, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  });
});

// GET /api/v1/emails — the account's transactional emails, newest first.
// ?status= filters on the public status vocabulary ("queued" includes rows a
// worker has momentarily claimed).
const STATUS_FILTERS: Record<string, TransactionalEmailStatus[]> = {
  queued: ["queued", "sending"],
  sent: ["sent"],
  delivered: ["delivered"],
  bounced: ["bounced"],
  complained: ["complained"],
  failed: ["failed"],
  suppressed: ["suppressed"],
};

export const GET = apiRoute(async (req, { db, account }) => {
  const { limit, after } = parsePageQuery(req);
  const filters = [eq(transactionalEmails.accountId, account.id)];

  const status = req.nextUrl.searchParams.get("status");
  if (status !== null) {
    const mapped = STATUS_FILTERS[status];
    if (!mapped) {
      throw new ApiError(
        400,
        "invalid_request",
        `status must be one of: ${Object.keys(STATUS_FILTERS).join(", ")}`,
        { param: "status" },
      );
    }
    filters.push(inArray(transactionalEmails.status, mapped));
  }

  if (after) filters.push(cursorCondition(transactionalEmails.createdAt, transactionalEmails.id, after));

  const rows = await db
    .select()
    .from(transactionalEmails)
    .where(and(...filters))
    .orderBy(desc(transactionalEmails.createdAt), desc(transactionalEmails.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, (row) => serializeEmail(row)));
});

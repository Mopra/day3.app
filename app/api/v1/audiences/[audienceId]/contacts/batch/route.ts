import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { ContactInputSchema, writeContacts } from "@/api/v1/contacts";
import { requireAudienceV1 } from "@/api/v1/finders";
import { withIdempotency } from "@/api/v1/idempotency";
import { serializeContact } from "@/api/v1/serialize";
import { canonicalizeEmail } from "@/lib/csv";

const MAX_BATCH = 1000;

const BatchSchema = z.object({
  upsert: z.boolean().optional().default(false),
  contacts: z.array(ContactInputSchema).min(1),
});

// POST /api/v1/audiences/{id}/contacts/batch — the migration workhorse: up to
// 1,000 contacts per call, per-row results (never all-or-nothing), one
// rate-limit charge for the whole call. Whole-request rejections happen only
// for caller bugs: oversized batch, duplicate emails within the payload, an
// unknown topic id, or a free-tier cap the batch would cross.
export const POST = apiRoute<{ params: Promise<{ audienceId: string }> }>(
  async (req, ctx, { params }) => {
    const { audienceId } = await params;
    const audience = await requireAudienceV1(ctx.db, ctx.account.id, audienceId);
    const body = await readJson(req, BatchSchema);

    if (body.contacts.length > MAX_BATCH) {
      throw new ApiError(
        400,
        "batch_too_large",
        `A batch may contain at most ${MAX_BATCH} contacts (got ${body.contacts.length})`,
        { param: "contacts" },
      );
    }

    // Duplicate emails inside one payload are ambiguous (which row wins?) —
    // reject the whole request with the offending indexes.
    const seen = new Map<string, number>();
    const duplicates: number[] = [];
    for (let i = 0; i < body.contacts.length; i++) {
      const email = canonicalizeEmail(body.contacts[i].email);
      if (seen.has(email)) duplicates.push(i);
      else seen.set(email, i);
    }
    if (duplicates.length > 0) {
      throw new ApiError(
        400,
        "invalid_request",
        `Duplicate emails within the payload at indexes: ${duplicates.join(", ")}`,
        { param: "contacts" },
      );
    }

    return withIdempotency(
      ctx,
      req,
      `POST /v1/audiences/${audience.id}/contacts/batch`,
      body,
      async () => {
        const { results } = await writeContacts(ctx.db, ctx.account, audience.id, body.contacts, {
          upsert: body.upsert,
        });

        const summary = { created: 0, updated: 0, failed: 0 };
        const rows = results.map((r, index) => {
          if (r.status === "failed") {
            summary.failed++;
            return { index, status: "failed", error: { code: r.code, message: r.message } };
          }
          summary[r.status]++;
          return { index, status: r.status, id: r.contact.id, contact: serializeContact(r.contact) };
        });

        return apiJson({ object: "batch_result", summary, results: rows });
      },
    );
  },
);

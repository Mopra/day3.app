import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import type { EnrollmentFilter } from "@/lib/automation-types";
import {
  ENROLLMENT_PAGE_MAX,
  enrollByEmail,
  findAutomationOr404,
  listEnrollments,
} from "@/services/automations";

type Ctx = { params: Promise<{ id: string }> };

// The engine's five statuses plus the two splits the tab filters by
// (`in_progress` / `held`); services/automations.ts owns what they mean.
const FILTERS: readonly EnrollmentFilter[] = [
  "in_progress",
  "held",
  "active",
  "sending",
  "completed",
  "exited",
  "failed",
];

// GET /api/automations/{id}/enrollments?status=&q=&offset=&limit=
export const GET = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const search = new URL(req.url).searchParams;
  const status = search.get("status");
  if (status && !FILTERS.includes(status as EnrollmentFilter)) {
    throw new HttpError(400, `Unknown status "${status}"`);
  }
  const q = search.get("q")?.slice(0, 320) ?? null;
  const offset = Number(search.get("offset") ?? "0");
  const limit = Number(search.get("limit") ?? "50");
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > ENROLLMENT_PAGE_MAX) {
    throw new HttpError(400, `limit must be an integer between 1 and ${ENROLLMENT_PAGE_MAX}`);
  }
  return json(
    await listEnrollments(db, account.id, id, {
      status: (status as EnrollmentFilter | null) ?? null,
      search: q,
      offset,
      limit,
    }),
  );
});

const EnrollBodySchema = z.object({ email: z.string().trim().min(3).max(320) });

// POST /api/automations/{id}/enrollments {email}: manual enrollment of an existing
// contact in the automation's audience. Every entry gate still applies; the
// outcome says which one, if any, refused.
export const POST = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const { email } = await parseJson(req, EnrollBodySchema);
  const automation = await findAutomationOr404(db, account.id, id);
  return json(await enrollByEmail(db, account, automation, email, "manual"));
});

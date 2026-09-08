import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { runEnrollmentNow } from "@/services/automations";

// POST .../enrollments/{enrollmentId}/run-now: skip the current wait. A dev's
// way of stepping through a flow without waiting two days between emails.
export const POST = route<{ params: Promise<{ id: string; enrollmentId: string }> }>(
  async (_req, { params }) => {
    const { id, enrollmentId } = await params;
    const { db, account } = await requireAccount();
    await runEnrollmentNow(db, account.id, id, enrollmentId);
    return json({ ok: true });
  },
);

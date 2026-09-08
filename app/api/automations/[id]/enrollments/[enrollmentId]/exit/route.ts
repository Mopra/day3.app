import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { exitEnrollment } from "@/services/automations";

// POST .../enrollments/{enrollmentId}/exit: stop this person's run (exit_reason
// manual). Nothing already sent is affected.
export const POST = route<{ params: Promise<{ id: string; enrollmentId: string }> }>(
  async (_req, { params }) => {
    const { id, enrollmentId } = await params;
    const { db, account } = await requireAccount();
    await exitEnrollment(db, account.id, id, enrollmentId);
    return json({ ok: true });
  },
);

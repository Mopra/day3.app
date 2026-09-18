import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { getEnrollmentDetail } from "@/services/automations";

// GET .../enrollments/{enrollmentId}: one person's run through the flow, with
// every email it has produced. What the Enrollments drawer reads to answer
// "did they actually get the welcome email, and where are they now?".
export const GET = route<{ params: Promise<{ id: string; enrollmentId: string }> }>(
  async (_req, { params }) => {
    const { id, enrollmentId } = await params;
    const { db, account } = await requireAccount();
    return json(await getEnrollmentDetail(db, account.id, id, enrollmentId));
  },
);

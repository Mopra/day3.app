import { z } from "zod";
import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { accounts, ONBOARDING_PATHS } from "@/db/schema";
import { eq } from "drizzle-orm";
import { nowIso } from "@/lib/ids";

// POST /api/account/onboarding/path: record which starting path the user is on.
//
// One question, asked once: do you already have a list, or are you building one?
// The checklist's audience step follows the answer, because "Import an audience"
// is a dead end for a team with nobody to import yet. They need a signup form
// first. See docs/dashboard-day-zero-plan.md §A4.
//
// Rewritable on purpose: a user who picked wrong (or whose situation changed)
// can switch paths, and nothing downstream depends on the first answer being
// final.
const PathSchema = z.object({
  path: z.enum(ONBOARDING_PATHS),
});

export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  const { path } = await parseJson(req, PathSchema);

  await db
    .update(accounts)
    .set({ onboardingPath: path, updatedAt: nowIso() })
    .where(eq(accounts.id, account.id));

  return json({ ok: true, path });
});

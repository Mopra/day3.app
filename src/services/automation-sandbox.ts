import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { automations } from "../db/schema";
import { planSandboxMode, type PlanKey } from "../lib/plans-catalog";

// Keeps `automations.sandbox` in step with the account's plan.
//
// Publish stamps the flag from the plan of the moment (free tier → sandbox: only
// org members are enrolled and sends draw on the sandbox allowance). Unlike a
// campaign, which is sent once and is done, an automation runs for months, so a
// flag frozen at publish time outlives the plan it described: a free org that
// upgrades would keep refusing every real signup as `sandbox_not_member`, with
// nothing on the Enrollments tab to show for it, until someone happened to republish.
// So every plan write re-stamps the account's automations. Enrollments keep their
// own snapshot (metering must not change under a run in flight), which is why
// this touches only the automation rows.
export async function restampAutomationSandbox(db: Db, accountId: string, plan: PlanKey): Promise<number> {
  const sandbox = planSandboxMode(plan);
  const updated = await db
    .update(automations)
    .set({ sandbox })
    .where(
      and(
        eq(automations.accountId, accountId),
        ne(automations.status, "archived"),
        ne(automations.sandbox, sandbox),
      ),
    )
    .returning({ id: automations.id });
  return updated.length;
}

// One-off smoke test for the public signup-form flow against a RUNNING dev
// server (npm run dev on :3000). Seeds a throwaway account/audience/form, drives
// the real HTTP endpoints (hosted render → submit → confirm), asserts the DB
// transitions, then cleans up. Run: npx tsx scripts/smoke-forms.ts
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { accounts, audiences, forms, subscribers } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { signFormConfirmToken } from "../src/services/form-token";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SECRET = process.env.UNSUBSCRIBE_SECRET!;
const EMAIL = `smoke+${Date.now()}@example.com`;

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const db = getDb();
  const now = nowIso();
  const accountId = newId("acc");
  const audienceId = newId("aud");
  const formId = newId("frm");

  await db.insert(accounts).values({
    id: accountId,
    clerkOrgId: `org_smoke_${accountId}`,
    name: "Smoke Co",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(audiences).values({ id: audienceId, accountId, name: "Smoke list", createdAt: now, updatedAt: now });
  await db.insert(forms).values({
    id: formId,
    accountId,
    audienceId,
    slug: `smoke-${formId.slice(-6)}`,
    name: "Smoke form",
    status: "active",
    doubleOptIn: true,
    buttonLabel: "Subscribe",
    collectName: false,
    createdAt: now,
    updatedAt: now,
  });
  console.log(`Seeded form ${formId}`);

  try {
    // 1. Hosted page renders the native form.
    const page = await fetch(`${BASE}/f/${formId}`);
    const html = await page.text();
    assert(page.status === 200, `hosted page returns 200 (got ${page.status})`);
    assert(/name="email"/.test(html), "hosted page contains an email field");
    assert(html.includes("Subscribe"), "hosted page shows the button label");

    // 2. Native form POST (urlencoded) → 303 to check-inbox.
    const submit = await fetch(`${BASE}/api/public/forms/${formId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: EMAIL }).toString(),
      redirect: "manual",
    });
    assert(submit.status === 303, `submit returns 303 (got ${submit.status})`);
    const loc = submit.headers.get("location") ?? "";
    assert(loc.includes("state=check-inbox"), `redirects to check-inbox (got ${loc})`);

    // 3. The subscriber exists and is PENDING (not yet mailable).
    const pending = await db.query.subscribers.findFirst({ where: eq(subscribers.email, EMAIL) });
    assert(pending?.status === "pending", `subscriber is pending (got ${pending?.status})`);
    assert(pending?.source === "form", "subscriber source is 'form'");
    assert(pending?.consentIp != null, "consent IP captured");

    // 4. Honeypot submission is silently accepted but creates nothing new.
    const hp = await fetch(`${BASE}/api/public/forms/${formId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: `bot+${Date.now()}@x.com`, _hp: "i am a bot" }).toString(),
      redirect: "manual",
    });
    assert(hp.status === 303, "honeypot submit still returns 303 (no error leaked)");
    const botRow = await db.query.subscribers.findFirst({ where: eq(subscribers.email, `bot@x.com`) });
    assert(!botRow, "honeypot submission did not create a subscriber");

    // 5. Confirmation link flips pending → subscribed.
    const token = await signFormConfirmToken(
      { accountId, subscriberId: pending!.id, formId, email: EMAIL },
      SECRET,
    );
    const confirm = await fetch(
      `${BASE}/api/public/forms/confirm?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    assert(confirm.status === 303, `confirm returns 303 (got ${confirm.status})`);
    assert((confirm.headers.get("location") ?? "").includes("state=confirmed"), "redirects to confirmed");

    const confirmed = await db.query.subscribers.findFirst({ where: eq(subscribers.id, pending!.id) });
    assert(confirmed?.status === "subscribed", `subscriber is now subscribed (got ${confirmed?.status})`);
    assert(confirmed?.confirmedAt != null, "confirmedAt is set");

    // 6. embed.js widget is served.
    const widget = await fetch(`${BASE}/embed.js`);
    assert(widget.status === 200, `embed.js served (got ${widget.status})`);
    assert((widget.headers.get("content-type") ?? "").includes("javascript"), "embed.js is JS");

    console.log("\n✅ SMOKE TEST PASSED");
  } finally {
    await db.delete(subscribers).where(eq(subscribers.accountId, accountId));
    await db.delete(forms).where(eq(forms.id, formId));
    await db.delete(audiences).where(eq(audiences.id, audienceId));
    await db.delete(accounts).where(eq(accounts.id, accountId));
    console.log("Cleaned up seeded rows.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌", err.message);
    process.exit(1);
  });

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { audienceFields, forms, imports, subscribers } from "../src/db/schema";
import { processImport } from "../src/queue/handlers/process-import";
import { FakeStore } from "./helpers";
import type { Db } from "../src/db/client";
import type { Account, Audience } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import {
  getAudienceFieldFallbacks,
  listAudienceFields,
  registerAudienceFields,
} from "../src/services/audience-fields";
import { renderCampaignEmail } from "../src/services/render";
import { seedAccount, seedAudience, seedSubscribers, testDb } from "./helpers";

// Drive the field-registry routes directly against a hermetic pglite DB.
// requireAccount is the only seam we replace.
let currentDb: Db;
let currentAccount: Account;

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({
    db: currentDb,
    account: currentAccount,
    auth: { userId: "user_test", orgId: "org_test", has: () => true },
  }),
}));

const fieldsRoute = await import("../app/api/audiences/[id]/fields/route");
const fieldItemRoute = await import("../app/api/audiences/[id]/fields/[fieldId]/route");

function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Next's route context: params resolve to the dynamic segments.
function params(id: string, fieldId?: string) {
  return { params: Promise.resolve(fieldId ? { id, fieldId } : { id }) } as never;
}

// The [fieldId] DELETE handler reads req.nextUrl.searchParams.
function delReq(url: string): Request {
  const req = new Request(url, { method: "DELETE" });
  Object.defineProperty(req, "nextUrl", { value: new URL(url) });
  return req;
}

let audience: Audience;

beforeEach(async () => {
  currentDb = await testDb();
  currentAccount = await seedAccount(currentDb);
  audience = await seedAudience(currentDb, currentAccount.id);
});

async function seedForm(db: Db, accountId: string, audienceId: string) {
  const now = nowIso();
  await db.insert(forms).values({
    id: newId("frm"),
    accountId,
    audienceId,
    slug: "join",
    name: "Join",
    fields: [
      { key: "first_name", label: "First name", type: "text", required: false },
      { key: "company", label: "Company", type: "text", required: false },
      { key: "seats", label: "Seats", type: "number", required: false },
    ],
    createdAt: now,
    updatedAt: now,
  });
}

describe("registerAudienceFields", () => {
  it("registers new keys idempotently and skips reserved/malformed keys", async () => {
    await registerAudienceFields(currentDb, currentAccount.id, audience.id, [
      { key: "plan" },
      { key: "plan" }, // duplicate in the same call
      { key: "email" }, // reserved
      { key: "Bad Key!" }, // malformed
    ]);
    await registerAudienceFields(currentDb, currentAccount.id, audience.id, [
      { key: "plan", label: "Should not overwrite" }, // already registered
    ]);

    const rows = await currentDb
      .select()
      .from(audienceFields)
      .where(eq(audienceFields.audienceId, audience.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("plan");
    expect(rows[0].label).toBe("Plan"); // humanized, not overwritten by the re-run
  });
});

describe("GET /api/audiences/[id]/fields", () => {
  it("seeds the registry from form fields and existing subscriber attributes", async () => {
    await seedForm(currentDb, currentAccount.id, audience.id);
    const [sub] = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
    ]);
    await currentDb
      .update(subscribers)
      .set({ attributes: { phone_number: "555", company: "Acme" } })
      .where(eq(subscribers.id, sub.id));

    const res = await fieldsRoute.GET(
      new Request(`http://localhost/api/audiences/${audience.id}/fields`) as never,
      params(audience.id),
    );
    expect(res.status).toBe(200);
    const { fields } = (await res.json()) as {
      fields: { key: string; label: string; type: string }[];
    };
    const byKey = new Map(fields.map((f) => [f.key, f]));

    // company came from the form (real label), phone_number from subscriber data
    // (humanized label), seats carried its number type; first_name is reserved.
    expect(byKey.has("first_name")).toBe(false);
    expect(byKey.get("company")?.label).toBe("Company");
    expect(byKey.get("seats")?.type).toBe("number");
    expect(byKey.get("phone_number")?.label).toBe("Phone number");
    expect(fields).toHaveLength(3);
  });

  it("404s for an audience of another account", async () => {
    const other = await seedAccount(currentDb);
    const otherAudience = await seedAudience(currentDb, other.id);
    const res = await fieldsRoute.GET(
      new Request(`http://localhost/api/audiences/${otherAudience.id}/fields`) as never,
      params(otherAudience.id),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/audiences/[id]/fields", () => {
  it("creates a field, deriving the key from the label", async () => {
    const res = await fieldsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/fields`, "POST", {
        label: "Plan renewal date",
        type: "date",
        fallback: "soon",
      }) as never,
      params(audience.id),
    );
    expect(res.status).toBe(201);
    const { field } = (await res.json()) as {
      field: { key: string; type: string; fallback: string };
    };
    expect(field.key).toBe("plan_renewal_date");
    expect(field.type).toBe("date");
    expect(field.fallback).toBe("soon");
  });

  it("rejects reserved keys and duplicates", async () => {
    const reserved = await fieldsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/fields`, "POST", {
        label: "First name",
      }) as never,
      params(audience.id),
    );
    expect(reserved.status).toBe(400);

    const first = await fieldsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/fields`, "POST", {
        label: "Company",
      }) as never,
      params(audience.id),
    );
    expect(first.status).toBe(201);
    const dup = await fieldsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/fields`, "POST", {
        label: "company",
      }) as never,
      params(audience.id),
    );
    expect(dup.status).toBe(409);
  });
});

describe("PATCH/DELETE /api/audiences/[id]/fields/[fieldId]", () => {
  async function createField(): Promise<{ id: string; key: string }> {
    const res = await fieldsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/fields`, "POST", {
        label: "Plan",
        fallback: "free",
      }) as never,
      params(audience.id),
    );
    const { field } = (await res.json()) as { field: { id: string; key: string } };
    return field;
  }

  it("edits label/type/fallback; '' clears the fallback", async () => {
    const field = await createField();
    const res = await fieldItemRoute.PATCH(
      jsonReq(
        `http://localhost/api/audiences/${audience.id}/fields/${field.id}`,
        "PATCH",
        { label: "Plan tier", type: "text", fallback: "" },
      ) as never,
      params(audience.id, field.id),
    );
    expect(res.status).toBe(200);
    const { field: updated } = (await res.json()) as {
      field: { label: string; fallback: string | null; key: string };
    };
    expect(updated.label).toBe("Plan tier");
    expect(updated.fallback).toBeNull();
    expect(updated.key).toBe("plan"); // key immutable
  });

  it("delete keeps stored values by default; ?purge=1 strips them from subscribers", async () => {
    const seeded = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
      "bob@example.com",
    ]);
    await currentDb
      .update(subscribers)
      .set({ attributes: { plan: "pro", city: "Oslo" } })
      .where(eq(subscribers.id, seeded[0].id));

    // Default delete: registry row gone, values untouched.
    const keep = await createField();
    const res1 = await fieldItemRoute.DELETE(
      delReq(`http://localhost/api/audiences/${audience.id}/fields/${keep.id}`) as never,
      params(audience.id, keep.id),
    );
    expect(res1.status).toBe(200);
    let sub = await currentDb.query.subscribers.findFirst({
      where: eq(subscribers.id, seeded[0].id),
    });
    expect(sub?.attributes).toEqual({ plan: "pro", city: "Oslo" });

    // Purge delete: values stripped, other keys intact, unaffected rows untouched.
    const purge = await createField();
    const res2 = await fieldItemRoute.DELETE(
      delReq(
        `http://localhost/api/audiences/${audience.id}/fields/${purge.id}?purge=1`,
      ) as never,
      params(audience.id, purge.id),
    );
    expect(res2.status).toBe(200);
    sub = await currentDb.query.subscribers.findFirst({
      where: eq(subscribers.id, seeded[0].id),
    });
    expect(sub?.attributes).toEqual({ city: "Oslo" });
    const rows = await currentDb
      .select()
      .from(audienceFields)
      .where(eq(audienceFields.audienceId, audience.id));
    expect(rows).toHaveLength(0);
  });

  it("404s for a field on another account's audience", async () => {
    const field = await createField();
    const other = await seedAccount(currentDb);
    currentAccount = other; // requireAccount now resolves the other tenant
    const res = await fieldItemRoute.PATCH(
      jsonReq(
        `http://localhost/api/audiences/${audience.id}/fields/${field.id}`,
        "PATCH",
        { label: "hijack" },
      ) as never,
      params(audience.id, field.id),
    );
    expect(res.status).toBe(404);
  });
});

describe("CSV import auto-registration", () => {
  it("catalogues new custom columns in the registry", async () => {
    const store = new FakeStore();
    const importId = newId("imp");
    const r2Key = `imports/${currentAccount.id}/${importId}.csv`;
    store.put(r2Key, "email,Company,Plan Tier\nalice@example.com,Acme,pro\n");
    const now = nowIso();
    await currentDb.insert(imports).values({
      id: importId,
      accountId: currentAccount.id,
      audienceId: audience.id,
      r2Key,
      filename: "test.csv",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    await processImport({ importId, accountId: currentAccount.id }, currentDb, store);

    const rows = await currentDb
      .select()
      .from(audienceFields)
      .where(eq(audienceFields.audienceId, audience.id));
    expect(rows.map((r) => r.key).sort()).toEqual(["company", "plan_tier"]);
  });
});

describe("field fallbacks at render time", () => {
  it("getAudienceFieldFallbacks returns only fields with a non-empty fallback", async () => {
    await registerAudienceFields(currentDb, currentAccount.id, audience.id, [
      { key: "plan" },
      { key: "city" },
    ]);
    const rows = await listAudienceFields(currentDb, currentAccount.id, audience.id);
    await currentDb
      .update(audienceFields)
      .set({ fallback: "free" })
      .where(eq(audienceFields.id, rows.find((r) => r.key === "plan")!.id));

    const fallbacks = await getAudienceFieldFallbacks(currentDb, audience.id);
    expect(fallbacks).toEqual({ plan: "free" });
  });

  it("resolution order: subscriber value → inline fallback → field fallback → empty", async () => {
    const base = {
      campaign: {
        subject: "s",
        htmlBody: "<p>A:{{plan}} B:{{plan|inline}} C:{{city}} D:{{nothing}}</p>",
      },
      companyName: "Acme",
      companyAddress: "1 St",
      unsubscribeUrl: "https://x/unsub",
      fieldFallbacks: { plan: "free", city: "somewhere" },
    };

    // Subscriber value wins over both fallbacks.
    const withValue = renderCampaignEmail({
      ...base,
      subscriber: { email: "a@b.com", attributes: { plan: "pro" } },
    });
    expect(withValue.html).toContain("A:pro B:pro");

    // No value: inline beats the field fallback; field fallback fills bare tags.
    const without = renderCampaignEmail({
      ...base,
      subscriber: { email: "a@b.com" },
    });
    expect(without.html).toContain("A:free B:inline C:somewhere D:");

    // Field fallbacks are merge values — HTML-escaped like everything else.
    const sneaky = renderCampaignEmail({
      ...base,
      fieldFallbacks: { plan: "<img onerror=x>" },
      subscriber: { email: "a@b.com" },
    });
    expect(sneaky.html).not.toContain("<img onerror");
  });
});

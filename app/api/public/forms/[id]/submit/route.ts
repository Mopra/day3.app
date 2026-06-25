import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { getDb } from "@/db/client";
import { forms } from "@/db/schema";
import { getQueue } from "@/queue/producer";
import { isValidEmail } from "@/lib/csv";
import { enforceRateLimit, clientIp } from "@/lib/rate-limit";
import { submitFormSignup } from "@/services/form-signup";
import { splitSubmittedFields } from "@/lib/form-fields";

// The single public ingestion endpoint behind every signup surface. It accepts
// BOTH a native HTML form POST (application/x-www-form-urlencoded or multipart —
// a "simple" cross-origin request needing NO CORS preflight, works with JS
// disabled) and a JSON fetch. Native posts get a 303 redirect to a hosted result
// page; JSON callers get JSON. Reliability is the point: the signup is written to
// Postgres synchronously and the confirmation email is queued, so a Redis blip
// never loses a signup.

async function readFields(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body ?? {})) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }
  // Handles both urlencoded and multipart/form-data native form posts.
  const form = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function wantsJson(req: NextRequest): boolean {
  const contentType = req.headers.get("content-type") ?? "";
  return contentType.includes("application/json");
}

function successRedirect(req: NextRequest, form: { id: string; doubleOptIn: boolean; redirectUrl: string | null }): NextResponse {
  if (form.redirectUrl) {
    return NextResponse.redirect(form.redirectUrl, 303);
  }
  const state = form.doubleOptIn ? "check-inbox" : "subscribed";
  const url = new URL(`/f/${form.id}`, req.nextUrl.origin);
  url.searchParams.set("state", state);
  return NextResponse.redirect(url, 303);
}

function errorRedirect(req: NextRequest, formId: string, reason: string): NextResponse {
  const url = new URL(`/f/${formId}`, req.nextUrl.origin);
  url.searchParams.set("state", "error");
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url, 303);
}

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  await enforceRateLimit("form_submit", clientIp(req));

  const db = getDb();
  const form = await db.query.forms.findFirst({ where: eq(forms.id, id) });
  if (!form || form.status !== "active") {
    throw new HttpError(404, "This form is not available");
  }

  const fields = await readFields(req);
  const json_ = wantsJson(req);

  // Honeypot: a real human never fills the hidden `_hp` field. If it's set,
  // pretend success and drop the submission silently (don't tip off the bot).
  if ((fields._hp ?? "").trim() !== "") {
    return json_ ? json({ ok: true, status: form.doubleOptIn ? "pending" : "subscribed" }) : successRedirect(req, form);
  }

  const email = (fields.email ?? "").trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    if (json_) throw new HttpError(400, "Enter a valid email address");
    return errorRedirect(req, form.id, "email");
  }

  // Accept legacy first/last name aliases (older HTML snippets posted firstName)
  // so embeds in the wild keep working alongside the new key-based fields.
  const values: Record<string, string> = {
    ...fields,
    first_name: fields.first_name ?? fields.firstName ?? "",
    last_name: fields.last_name ?? fields.lastName ?? "",
  };
  // Only keys declared on the form are read; everything else is ignored, so a
  // crafted POST can't write arbitrary attributes onto a subscriber.
  const { firstName, lastName, attributes } = splitSubmittedFields(form.fields, values);

  const result = await submitFormSignup(db, getQueue(), {
    form,
    email,
    firstName,
    lastName,
    attributes,
    consentIp: clientIp(req),
  });

  // Always present the same success outcome regardless of the internal result
  // (pending / already_* / opted_out): never reveal whether an address is known
  // or suppressed. Only hard input errors above are surfaced.
  if (json_) {
    return json({ ok: true, status: form.doubleOptIn ? "pending" : "subscribed", outcome: result.outcome });
  }
  return successRedirect(req, form);
});

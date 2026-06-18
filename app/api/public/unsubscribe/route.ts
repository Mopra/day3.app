import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema";
import { verifyUnsubscribeToken } from "@/services/unsubscribe";
import { applyUnsubscribe } from "@/services/unsubscribe-action";

export const GET = route(async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const payload = await verifyUnsubscribeToken(token, process.env.UNSUBSCRIBE_SECRET ?? "");
  if (!payload) throw new HttpError(400, "Invalid or expired link");

  const db = getDb();
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, payload.accountId),
  });
  return json({ email: payload.email, companyName: account?.name ?? "this sender" });
});

const ConfirmSchema = z.object({ token: z.string().min(1) });

export const POST = route(async (req: NextRequest) => {
  // Support both the SPA JSON body and the form-encoded one-click
  // List-Unsubscribe-Post (RFC 8058) flow, which posts to the token URL.
  let token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      token = (await parseJson(req, ConfirmSchema)).token;
    }
  }

  const payload = await verifyUnsubscribeToken(token, process.env.UNSUBSCRIBE_SECRET ?? "");
  if (!payload) throw new HttpError(400, "Invalid or expired link");

  await applyUnsubscribe(getDb(), payload);
  return json({ ok: true });
});

import { Webhook } from "svix";
import { headers } from "next/headers";
import { deleteAllUserData } from "@/lib/db";

export async function POST(request: Request) {
  const SIGNING_SECRET = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!SIGNING_SECRET) {
    return new Response("Missing CLERK_WEBHOOK_SIGNING_SECRET", { status: 500 });
  }

  const headersList = await headers();
  const svixId = headersList.get("svix-id");
  const svixTimestamp = headersList.get("svix-timestamp");
  const svixSignature = headersList.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing svix headers", { status: 400 });
  }

  const body = await request.text();

  const wh = new Webhook(SIGNING_SECRET);
  let event: { type: string; data: { id: string } };

  try {
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as typeof event;
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "user.deleted") {
    const clerkUserId = event.data.id;
    if (clerkUserId) {
      await deleteAllUserData(clerkUserId);
    }
  }

  return new Response("OK", { status: 200 });
}

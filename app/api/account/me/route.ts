import { clerkClient } from "@clerk/nextjs/server";
import { route, json } from "@/api/http";
import { requireAuth } from "@/api/context";

// Who am I: primary email + admin flag (drives the Admin nav; admin routes
// re-check on every request).
export const GET = route(async () => {
  const { userId } = await requireAuth();
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const email =
    user.emailAddresses
      .find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress.toLowerCase() ?? "";
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return json({ email, isAdmin: adminEmails.includes(email) });
});

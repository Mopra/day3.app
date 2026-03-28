"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { getUserByClerkId, createOrUpdateProfile } from "@/lib/db";

/**
 * Returns the current user's profile, auto-provisioning from Clerk OAuth data
 * on first visit so no manual onboarding form is needed.
 */
export async function getCurrentUserProfile() {
  const { userId } = await auth();
  if (!userId) return null;

  const existing = await getUserByClerkId(userId);
  if (existing) return existing;

  // First visit — auto-create profile from Clerk / X OAuth data
  const clerk = await currentUser();
  if (!clerk) return null;

  const xAccount = clerk.externalAccounts?.find(
    (a) => a.provider === "x" || a.provider === "twitter",
  );

  const email = clerk.emailAddresses[0]?.emailAddress ?? "";
  const name =
    [clerk.firstName, clerk.lastName].filter(Boolean).join(" ") ||
    clerk.username ||
    xAccount?.username ||
    "";
  const xHandle = xAccount?.username ?? clerk.username ?? "";

  await createOrUpdateProfile(userId, email, { name, xHandle });

  return getUserByClerkId(userId);
}

export async function saveProfile(formData: FormData) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const clerk = await currentUser();
  const email = clerk?.emailAddresses[0]?.emailAddress ?? "";

  const name = formData.get("name") as string;
  const xHandle = formData.get("xHandle") as string;

  await createOrUpdateProfile(userId, email, { name, xHandle });
  return { success: true };
}

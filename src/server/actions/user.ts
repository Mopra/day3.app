"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { getUserByClerkId, createOrUpdateProfile } from "@/lib/db";
import { serialize } from "@/lib/firebase";

export async function getCurrentUserProfile() {
  const { userId } = await auth();
  if (!userId) return null;
  const user = await getUserByClerkId(userId);
  if (!user) return null;
  return serialize(user);
}

export async function saveProfile(formData: FormData) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const user = await currentUser();
  const email = user?.emailAddresses[0]?.emailAddress || "";

  const name = formData.get("name") as string;
  const xHandle = formData.get("xHandle") as string;
  const bio = (formData.get("bio") as string) || "";
  const interestsRaw = (formData.get("interests") as string) || "";
  const interests = interestsRaw.split(",").map((s) => s.trim()).filter(Boolean);

  await createOrUpdateProfile(userId, email, { name, xHandle, bio, interests });
  return { success: true };
}

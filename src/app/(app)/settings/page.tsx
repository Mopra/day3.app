export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getCurrentUserProfile } from "@/server/actions/user";
import { ProfileForm } from "@/components/settings/profile-form";

export default async function SettingsPage() {
  const user = await getCurrentUserProfile();
  if (!user) redirect("/sign-in");

  return (
    <div className="max-w-lg">
      <ProfileForm
        defaultValues={{
          name: user.name,
          xHandle: user.xHandle,
        }}
      />
    </div>
  );
}

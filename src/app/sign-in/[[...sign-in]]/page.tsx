import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";

export default async function SignInPage() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <div className="flex items-center justify-center min-h-screen">
      <SignIn fallbackRedirectUrl="/dashboard" />
    </div>
  );
}

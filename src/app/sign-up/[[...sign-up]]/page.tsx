import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";

export default async function SignUpPage() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <div className="flex items-center justify-center min-h-screen">
      <SignUp fallbackRedirectUrl="/dashboard" />
    </div>
  );
}

import { redirect } from "next/navigation";

// Safety net: mirror /login → /sign-in for the sign-up alias. See app/login/page.tsx.
export default function SignupRedirect() {
  redirect("/sign-up");
}

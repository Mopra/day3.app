import { redirect } from "next/navigation";

// Safety net: some Clerk auth flows can redirect to /login (a path this app does
// not serve — sign-in lives at /sign-in). Without this, those users dead-end on
// the 404 page mid-auth. Bounce them to the real sign-in route, which forwards
// already-authenticated users on to /dashboard.
export default function LoginRedirect() {
  redirect("/sign-in");
}

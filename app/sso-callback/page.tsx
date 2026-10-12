import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

// Finishes an SSO sign-in started in the app itself (app/login/agentid). The
// hosted sign-in page has its own callback; this one only serves the custom
// entry points.
export default function SsoCallback() {
  return <AuthenticateWithRedirectCallback />;
}

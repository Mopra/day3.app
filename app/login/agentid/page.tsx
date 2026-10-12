"use client";

import { useSignIn } from "@clerk/nextjs";
import { useEffect, useRef } from "react";

// AgentID's "initiate login URL": a page that starts Sign in with AgentID as
// soon as it loads, so an agent coming from the AgentID directory skips our
// sign-in form. Signing in and signing up are the same flow here: Clerk
// creates the user on first sign-in.
// Clerk's server knows this strategy, but @clerk/nextjs 7.5's OAuthStrategy
// union predates AgentID. Drop the cast once the types catch up.
const AGENTID = "oauth_agentid" as Parameters<ReturnType<typeof useSignIn>["signIn"]["sso"]>[0]["strategy"];

export default function AgentIdSignIn() {
  const { signIn } = useSignIn();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // effects can run twice in development
    started.current = true;
    void signIn.sso({
      strategy: AGENTID,
      redirectCallbackUrl: "/sso-callback",
      redirectUrl: "/dashboard",
    });
  }, [signIn]);

  return (
    <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
      Redirecting to AgentID…
    </div>
  );
}

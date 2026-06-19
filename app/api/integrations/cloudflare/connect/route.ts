import { NextResponse, type NextRequest } from "next/server";
import { requireAccount } from "@/api/context";
import {
  CF_STATE_COOKIE,
  buildAuthorizeUrl,
  getCloudflareOAuthConfig,
  newStatePayload,
  pkceChallenge,
  randomToken,
  signState,
} from "@/services/cloudflare-oauth";
import { requireOAuthStateSecret } from "@/lib/env";

// Only allow same-origin relative paths as the post-connect destination, so the
// returnTo param can't be turned into an open redirect.
function safeReturnTo(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/domains";
}

// Browser navigation entry point: mints PKCE + state, stashes them in a signed
// short-lived httpOnly cookie, and redirects the user to Cloudflare's consent
// screen.
export async function GET(req: NextRequest) {
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get("returnTo"));
  try {
    const { account } = await requireAccount();
    const config = getCloudflareOAuthConfig();

    const state = randomToken();
    const codeVerifier = randomToken(48);
    const codeChallenge = await pkceChallenge(codeVerifier);
    const cookie = await signState(
      newStatePayload(account.id, returnTo, codeVerifier, state),
      requireOAuthStateSecret(),
    );

    const res = NextResponse.redirect(buildAuthorizeUrl(config, { state, codeChallenge }));
    res.cookies.set(CF_STATE_COOKIE, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax", // survives the top-level redirect back from Cloudflare
      path: "/",
      maxAge: 600,
    });
    return res;
  } catch (err) {
    console.error("[cloudflare/connect] failed to start OAuth", err);
    const dest = new URL(returnTo, req.nextUrl.origin);
    dest.searchParams.set("cf_error", "Could not start the Cloudflare connection");
    return NextResponse.redirect(dest);
  }
}

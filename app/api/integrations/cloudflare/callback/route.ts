import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client";
import {
  CF_STATE_COOKIE,
  completeAuthCode,
  getCloudflareOAuthConfig,
  verifyState,
} from "@/services/cloudflare-oauth";

// Cloudflare redirects the user back here with ?code&state. We validate state
// against the signed cookie, exchange the code (PKCE), persist the encrypted
// tokens, and bounce back to where the user started.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const cookie = req.cookies.get(CF_STATE_COOKIE)?.value;
  const saved = cookie ? await verifyState(cookie, process.env.OAUTH_STATE_SECRET ?? "") : null;
  const returnTo = saved?.returnTo ?? "/domains";

  const redirectBack = (params: Record<string, string>) => {
    const dest = new URL(returnTo, url.origin);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    const res = NextResponse.redirect(dest);
    res.cookies.delete(CF_STATE_COOKIE);
    return res;
  };

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return redirectBack({ cf_error: url.searchParams.get("error_description") ?? oauthError });
  }

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code || !stateParam || !saved) {
    return redirectBack({ cf_error: "The Cloudflare connection expired — please try again" });
  }
  if (saved.state !== stateParam) {
    return redirectBack({ cf_error: "Could not verify the Cloudflare connection (state mismatch)" });
  }

  try {
    await completeAuthCode(
      getDb(),
      saved.accountId,
      { code, codeVerifier: saved.codeVerifier },
      getCloudflareOAuthConfig(),
    );
  } catch (err) {
    console.error("[cloudflare/callback] token exchange failed", err);
    return redirectBack({ cf_error: "Could not complete the Cloudflare connection" });
  }

  return redirectBack({ cf_connected: "1" });
}

// Reports a new workspace to the marketing site's GA4 property as `sign_up`.
//
// The marketing site (day3.app) runs GA4 and can see a visitor click "Get
// started", but the signup itself happens here, on another origin, and this app
// sets essential cookies only (see the privacy policy and CookieNotice). So the
// app never loads a GA tag. Instead the server sends one Measurement Protocol
// event when an account row is first created, under the visitor's GA client id
// carried over from the site:
//
//   day3.app CTA (adds ?ga_cid=...&ga_sid=...&utm_*=...) → /sign-up (stores them in the
//   Clerk user's unsafeMetadata) → syncCurrentOrganization creates the account
//   → reportSignup.
//
// Reusing the site's client id is what lets GA4 credit the signup to the
// channel and page that earned it. The session id matters as much: a
// Measurement Protocol event without `session_id` is not joined to any session,
// so GA4 reports it as "Unassigned" with landing page "(not set)" even under the
// right client id. Every sign_up landed there until ga_sid was carried too.
// Without a client id (a direct visit) the event is still counted, under a
// fresh id.
//
// This is the app's one sign_up. Do not add a client-side GA tag to fire another:
// it would set the cookies the privacy policy says the app does not, and GA4
// would count each signup twice.
//
// Off unless GA4_MEASUREMENT_ID and GA4_API_SECRET are both set, and never
// throws: a signup is never held up or broken by analytics.

export const SIGNUP_ATTRIBUTION_KEY = "signupAttribution";

export type SignupAttribution = {
  gaClientId?: string;
  gaSessionId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
};

const FIELDS: Record<keyof SignupAttribution, string> = {
  gaClientId: "ga_cid",
  gaSessionId: "ga_sid",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmContent: "utm_content",
};

// A GA4 client id is two dot-separated integers ("1234567890.1712345678").
const CLIENT_ID = /^\d{1,20}\.\d{1,20}$/;
// A GA4 session id is the session's start time in Unix seconds.
const SESSION_ID = /^\d{1,20}$/;
// GA4 truncates parameter values at 100 characters; anything longer is not ours.
const MAX_VALUE = 100;

function clean(key: keyof SignupAttribution, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.length > MAX_VALUE) return undefined;
  if (key === "gaClientId" && !CLIENT_ID.test(v)) return undefined;
  if (key === "gaSessionId" && !SESSION_ID.test(v)) return undefined;
  return v;
}

function pick(read: (key: keyof SignupAttribution) => unknown): SignupAttribution | undefined {
  const out: SignupAttribution = {};
  for (const key of Object.keys(FIELDS) as (keyof SignupAttribution)[]) {
    const v = clean(key, read(key));
    if (v) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Attribution from the /sign-up URL's query string, or undefined if it carries none. */
export function attributionFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): SignupAttribution | undefined {
  return pick((key) => {
    const v = params[FIELDS[key]];
    return Array.isArray(v) ? v[0] : v;
  });
}

/** Attribution stored on a Clerk user's unsafeMetadata at sign-up. */
export function attributionFromMetadata(metadata: unknown): SignupAttribution {
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)[SIGNUP_ATTRIBUTION_KEY]
      : undefined;
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  return pick((key) => obj[key]) ?? {};
}

/**
 * How the person signed up, as GA4's `method`: the social provider they came
 * through ("google", "github", "agentid"), or "email". Clerk names providers
 * "google" or "oauth_google" depending on version, and a custom one
 * "oauth_custom_agentid", so the prefixes are stripped.
 */
export function signupMethod(user: { externalAccounts?: { provider: string }[] }): string {
  const provider = user.externalAccounts?.[0]?.provider;
  if (!provider) return "email";
  return provider.replace(/^oauth_/, "").replace(/^custom_/, "").slice(0, MAX_VALUE) || "email";
}

function freshClientId(): string {
  const random = Math.floor(Math.random() * 2_000_000_000);
  return `${random}.${Math.floor(Date.now() / 1000)}`;
}

/** The Measurement Protocol body for one sign_up. Exported for the test. */
export function signupPayload(attribution: SignupAttribution, method = "email") {
  const params: Record<string, string | number> = {
    method,
    // Required for the event to count as engaged in GA4 reports.
    engagement_time_msec: 1,
  };
  // Joins the event to the visit on the site, so it inherits that session's
  // channel and landing page. Only meaningful under the site's own client id.
  if (attribution.gaClientId && attribution.gaSessionId) {
    params.session_id = attribution.gaSessionId;
  }
  // The same names the site's signup_click uses, so one custom dimension reads both.
  if (attribution.utmContent) params.page_path = attribution.utmContent;
  if (attribution.utmCampaign) params.placement = attribution.utmCampaign;
  if (attribution.utmSource) params.source = attribution.utmSource;
  if (attribution.utmMedium) params.medium = attribution.utmMedium;
  return {
    client_id: attribution.gaClientId ?? freshClientId(),
    events: [{ name: "sign_up", params }],
  };
}

export async function reportSignup(
  attribution: SignupAttribution,
  method = "email",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) return;

  const url =
    "https://www.google-analytics.com/mp/collect" +
    `?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      body: JSON.stringify(signupPayload(attribution, method)),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) console.error(`[signup-analytics] GA4 answered ${res.status}`);
  } catch (err) {
    console.error("[signup-analytics] could not report sign_up", err);
  }
}

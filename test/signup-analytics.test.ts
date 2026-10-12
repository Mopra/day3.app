import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIGNUP_ATTRIBUTION_KEY,
  attributionFromMetadata,
  attributionFromSearchParams,
  reportSignup,
  signupMethod,
  signupPayload,
} from "../src/services/signup-analytics";

describe("signup attribution", () => {
  it("reads the site's client id and UTM tags from the sign-up URL", () => {
    expect(
      attributionFromSearchParams({
        ga_cid: "123456789.1712345678",
        utm_source: "day3-website",
        utm_medium: "cta",
        utm_campaign: "header",
        utm_content: "/pricing",
        redirect_url: "/dashboard",
      }),
    ).toEqual({
      gaClientId: "123456789.1712345678",
      utmSource: "day3-website",
      utmMedium: "cta",
      utmCampaign: "header",
      utmContent: "/pricing",
    });
  });

  it("returns undefined when the URL carries nothing, and drops a malformed client id", () => {
    expect(attributionFromSearchParams({})).toBeUndefined();
    expect(attributionFromSearchParams({ ga_cid: "GA1.1.<script>" })).toBeUndefined();
  });

  it("round-trips through Clerk metadata and ignores junk there", () => {
    const a = attributionFromSearchParams({ ga_cid: "1.2", utm_content: "/" })!;
    expect(attributionFromMetadata({ [SIGNUP_ATTRIBUTION_KEY]: a })).toEqual(a);
    expect(attributionFromMetadata(undefined)).toEqual({});
    expect(attributionFromMetadata({ [SIGNUP_ATTRIBUTION_KEY]: { gaClientId: 42 } })).toEqual({});
  });

  it("builds a sign_up under the site's client id, or a fresh one", () => {
    const p = signupPayload({ gaClientId: "1.2", utmContent: "/pricing", utmCampaign: "header" });
    expect(p.client_id).toBe("1.2");
    expect(p.events[0]).toEqual({
      name: "sign_up",
      params: { method: "email", engagement_time_msec: 1, page_path: "/pricing", placement: "header" },
    });
    expect(signupPayload({}).client_id).toMatch(/^\d+\.\d+$/);
    expect(signupPayload({}, "google").events[0].params.method).toBe("google");
  });

  it("names the sign-up method from the user's social account, or email", () => {
    expect(signupMethod({ externalAccounts: [] })).toBe("email");
    expect(signupMethod({ externalAccounts: [{ provider: "google" }] })).toBe("google");
    expect(signupMethod({ externalAccounts: [{ provider: "oauth_github" }] })).toBe("github");
    expect(signupMethod({ externalAccounts: [{ provider: "oauth_custom_agentid" }] })).toBe("agentid");
  });
});

describe("reportSignup", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does nothing without GA4 credentials", async () => {
    vi.stubEnv("GA4_MEASUREMENT_ID", "");
    vi.stubEnv("GA4_API_SECRET", "");
    const fetchImpl = vi.fn();
    await reportSignup({}, "email", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to the Measurement Protocol and swallows a failure", async () => {
    vi.stubEnv("GA4_MEASUREMENT_ID", "G-TEST");
    vi.stubEnv("GA4_API_SECRET", "s3cret");
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reportSignup({ gaClientId: "1.2" }, "email", fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=s3cret");
    expect(JSON.parse(init.body).client_id).toBe("1.2");
    log.mockRestore();
  });
});

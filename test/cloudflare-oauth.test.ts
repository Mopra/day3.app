import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  fetchUserInfo,
  getCloudflareOAuthConfig,
  getValidAccessToken,
  newStatePayload,
  pkceChallenge,
  randomToken,
  saveTokens,
  signState,
  verifyState,
  type OAuthStatePayload,
} from "../src/services/cloudflare-oauth";
import { decryptSecret } from "../src/lib/crypto";
import { dnsIntegrations } from "../src/db/schema";
import { testDb, seedAccount } from "./helpers";

// These functions read secrets/config from the environment at call time.
process.env.DNS_TOKEN_ENC_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.CLOUDFLARE_OAUTH_CLIENT_ID = "test-client";
process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET = "test-secret";

const STATE_SECRET = "state-secret";
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OAuth state cookie (PKCE bridge)", () => {
  it("round-trips a valid payload", async () => {
    const token = await signState(newStatePayload("acc_1", "/domains/d1", "verifier", "state"), STATE_SECRET);
    const out = await verifyState(token, STATE_SECRET);
    expect(out).toMatchObject({ accountId: "acc_1", codeVerifier: "verifier", state: "state" });
  });

  it("rejects a tampered token", async () => {
    const token = await signState(newStatePayload("a", "/d", "v", "s"), STATE_SECRET);
    expect(await verifyState(`${token}x`, STATE_SECRET)).toBeNull();
  });

  it("rejects the wrong secret", async () => {
    const token = await signState(newStatePayload("a", "/d", "v", "s"), STATE_SECRET);
    expect(await verifyState(token, "other-secret")).toBeNull();
  });

  it("rejects an expired payload", async () => {
    const expired: OAuthStatePayload = {
      state: "s",
      codeVerifier: "v",
      accountId: "a",
      returnTo: "/d",
      exp: Date.now() - 1000,
    };
    const token = await signState(expired, STATE_SECRET);
    expect(await verifyState(token, STATE_SECRET)).toBeNull();
  });
});

describe("PKCE", () => {
  it("produces the S256 challenge (RFC 7636 test vector)", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("randomToken returns a url-safe string", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("token storage", () => {
  it("inserts, encrypts, then updates the single connection per account", async () => {
    const db = await testDb();
    const acc = await seedAccount(db);

    await saveTokens(
      db,
      acc.id,
      { accessToken: "acc-1", refreshToken: "ref-1", expiresAt: future(), scope: "dns.write zone.read" },
      "me@example.com",
    );

    let rows = await db.select().from(dnsIntegrations).where(eq(dnsIntegrations.accountId, acc.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].cfAccountLabel).toBe("me@example.com");
    expect(rows[0].accessTokenEnc).not.toContain("acc-1"); // stored encrypted
    expect(await decryptSecret(rows[0].accessTokenEnc)).toBe("acc-1");

    // Second connect updates the same row (unique account+provider) and keeps the
    // label when a new one isn't supplied.
    await saveTokens(db, acc.id, { accessToken: "acc-2", refreshToken: "ref-2", expiresAt: future() });
    rows = await db.select().from(dnsIntegrations).where(eq(dnsIntegrations.accountId, acc.id));
    expect(rows).toHaveLength(1);
    expect(await decryptSecret(rows[0].accessTokenEnc)).toBe("acc-2");
    expect(rows[0].cfAccountLabel).toBe("me@example.com");
  });

  it("returns the stored access token without refreshing when it's still valid", async () => {
    const db = await testDb();
    const acc = await seedAccount(db);
    await saveTokens(db, acc.id, { accessToken: "fresh", refreshToken: "r", expiresAt: future() });
    const row = await db.query.dnsIntegrations.findFirst({ where: eq(dnsIntegrations.accountId, acc.id) });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not refresh"); }));
    expect(await getValidAccessToken(db, row!)).toBe("fresh");
  });

  it("refreshes and persists rotated tokens when expired", async () => {
    const db = await testDb();
    const acc = await seedAccount(db);
    await saveTokens(db, acc.id, { accessToken: "old", refreshToken: "old-refresh", expiresAt: past() });
    const row = await db.query.dnsIntegrations.findFirst({ where: eq(dnsIntegrations.accountId, acc.id) });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "dns.write zone.read",
        }),
      })) as unknown as typeof fetch,
    );

    expect(await getValidAccessToken(db, row!)).toBe("new-access");
    const after = await db.query.dnsIntegrations.findFirst({ where: eq(dnsIntegrations.accountId, acc.id) });
    expect(await decryptSecret(after!.accessTokenEnc)).toBe("new-access");
    expect(await decryptSecret(after!.refreshTokenEnc)).toBe("new-refresh");
  });
});

describe("fetchUserInfo (best-effort label)", () => {
  it("returns the email when Cloudflare provides identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ result: { email: "me@x.co" } }) })) as unknown as typeof fetch,
    );
    expect(await fetchUserInfo("tok", getCloudflareOAuthConfig())).toBe("me@x.co");
  });

  it("returns null when userinfo is forbidden (no identity scope)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch,
    );
    expect(await fetchUserInfo("tok", getCloudflareOAuthConfig())).toBeNull();
  });
});

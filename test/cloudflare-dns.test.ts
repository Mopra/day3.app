import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, decryptSecret, keyIdOf } from "../src/lib/crypto";
import {
  findZone,
  upsertRecord,
  writeRecords,
  CloudflareApiError,
} from "../src/services/cloudflare-dns";
import { buildAuthorizeUrl } from "../src/services/cloudflare-oauth";
import type { DnsRecord } from "../src/lib/types";

// A deterministic 32-byte key (base64) for the crypto round-trip tests.
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("crypto (AES-256-GCM)", () => {
  it("round-trips a secret", async () => {
    const secret = "cf-refresh-token-abc123";
    const enc = await encryptSecret(secret, KEY);
    expect(enc).not.toContain(secret);
    expect(await decryptSecret(enc, KEY)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const a = await encryptSecret("same", KEY);
    const b = await encryptSecret("same", KEY);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, KEY)).toBe("same");
    expect(await decryptSecret(b, KEY)).toBe("same");
  });

  it("fails to decrypt with the wrong key", async () => {
    const enc = await encryptSecret("secret", KEY);
    const otherKey = Buffer.alloc(32, 9).toString("base64");
    await expect(decryptSecret(enc, otherKey)).rejects.toThrow();
  });

  it("rejects a key that isn't 32 bytes", async () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    await expect(encryptSecret("x", shortKey)).rejects.toThrow(/32 bytes/);
  });

  it("throws when no key is configured", async () => {
    await expect(encryptSecret("x", undefined)).rejects.toThrow(/DNS_TOKEN_ENC_KEY/);
  });
});

describe("crypto key rotation (versioned ciphertext)", () => {
  const V1 = Buffer.alloc(32, 1).toString("base64");
  const V2 = Buffer.alloc(32, 2).toString("base64");
  // A keyring carrying both keys, encrypting new data under v2.
  const ring = { keys: { v1: V1, v2: V2 }, activeKeyId: "v2" };

  it("encrypts under the active key id (v2) and tags the ciphertext with it", async () => {
    const enc = await encryptSecret("token", ring);
    expect(enc.startsWith("v2.")).toBe(true);
    expect(keyIdOf(enc)).toBe("v2");
  });

  it("decrypts ciphertext written under either v1 or v2 while both keys are present", async () => {
    // v2 ciphertext from the active key.
    const encV2 = await encryptSecret("new-secret", ring);
    expect(await decryptSecret(encV2, ring)).toBe("new-secret");

    // v1 ciphertext, as written before the rotation, still decrypts via the keyring.
    const encV1 = await encryptSecret("old-secret", { keys: { v1: V1 }, activeKeyId: "v1" });
    expect(keyIdOf(encV1)).toBe("v1");
    expect(await decryptSecret(encV1, ring)).toBe("old-secret");
  });

  it("fails closed on an unknown key version (no key for that id)", async () => {
    const enc = await encryptSecret("secret", { keys: { v9: V1 }, activeKeyId: "v9" });
    // Keyring lacks v9 → must reject, never returning plaintext.
    await expect(decryptSecret(enc, ring)).rejects.toThrow(/no key for id "v9"/);
  });

  it("reads legacy (un-prefixed) ciphertext as key id v1", async () => {
    // Legacy payloads have no `<id>.` prefix; attribute them to v1.
    const enc = await encryptSecret("legacy", V1); // bare key → emits "v1." prefix
    const bare = enc.replace(/^v1\./, ""); // simulate pre-versioning storage
    expect(keyIdOf(bare)).toBe("v1");
    expect(await decryptSecret(bare, ring)).toBe("legacy");
  });

  it("re-encrypts v1 → v2 (the rotation step) and the result decrypts under v2", async () => {
    const encV1 = await encryptSecret("rotate-me", { keys: { v1: V1 }, activeKeyId: "v1" });
    const reEncrypted = await encryptSecret(await decryptSecret(encV1, ring), ring);
    expect(keyIdOf(reEncrypted)).toBe("v2");
    expect(await decryptSecret(reEncrypted, ring)).toBe("rotate-me");
  });
});

// ----------------------------------------------------------------------------

type MockCall = { url: string; method: string; body: unknown };

// Minimal Cloudflare API mock. Routes are matched in order; each returns the
// `result` wrapped in the standard envelope. Records the calls for assertions.
function mockCloudflare(
  routes: Array<{
    match: (call: MockCall) => boolean;
    result?: unknown;
    status?: number;
    errors?: { code: number; message: string }[];
  }>,
) {
  const calls: MockCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const call: MockCall = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const route = routes.find((r) => r.match(call));
    if (!route) throw new Error(`No mock route for ${call.method} ${call.url}`);
    const ok = (route.status ?? 200) < 400 && !route.errors;
    return {
      ok,
      status: route.status ?? 200,
      json: async () => ({
        success: ok,
        errors: route.errors ?? [],
        result: route.result ?? null,
      }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

const dkim: DnsRecord = {
  type: "CNAME",
  name: "abc._domainkey.updates.acme.com",
  value: "abc.dkim.amazonses.com",
  required: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("findZone", () => {
  it("returns the zone for the registrable root of a subdomain", async () => {
    const { calls } = mockCloudflare([
      { match: (c) => c.url.includes("/zones?"), result: [{ id: "zone1", name: "acme.com" }] },
    ]);
    const zone = await findZone("tok", "updates.acme.com");
    expect(zone).toEqual({ id: "zone1", name: "acme.com" });
    expect(calls[0].url).toContain("name=acme.com");
  });

  it("returns null when the domain isn't in the account", async () => {
    mockCloudflare([{ match: (c) => c.url.includes("/zones?"), result: [] }]);
    expect(await findZone("tok", "updates.notmine.com")).toBeNull();
  });

  it("throws CloudflareApiError on an API failure", async () => {
    mockCloudflare([
      {
        match: (c) => c.url.includes("/zones?"),
        status: 403,
        errors: [{ code: 9109, message: "Unauthorized" }],
      },
    ]);
    await expect(findZone("tok", "acme.com")).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe("upsertRecord (idempotent)", () => {
  it("creates the record when none exists, never proxied", async () => {
    const { calls } = mockCloudflare([
      { match: (c) => c.method === "GET", result: [] },
      { match: (c) => c.method === "POST", result: { id: "rec1" } },
    ]);
    const res = await upsertRecord("tok", "zone1", dkim);
    expect(res.action).toBe("created");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ proxied: false, content: dkim.value, type: "CNAME" });
  });

  it("skips when an identical record already exists", async () => {
    const { calls } = mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [
          { id: "rec1", type: "CNAME", name: dkim.name, content: dkim.value, proxied: false },
        ],
      },
    ]);
    const res = await upsertRecord("tok", "zone1", dkim);
    expect(res.action).toBe("skipped");
    expect(calls.every((c) => c.method === "GET")).toBe(true); // no write issued
  });

  it("patches when an existing record has different content", async () => {
    const { calls } = mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [
          { id: "rec1", type: "CNAME", name: dkim.name, content: "stale.example.com", proxied: false },
        ],
      },
      { match: (c) => c.method === "PATCH", result: { id: "rec1" } },
    ]);
    const res = await upsertRecord("tok", "zone1", dkim);
    expect(res.action).toBe("updated");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/dns_records/rec1");
    expect(patch?.body).toMatchObject({ proxied: false, content: dkim.value });
  });

  it("patches a record that exists but is proxied (orange cloud)", async () => {
    mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [{ id: "rec1", type: "CNAME", name: dkim.name, content: dkim.value, proxied: true }],
      },
      { match: (c) => c.method === "PATCH", result: { id: "rec1" } },
    ]);
    const res = await upsertRecord("tok", "zone1", dkim);
    expect(res.action).toBe("updated");
  });
});

const dmarc: DnsRecord = {
  type: "TXT",
  name: "_dmarc.updates.acme.com",
  value: "v=DMARC1; p=none;",
  required: false,
};

describe("upsertRecord — TXT records", () => {
  it("wraps TXT content in double quotes on create", async () => {
    const { calls } = mockCloudflare([
      { match: (c) => c.method === "GET", result: [] },
      { match: (c) => c.method === "POST", result: { id: "rec1" } },
    ]);
    const res = await upsertRecord("tok", "zone1", dmarc);
    expect(res.action).toBe("created");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ type: "TXT", content: '"v=DMARC1; p=none;"' });
  });

  it("skips when the existing TXT differs only by Cloudflare's added quotes", async () => {
    const { calls } = mockCloudflare([
      {
        match: (c) => c.method === "GET",
        // Cloudflare returns the quoted form even though we stored it unquoted.
        result: [{ id: "rec1", type: "TXT", name: dmarc.name, content: '"v=DMARC1; p=none;"' }],
      },
    ]);
    const res = await upsertRecord("tok", "zone1", dmarc);
    expect(res.action).toBe("skipped");
    expect(calls.every((c) => c.method === "GET")).toBe(true); // no needless rewrite
  });

  it("patches when the TXT content genuinely changed", async () => {
    mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [{ id: "rec1", type: "TXT", name: dmarc.name, content: '"v=DMARC1; p=reject;"' }],
      },
      { match: (c) => c.method === "PATCH", result: { id: "rec1" } },
    ]);
    const res = await upsertRecord("tok", "zone1", dmarc);
    expect(res.action).toBe("updated");
  });
});

const mx: DnsRecord = {
  type: "MX",
  name: "send.updates.acme.com",
  value: "feedback-smtp.eu-west-1.amazonses.com",
  priority: 10,
  required: false,
  group: "deliverability",
};

describe("upsertRecord — MX records", () => {
  it("creates an MX with its priority in the payload", async () => {
    const { calls } = mockCloudflare([
      { match: (c) => c.method === "GET", result: [] },
      { match: (c) => c.method === "POST", result: { id: "rec1" } },
    ]);
    const res = await upsertRecord("tok", "zone1", mx);
    expect(res.action).toBe("created");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ type: "MX", name: mx.name, content: mx.value, priority: 10 });
  });

  it("skips an identical MX (same host and priority)", async () => {
    const { calls } = mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [{ id: "rec1", type: "MX", name: mx.name, content: mx.value, priority: 10 }],
      },
    ]);
    const res = await upsertRecord("tok", "zone1", mx);
    expect(res.action).toBe("skipped");
    expect(calls.every((c) => c.method === "GET")).toBe(true); // no write issued
  });

  it("patches an MX whose host matches but priority is wrong", async () => {
    const { calls } = mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [{ id: "rec1", type: "MX", name: mx.name, content: mx.value, priority: 5 }],
      },
      { match: (c) => c.method === "PATCH", result: { id: "rec1" } },
    ]);
    const res = await upsertRecord("tok", "zone1", mx);
    expect(res.action).toBe("updated");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toMatchObject({ type: "MX", priority: 10 });
  });
});

describe("writeRecords", () => {

  it("isolates per-record failures and still writes the rest", async () => {
    mockCloudflare([
      // DKIM lookup → none, then create succeeds
      { match: (c) => c.method === "GET" && c.url.includes("CNAME"), result: [] },
      { match: (c) => c.method === "POST", result: { id: "rec1" } },
      // DMARC lookup fails
      {
        match: (c) => c.method === "GET" && c.url.includes("TXT"),
        status: 500,
        errors: [{ code: 1, message: "boom" }],
      },
    ]);
    const results = await writeRecords("tok", "zone1", [dkim, dmarc]);
    expect(results.map((r) => r.action)).toEqual(["created", "error"]);
    expect(results[1].error).toContain("boom");
  });
});

// A deliverability record shares its name with whatever the customer (or another
// email provider mid-migration) already publishes there, so upsertRecord must
// report rather than overwrite. The DKIM CNAMEs are ours alone and still patch.
describe("upsertRecord conflicts on deliverability records", () => {
  const returnPathMx: DnsRecord = {
    type: "MX",
    name: "send.updates.acme.com",
    value: "feedback-smtp.eu-north-1.amazonses.com",
    priority: 10,
    description: "Return-Path (MX)",
    required: false,
    group: "deliverability",
  };
  const dmarc: DnsRecord = {
    type: "TXT",
    name: "_dmarc.updates.acme.com",
    value: "v=DMARC1; p=none;",
    description: "DMARC (recommended)",
    required: false,
    group: "deliverability",
  };

  it("refuses to repoint another provider's Return-Path MX", async () => {
    const { calls } = mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [
          {
            id: "rec1",
            type: "MX",
            name: returnPathMx.name,
            content: "feedback-smtp.us-east-1.amazonses.com",
            priority: 10,
          },
        ],
      },
    ]);
    const res = await upsertRecord("tok", "zone1", returnPathMx);
    expect(res.action).toBe("conflict");
    expect(res.existing).toBe("10 feedback-smtp.us-east-1.amazonses.com");
    // The whole point: the zone is left untouched.
    expect(calls.some((c) => c.method === "PATCH" || c.method === "POST")).toBe(false);
  });

  it("refuses to downgrade a stricter existing DMARC policy", async () => {
    const { calls } = mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [
          {
            id: "rec2",
            type: "TXT",
            name: dmarc.name,
            content: '"v=DMARC1; p=reject; rua=mailto:dmarc@acme.com"',
          },
        ],
      },
    ]);
    const res = await upsertRecord("tok", "zone1", dmarc);
    expect(res.action).toBe("conflict");
    // Reported unquoted, the way it reads in a DNS panel.
    expect(res.existing).toBe("v=DMARC1; p=reject; rua=mailto:dmarc@acme.com");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("still creates a deliverability record when the name is free", async () => {
    mockCloudflare([
      { match: (c) => c.method === "GET", result: [] },
      { match: (c) => c.method === "POST", result: { id: "rec3" } },
    ]);
    expect((await upsertRecord("tok", "zone1", dmarc)).action).toBe("created");
  });

  it("still skips an identical deliverability record", async () => {
    mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [{ id: "rec4", type: "TXT", name: dmarc.name, content: `"${dmarc.value}"` }],
      },
    ]);
    expect((await upsertRecord("tok", "zone1", dmarc)).action).toBe("skipped");
  });

  it("still overwrites a differing DKIM CNAME, which is ours alone", async () => {
    const { calls } = mockCloudflare([
      {
        match: (c) => c.method === "GET",
        result: [
          { id: "rec5", type: "CNAME", name: dkim.name, content: "stale.dkim.amazonses.com", proxied: false },
        ],
      },
      { match: (c) => c.method === "PATCH", result: { id: "rec5" } },
    ]);
    expect((await upsertRecord("tok", "zone1", dkim)).action).toBe("updated");
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });
});

describe("buildAuthorizeUrl scope encoding", () => {
  const config = {
    clientId: "cid",
    clientSecret: "secret",
    tokenEndpoint: "https://dash.cloudflare.com/oauth2/token",
    authorizeEndpoint: "https://dash.cloudflare.com/oauth2/auth",
    revokeEndpoint: "https://dash.cloudflare.com/oauth2/revoke",
    userinfoEndpoint: "https://dash.cloudflare.com/oauth2/userinfo",
    redirectUri: "https://app.example/api/integrations/cloudflare/callback",
    scopes: "dns.write zone.read offline_access",
  };

  // A "+" here is read as a literal plus by any server that percent-decodes the
  // query without form-decoding it, collapsing three scopes into one unknown one.
  // Losing offline_access that way costs us the refresh token, and the connection
  // then dies at the first token expiry with no way back.
  it("percent-encodes the spaces between scopes rather than using '+'", () => {
    const url = buildAuthorizeUrl(config, { state: "st", codeChallenge: "ch" });
    const scope = url.match(/[?&]scope=([^&]*)/)?.[1];
    expect(scope).toBe("dns.write%20zone.read%20offline_access");
    expect(url).not.toContain("+");
  });

  it("round-trips to the exact space-delimited scope list a server should parse", () => {
    const url = buildAuthorizeUrl(config, { state: "st", codeChallenge: "ch" });
    expect(new URL(url).searchParams.get("scope")).toBe("dns.write zone.read offline_access");
  });

  it("omits scope entirely when none are configured", () => {
    const url = buildAuthorizeUrl({ ...config, scopes: "" }, { state: "st", codeChallenge: "ch" });
    expect(new URL(url).searchParams.has("scope")).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, decryptSecret } from "../src/lib/crypto";
import {
  findZone,
  upsertRecord,
  writeRecords,
  CloudflareApiError,
} from "../src/services/cloudflare-dns";
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

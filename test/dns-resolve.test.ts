import { afterEach, describe, expect, it, vi } from "vitest";
import { cnameResolves, requiredRecordsResolve } from "../src/services/dns-resolve";
import type { DnsRecord } from "../src/lib/types";

function mockDoh(answersByName: Record<string, string[]>, status = 0) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const name = new URL(url).searchParams.get("name") ?? "";
      const data = answersByName[name];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Status: status,
          Answer: data ? data.map((d) => ({ name, type: 5, data: d })) : undefined,
        }),
      } as Response;
    }),
  );
}

const dkim = (n: number): DnsRecord => ({
  type: "CNAME",
  name: `tok${n}._domainkey.updates.acme.com`,
  value: `tok${n}.dkim.amazonses.com`,
  required: true,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cnameResolves", () => {
  it("matches the expected target, ignoring trailing dot and case", async () => {
    mockDoh({ "x._domainkey.acme.com": ["X.DKIM.AMAZONSES.COM."] });
    expect(await cnameResolves("x._domainkey.acme.com", "x.dkim.amazonses.com")).toBe(true);
  });

  it("returns false when the record doesn't resolve yet", async () => {
    mockDoh({}, 3); // NXDOMAIN
    expect(await cnameResolves("missing.acme.com", "x.dkim.amazonses.com")).toBe(false);
  });

  it("returns false when the target differs", async () => {
    mockDoh({ "x._domainkey.acme.com": ["someone-else.example.com"] });
    expect(await cnameResolves("x._domainkey.acme.com", "x.dkim.amazonses.com")).toBe(false);
  });

  it("never throws on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await cnameResolves("x.acme.com", "y.dkim.amazonses.com")).toBe(false);
  });
});

describe("requiredRecordsResolve", () => {
  it("is true only when every required CNAME resolves", async () => {
    mockDoh({
      [dkim(1).name]: [dkim(1).value],
      [dkim(2).name]: [dkim(2).value],
      [dkim(3).name]: [dkim(3).value],
    });
    const dmarc: DnsRecord = { type: "TXT", name: "_dmarc.acme.com", value: "v=DMARC1;", required: false };
    expect(await requiredRecordsResolve([dkim(1), dkim(2), dkim(3), dmarc])).toBe(true);
  });

  it("is false when one required CNAME is still missing", async () => {
    mockDoh({ [dkim(1).name]: [dkim(1).value], [dkim(2).name]: [dkim(2).value] }); // dkim(3) missing
    expect(await requiredRecordsResolve([dkim(1), dkim(2), dkim(3)])).toBe(false);
  });

  it("is false when there are no required records to confirm", async () => {
    mockDoh({});
    const dmarc: DnsRecord = { type: "TXT", name: "_dmarc.acme.com", value: "v=DMARC1;", required: false };
    expect(await requiredRecordsResolve([dmarc])).toBe(false);
  });
});

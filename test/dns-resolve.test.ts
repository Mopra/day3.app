import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cnameResolves,
  txtResolves,
  mxResolves,
  resolveRecords,
  requiredRecordsResolve,
} from "../src/services/dns-resolve";
import type { DnsRecord } from "../src/lib/types";

// Mock DoH keyed by "<TYPE> <name>" so a name carrying both an MX and a TXT (the
// Return-Path) can return different answers per query type. A bare "<name>" key
// also works as a type-agnostic fallback.
function mockDoh(answers: Record<string, string[]>, status = 0) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      const name = u.searchParams.get("name") ?? "";
      const type = u.searchParams.get("type") ?? "";
      const data = answers[`${type} ${name}`] ?? answers[name];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Status: status,
          Answer: data ? data.map((d) => ({ name, type: 0, data: d })) : undefined,
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
  group: "verify",
});

const mx: DnsRecord = {
  type: "MX",
  name: "send.updates.acme.com",
  value: "feedback-smtp.eu-west-1.amazonses.com",
  priority: 10,
  required: false,
  group: "deliverability",
};

const spf: DnsRecord = {
  type: "TXT",
  name: "send.updates.acme.com",
  value: "v=spf1 include:amazonses.com ~all",
  required: false,
  group: "deliverability",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cnameResolves", () => {
  it("matches the expected target, ignoring trailing dot and case", async () => {
    mockDoh({ "CNAME x._domainkey.acme.com": ["X.DKIM.AMAZONSES.COM."] });
    expect(await cnameResolves("x._domainkey.acme.com", "x.dkim.amazonses.com")).toBe(true);
  });

  it("returns false when the record doesn't resolve yet", async () => {
    mockDoh({}, 3); // NXDOMAIN
    expect(await cnameResolves("missing.acme.com", "x.dkim.amazonses.com")).toBe(false);
  });

  it("returns false when the target differs", async () => {
    mockDoh({ "CNAME x._domainkey.acme.com": ["someone-else.example.com"] });
    expect(await cnameResolves("x._domainkey.acme.com", "x.dkim.amazonses.com")).toBe(false);
  });

  it("never throws on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await cnameResolves("x.acme.com", "y.dkim.amazonses.com")).toBe(false);
  });
});

describe("txtResolves", () => {
  it("matches an SPF record regardless of quoting and case", async () => {
    mockDoh({ "TXT send.updates.acme.com": ['"v=spf1 include:amazonses.com ~all"'] });
    expect(await txtResolves(spf.name, spf.value)).toBe(true);
  });

  it("matches an SPF record split into adjacent quoted chunks", async () => {
    mockDoh({ "TXT send.updates.acme.com": ['"v=spf1 " "include:amazonses.com ~all"'] });
    expect(await txtResolves(spf.name, spf.value)).toBe(true);
  });

  it("returns false when the SES include is missing", async () => {
    mockDoh({ "TXT send.updates.acme.com": ['"v=spf1 include:_spf.google.com ~all"'] });
    expect(await txtResolves(spf.name, spf.value)).toBe(false);
  });

  it("matches DMARC on the version tag even with a stricter policy", async () => {
    mockDoh({ "TXT _dmarc.acme.com": ['"v=DMARC1; p=reject; rua=mailto:x@acme.com"'] });
    expect(await txtResolves("_dmarc.acme.com", "v=DMARC1; p=none;")).toBe(true);
  });

  it("never throws on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await txtResolves(spf.name, spf.value)).toBe(false);
  });
});

describe("mxResolves", () => {
  it("matches the expected MX host, ignoring priority, trailing dot, and case", async () => {
    mockDoh({ "MX send.updates.acme.com": ["10 FEEDBACK-SMTP.EU-WEST-1.AMAZONSES.COM."] });
    expect(await mxResolves(mx.name, mx.value)).toBe(true);
  });

  it("returns false when the MX host differs", async () => {
    mockDoh({ "MX send.updates.acme.com": ["10 mail.someoneelse.com."] });
    expect(await mxResolves(mx.name, mx.value)).toBe(false);
  });

  it("returns false when nothing resolves yet", async () => {
    mockDoh({});
    expect(await mxResolves(mx.name, mx.value)).toBe(false);
  });
});

describe("resolveRecords", () => {
  it("reports per-record status; requiredResolved covers the verify group only", async () => {
    // All DKIM live; Return-Path MX/SPF not yet.
    mockDoh({
      [`CNAME ${dkim(1).name}`]: [dkim(1).value],
      [`CNAME ${dkim(2).name}`]: [dkim(2).value],
      [`CNAME ${dkim(3).name}`]: [dkim(3).value],
    });
    const res = await resolveRecords([dkim(1), dkim(2), dkim(3), mx, spf]);
    expect(res.requiredResolved).toBe(true); // DKIM complete despite pending deliverability
    const byKey = Object.fromEntries(res.records.map((r) => [`${r.type}:${r.name}`, r.resolved]));
    expect(byKey[`CNAME:${dkim(1).name}`]).toBe(true);
    expect(byKey["MX:send.updates.acme.com"]).toBe(false);
    expect(byKey["TXT:send.updates.acme.com"]).toBe(false);
  });

  it("requiredResolved is false when a DKIM record is still missing", async () => {
    mockDoh({
      [`CNAME ${dkim(1).name}`]: [dkim(1).value],
      [`CNAME ${dkim(2).name}`]: [dkim(2).value],
      // dkim(3) missing
    });
    const res = await resolveRecords([dkim(1), dkim(2), dkim(3)]);
    expect(res.requiredResolved).toBe(false);
  });

  it("requiredResolved is false when there are no verify records", async () => {
    mockDoh({});
    const res = await resolveRecords([mx, spf]);
    expect(res.requiredResolved).toBe(false);
    expect(res.records).toHaveLength(2);
  });
});

describe("requiredRecordsResolve", () => {
  it("is true only when every verify record resolves (deliverability ignored)", async () => {
    mockDoh({
      [`CNAME ${dkim(1).name}`]: [dkim(1).value],
      [`CNAME ${dkim(2).name}`]: [dkim(2).value],
      [`CNAME ${dkim(3).name}`]: [dkim(3).value],
    });
    expect(await requiredRecordsResolve([dkim(1), dkim(2), dkim(3), spf])).toBe(true);
  });

  it("is false when one verify record is still missing", async () => {
    mockDoh({
      [`CNAME ${dkim(1).name}`]: [dkim(1).value],
      [`CNAME ${dkim(2).name}`]: [dkim(2).value],
    });
    expect(await requiredRecordsResolve([dkim(1), dkim(2), dkim(3)])).toBe(false);
  });
});

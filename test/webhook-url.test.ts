import { describe, expect, it } from "vitest";
import { isPublicAddress, validateWebhookUrl } from "../src/lib/webhook-url";

// This is the SSRF boundary. A miss here turns the webhook sender into a way to
// read cloud instance credentials or reach Redis from the open internet, so the
// blocklist gets tested range by range rather than by spot check.
describe("webhook URL validation", () => {
  it("accepts a normal https endpoint, on 443 or 8443, with path and query", () => {
    expect(validateWebhookUrl("https://api.example.com/hooks/day3?v=1")).toMatchObject({ ok: true });
    expect(validateWebhookUrl("https://api.example.com:8443/hooks")).toMatchObject({ ok: true });
    // Trailing whitespace and a trailing dot on the host are normalized, not rejected.
    expect(validateWebhookUrl("  https://api.example.com/hooks  ")).toMatchObject({ ok: true });
  });

  it("requires https", () => {
    expect(validateWebhookUrl("http://api.example.com/hooks")).toMatchObject({
      ok: false,
      reason: "scheme_not_https",
    });
    for (const raw of ["file:///etc/passwd", "gopher://x", "ftp://example.com"]) {
      expect(validateWebhookUrl(raw).ok).toBe(false);
    }
  });

  it("rejects credentials in the URL", () => {
    expect(validateWebhookUrl("https://user:pw@api.example.com/h")).toMatchObject({
      ok: false,
      reason: "credentials_in_url",
    });
  });

  it("rejects ports other than 443/8443 (no internal port scanning)", () => {
    for (const port of [22, 80, 6379, 5432, 9200]) {
      expect(validateWebhookUrl(`https://api.example.com:${port}/h`)).toMatchObject({
        ok: false,
        reason: "port_not_allowed",
      });
    }
  });

  it("rejects loopback, private, link-local and internal-looking hostnames", () => {
    const blocked = [
      "https://localhost/h",
      "https://LOCALHOST/h",
      "https://db.local/h",
      "https://api.internal/h",
      "https://metadata.google.internal/h",
      "https://redis/h", // single-label container name
      "https://127.0.0.1/h",
      "https://10.0.0.5/h",
      "https://172.16.5.5/h",
      "https://172.31.255.255/h",
      "https://192.168.1.1/h",
      "https://169.254.169.254/latest/meta-data/", // the one that matters most
      "https://100.64.0.1/h", // CGNAT
      "https://0.0.0.0/h",
      "https://255.255.255.255/h",
      "https://[::1]/h",
      "https://[fd00::1]/h", // unique-local
      "https://[fe80::1]/h", // link-local
    ];
    for (const raw of blocked) {
      expect(validateWebhookUrl(raw), raw).toMatchObject({ ok: false });
    }
  });

  it("rejects IPv4 wrapped in IPv6 — the classic blocklist bypass", () => {
    // ::ffff:169.254.169.254 and its hex spelling are the same destination as
    // the bare IPv4 address; both must be classified as IPv4 and blocked.
    expect(isPublicAddress("::ffff:169.254.169.254", 6)).toBe(false);
    expect(isPublicAddress("::ffff:a9fe:a9fe", 6)).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1", 6)).toBe(false);
    expect(isPublicAddress("64:ff9b::169.254.169.254", 6)).toBe(false); // NAT64
    // …while a wrapped public address stays allowed.
    expect(isPublicAddress("::ffff:8.8.8.8", 6)).toBe(true);
  });

  it("classifies public addresses as public", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1"]) {
      expect(isPublicAddress(a, 4), a).toBe(true);
    }
    expect(isPublicAddress("2606:4700::1111", 6)).toBe(true);
  });

  it("fails closed on anything it cannot parse", () => {
    for (const a of ["", "999.1.1.1", "1.2.3", "010.0.0.1", "not-an-ip", "1.2.3.4.5"]) {
      expect(isPublicAddress(a, 4), a).toBe(false);
    }
    for (const a of ["", "gg::1", "1:2:3::4::5", "zzzz"]) {
      expect(isPublicAddress(a, 6), a).toBe(false);
    }
  });
});

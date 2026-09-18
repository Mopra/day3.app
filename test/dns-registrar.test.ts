import { describe, expect, it } from "vitest";
import { guideForNameservers } from "../src/services/dns-registrar";

// Nameserver detection is advisory: a hit shortcuts the "find your DNS host"
// step that most often stalls a non-technical user, and a miss simply falls back
// to the full provider list. So the bar here is that a hit is never WRONG:
// sending someone to the wrong registrar's instructions is worse than none.
describe("guideForNameservers", () => {
  it("identifies the common hosts", () => {
    expect(guideForNameservers(["ns1.domaincontrol.com", "ns2.domaincontrol.com"])?.key).toBe(
      "godaddy",
    );
    expect(guideForNameservers(["dns1.registrar-servers.com"])?.key).toBe("namecheap");
    expect(guideForNameservers(["kate.ns.cloudflare.com", "rob.ns.cloudflare.com"])?.key).toBe(
      "cloudflare",
    );
    expect(guideForNameservers(["ns-1234.awsdns-56.org"])?.key).toBe("route53");
    expect(guideForNameservers(["ns1.digitalocean.com"])?.key).toBe("digitalocean");
    expect(guideForNameservers(["ns1.vercel-dns.com"])?.key).toBe("vercel");
  });

  it("returns null for an unknown or empty nameserver set", () => {
    expect(guideForNameservers([])).toBeNull();
    expect(guideForNameservers(["ns1.some-tiny-host.example"])).toBeNull();
  });

  it("is case and trailing-dot insensitive at the caller's normalization", () => {
    // detectRegistrar lowercases and strips the trailing dot before matching;
    // this asserts the matcher itself accepts that normalized form.
    expect(guideForNameservers(["ns1.domaincontrol.com"])?.name).toBe("GoDaddy");
  });
});

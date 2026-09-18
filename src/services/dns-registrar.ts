// Who hosts this domain's DNS, guessed from its nameservers.
//
// The setup guide already shows a list of four registrar guides and lets the user
// find their own. That is a small ask for someone technical and a real one for
// everybody else: the most common way the DNS step stalls is a person who does
// not know where their records live, staring at a list that does not name their
// provider.
//
// A nameserver lookup answers it outright. `ns1.digitalocean.com` means DigitalOcean
// and nothing else, so one DoH query turns "find your DNS host" into "here is
// yours, with the instructions". It is advisory only: an unrecognized (or
// unreachable) nameserver returns null and the guide falls back to the full list,
// exactly as before.
//
// Detection is on the REGISTRABLE ROOT, not the sending subdomain: nameservers
// are delegated at the zone apex, so asking about `mail.example.com` usually
// returns nothing.

const DOH_URL = "https://cloudflare-dns.com/dns-query";

export type RegistrarGuide = {
  /** Stable key, for tests and telemetry. */
  key: string;
  /** What the user calls them. */
  name: string;
  /** Their own documentation for adding a CNAME. */
  href: string;
};

// Matched as suffixes of the nameserver hostname, longest first, so a more
// specific host wins over a generic one it happens to end with. Only providers
// whose nameservers are unambiguous are listed: a wrong guess sends someone to
// the wrong instructions, which is worse than no guess.
const NAMESERVER_MAP: { suffix: string; guide: RegistrarGuide }[] = [
  {
    suffix: "domaincontrol.com",
    guide: {
      key: "godaddy",
      name: "GoDaddy",
      href: "https://www.godaddy.com/help/add-a-cname-record-19236",
    },
  },
  {
    suffix: "registrar-servers.com",
    guide: {
      key: "namecheap",
      name: "Namecheap",
      href: "https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-to-create-a-cname-record-for-your-domain/",
    },
  },
  {
    suffix: "ns.cloudflare.com",
    guide: {
      key: "cloudflare",
      name: "Cloudflare",
      href: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/",
    },
  },
  {
    suffix: "googledomains.com",
    guide: {
      key: "squarespace",
      name: "Squarespace (formerly Google Domains)",
      href: "https://support.google.com/domains/answer/3290350",
    },
  },
  {
    suffix: "squarespacedns.com",
    guide: {
      key: "squarespace",
      name: "Squarespace",
      href: "https://support.squarespace.com/hc/en-us/articles/360002101888",
    },
  },
  {
    suffix: "awsdns",
    guide: {
      key: "route53",
      name: "AWS Route 53",
      href: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html",
    },
  },
  {
    suffix: "digitalocean.com",
    guide: {
      key: "digitalocean",
      name: "DigitalOcean",
      href: "https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/",
    },
  },
  {
    suffix: "vercel-dns.com",
    guide: {
      key: "vercel",
      name: "Vercel",
      href: "https://vercel.com/docs/projects/domains/working-with-dns",
    },
  },
  {
    suffix: "netlify.com",
    guide: {
      key: "netlify",
      name: "Netlify",
      href: "https://docs.netlify.com/domains-https/netlify-dns/dns-records/",
    },
  },
  {
    suffix: "wixdns.net",
    guide: {
      key: "wix",
      name: "Wix",
      href: "https://support.wix.com/en/article/adding-or-updating-cname-records-in-your-wix-account",
    },
  },
  {
    suffix: "shopify.com",
    guide: {
      key: "shopify",
      name: "Shopify",
      href: "https://help.shopify.com/en/manual/domains/add-a-domain/connecting-domains/connect-subdomain",
    },
  },
  {
    suffix: "one.com",
    guide: {
      key: "onecom",
      name: "one.com",
      href: "https://help.one.com/hc/en-us/articles/360000799298",
    },
  },
  {
    suffix: "simply.com",
    guide: {
      key: "simply",
      name: "Simply.com",
      href: "https://www.simply.com/en/docs/dns/",
    },
  },
  {
    suffix: "hostinger.com",
    guide: {
      key: "hostinger",
      name: "Hostinger",
      href: "https://support.hostinger.com/en/articles/1583227-how-to-add-a-cname-record",
    },
  },
  {
    suffix: "ionos.com",
    guide: {
      key: "ionos",
      name: "IONOS",
      href: "https://www.ionos.com/help/domains/configuring-cname-records/",
    },
  },
].sort((a, b) => b.suffix.length - a.suffix.length);

type DohAnswer = { name: string; type: number; data: string };
type DohResponse = { Status: number; Answer?: DohAnswer[] };

/** The domain's NS hostnames, lowercased and de-dotted. [] on any failure. */
async function nameservers(root: string): Promise<string[]> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(root)}&type=NS`;
    const res = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!res.ok) return [];
    const body = (await res.json()) as DohResponse;
    if (body.Status !== 0 || !body.Answer?.length) return [];
    return body.Answer.map((a) => a.data.trim().replace(/\.$/, "").toLowerCase());
  } catch {
    return [];
  }
}

/** Match a nameserver hostname to a known provider. Exported for tests. */
export function guideForNameservers(hosts: readonly string[]): RegistrarGuide | null {
  for (const { suffix, guide } of NAMESERVER_MAP) {
    if (hosts.some((h) => h === suffix || h.endsWith(`.${suffix}`) || h.includes(suffix))) {
      return guide;
    }
  }
  return null;
}

/**
 * Best guess at where this domain's DNS records must be added.
 *
 * Never throws and never blocks anything: a null result just means the guide
 * shows its full list of providers, which is what it did before this existed.
 */
export async function detectRegistrar(registrableRoot: string): Promise<RegistrarGuide | null> {
  if (!registrableRoot.trim()) return null;
  const hosts = await nameservers(registrableRoot);
  if (hosts.length === 0) return null;
  return guideForNameservers(hosts);
}

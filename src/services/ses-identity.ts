import {
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";

// The DNS records a customer adds at their own DNS host to verify a sending
// domain. For Easy DKIM these are 3 required CNAMEs; a DMARC TXT is recommended
// (it improves deliverability but isn't needed for verification).
export type DnsRecord = {
  type: "CNAME" | "TXT" | "MX";
  name: string;
  value: string;
  // Shown to the user as a short label, e.g. "DKIM" or "DMARC (recommended)".
  description?: string;
  // false ⇒ recommended-but-optional (does not block verification).
  required: boolean;
};

export type DomainIdentityState = {
  verified: boolean;
  // verification_status / dkim_status values the DB stores.
  verificationStatus: "pending" | "verified" | "failed";
  dkimStatus: string;
  records: DnsRecord[];
};

function client(region: string): SESv2Client {
  return new SESv2Client({ region });
}

// Easy DKIM CNAMEs: <token>._domainkey.<domain> → <token>.dkim.amazonses.com
function dkimRecords(domain: string, tokens: string[]): DnsRecord[] {
  return tokens.map((token) => ({
    type: "CNAME" as const,
    name: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
    description: "DKIM",
    required: true,
  }));
}

// Recommended DMARC policy for the sending domain. p=none only monitors, so it's
// safe to publish and improves inbox placement without risking legitimate mail.
function dmarcRecord(domain: string): DnsRecord {
  return {
    type: "TXT",
    name: `_dmarc.${domain}`,
    value: "v=DMARC1; p=none;",
    description: "DMARC (recommended)",
    required: false,
  };
}

function toState(
  verified: boolean | undefined,
  dkimStatus: string | undefined,
  domain: string,
  tokens: string[] | undefined,
): DomainIdentityState {
  const dkim = (dkimStatus ?? "PENDING").toUpperCase();
  const dkimCnames = dkimRecords(domain, tokens ?? []);
  return {
    verified: !!verified,
    verificationStatus: verified ? "verified" : dkim === "FAILED" ? "failed" : "pending",
    dkimStatus: dkim.toLowerCase(),
    // Only surface records once SES has issued DKIM tokens; an empty array means
    // "not configured yet" to the UI.
    records: dkimCnames.length ? [...dkimCnames, dmarcRecord(domain)] : [],
  };
}

// Add a domain to SES (Easy DKIM). Returns the DKIM CNAMEs to display. If the
// identity already exists in the AWS account, falls back to reading its state.
export async function createDomainIdentity(
  domain: string,
  region: string,
  configurationSet?: string,
): Promise<DomainIdentityState> {
  const c = client(region);
  try {
    const res = await c.send(
      new CreateEmailIdentityCommand({
        EmailIdentity: domain,
        DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
        ConfigurationSetName: configurationSet,
      }),
    );
    return toState(res.VerifiedForSendingStatus, res.DkimAttributes?.Status, domain, res.DkimAttributes?.Tokens);
  } catch (err) {
    if (typeof err === "object" && err !== null && "name" in err && err.name === "AlreadyExistsException") {
      return getDomainIdentity(domain, region);
    }
    throw err;
  }
}

// Re-check verification with SES. `verified` ⇔ VerifiedForSendingStatus is true.
export async function getDomainIdentity(
  domain: string,
  region: string,
): Promise<DomainIdentityState> {
  const c = client(region);
  const res = await c.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  return toState(
    res.VerifiedForSendingStatus,
    res.DkimAttributes?.Status,
    domain,
    res.DkimAttributes?.Tokens,
  );
}

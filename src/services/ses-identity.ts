import {
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";

// The DNS records a customer adds at their own DNS host to verify a sending
// domain. For Easy DKIM these are 3 required CNAMEs; a custom Return-Path
// (MX + SPF TXT) and a DMARC TXT are recommended (they improve deliverability
// but aren't needed for verification). Mirrors the client shape in lib/types.ts
// — keep the two in lockstep.
export type DnsRecord = {
  type: "CNAME" | "TXT" | "MX";
  name: string;
  value: string;
  // Shown to the user as a short label, e.g. "DKIM" or "Return-Path (SPF)".
  description?: string;
  // false ⇒ recommended-but-optional (does not block verification).
  required: boolean;
  // MX records carry a priority (e.g. 10); omitted for CNAME/TXT.
  priority?: number;
  // "verify" (DKIM) gates the domain's verified state; "deliverability"
  // (Return-Path MX/SPF + DMARC) is optional polish. Defaults to "verify".
  group?: "verify" | "deliverability";
};

export type DomainIdentityState = {
  verified: boolean;
  // verification_status / dkim_status values the DB stores.
  verificationStatus: "pending" | "verified" | "failed";
  dkimStatus: string;
  // The custom Return-Path subdomain (send.<domain>) and SES's status for it.
  // Deliverability-only: never affects verificationStatus.
  mailFromDomain: string;
  mailFromStatus: string;
  records: DnsRecord[];
};

// Structural subset of the SES GetEmailIdentity response we read — avoids
// coupling toState() to the exact SDK output type.
type IdentityResponse = {
  VerifiedForSendingStatus?: boolean;
  DkimAttributes?: { Status?: string; Tokens?: string[] };
  MailFromAttributes?: { MailFromDomain?: string; MailFromDomainStatus?: string };
};

function client(region: string): SESv2Client {
  return new SESv2Client({ region });
}

// The custom MAIL FROM (Return-Path) subdomain SES sends bounces from. Must be a
// subdomain of the verified identity (SES requirement); `send.` matches the
// convention customers see at other providers.
function mailFromDomainFor(domain: string): string {
  return `send.${domain}`;
}

// Easy DKIM CNAMEs: <token>._domainkey.<domain> → <token>.dkim.amazonses.com
function dkimRecords(domain: string, tokens: string[]): DnsRecord[] {
  return tokens.map((token) => ({
    type: "CNAME" as const,
    name: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
    description: "DKIM",
    required: true,
    group: "verify" as const,
  }));
}

// Custom Return-Path records: an MX pointing at the region's feedback endpoint
// and an SPF TXT authorizing SES. Together they give SPF/DMARC alignment. The MX
// target is region-specific. Optional — sending falls back to amazonses.com
// (BehaviorOnMxFailure=USE_DEFAULT_VALUE) until these propagate.
function mailFromRecords(domain: string, region: string): DnsRecord[] {
  const mailFrom = mailFromDomainFor(domain);
  return [
    {
      type: "MX",
      name: mailFrom,
      value: `feedback-smtp.${region}.amazonses.com`,
      priority: 10,
      description: "Return-Path (MX)",
      required: false,
      group: "deliverability",
    },
    {
      type: "TXT",
      name: mailFrom,
      value: "v=spf1 include:amazonses.com ~all",
      description: "Return-Path (SPF)",
      required: false,
      group: "deliverability",
    },
  ];
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
    group: "deliverability",
  };
}

function toState(res: IdentityResponse, domain: string, region: string): DomainIdentityState {
  const verified = !!res.VerifiedForSendingStatus;
  const dkim = (res.DkimAttributes?.Status ?? "PENDING").toUpperCase();
  const dkimCnames = dkimRecords(domain, res.DkimAttributes?.Tokens ?? []);
  // SES omits MailFromAttributes entirely until a custom MAIL FROM is set; treat
  // that as our own "not_started" sentinel so /check knows to back-fill it.
  const mailFromStatus = res.MailFromAttributes?.MailFromDomain
    ? (res.MailFromAttributes.MailFromDomainStatus ?? "PENDING").toLowerCase()
    : "not_started";
  return {
    verified,
    verificationStatus: verified ? "verified" : dkim === "FAILED" ? "failed" : "pending",
    dkimStatus: dkim.toLowerCase(),
    mailFromDomain: mailFromDomainFor(domain),
    mailFromStatus,
    // Only surface records once SES has issued DKIM tokens; an empty array means
    // "not configured yet" to the UI.
    records: dkimCnames.length
      ? [...dkimCnames, ...mailFromRecords(domain, region), dmarcRecord(domain)]
      : [],
  };
}

// Point SES at our custom Return-Path subdomain. Idempotent (safe to re-send).
// USE_DEFAULT_VALUE ⇒ if the MX isn't live yet, SES falls back to amazonses.com
// instead of failing the send.
export async function ensureMailFrom(domain: string, region: string): Promise<void> {
  const c = client(region);
  await c.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: domain,
      MailFromDomain: mailFromDomainFor(domain),
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    }),
  );
}

// Add a domain to SES (Easy DKIM) and configure its custom Return-Path. Returns
// the full record set (DKIM CNAMEs + Return-Path MX/SPF + DMARC) to display. If
// the identity already exists in the AWS account, falls back to reading it. The
// MAIL FROM step is best-effort — it must never block DKIM-based verification.
export async function createDomainIdentity(
  domain: string,
  region: string,
  configurationSet?: string,
): Promise<DomainIdentityState> {
  const c = client(region);
  try {
    await c.send(
      new CreateEmailIdentityCommand({
        EmailIdentity: domain,
        DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
        ConfigurationSetName: configurationSet,
      }),
    );
  } catch (err) {
    if (!(typeof err === "object" && err !== null && "name" in err && err.name === "AlreadyExistsException")) {
      throw err;
    }
    // Identity already exists — fall through to (re)set MAIL FROM and read state.
  }
  try {
    await ensureMailFrom(domain, region);
  } catch (err) {
    console.error("[ses] PutEmailIdentityMailFromAttributes failed:", err);
  }
  return getDomainIdentity(domain, region);
}

// Re-check verification with SES. `verified` ⇔ VerifiedForSendingStatus is true.
export async function getDomainIdentity(
  domain: string,
  region: string,
): Promise<DomainIdentityState> {
  const c = client(region);
  const res = await c.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  return toState(res, domain, region);
}

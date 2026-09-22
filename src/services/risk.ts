import { logger } from "../lib/logger";
import { aiReviewCampaign, type AiRiskVerdict } from "./risk-ai";

export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type CampaignRiskReview = {
  riskLevel: RiskLevel;
  riskScore: number;
  categories: string[];
  summary: string;
  // User-facing fix-it steps ("Replace the bit.ly link with the full URL"),
  // shown on the campaign page when the review flags or blocks the send.
  guidance: string[];
  recommendedAction: "approve" | "manual_review" | "block";
  // Set when the AI pass ran; persisted to risk_reviews.raw_response_json so
  // admins can see the model's verdict alongside the deterministic one.
  ai?: AiRiskVerdict | null;
  // Set when the AI pass was attempted but failed — the review fails open to
  // the deterministic result rather than wedging the campaign.
  aiError?: string;
};

export type RiskCheckInput = {
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  fromEmail: string;
  /**
   * The From display name ("HotDoc" in `HotDoc <news@example.com>`). Optional
   * because campaigns always have one and the API's `from` may be a bare
   * address. It is the single most load-bearing field for brand impersonation:
   * the display name is what a recipient actually reads, and a phishing run
   * puts the impersonated brand there while the address stays on a domain the
   * attacker controls.
   */
  fromName?: string | null;
  sendingDomain: string;
};

type Signal = {
  category: string;
  score: number;
  description: string;
  // The user-facing fix for this signal — concrete and friendly, addressed to
  // the sender. Every fired signal contributes its fix to `guidance`.
  fix: string;
  test: (input: RiskCheckInput, lowered: string) => boolean;
};

const URL_SHORTENERS = [
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
];

function wordsPresent(text: string, words: string[], min = 1): boolean {
  let hits = 0;
  for (const w of words) {
    if (text.includes(w)) hits++;
    if (hits >= min) return true;
  }
  return false;
}

export function extractLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) links.push(m[1]);
  return links;
}

/**
 * Every `src=` in the HTML — images, which is where a lifted template's
 * original tracking pixel survives.
 */
export function extractImageSources(html: string): string[] {
  const out: string[] = [];
  const re = /<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/**
 * Hostname of an absolute http(s) URL, lowercased; null for anything else
 * (relative URLs, `cid:`, `data:`, `mailto:`, junk).
 */
export function urlHost(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

// Second-level suffixes where the registrable name is the THIRD label from the
// right (hotdoc.com.au, bbc.co.uk). Not a full public-suffix list — this only
// needs to find the brand word a recipient would recognise, and being wrong on
// an exotic TLD costs at most one missed or one extra signal.
const MULTIPART_SUFFIXES = new Set([
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.uk", "org.uk", "me.uk",
  "co.nz", "co.za", "co.jp", "co.in", "co.kr", "com.br", "com.mx", "com.ar",
  "com.sg", "com.hk", "com.tw", "com.cn", "com.tr", "com.pl",
]);

/**
 * The brand label of a hostname: "hotdoc" from `www.hotdoc.com.au`, "westpac"
 * from `westpac.com.au`. This is the word a recipient reads as "who is this
 * from", which is exactly what impersonation borrows and what the sending
 * domain has to be compared against.
 */
export function brandLabel(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const lastTwo = parts.slice(-2).join(".");
  const idx = MULTIPART_SUFFIXES.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  return parts[Math.max(0, idx)] ?? "";
}

// Landing-page hosts anyone can spin up in minutes under someone else's brand
// name. Legitimate mail does use them, so this stays a supporting signal (low
// score) that only becomes decisive next to credential-harvest language.
const DISPOSABLE_CTA_HOSTS = [
  "myclickfunnels.com", "clickfunnels.com", "systeme.io", "kartra.com",
  "wixsite.com", "weebly.com", "webflow.io", "carrd.co", "glitch.me",
  "firebaseapp.com", "web.app", "vercel.app", "netlify.app", "pages.dev",
  "github.io", "replit.app", "onrender.com", "ngrok-free.app", "trycloudflare.com",
  "forms.gle", "typeform.com", "jotform.com", "notion.site",
];

// Open/click-tracking hosts belonging to OTHER email providers. Mail sent
// through Day3 has no reason to carry a competitor's tracking pixel: its
// presence means the HTML was copied out of a real email somebody received.
// Next to a brand in the From name that is the signature of a lifted template,
// which is how nearly every credential-phishing run is built.
const FOREIGN_ESP_TRACKING_HOSTS = [
  "ct.sendgrid.net", "sendgrid.net", "list-manage.com", "mcusercontent.com",
  "hubspotemail.net", "hs-sites.com", "mailgun.org", "sparkpostmail.com",
  "createsend.com", "cmail19.com", "cmail20.com", "klaviyomail.com",
  "rs6.net", "constantcontact.com", "exct.net", "mktdns.com", "mandrillapp.com",
  "sendinblue.com", "brevo.com", "postmarkapp.com", "customeriomail.com",
];

function hostMatches(host: string, needles: string[]): boolean {
  return needles.some((n) => host === n || host.endsWith("." + n));
}

/** Every absolute-URL host referenced by the email, links and images alike. */
function referencedHosts(html: string): string[] {
  const hosts: string[] = [];
  for (const raw of [...extractLinks(html), ...extractImageSources(html)]) {
    const host = urlHost(raw);
    if (host) hosts.push(host);
  }
  return hosts;
}

// Words in a From display name carrying no brand meaning, so they can never be
// what makes a name "match" a linked domain.
const GENERIC_NAME_WORDS = new Set([
  "the", "team", "news", "newsletter", "info", "support", "hello", "mail",
  "email", "reply", "noreply", "notifications", "account", "accounts",
  "service", "services", "customer", "care", "help", "alerts", "billing",
  "updates", "update", "group", "inc", "ltd", "llc", "gmbh", "and",
]);

/**
 * Brand-ish tokens in a From display name: "HotDoc" gives ["hotdoc"]; "Banque
 * Nationale du Canada" gives ["banque","nationale","canada"] plus the joined
 * "banquenationaleducanada". Generic words are dropped so "News" or "Support"
 * can never be what matches a domain.
 */
export function nameTokens(fromName: string | null | undefined): string[] {
  if (!fromName) return [];
  const cleaned = fromName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!cleaned) return [];
  const words = cleaned.split(" ").filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  const joined = cleaned.replace(/ /g, "");
  const out = new Set(words);
  if (joined.length >= 3) out.add(joined);
  return [...out];
}

/**
 * The impersonation test, shared by the signal and the combination rule below.
 *
 * Fires when the From display name names a brand whose own domain the email
 * links to, while the mail is authenticated by a DIFFERENT domain. That is
 * exactly the shape of `HotDoc <news@globalcitiys.com>` linking to
 * hotdoc.com.au: the recipient reads HotDoc, the brand's real site is right
 * there to make it look legitimate, and none of it is on the domain that signed
 * the message.
 *
 * A real brand mailing from its own domain never trips this, because its
 * sending domain shares the matched label.
 */
export function impersonatedBrand(input: RiskCheckInput): string | null {
  const tokens = nameTokens(input.fromName);
  if (tokens.length === 0) return null;
  const sendingLabel = brandLabel(input.sendingDomain.toLowerCase());
  for (const host of referencedHosts(input.htmlBody)) {
    const label = brandLabel(host);
    if (!label || label.length < 3) continue;
    if (label === sendingLabel) continue;
    if (tokens.includes(label)) return host;
  }
  return null;
}

const SIGNALS: Signal[] = [
  {
    category: "prohibited_industry",
    score: 60,
    description: "Crypto/investment terms",
    fix: "Remove the cryptocurrency/investment promotion — crypto and investment offers are a prohibited category Day3 can't deliver mail for.",
    test: (_i, t) =>
      wordsPresent(t, ["crypto", "bitcoin", "ethereum", "token sale", "ico ", "airdrop", "web3 investment"], 1),
  },
  {
    category: "prohibited_industry",
    score: 60,
    description: "Gambling terms",
    fix: "Remove the gambling content — gambling promotion is a prohibited category Day3 can't deliver mail for.",
    test: (_i, t) => wordsPresent(t, ["casino", "betting", "poker", "jackpot", "slots", "sportsbook"], 1),
  },
  {
    category: "prohibited_industry",
    score: 80,
    description: "Adult content terms",
    fix: "Remove the adult content — it's a prohibited category Day3 can't deliver mail for.",
    test: (_i, t) => wordsPresent(t, ["adult content", "xxx", "porn", "onlyfans", "escort"], 1),
  },
  {
    category: "cold_outreach",
    score: 40,
    description: "Cold outreach language",
    fix: "Rewrite cold-outreach phrasing like “I came across your…” — Day3 is for newsletters to people who signed up, and cold-outreach mail gets marked as spam, which damages your sender reputation.",
    test: (_i, t) =>
      wordsPresent(
        t,
        ["i came across your", "reaching out cold", "we've never met", "found your email", "quick question for you"],
        1,
      ),
  },
  {
    category: "purchased_list_suspected",
    score: 50,
    description: "Purchased/scraped list language",
    fix: "Remove references to purchased or scraped contact lists, and only email people who explicitly opted in — bought lists generate bounces and spam complaints that hurt every future send.",
    test: (_i, t) =>
      wordsPresent(t, ["purchased list", "bought this list", "scraped", "verified leads", "email database"], 1),
  },
  {
    category: "aggressive_sales",
    score: 25,
    description: "Suspicious urgency",
    fix: "Tone down the urgency (“act now”, “expires tonight”, “last chance”) — pressure language is a classic spam-filter trigger.",
    test: (_i, t) =>
      wordsPresent(t, ["act now", "limited time only", "expires tonight", "last chance", "urgent action required"], 2),
  },
  {
    category: "link_mismatch",
    score: 30,
    description: "URL shorteners present",
    fix: "Replace shortened links (bit.ly, tinyurl, …) with the full destination URL — spam filters can't see where short links lead and often junk the email because of them.",
    test: (i) => extractLinks(i.htmlBody).some((l) => URL_SHORTENERS.some((s) => l.includes(s))),
  },
  {
    category: "aggressive_sales",
    score: 20,
    description: "Too many links",
    fix: "Reduce the number of links — this email has more than 15, and link-heavy emails score poorly with spam filters. Keep the few that matter.",
    test: (i) => extractLinks(i.htmlBody).length > 15,
  },
  {
    category: "financial_claims",
    score: 35,
    description: "Get-rich financial claims",
    fix: "Remove get-rich claims like “guaranteed returns” or “double your money” — they're a strong spam signal and can't be substantiated.",
    test: (_i, t) =>
      wordsPresent(t, ["guaranteed returns", "double your money", "risk-free investment", "passive income guaranteed"], 1),
  },
  {
    category: "misleading_subject",
    score: 30,
    description: "Misleading subject (re:/fwd: bait)",
    fix: "Remove the “Re:”/“Fwd:” from the subject — pretending to be a reply misleads recipients and violates anti-spam rules.",
    test: (i) => /^(re|fwd|fw):/i.test(i.subject.trim()),
  },
  {
    category: "phishing_like",
    score: 70,
    description: "Phishing-like language",
    fix: "Remove account-verification and password language (“verify your account immediately”, “confirm your password”) — it reads as phishing and can't be sent.",
    test: (_i, t) =>
      wordsPresent(t, ["verify your account immediately", "your account will be suspended", "confirm your password"], 1),
  },
  {
    category: "brand_impersonation",
    score: 70,
    description: "From name impersonates a brand the email links to",
    fix: "Use your own company in the From name. This email signs as one brand but is sent from an unrelated domain, which is the shape of a phishing message and cannot be delivered.",
    test: (i) => impersonatedBrand(i) !== null,
  },
  {
    category: "credential_harvest",
    score: 60,
    description: "Account/payment verification request",
    fix: "Remove the request to sign in, verify an identity, or confirm billing details. Day3 sends newsletters; mail asking a recipient to authenticate or hand over financial details cannot go out over shared sending infrastructure.",
    test: (_i, t) =>
      wordsPresent(
        t,
        [
          "confirm your billing",
          "confirm your payment",
          "billing and payment information",
          "payment information",
          "update your payment details",
          "verify your identity",
          "verify your account",
          "confirm your account",
          "sign in to your account",
          "log in to your account",
          "confirm your medicare",
          "confirm your bank",
          "banking details",
          "tax refund",
          "unclaimed refund",
          "your account has been limited",
          "unusual activity on your account",
        ],
        1,
      ),
  },
  {
    category: "foreign_tracking",
    score: 45,
    description: "Another email provider's tracking pixel in the HTML",
    fix: "Remove the tracking pixel left behind by another email platform (SendGrid, Mailchimp, HubSpot, …). It means this HTML was copied out of an email someone else sent, and mail carrying it will not be delivered.",
    test: (i) => referencedHosts(i.htmlBody).some((h) => hostMatches(h, FOREIGN_ESP_TRACKING_HOSTS)),
  },
  {
    category: "disposable_cta",
    score: 25,
    description: "Call to action points at a throwaway landing-page host",
    fix: "Point the main link at your own domain. Funnel and site-builder links (ClickFunnels, Google Forms, *.vercel.app, …) are heavily abused to host fake sign-in pages, so they score badly with spam filters.",
    test: (i) =>
      extractLinks(i.htmlBody).some((l) => {
        const host = urlHost(l);
        return host !== null && hostMatches(host, DISPOSABLE_CTA_HOSTS);
      }),
  },
  {
    category: "missing_sender_identity",
    score: 20,
    description: "From email does not match sending domain",
    fix: "Send from an address on your verified sending domain so the From address matches the domain that authenticates your mail.",
    test: (i) => !i.fromEmail.toLowerCase().endsWith(`@${i.sendingDomain.toLowerCase()}`),
  },
];

function actionFor(riskLevel: RiskLevel): CampaignRiskReview["recommendedAction"] {
  return riskLevel === "low" ? "approve" : riskLevel === "medium" ? "manual_review" : "block";
}

export function runDeterministicRiskChecks(input: RiskCheckInput): CampaignRiskReview {
  const lowered = `${input.subject}\n${input.htmlBody}\n${input.textBody ?? ""}`.toLowerCase();

  const categories = new Set<string>();
  const reasons: string[] = [];
  const guidance: string[] = [];
  let score = 0;

  for (const signal of SIGNALS) {
    if (signal.test(input, lowered)) {
      categories.add(signal.category);
      reasons.push(signal.description);
      guidance.push(signal.fix);
      score += signal.score;
    }
  }

  score = Math.min(score, 100);

  let riskLevel: RiskLevel;
  if (score >= 70) riskLevel = "high";
  else if (score >= 40) riskLevel = "medium";
  else riskLevel = "low";

  // Hard-block categories regardless of total score.
  if (categories.has("prohibited_industry") || categories.has("phishing_like")) {
    riskLevel = "blocked";
    score = 100;
  }

  // Phishing is a COMBINATION, and insisting on the combination is what keeps
  // this usable on the transactional API.
  //
  // Each of these three categories has an innocent reading on its own, and
  // blocking any one of them alone would break real mail:
  //   - credential_harvest   — every signup confirmation says "verify your
  //                            account"; every SaaS says "sign in to your
  //                            account". On its own this is a password reset.
  //   - brand_impersonation  — a newsletter about a company legitimately links
  //                            to that company while sending from its own
  //                            publishing domain.
  //   - foreign_tracking     — someone pasted a competitor's template in while
  //                            migrating to Day3, pixel and all.
  //
  // Impersonation plus EITHER of the other two has no innocent reading left.
  // Asking for credentials while wearing another brand's name is phishing;
  // wearing another brand's name in HTML lifted from that brand's own mail is
  // phishing. This pair rule is what catches a run that no single keyword
  // would: `HotDoc <news@globalcitiys.com>` asking recipients to "confirm your
  // Medicare billing" behind a ClickFunnels link.
  //
  // Impersonation has to be one of the two. The remaining combination —
  // credential language in a template carrying someone else's pixel — is a
  // customer migrating their password-reset email off SendGrid and forgetting
  // to strip the tracking image. That is a real and common thing to do, it is
  // not deceptive to anyone, and blocking it would break a new customer's auth
  // flow on their first day. It still scores as high risk and still shows up in
  // the admin queue; it just sends.
  if (
    categories.has("brand_impersonation") &&
    (categories.has("credential_harvest") || categories.has("foreign_tracking"))
  ) {
    categories.add("phishing_like");
    riskLevel = "blocked";
    score = 100;
  }

  // The second pair, learned from the attacker's third account. Having been
  // blocked on the impersonation pair, he dropped the brand link and the pixel,
  // kept "confirm your Medicare billing and payment information", and pointed the
  // button at the same ClickFunnels page. That scored `high` and 475 emails went
  // out before the ramp stopped him.
  //
  // Asking a reader for payment or sign-in details behind a link to a
  // throwaway page-builder host is a credential harvester whatever the From name
  // says. The innocent reading — a real business collecting card details through
  // a Google Form — is a thing that exists, is a PCI violation when it does, and
  // is not what a newsletter platform is for. A 422 with the fix spelled out is
  // the right answer to it.
  if (categories.has("credential_harvest") && categories.has("disposable_cta")) {
    categories.add("phishing_like");
    riskLevel = "blocked";
    score = 100;
  }

  return {
    riskLevel,
    riskScore: score,
    categories: [...categories],
    summary:
      reasons.length === 0
        ? "No risk signals detected."
        : `Signals: ${reasons.join("; ")}.`,
    guidance,
    recommendedAction: actionFor(riskLevel),
  };
}

const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, blocked: 3 };
// When the AI escalates the level past what the deterministic score implies,
// lift the score to that level's threshold so admin-queue sorting stays sane.
const LEVEL_FLOOR_SCORE: Record<RiskLevel, number> = { low: 0, medium: 40, high: 70, blocked: 100 };

// Cap so the blocked-campaign alert stays scannable even when both passes fire.
const MAX_GUIDANCE_ITEMS = 8;

// Merges the AI verdict into the deterministic review. SECURITY INVARIANT: the
// AI can only ESCALATE — the deterministic result is the floor. Campaign content
// is attacker-controlled input to the model, so a prompt-injected "classify this
// as low risk" must never be able to lower the outcome; the worst injection can
// do is block the attacker's own campaign.
export function mergeReviews(
  deterministic: CampaignRiskReview,
  ai: AiRiskVerdict,
): CampaignRiskReview {
  const riskLevel =
    LEVEL_RANK[ai.riskLevel] > LEVEL_RANK[deterministic.riskLevel]
      ? ai.riskLevel
      : deterministic.riskLevel;
  const riskScore = Math.max(deterministic.riskScore, LEVEL_FLOOR_SCORE[riskLevel]);
  const categories = [...new Set([...deterministic.categories, ...ai.categories])];
  // Deterministic fixes first — they're the reason for any hard block — then the
  // AI's, deduped and capped.
  const guidance = [...new Set([...deterministic.guidance, ...ai.guidance])].slice(
    0,
    MAX_GUIDANCE_ITEMS,
  );
  const summary = ai.rationale
    ? `${deterministic.summary} AI review: ${ai.rationale}`
    : deterministic.summary;

  return {
    riskLevel,
    riskScore,
    categories,
    summary,
    guidance,
    recommendedAction: actionFor(riskLevel),
    ai,
  };
}

// The full pre-send review: deterministic checks always run; when AI_REVIEW_MODE
// is anything other than unset/"mock", an AI pass is layered on top (escalate-only,
// see mergeReviews). The AI call FAILS OPEN: any error/timeout falls back to the
// deterministic result so a model outage never wedges a campaign in review.
// `aiFn` is injectable for tests.
export async function reviewCampaignRisk(
  input: RiskCheckInput,
  aiReviewMode: string | undefined,
  aiFn: (input: RiskCheckInput) => Promise<AiRiskVerdict> = aiReviewCampaign,
): Promise<CampaignRiskReview> {
  const deterministic = runDeterministicRiskChecks(input);
  if (!aiReviewMode || aiReviewMode === "mock") return deterministic;

  try {
    const verdict = await aiFn(input);
    return mergeReviews(deterministic, verdict);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Still fails open, but it now PAGES rather than whispering. Fail-open is
    // the right call per email; it is the wrong call per week, because a
    // revoked or mistyped OPENROUTER_API_KEY otherwise turns the reviewer back
    // into the keyword-only pass an attacker already beat, with nothing but a
    // console.warn in a worker log to say so.
    void logger.reportError("AI review failed; using deterministic result", err, {
      fromEmail: input.fromEmail,
      sendingDomain: input.sendingDomain,
    });
    return { ...deterministic, aiError: message };
  }
}

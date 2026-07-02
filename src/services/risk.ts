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
    console.warn(`[risk] AI review failed; using deterministic result: ${message}`);
    return { ...deterministic, aiError: message };
  }
}

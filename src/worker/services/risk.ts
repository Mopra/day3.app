export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type CampaignRiskReview = {
  riskLevel: RiskLevel;
  riskScore: number;
  categories: string[];
  summary: string;
  recommendedAction: "approve" | "manual_review" | "block";
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

function extractLinks(html: string): string[] {
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
    test: (_i, t) =>
      wordsPresent(t, ["crypto", "bitcoin", "ethereum", "token sale", "ico ", "airdrop", "web3 investment"], 1),
  },
  {
    category: "prohibited_industry",
    score: 60,
    description: "Gambling terms",
    test: (_i, t) => wordsPresent(t, ["casino", "betting", "poker", "jackpot", "slots", "sportsbook"], 1),
  },
  {
    category: "prohibited_industry",
    score: 80,
    description: "Adult content terms",
    test: (_i, t) => wordsPresent(t, ["adult content", "xxx", "porn", "onlyfans", "escort"], 1),
  },
  {
    category: "cold_outreach",
    score: 40,
    description: "Cold outreach language",
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
    test: (_i, t) =>
      wordsPresent(t, ["purchased list", "bought this list", "scraped", "verified leads", "email database"], 1),
  },
  {
    category: "aggressive_sales",
    score: 25,
    description: "Suspicious urgency",
    test: (_i, t) =>
      wordsPresent(t, ["act now", "limited time only", "expires tonight", "last chance", "urgent action required"], 2),
  },
  {
    category: "link_mismatch",
    score: 30,
    description: "URL shorteners present",
    test: (i) => extractLinks(i.htmlBody).some((l) => URL_SHORTENERS.some((s) => l.includes(s))),
  },
  {
    category: "aggressive_sales",
    score: 20,
    description: "Too many links",
    test: (i) => extractLinks(i.htmlBody).length > 15,
  },
  {
    category: "financial_claims",
    score: 35,
    description: "Get-rich financial claims",
    test: (_i, t) =>
      wordsPresent(t, ["guaranteed returns", "double your money", "risk-free investment", "passive income guaranteed"], 1),
  },
  {
    category: "misleading_subject",
    score: 30,
    description: "Misleading subject (re:/fwd: bait)",
    test: (i) => /^(re|fwd|fw):/i.test(i.subject.trim()),
  },
  {
    category: "phishing_like",
    score: 70,
    description: "Phishing-like language",
    test: (_i, t) =>
      wordsPresent(t, ["verify your account immediately", "your account will be suspended", "confirm your password"], 1),
  },
  {
    category: "missing_sender_identity",
    score: 20,
    description: "From email does not match sending domain",
    test: (i) => !i.fromEmail.toLowerCase().endsWith(`@${i.sendingDomain.toLowerCase()}`),
  },
];

export function runDeterministicRiskChecks(input: RiskCheckInput): CampaignRiskReview {
  const lowered = `${input.subject}\n${input.htmlBody}\n${input.textBody ?? ""}`.toLowerCase();

  const categories = new Set<string>();
  const reasons: string[] = [];
  let score = 0;

  for (const signal of SIGNALS) {
    if (signal.test(input, lowered)) {
      categories.add(signal.category);
      reasons.push(signal.description);
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

  const recommendedAction =
    riskLevel === "low" ? "approve" : riskLevel === "medium" ? "manual_review" : "block";

  return {
    riskLevel,
    riskScore: score,
    categories: [...categories],
    summary:
      reasons.length === 0
        ? "No risk signals detected."
        : `Signals: ${reasons.join("; ")}.`,
    recommendedAction,
  };
}

// AI review hook. In mock mode the deterministic result stands alone; a real
// model review can be layered in later without changing callers.
export async function reviewCampaignRisk(
  input: RiskCheckInput,
  aiReviewMode: string | undefined,
): Promise<CampaignRiskReview> {
  const deterministic = runDeterministicRiskChecks(input);
  if (aiReviewMode && aiReviewMode !== "mock") {
    // Placeholder for a real AI review pass (e.g. Workers AI). MVP: mock only.
    console.log(`[risk] AI_REVIEW_MODE=${aiReviewMode} not implemented; using deterministic result`);
  }
  return deterministic;
}

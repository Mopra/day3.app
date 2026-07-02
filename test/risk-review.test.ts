// The pre-send safety review: deterministic guidance, the escalate-only AI
// merge, and the fail-open orchestration in reviewCampaignRisk.
import { describe, expect, it, vi } from "vitest";
import {
  mergeReviews,
  reviewCampaignRisk,
  runDeterministicRiskChecks,
  type RiskCheckInput,
} from "../src/services/risk";
import { htmlToText, type AiRiskVerdict } from "../src/services/risk-ai";

const base: Omit<RiskCheckInput, "subject" | "htmlBody"> = {
  fromEmail: "news@updates.test.co",
  sendingDomain: "updates.test.co",
  textBody: null,
};

const clean: RiskCheckInput = {
  ...base,
  subject: "June product update",
  htmlBody: "<p>We shipped a new dashboard and fixed bugs.</p>",
};

function verdict(overrides: Partial<AiRiskVerdict> = {}): AiRiskVerdict {
  return {
    riskLevel: "low",
    categories: [],
    rationale: "Reads like a normal product newsletter.",
    guidance: [],
    model: "test-model",
    usage: { inputTokens: 100, outputTokens: 50 },
    ...overrides,
  };
}

describe("deterministic guidance", () => {
  it("is empty for a clean newsletter", () => {
    const result = runDeterministicRiskChecks(clean);
    expect(result.guidance).toEqual([]);
  });

  it("carries a fix for every fired signal", () => {
    const result = runDeterministicRiskChecks({
      ...base,
      subject: "Re: your account",
      htmlBody: '<p>Act now! Last chance! <a href="https://bit.ly/x">Click</a></p>',
    });
    // misleading subject + urgency (2 phrases) + shortener → three fixes.
    expect(result.guidance).toHaveLength(3);
    expect(result.guidance.join(" ")).toContain("bit.ly");
    expect(result.guidance.join(" ")).toContain("Re:");
  });
});

describe("mergeReviews (escalate-only)", () => {
  it("lets the AI escalate a low deterministic result and floors the score", () => {
    const det = runDeterministicRiskChecks(clean);
    expect(det.riskLevel).toBe("low");
    const merged = mergeReviews(
      det,
      verdict({
        riskLevel: "high",
        categories: ["cold_outreach"],
        rationale: "This is cold outreach to strangers.",
        guidance: ["Only email people who signed up for your list."],
      }),
    );
    expect(merged.riskLevel).toBe("high");
    expect(merged.riskScore).toBeGreaterThanOrEqual(70);
    expect(merged.recommendedAction).toBe("block");
    expect(merged.categories).toContain("cold_outreach");
    expect(merged.guidance).toContain("Only email people who signed up for your list.");
    expect(merged.summary).toContain("AI review:");
    expect(merged.ai?.model).toBe("test-model");
  });

  it("never lets the AI lower a deterministic hard block", () => {
    const det = runDeterministicRiskChecks({
      ...base,
      subject: "Win big",
      htmlBody: "<p>Best casino bonuses!</p>",
    });
    expect(det.riskLevel).toBe("blocked");
    const merged = mergeReviews(det, verdict({ riskLevel: "low" }));
    expect(merged.riskLevel).toBe("blocked");
    expect(merged.riskScore).toBe(100);
    expect(merged.recommendedAction).toBe("block");
  });

  it("dedupes guidance and caps it at 8 items", () => {
    const det = runDeterministicRiskChecks(clean);
    const merged = mergeReviews(
      det,
      verdict({
        guidance: Array.from({ length: 12 }, (_, i) => `Fix number ${i}`).concat([
          "Fix number 0", // duplicate
        ]),
      }),
    );
    expect(merged.guidance).toHaveLength(8);
    expect(new Set(merged.guidance).size).toBe(8);
  });
});

describe("reviewCampaignRisk orchestration", () => {
  it("skips the AI pass entirely in mock mode", async () => {
    const aiFn = vi.fn();
    const result = await reviewCampaignRisk(clean, "mock", aiFn);
    expect(aiFn).not.toHaveBeenCalled();
    expect(result.ai).toBeUndefined();
    expect(result.riskLevel).toBe("low");
  });

  it("merges the AI verdict when the mode is enabled", async () => {
    const aiFn = vi.fn().mockResolvedValue(verdict({ riskLevel: "medium" }));
    const result = await reviewCampaignRisk(clean, "ai", aiFn);
    expect(aiFn).toHaveBeenCalledOnce();
    expect(result.riskLevel).toBe("medium");
    expect(result.ai?.usage.inputTokens).toBe(100);
  });

  it("fails open to the deterministic result when the AI call throws", async () => {
    const aiFn = vi.fn().mockRejectedValue(new Error("provider timeout"));
    const result = await reviewCampaignRisk(clean, "ai", aiFn);
    expect(result.riskLevel).toBe("low");
    expect(result.recommendedAction).toBe("approve");
    expect(result.aiError).toBe("provider timeout");
    expect(result.ai).toBeUndefined();
  });
});

describe("htmlToText", () => {
  it("strips tags, styles, and entities down to readable text", () => {
    const text = htmlToText(
      '<style>p{color:red}</style><table><tr><td><p>Hello &amp; welcome&nbsp;to <strong>Day3</strong></p></td></tr></table>',
    );
    expect(text).toBe("Hello & welcome to Day3");
  });
});

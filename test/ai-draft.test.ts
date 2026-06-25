import { describe, expect, it } from "vitest";
import { aiBlocksToSections, type AiBlock } from "../src/services/ai";
import { SectionsSchema, serializeSections } from "../src/lib/sections";
import { sanitizeHtml } from "../src/services/render";

// aiBlocksToSections is the bridge from the model's block list to the section
// builder. These tests pin the mapping + the safety/skip rules; the model call
// itself (network) is out of scope.

describe("aiBlocksToSections", () => {
  it("builds a full multi-section email from a mixed block list", () => {
    const blocks: AiBlock[] = [
      { type: "text", html: "<h1>Big update</h1><p>Hi {{first_name}}</p>" },
      { type: "divider", spacer: false },
      {
        type: "columns",
        columns: ["<h3>Fast</h3><p>a</p>", "<h3>Safe</h3><p>b</p>", "<h3>Cheap</h3><p>c</p>"],
      },
      { type: "quote", html: "<p>Best tool ever</p>", attribution: "Jane, Acme" },
      { type: "button", label: "Get started", href: "https://example.com/go" },
      { type: "divider", spacer: true },
    ];
    const sections = aiBlocksToSections(blocks);

    expect(sections.map((s) => s.kind)).toEqual([
      "text",
      "divider",
      "text",
      "quote",
      "button",
      "divider",
    ]);
    // The columns block becomes a real 3-column text row.
    const cols = sections[2];
    expect(cols.columns).toBe(3);
    expect(cols.content).toHaveLength(3);
    // The quote keeps its attribution; the button keeps its link + brand colors.
    expect(sections[3].attribution).toBe("Jane, Acme");
    expect(sections[4].buttons?.[0]).toMatchObject({ href: "https://example.com/go" });
    // The rule divider is a line; the spacer divider is a blank gap.
    expect(sections[1].line).toBe(true);
    expect(sections[5].line).toBe(false);
    expect(sections[5].height).toBeGreaterThan(0);

    // The whole thing validates and serializes to a non-trivial email body.
    expect(SectionsSchema.safeParse(sections).success).toBe(true);
    expect(serializeSections(sections).length).toBeGreaterThan(100);
  });

  it("drops a button with no real http(s) link rather than shipping a dead CTA", () => {
    expect(aiBlocksToSections([{ type: "button", label: "Click", href: "" }])).toEqual([]);
    expect(aiBlocksToSections([{ type: "button", label: "Click" }])).toEqual([]);
    expect(
      aiBlocksToSections([{ type: "button", label: "Click", href: "javascript:alert(1)" }]),
    ).toEqual([]);
  });

  it("falls back to a text block when a columns block has fewer than two fragments", () => {
    const sections = aiBlocksToSections([{ type: "columns", columns: ["<p>only one</p>"] }]);
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("text");
    expect(sections[0].columns).toBe(1);
  });

  it("skips empty text and quote blocks", () => {
    expect(aiBlocksToSections([{ type: "text", html: "   " }])).toEqual([]);
    expect(aiBlocksToSections([{ type: "quote", html: "" }])).toEqual([]);
  });

  it("sanitizes rich-text fields so output is always email-safe", () => {
    const sections = aiBlocksToSections([
      { type: "text", html: '<p onclick="x()">hi<script>evil()</script></p>' },
    ]);
    const html = sections[0].content[0];
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
    // Already a fixed point of sanitize (the builder's email-safe invariant).
    expect(sanitizeHtml(html)).toBe(html);
  });
});

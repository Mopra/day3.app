import { describe, expect, it } from "vitest";
import { markdownToSections, sectionsToMarkdown } from "../src/lib/campaign-markdown";
import { SectionsSchema, serializeSections } from "../src/lib/sections";
import { sanitizeHtml } from "../src/services/render";

// The codec is the contract between an external editor (the MCP server) and the
// section builder, so these tests care about three things: the markdown maps to
// the *right kind* of section, the output survives the schema + the email-safety
// invariant, and a section list round-trips through markdown without losing
// content.

const parse = (md: string) => markdownToSections(md);

describe("markdownToSections — prose", () => {
  it("folds consecutive prose blocks into one text section", () => {
    const sections = parse("# Hello\n\nFirst para.\n\nSecond para.");
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("text");
    expect(sections[0].content[0]).toBe(
      "<h1>Hello</h1><p>First para.</p><p>Second para.</p>",
    );
  });

  it("splits text sections on ===", () => {
    const sections = parse("One.\n\n===\n\nTwo.");
    expect(sections.map((s) => s.kind)).toEqual(["text", "text"]);
    expect(sections[0].content[0]).toBe("<p>One.</p>");
    expect(sections[1].content[0]).toBe("<p>Two.</p>");
  });

  it("renders lists, emphasis, code and links", () => {
    const sections = parse("- **bold** item\n- *em* and `code`\n- [link](https://day3.app)");
    expect(sections[0].content[0]).toBe(
      "<ul>" +
        "<li><strong>bold</strong> item</li>" +
        "<li><em>em</em> and <code>code</code></li>" +
        '<li><a href="https://day3.app">link</a></li>' +
        "</ul>",
    );
  });

  it("does not mangle underscores inside a URL", () => {
    const [section] = parse("See [the docs](https://day3.app/a_b_c_d).");
    expect(section.content[0]).toContain('href="https://day3.app/a_b_c_d"');
    expect(section.content[0]).not.toContain("<em>");
  });

  it("escapes HTML in prose rather than emitting it", () => {
    const [section] = parse("A <script>alert(1)</script> and 5 > 3.");
    expect(section.content[0]).not.toContain("<script");
    expect(section.content[0]).toContain("&lt;script&gt;");
  });

  it("drops an unsafe link scheme back to plain text", () => {
    const [section] = parse("[click](javascript:alert(1))");
    expect(section.content[0]).not.toContain("<a ");
    expect(section.content[0]).not.toContain("javascript:");
  });

  it("keeps a merge tag usable in prose", () => {
    const [section] = parse("Hi {{first_name|there}}, welcome.");
    expect(section.content[0]).toBe("<p>Hi {{first_name|there}}, welcome.</p>");
  });

  it("numbers a shelved code span from real digits in the text", () => {
    const [section] = parse("We shipped 3 things and `4` more.");
    expect(section.content[0]).toBe("<p>We shipped 3 things and <code>4</code> more.</p>");
  });
});

describe("markdownToSections — section kinds", () => {
  it("maps a standalone image line to an image section", () => {
    const sections = parse("Intro.\n\n![A chart](https://cdn.day3.app/a.png)\n\nOutro.");
    expect(sections.map((s) => s.kind)).toEqual(["text", "image", "text"]);
    expect(sections[1].images?.[0]).toEqual({ src: "https://cdn.day3.app/a.png", alt: "A chart" });
  });

  it("keeps an inline image inside its paragraph", () => {
    const sections = parse("Look ![x](https://cdn.day3.app/a.png) here.");
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("text");
  });

  it("maps a linked image", () => {
    const [section] = parse("[![A chart](https://cdn.day3.app/a.png)](https://day3.app)");
    expect(section.images?.[0]?.href).toBe("https://day3.app");
  });

  it("maps a button line, with attributes", () => {
    const [section] = parse("[Get started](https://day3.app){.button bg=#111111 full}");
    expect(section.kind).toBe("button");
    expect(section.buttons?.[0]).toEqual({
      label: "Get started",
      href: "https://day3.app",
      bgColor: "#111111",
      fullWidth: true,
    });
    expect(section.align).toBe("center");
  });

  it("maps --- to a rule and :::spacer to a blank spacer", () => {
    const sections = parse("a\n\n---\n\n:::spacer 48:::\n\nb");
    expect(sections.map((s) => s.kind)).toEqual(["text", "divider", "divider", "text"]);
    expect(sections[1].line).toBe(true);
    expect(sections[2].line).toBe(false);
    expect(sections[2].height).toBe(48);
  });

  it("maps a blockquote with an attribution", () => {
    const [section] = parse("> It just works.\n> — Jane, Acme");
    expect(section.kind).toBe("quote");
    expect(section.content[0]).toBe("<p>It just works.</p>");
    expect(section.attribution).toBe("Jane, Acme");
  });

  it("maps :::columns to a multi-column text section", () => {
    const [section] = parse(":::columns\n### Fast\nShip today.\n+++\n### Safe\nReview built in.\n:::");
    expect(section.kind).toBe("text");
    expect(section.columns).toBe(2);
    expect(section.content[0]).toBe("<h3>Fast</h3><p>Ship today.</p>");
    expect(section.content[1]).toBe("<h3>Safe</h3><p>Review built in.</p>");
  });

  it("makes :::columns an image section when every column is one image", () => {
    const [section] = parse(
      ":::columns\n![a](https://cdn.day3.app/a.png)\n+++\n![b](https://cdn.day3.app/b.png)\n:::",
    );
    expect(section.kind).toBe("image");
    expect(section.columns).toBe(2);
    expect(section.images?.map((i) => i?.src)).toEqual([
      "https://cdn.day3.app/a.png",
      "https://cdn.day3.app/b.png",
    ]);
  });

  it("makes :::columns a button section when every column is one button", () => {
    const [section] = parse(
      ":::columns\n[A](https://day3.app/a){.button}\n+++\n[B](https://day3.app/b){.button}\n:::",
    );
    expect(section.kind).toBe("button");
    expect(section.buttons?.map((b) => b?.label)).toEqual(["A", "B"]);
  });

  it("maps :::card and :::social", () => {
    const sections = parse(
      ":::card image-right\n![p](https://cdn.day3.app/p.png)\n\nBuy it.\n:::\n\n" +
        ":::social Follow us:\n- twitter: https://x.com/day3\n- website: https://day3.app\n:::",
    );
    expect(sections.map((s) => s.kind)).toEqual(["card", "social"]);
    expect(sections[0].layout).toBe("image-right");
    expect(sections[0].images?.[0]?.src).toBe("https://cdn.day3.app/p.png");
    expect(sections[0].content[0]).toBe("<p>Buy it.</p>");
    expect(sections[1].socialIntro).toBe("Follow us:");
    expect(sections[1].socials).toEqual([
      { network: "twitter", url: "https://x.com/day3" },
      { network: "website", url: "https://day3.app" },
    ]);
  });

  it("sanitizes a :::html passthrough", () => {
    const [section] = parse(':::html\n<p>ok</p><script>bad()</script>\n:::');
    expect(section.content[0]).toContain("<p>ok</p>");
    expect(section.content[0]).not.toContain("script");
  });

  it("applies :::section styling to what it wraps", () => {
    const [section] = parse(":::section {bg=#f5f5f5 align=center}\nHello.\n:::");
    expect(section.sectionBg).toBe("#f5f5f5");
    expect(section.align).toBe("center");
    expect(section.content[0]).toBe("<p>Hello.</p>");
  });

  it("ignores an unsafe colour in a section background", () => {
    const [section] = parse(":::section {bg=url(javascript:1)}\nHello.\n:::");
    expect(section.sectionBg).toBeUndefined();
  });
});

describe("codec output is valid and email-safe", () => {
  const kitchenSink = [
    "# Launch day",
    "",
    "We shipped **the thing**. [Read more](https://day3.app/blog).",
    "",
    "![Hero](https://cdn.day3.app/hero.png)",
    "",
    "---",
    "",
    "> Best release yet.",
    "> — Jane",
    "",
    ":::columns",
    "### One",
    "First.",
    "+++",
    "### Two",
    "Second.",
    ":::",
    "",
    "[Get started](https://day3.app){.button bg=#2563eb}",
    "",
    ":::social Follow:",
    "- twitter: https://x.com/day3",
    ":::",
  ].join("\n");

  it("produces sections the stored-body schema accepts", () => {
    const sections = markdownToSections(kitchenSink);
    const parsed = SectionsSchema.safeParse(sections);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("serializes to a fixed point of sanitizeHtml", () => {
    const html = serializeSections(markdownToSections(kitchenSink));
    expect(html).not.toBe("");
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("caps runaway documents at the section limit", () => {
    const md = Array.from({ length: 60 }, (_, i) => `Para ${i}.\n\n===`).join("\n\n");
    expect(markdownToSections(md).length).toBeLessThanOrEqual(30);
  });
});

describe("sectionsToMarkdown", () => {
  // Round-tripping compares the *serialized email*, not the markdown text: the
  // codec promises the rendered result survives, not a byte-identical document.
  const roundTrips = (md: string) => {
    const first = markdownToSections(md);
    const second = markdownToSections(sectionsToMarkdown(first));
    expect(serializeSections(second)).toBe(serializeSections(first));
  };

  it("round-trips prose, images, buttons, rules and quotes", () => {
    roundTrips(
      [
        "# Title",
        "",
        "Body with **bold** and [a link](https://day3.app).",
        "",
        "![Hero](https://cdn.day3.app/hero.png)",
        "",
        "---",
        "",
        "> Quoted.",
        "> — Jane",
        "",
        "[Go](https://day3.app){.button bg=#2563eb full}",
      ].join("\n"),
    );
  });

  it("round-trips multi-column text, images and buttons", () => {
    roundTrips(":::columns\n### A\nOne.\n+++\n### B\nTwo.\n:::");
    roundTrips(":::columns\n![a](https://cdn.day3.app/a.png)\n+++\n![b](https://cdn.day3.app/b.png)\n:::");
    roundTrips(":::columns\n[A](https://day3.app/a){.button}\n+++\n[B](https://day3.app/b){.button}\n:::");
  });

  it("round-trips cards, socials, spacers and section styling", () => {
    roundTrips(":::card image-top\n![p](https://cdn.day3.app/p.png)\n\nText.\n:::");
    roundTrips(":::social Follow:\n- github: https://github.com/day3\n:::");
    roundTrips(":::spacer 64:::");
    roundTrips(":::section {bg=#eeeeee}\nTinted.\n:::");
  });

  it("keeps adjacent text sections apart", () => {
    const sections = markdownToSections("One.\n\n===\n\nTwo.");
    const md = sectionsToMarkdown(sections);
    expect(md).toContain("===");
    expect(markdownToSections(md)).toHaveLength(2);
  });

  it("falls back to a :::html block for content it cannot express", () => {
    const sections = markdownToSections("x");
    sections[0].content[0] = '<p>Keep <u>this</u> underline</p>';
    const md = sectionsToMarkdown(sections);
    expect(md).toContain(":::html");
    expect(markdownToSections(md)[0].content[0]).toContain("<u>this</u>");
  });

  it("nests a :::html fallback inside a column without breaking the fence", () => {
    const sections = markdownToSections(":::columns\nA\n+++\nB\n:::");
    sections[0].content[1] = "<p>Has <u>underline</u></p>";
    const reparsed = markdownToSections(sectionsToMarkdown(sections));
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].columns).toBe(2);
    expect(reparsed[0].content[1]).toContain("<u>underline</u>");
  });
});

import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../src/services/render";
import {
  SectionsSchema,
  duplicateSection,
  emptySection,
  htmlBodyToSections,
  resizeSection,
  safeParseSections,
  serializeSections,
  setSectionKind,
  starterSections,
  type CampaignSection,
  type SectionImage,
} from "../src/lib/sections";

// Build a text section without depending on crypto for stable assertions.
function section(columns: 1 | 2 | 3, content: string[]): CampaignSection {
  return { id: `sec_${columns}_${content.join("|").length}`, kind: "text", content, columns };
}

// Build an image section: content stays sized to columns (empty), images carries
// one slot per column.
function imageSection(columns: 1 | 2 | 3, images: (SectionImage | null)[]): CampaignSection {
  return {
    id: `img_${columns}_${images.length}`,
    kind: "image",
    columns,
    content: Array.from({ length: columns }, () => ""),
    images,
  };
}

describe("serializeSections", () => {
  // Every section is wrapped in a layout band — transparent spacer columns inset the
  // content horizontally (so colored sections can bleed full width; see the section
  // background tests below). This helper builds the expected wrapper for an uncolored
  // section's inner table.
  const band = (inner: string): string =>
    '<table role="presentation" width="100%"><tbody><tr>' +
    '<td width="40"></td>' +
    `<td>${inner}</td>` +
    '<td width="40"></td>' +
    "</tr></tbody></table>";

  it("serializes a single full-width column with no explicit width", () => {
    const html = serializeSections([section(1, ["<p>Hello</p>"])]);
    expect(html).toBe(
      band(
        '<table role="presentation" width="100%"><tbody><tr>' +
          '<td valign="top"><p>Hello</p></td>' +
          "</tr></tbody></table>",
      ),
    );
  });

  it("serializes two and three equal-width columns", () => {
    // Multi-column cells carry the `d3-col` hook so the document <style> can stack
    // them to full width on phones (single columns get no hook).
    expect(serializeSections([section(2, ["<p>A</p>", "<p>B</p>"])])).toBe(
      band(
        '<table role="presentation" width="100%"><tbody><tr>' +
          '<td class="d3-col" valign="top" width="50%"><p>A</p></td>' +
          '<td class="d3-col" valign="top" width="50%"><p>B</p></td>' +
          "</tr></tbody></table>",
      ),
    );
    const three = serializeSections([section(3, ["<p>A</p>", "<p>B</p>", "<p>C</p>"])]);
    expect(three.match(/width="33%"/g)).toHaveLength(3);
    expect(three.match(/class="d3-col"/g)).toHaveLength(3);
  });

  it("aligns text columns via the cell's align attribute (center/right only)", () => {
    const centered = serializeSections([{ ...section(1, ["<p>Hi</p>"]), align: "center" }]);
    expect(centered).toContain('<td valign="top" align="center"><p>Hi</p></td>');
    const right = serializeSections([{ ...section(2, ["<p>A</p>", "<p>B</p>"]), align: "right" }]);
    expect(right.match(/<td class="d3-col" valign="top" width="50%" align="right">/g)).toHaveLength(2);
    // Left is the default — no attribute, output stays byte-identical.
    const left = serializeSections([{ ...section(1, ["<p>Hi</p>"]), align: "left" }]);
    expect(left).toContain('<td valign="top"><p>Hi</p></td>');
  });

  it("joins multiple sections in order, separated by a spacer", () => {
    const html = serializeSections([section(1, ["<p>One</p>"]), section(1, ["<p>Two</p>"])]);
    expect(html.indexOf("One")).toBeLessThan(html.indexOf("Two"));
    // Two sections (each a band wrapper + its inner table = 4 tables) with a single
    // inter-section spacer table between them = 5 tables.
    expect(html.match(/<table/g)).toHaveLength(5);
    // The spacer sits between the two sections, giving the email the same vertical
    // rhythm as the builder's `space-y` canvas.
    const spacer = '<td height="16">&nbsp;</td>';
    expect(html).toContain(spacer);
    expect(html.indexOf("One")).toBeLessThan(html.indexOf(spacer));
    expect(html.indexOf(spacer)).toBeLessThan(html.indexOf("Two"));
  });

  it("places column HTML verbatim (no double-escaping)", () => {
    const content = '<p>Hi <strong>there</strong></p><a href="https://x.test/path">link</a>';
    expect(serializeSections([section(1, [content])])).toContain(content);
  });

  it("returns an empty string when nothing has been written", () => {
    expect(serializeSections([emptySection()])).toBe("");
    expect(serializeSections([section(2, ["", "   "])])).toBe("");
  });

  it("serializes a section that has content in only some columns", () => {
    const html = serializeSections([section(2, ["<p>Left</p>", ""])]);
    expect(html).toContain("<p>Left</p>");
    // Two content cells (the empty band gutters are width-only spacer cells).
    expect(html.match(/valign="top"/g)).toHaveLength(2);
  });
});

describe("serializeSections (image sections)", () => {
  it("emits a full-width <img> filling a single column", () => {
    const html = serializeSections([
      imageSection(1, [{ src: "https://cdn.test/a.png", alt: "A logo", width: 1200, height: 400 }]),
    ]);
    // Scaled to the 600px body width, height kept proportional (400/1200 * 600 = 200).
    expect(html).toBe(
      '<table role="presentation" width="100%"><tbody><tr>' +
        '<td width="40"></td>' +
        "<td>" +
        '<table role="presentation" width="100%"><tbody><tr>' +
        '<td valign="top"><img src="https://cdn.test/a.png" alt="A logo" width="600" height="200"></td>' +
        "</tr></tbody></table>" +
        "</td>" +
        '<td width="40"></td>' +
        "</tr></tbody></table>",
    );
  });

  it("wraps the image in a link when href is set", () => {
    const html = serializeSections([
      imageSection(1, [{ src: "https://cdn.test/a.png", alt: "", href: "https://site.test" }]),
    ]);
    expect(html).toContain('<a href="https://site.test"><img src="https://cdn.test/a.png" alt=""');
    expect(html).toContain("></a>");
  });

  it("does not upscale an image smaller than the column", () => {
    const html = serializeSections([
      imageSection(1, [{ src: "https://cdn.test/small.png", width: 200, height: 100 }]),
    ]);
    expect(html).toContain('width="200" height="100"');
  });

  it("scales per-column for multi-column image sections", () => {
    const html = serializeSections([
      imageSection(2, [
        { src: "https://cdn.test/l.png", width: 1000, height: 500 },
        { src: "https://cdn.test/r.png", width: 1000, height: 500 },
      ]),
    ]);
    // Each column's pixel budget is 300 in a 2-col layout.
    expect(html.match(/width="300"/g)).toHaveLength(2);
  });

  it("renders an empty cell for an unset image slot", () => {
    const html = serializeSections([
      imageSection(2, [{ src: "https://cdn.test/a.png" }, null]),
    ]);
    expect(html).toContain('<td class="d3-col" valign="top" width="50%"><img');
    // The empty slot is a cell with no content.
    expect(html).toContain('<td class="d3-col" valign="top" width="50%"></td>');
  });

  it("treats an image-only section as content (not empty)", () => {
    expect(serializeSections([imageSection(1, [{ src: "https://cdn.test/a.png" }])])).not.toBe("");
  });

  it("returns empty when an image section has no uploaded images", () => {
    expect(serializeSections([imageSection(2, [null, null])])).toBe("");
  });

  // An all-placeholder section is invisible in the inbox, but a table is not free: if it
  // survived as a part, serializeSections would put a 16px spacer on each side of it and
  // the unfilled placeholder would punch a ~32px hole into the delivered email. So a
  // section whose every cell is empty is dropped entirely — which is what lets templates
  // (and the starter layout) ship placeholders safely.
  it("drops an all-placeholder section rather than leaving a spacer around it", () => {
    const withPlaceholders = serializeSections([
      section(1, ["<p>Real content</p>"]),
      // An unlinked button and an un-uploaded image: both placeholders.
      {
        id: "btn",
        kind: "button",
        columns: 1,
        content: [""],
        buttons: [{ label: "Get started", href: "" }],
      },
      imageSection(1, [null]),
      section(1, ["<p>More content</p>"]),
    ]);
    const withoutPlaceholders = serializeSections([
      section(1, ["<p>Real content</p>"]),
      section(1, ["<p>More content</p>"]),
    ]);
    // The placeholders contribute nothing at all — not even the inter-section gap.
    expect(withPlaceholders).toBe(withoutPlaceholders);
    expect(withPlaceholders).not.toContain('valign="top"></td>');
  });

  it("keeps every cell when only some are empty (they carry the column layout)", () => {
    // Contrast with the case above: a partly-filled section must keep its empty cells,
    // or the remaining content would stretch across the whole row.
    const html = serializeSections([section(2, ["<p>Left</p>", ""])]);
    expect(html).toContain('<td class="d3-col" valign="top" width="50%"><p>Left</p></td>');
    expect(html).toContain('<td class="d3-col" valign="top" width="50%"></td>');
  });

  it("emits the section's fixed box dimensions when a height is set", () => {
    const html = serializeSections([
      { ...imageSection(1, [{ src: "https://cdn.test/a.png", width: 600, height: 400 }]), height: 250 },
    ]);
    // The src is cover-cropped to the box, so we emit the box dims (not the natural aspect).
    expect(html).toContain('<img src="https://cdn.test/a.png" alt="" width="600" height="250">');
  });

  it("emits per-column box dimensions for a multi-column fixed-height section", () => {
    const html = serializeSections([
      {
        ...imageSection(2, [{ src: "https://cdn.test/a.png" }, { src: "https://cdn.test/b.png" }]),
        height: 180,
      },
    ]);
    expect(html.match(/width="300" height="180"/g)).toHaveLength(2);
  });
});

describe("serializeSections (button sections)", () => {
  function buttonSection(
    columns: 1 | 2 | 3,
    buttons: ({ label: string; href: string; bgColor?: string; textColor?: string; fullWidth?: boolean } | null)[],
    align?: "left" | "center" | "right",
  ): CampaignSection {
    return {
      id: `btn_${columns}`,
      kind: "button",
      columns,
      content: Array.from({ length: columns }, () => ""),
      buttons,
      align,
    };
  }

  it("emits a filled, color-validated button with a <font>-colored label", () => {
    const html = serializeSections([
      buttonSection(1, [{ label: "Get started", href: "https://x.test/go" }]),
    ]);
    expect(html).toContain('<td bgcolor="#2563eb" align="center" class="d3-btn-round">');
    expect(html).toContain(
      '<a href="https://x.test/go"><font color="#ffffff"><strong>Get started</strong></font></a>',
    );
    expect(html).toContain('cellpadding="14"');
    // The button rounds via the class-keyed style rule (border-radius is forbidden in
    // the sanitized body), tagging both its table and its filled cell.
    expect(html.match(/class="d3-btn-round"/g)).toHaveLength(2);
  });

  it("honors custom (validated) button colors and alignment", () => {
    const html = serializeSections([
      buttonSection(1, [{ label: "Buy", href: "https://x.test", bgColor: "#16a34a", textColor: "#000000" }], "left"),
    ]);
    expect(html).toContain('align="left"');
    expect(html).toContain('<td bgcolor="#16a34a"');
    expect(html).toContain('<font color="#000000">');
  });

  it("renders a button row (one button per column)", () => {
    const html = serializeSections([
      buttonSection(2, [
        { label: "A", href: "https://x.test/a" },
        { label: "B", href: "https://x.test/b" },
      ]),
    ]);
    expect(html.match(/<a href="https:\/\/x\.test\/[ab]">/g)).toHaveLength(2);
    expect(html.match(/width="50%"/g)).toHaveLength(2);
  });

  it("skips a button with no label or no href (never ships half-built)", () => {
    expect(serializeSections([buttonSection(1, [{ label: "Go", href: "" }])])).toBe("");
    expect(serializeSections([buttonSection(1, [{ label: "", href: "https://x.test" }])])).toBe("");
  });

  it("stretches a full-width button's table and cell to the column", () => {
    const html = serializeSections([
      buttonSection(1, [{ label: "Go", href: "https://x.test", fullWidth: true }]),
    ]);
    expect(html).toContain('cellpadding="14" align="center" class="d3-btn-round" width="100%"');
    expect(html).toContain('<td bgcolor="#2563eb" align="center" class="d3-btn-round" width="100%">');
  });

  it("omits the width attribute for a default (fit-to-label) button", () => {
    const html = serializeSections([
      buttonSection(1, [{ label: "Go", href: "https://x.test" }]),
    ]);
    // The button's own table/cell stay unsized (only the layout wrappers use 100%).
    expect(html).toContain('cellpadding="14" align="center" class="d3-btn-round"><tbody>');
    expect(html).toContain('<td bgcolor="#2563eb" align="center" class="d3-btn-round"><a');
  });
});

describe("serializeSections (divider, quote, social, card)", () => {
  const text = (html: string): CampaignSection => ({
    id: `t_${html.length}`,
    kind: "text",
    columns: 1,
    content: [html],
  });

  it("renders a horizontal rule, alongside real content", () => {
    const divider: CampaignSection = { id: "d1", kind: "divider", columns: 1, content: [""], line: true };
    const html = serializeSections([text("<p>Hi</p>"), divider]);
    expect(html).toContain("<td><hr></td>");
  });

  it("renders a fixed-height spacer (clamped)", () => {
    const spacer: CampaignSection = {
      id: "d2",
      kind: "divider",
      columns: 1,
      content: [""],
      line: false,
      height: 24,
    };
    const html = serializeSections([text("<p>Hi</p>"), spacer]);
    expect(html).toContain('<td height="24">&nbsp;</td>');
  });

  it("treats a divider-only body as empty (a lone rule isn't a real email)", () => {
    const divider: CampaignSection = { id: "d3", kind: "divider", columns: 1, content: [""], line: true };
    expect(serializeSections([divider])).toBe("");
  });

  it("renders a shaded quote with an attribution line", () => {
    const quote: CampaignSection = {
      id: "q1",
      kind: "quote",
      columns: 1,
      content: ["<p>Best tool ever</p>"],
      bgColor: "#f4f4f5",
      attribution: "Jane, Acme",
    };
    const html = serializeSections([quote]);
    expect(html).toContain('cellpadding="16"');
    expect(html).toContain('<td bgcolor="#f4f4f5"><p>Best tool ever</p><p><em>— Jane, Acme</em></p></td>');
    // A square (default) quote carries no round hook.
    expect(html).not.toContain("d3-quote-round");
  });

  it("tags a rounded quote's table and cell with the round hook", () => {
    const quote: CampaignSection = {
      id: "q-round",
      kind: "quote",
      columns: 1,
      content: ["<p>Rounded</p>"],
      bgColor: "#eff6ff",
      rounded: true,
    };
    const html = serializeSections([quote]);
    // Both the table (for border-collapse:separate) and the filled cell (for the
    // radius) get the class the email <style> targets; it survives sanitization.
    expect(html).toContain('cellpadding="16" class="d3-quote-round">');
    expect(html).toContain('<td bgcolor="#eff6ff" class="d3-quote-round"><p>Rounded</p></td>');
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("renders a social row of escaped text links", () => {
    const social: CampaignSection = {
      id: "s1",
      kind: "social",
      columns: 1,
      content: [""],
      align: "center",
      socialIntro: "Follow us:",
      socials: [
        { network: "twitter", url: "https://t.co/acme" },
        { network: "website", url: "https://acme.test" },
      ],
    };
    const html = serializeSections([social]);
    expect(html).toContain('<td align="center">Follow us: ');
    expect(html).toContain(
      '<a href="https://t.co/acme">Twitter</a> · <a href="https://acme.test">Website</a>',
    );
  });

  it("bleeds a section to full width with a padded, color-filled cell when sectionBg is set", () => {
    const html = serializeSections([{ ...text("<p>Hi</p>"), sectionBg: "#eff6ff" }]);
    // No spacer-column gutters: the colored table itself spans the full width, and
    // cellpadding insets the content from the fill edge.
    expect(html).toContain('<table role="presentation" width="100%" cellpadding="40" bgcolor="#eff6ff">');
    expect(html).toContain('<td bgcolor="#eff6ff">');
    expect(html).toContain("<p>Hi</p>");
    expect(html).not.toContain('<td width="40"></td>');
  });

  it("falls back to the uncolored gutter band for an unset or transparent sectionBg", () => {
    const plain = serializeSections([text("<p>Hi</p>")]);
    expect(serializeSections([{ ...text("<p>Hi</p>"), sectionBg: undefined }])).toBe(plain);
    expect(serializeSections([{ ...text("<p>Hi</p>"), sectionBg: "transparent" }])).toBe(plain);
    // The uncolored band uses spacer columns, not a colored cellpadding cell.
    expect(plain).toContain('<td width="40"></td>');
    expect(plain).not.toContain("cellpadding");
    expect(plain).not.toContain("bgcolor");
  });

  it("does not wrap an empty section even with a sectionBg (stays empty)", () => {
    expect(serializeSections([{ ...text(""), sectionBg: "#eff6ff" }])).toBe("");
  });

  it("omits social links with no url, and an all-empty social row", () => {
    const social: CampaignSection = {
      id: "s2",
      kind: "social",
      columns: 1,
      content: [""],
      socials: [{ network: "twitter", url: "" }],
    };
    expect(serializeSections([social])).toBe("");
  });

  it("renders a card image-left as a two-cell row", () => {
    const card: CampaignSection = {
      id: "c1",
      kind: "card",
      columns: 1,
      content: ["<p>Story</p>"],
      images: [{ src: "https://cdn.test/a.png", width: 1000, height: 500 }],
      layout: "image-left",
    };
    const html = serializeSections([card]);
    // Image hugs a 40% column (240px of the 600px body) at its natural aspect. Both
    // cells are vertically centered (valign="middle") and separated by a gutter column
    // so a short image beside long text reads balanced and uncramped.
    expect(html).toContain('<td class="d3-col" valign="middle" width="40%"><img src="https://cdn.test/a.png" alt="" width="240" height="120"></td>');
    expect(html).toContain('<td class="d3-col" valign="middle" width="60%"><p>Story</p></td>');
    expect(html).toContain('<td class="d3-col" width="24"></td>');
  });

  it("puts the image after the text for image-right", () => {
    const card: CampaignSection = {
      id: "c2",
      kind: "card",
      columns: 1,
      content: ["<p>Story</p>"],
      images: [{ src: "https://cdn.test/a.png", width: 1000, height: 500 }],
      layout: "image-right",
    };
    const html = serializeSections([card]);
    expect(html.indexOf("<p>Story</p>")).toBeLessThan(html.indexOf("<img"));
  });

  it("stacks image over text for image-top (and when only one part is present)", () => {
    const card: CampaignSection = {
      id: "c3",
      kind: "card",
      columns: 1,
      content: ["<p>Story</p>"],
      images: [{ src: "https://cdn.test/a.png", width: 600, height: 300 }],
      layout: "image-top",
    };
    const html = serializeSections([card]);
    // The card stacks an image row over a text row (2 rows), inside the band wrapper's
    // own row → 3 <tr> total.
    expect(html.match(/<tr>/g)).toHaveLength(3);
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("<p>Story</p>"));
  });
});

describe("starterSections", () => {
  it("opens a new campaign with a text block and an unset CTA button", () => {
    const s = starterSections();
    expect(s.map((x) => x.kind)).toEqual(["text", "button"]);
    expect(s[1].buttons?.[0]?.label).toBe("Get started");
    // The button has no href yet, so the starter serializes to nothing (no
    // half-built button ships, and a fresh draft isn't auto-saved as non-empty).
    expect(serializeSections(s)).toBe("");
  });
});

describe("htmlBodyToSections", () => {
  it("wraps legacy/AI flat html as a single full-width section", () => {
    const sections = htmlBodyToSections("<p>Legacy body</p>");
    expect(sections).toHaveLength(1);
    expect(sections[0].columns).toBe(1);
    expect(sections[0].kind).toBe("text");
    expect(sections[0].content).toEqual(["<p>Legacy body</p>"]);
  });

  it("yields one empty section for empty/null input", () => {
    for (const v of ["", "   ", null, undefined]) {
      const sections = htmlBodyToSections(v);
      expect(sections).toHaveLength(1);
      expect(sections[0].columns).toBe(1);
      expect(sections[0].content).toEqual([""]);
    }
  });
});

describe("resizeSection", () => {
  it("appends empty columns when growing", () => {
    const grown = resizeSection(section(1, ["<p>A</p>"]), 3);
    expect(grown.columns).toBe(3);
    expect(grown.content).toEqual(["<p>A</p>", "", ""]);
  });

  it("folds dropped columns' content into the last kept column when shrinking", () => {
    const shrunk = resizeSection(section(3, ["<p>A</p>", "<p>B</p>", "<p>C</p>"]), 1);
    expect(shrunk.columns).toBe(1);
    expect(shrunk.content).toHaveLength(1);
    // Nothing the user wrote is lost.
    expect(shrunk.content[0]).toContain("<p>A</p>");
    expect(shrunk.content[0]).toContain("<p>B</p>");
    expect(shrunk.content[0]).toContain("<p>C</p>");
  });

  it("is a no-op when the column count is unchanged", () => {
    const s = section(2, ["<p>A</p>", "<p>B</p>"]);
    expect(resizeSection(s, 2)).toBe(s);
  });

  it("appends empty image slots when growing an image section", () => {
    const grown = resizeSection(imageSection(1, [{ src: "https://cdn.test/a.png" }]), 3);
    expect(grown.columns).toBe(3);
    expect(grown.images).toEqual([{ src: "https://cdn.test/a.png" }, null, null]);
  });

  it("drops overflow images when shrinking an image section", () => {
    const shrunk = resizeSection(
      imageSection(3, [
        { src: "https://cdn.test/a.png" },
        { src: "https://cdn.test/b.png" },
        { src: "https://cdn.test/c.png" },
      ]),
      1,
    );
    expect(shrunk.images).toEqual([{ src: "https://cdn.test/a.png" }]);
  });
});

describe("setSectionKind", () => {
  it("switches a text section to image with one slot per column", () => {
    const img = setSectionKind(section(2, ["<p>A</p>", "<p>B</p>"]), "image");
    expect(img.kind).toBe("image");
    expect(img.images).toEqual([null, null]);
    // Text is preserved so toggling back doesn't lose work.
    expect(img.content).toEqual(["<p>A</p>", "<p>B</p>"]);
  });

  it("preserves an already-uploaded image when toggling back and forth", () => {
    const img = imageSection(1, [{ src: "https://cdn.test/a.png" }]);
    const asText = setSectionKind(img, "text");
    expect(asText.kind).toBe("text");
    const backToImage = setSectionKind(asText, "image");
    expect(backToImage.images).toEqual([{ src: "https://cdn.test/a.png" }]);
  });

  it("is a no-op when the kind is unchanged", () => {
    const s = section(1, ["<p>A</p>"]);
    expect(setSectionKind(s, "text")).toBe(s);
  });
});

describe("duplicateSection", () => {
  it("copies columns and content but assigns a fresh id", () => {
    const original = section(2, ["<p>A</p>", "<p>B</p>"]);
    const copy = duplicateSection(original);
    expect(copy.columns).toBe(original.columns);
    expect(copy.content).toEqual(original.content);
    expect(copy.id).not.toBe(original.id);
  });

  it("does not share the content array with the original", () => {
    const original = section(1, ["<p>A</p>"]);
    const copy = duplicateSection(original);
    copy.content[0] = "<p>changed</p>";
    expect(original.content[0]).toBe("<p>A</p>");
  });
});

describe("SectionsSchema validation", () => {
  it("accepts well-formed sections", () => {
    expect(SectionsSchema.safeParse([section(2, ["a", "b"])]).success).toBe(true);
  });

  it("rejects content whose length does not match the column count", () => {
    expect(SectionsSchema.safeParse([{ id: "x", columns: 2, content: ["only-one"] }]).success).toBe(
      false,
    );
  });

  it("rejects an out-of-range column count", () => {
    expect(
      SectionsSchema.safeParse([{ id: "x", columns: 4, content: ["a", "b", "c", "d"] }]).success,
    ).toBe(false);
  });

  it("rejects a section list whose serialized body exceeds the size ceiling", () => {
    const big = "x".repeat(100_000);
    const sections = [section(3, [big, big, big]), section(3, [big, big, big])]; // ~600 KB
    expect(SectionsSchema.safeParse(sections).success).toBe(false);
  });

  it("defaults a missing kind to text (legacy rows)", () => {
    const parsed = SectionsSchema.safeParse([{ id: "x", columns: 1, content: ["<p>hi</p>"] }]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[0].kind).toBe("text");
  });

  it("accepts a well-formed image section", () => {
    expect(
      SectionsSchema.safeParse([
        imageSection(2, [{ src: "https://cdn.test/a.png", alt: "x" }, { src: "https://cdn.test/b.png" }]),
      ]).success,
    ).toBe(true);
  });

  it("rejects an image section whose image slots don't match the column count", () => {
    expect(
      SectionsSchema.safeParse([imageSection(2, [{ src: "https://cdn.test/a.png" }])]).success,
    ).toBe(false);
  });

  it("rejects a non-http(s) image src", () => {
    expect(
      SectionsSchema.safeParse([imageSection(1, [{ src: "javascript:alert(1)" }])]).success,
    ).toBe(false);
  });

  it("accepts a fixed-height image section with originalSrc", () => {
    const s = {
      ...imageSection(1, [
        { src: "https://cdn.test/cropped.png", originalSrc: "https://cdn.test/original.png" },
      ]),
      height: 240,
    };
    expect(SectionsSchema.safeParse([s]).success).toBe(true);
  });
});

describe("safeParseSections", () => {
  it("returns the parsed sections for valid JSON", () => {
    const json = JSON.stringify([section(1, ["<p>x</p>"])]);
    expect(safeParseSections(json)?.[0].content).toEqual(["<p>x</p>"]);
  });

  it("falls back to null for null, malformed, or empty input", () => {
    expect(safeParseSections(null)).toBeNull();
    expect(safeParseSections("not json")).toBeNull();
    expect(safeParseSections("[]")).toBeNull();
  });
});

describe("email-safe invariant", () => {
  it("serialized output is unchanged by the sanitizer (what you build is what ships)", () => {
    const sections: CampaignSection[] = [
      section(1, ['<h1>Welcome</h1><p>Hello <strong>world</strong></p>']),
      section(2, ['<p>Left column</p>', '<p>Right <a href="https://x.test/path">link</a></p>']),
      section(3, ["<p>One</p>", "<p>Two</p>", "<p>Three</p>"]),
      // Image sections must round-trip too: the <img>/<a> the serializer emits is
      // built with the sanitizer's own escaping, so it is a fixed point of sanitizeHtml.
      imageSection(1, [
        { src: "https://cdn.test/banner.png", alt: "Banner", href: "https://site.test", width: 1200, height: 300 },
      ]),
      imageSection(2, [{ src: "https://cdn.test/l.png", alt: "Left" }, null]),
      // A fixed-height (cover-cropped) image section must round-trip too.
      {
        ...imageSection(1, [
          { src: "https://cdn.test/hero.png", originalSrc: "https://cdn.test/hero-full.png", alt: "Hero" },
        ]),
        height: 220,
      },
      // The new kinds must round-trip too — their bgcolor/<font color>/<hr>/spacer
      // markup is built to be a fixed point of sanitizeHtml.
      {
        id: "btn",
        kind: "button",
        columns: 2,
        content: ["", ""],
        align: "center",
        buttons: [
          { label: "Primary", href: "https://x.test/a", bgColor: "#2563eb", textColor: "#ffffff" },
          { label: "Secondary", href: "https://x.test/b", bgColor: "#16a34a", textColor: "#000000" },
        ],
      },
      { id: "rule", kind: "divider", columns: 1, content: [""], line: true },
      { id: "gap", kind: "divider", columns: 1, content: [""], line: false, height: 24 },
      {
        id: "quote",
        kind: "quote",
        columns: 1,
        content: ["<p>It just works</p>"],
        bgColor: "#f4f4f5",
        attribution: "A happy customer",
        // Rounded → emits the d3-quote-round class on table + cell, which must round-
        // trip through the sanitizer like every other serialized hook.
        rounded: true,
      },
      {
        id: "social",
        kind: "social",
        columns: 1,
        content: [""],
        align: "center",
        socialIntro: "Follow us:",
        socials: [
          { network: "twitter", url: "https://t.co/acme" },
          { network: "website", url: "https://acme.test" },
        ],
      },
      {
        id: "card",
        kind: "card",
        columns: 1,
        content: ["<p>Read the story</p>"],
        images: [{ src: "https://cdn.test/card.png", alt: "Card", width: 1000, height: 600 }],
        layout: "image-right",
      },
      // A section background fill wraps the body in a bgcolor'd table/cell — both
      // color carriers are isSafeColor-validated, so it round-trips too.
      { ...section(1, ["<p>On a tint</p>"]), sectionBg: "#eff6ff" },
    ];
    const serialized = serializeSections(sections);
    expect(sanitizeHtml(serialized)).toBe(serialized);
  });
});

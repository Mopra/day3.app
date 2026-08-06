// The Day3 Markdown reference, as plain text.
//
// Deliberately dependency-free: it is served to an AI editor as the MCP server's
// `instructions` (src/mcp/tools.ts, which pulls in the database and the send
// pipeline) AND rendered in the browser on /api-keys, so it cannot live in
// either place without dragging one into the other.
//
// This is the spec a model reads before writing an email. Keep it terse and keep
// it honest — every construct here must actually parse (see lib/campaign-markdown
// and its tests).

export const MARKDOWN_DIALECT_REFERENCE = `# Day3 Markdown

Ordinary Markdown plus a few block constructs. Each one becomes a real editable
block in Day3's visual composer, so whatever you write stays editable by hand.

  # Heading            (through ######)      a heading
  Plain paragraphs, **bold**, *italic*, \`code\`, [links](https://example.com)
  - bullet / 1. numbered lists
  ---                                        a horizontal rule
  ![Alt](https://cdn.example.com/a.png)      an image (alone on its own line)
  [![Alt](img-url)](link-url)                an image that links somewhere
  [Label](https://x.com){.button}            a call-to-action button
      options: {.button bg=#2563eb color=#ffffff full align=left}
  > A quote                                  a callout box
  > — Attribution                            optional attribution line
  :::spacer 48:::                            blank vertical space, in pixels

  :::columns                                 two or three side-by-side columns
  ### Left
  Text.
  +++
  ### Right
  Text.
  :::

  :::card image-left                         an image paired with text
  ![Alt](https://cdn.example.com/p.png)      (also image-right / image-top)

  Text beside the image.
  :::

  :::social Follow us:                       a row of profile links
  - twitter: https://x.com/acme              (twitter, linkedin, facebook,
  - website: https://acme.com                 instagram, youtube, github,
  :::                                         website, email)

  :::section {bg=#f5f5f5 align=center}       tint / align a block
  Anything above.
  :::

  ===                                        force a split between two text blocks

Images must be absolute https URLs that are already hosted publicly — the API
cannot upload files.

Personalization: {{first_name}}, {{last_name}} and {{email}} are merged per
recipient. Give blank-safe copy a fallback: {{first_name|there}}.

The footer's postal address and unsubscribe link are appended automatically and
cannot be removed.`;

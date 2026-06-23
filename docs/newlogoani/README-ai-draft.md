# Day3 — AI Draft loader (Next.js)

The three-block mark "thinking up" a draft: blocks bounce in an equalizer wave
while a caramel glow washes across them. Pure CSS — works as a **Server
Component** (no `"use client"`).

## Files
- `AiDraft.tsx` — `AiDraftMark` + `DraftWithAIButton` (imports the CSS for you)
- `day3-ai-draft.css` — keyframes + classes

## Install
Copy into your app, e.g. `components/day3/`. Uses **Hanken Grotesk** for the
button label — load it once with `next/font` (see the Queue & Send README).

## Use

```tsx
import { AiDraftMark, DraftWithAIButton } from "@/components/day3/AiDraft";

// The button (espresso primary / light secondary). Forwards onClick etc.
<DraftWithAIButton onClick={generate} />
<DraftWithAIButton variant="light" label="Draft with AI" onClick={generate} />

// Just the animated mark — as a loading indicator anywhere
<AiDraftMark />                         {/* 16px espresso */}
<AiDraftMark size={40} />               {/* hero scale */}
<AiDraftMark color="#F6F0E3" accent="#D89E5C" />   {/* on espresso bg */}
```

### Props
**`AiDraftMark`** — `size` (px per block, default 16), `color` (base, default
`#2B2019`), `accent` (glow, default `#C28A4D`). Gap and corner radius scale with
`size`.

**`DraftWithAIButton`** — `label`, `variant` (`"primary"` | `"light"`), plus any
native `<button>` props.

### Notes
- Respects `prefers-reduced-motion` (animation stops, blocks stay visible).
- Colors: espresso `#2B2019`, caramel `#C28A4D` (`#D89E5C` on dark), cream `#F6F0E3`.

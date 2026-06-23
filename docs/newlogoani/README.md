# Day3 — Queue & Send loaders (Next.js)

Four drop-in loaders built from the Day3 three-block mark. Pure CSS animation —
no JavaScript, no images — so they render fine as **Server Components** (no
`"use client"` required).

## Files
- `Day3Loaders.tsx` — the components (imports the CSS for you)
- `day3-loaders.css` — keyframes + classes

## Install
Copy the `nextjs/` folder into your app, e.g. `components/day3/`.

The components use the **Hanken Grotesk** font. If it isn't already loaded, add it
once (e.g. with `next/font`):

```tsx
// app/layout.tsx
import { Hanken_Grotesk } from "next/font/google";
const hanken = Hanken_Grotesk({ subsets: ["latin"], weight: ["400","500","600","700"] });
// …apply hanken.className on <body>, or set --font on it.
```

## Use

```tsx
import { LaunchStream, SendButton, QueueToast } from "@/components/day3/Day3Loaders";

// Launch stream — full-screen / panel loader
<LaunchStream />                     {/* cream */}
<LaunchStream variant="dark" />      {/* on espresso backgrounds */}
<LaunchStream scale={0.6} />         {/* resize the whole thing */}

// Inline button (forwards onClick / disabled / type …)
<SendButton label="Sending…" onClick={send} />

// Toast / status row
<QueueToast title="Sending your campaign" subtitle="1,248 queued · going out now" />
```

### Notes
- `LaunchStream` is natively **320 × 56**. Because the motion uses absolute pixel
  distances, resize with the `scale` prop (transform), not by setting width.
- Put `<LaunchStream variant="dark" />` only on dark/espresso backgrounds — the
  caramel glows brighter there.
- All four respect `prefers-reduced-motion` (animation stops, blocks stay visible).
- Colors: espresso `#2B2019`, caramel `#C28A4D` (`#D89E5C`/`#E0A463` on dark), cream `#F6F0E3`.

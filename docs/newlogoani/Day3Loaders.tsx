import "./day3-loaders.css";

/* ============================================================
   Day3 — Queue & Send loaders for Next.js
   Pure CSS animation → these are Server Components by default.
   No "use client" needed. Drop the folder anywhere under your
   app and import what you need.
   ============================================================ */

type Variant = "cream" | "dark";

/* ---- 1 · LAUNCH STREAM -----------------------------------
   Mail queues in from the left, lights caramel at the front,
   then rockets off to the right. Native size 320×56.
   `scale` resizes the whole thing (keyframe distances are
   absolute, so resize via transform — not width). ---------- */
export function LaunchStream({
  variant = "cream",
  scale = 1,
  className = "",
  style,
}: {
  variant?: Variant;
  scale?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={className}
      style={{ width: 320 * scale, height: 56 * scale, ...style }}
      role="status"
      aria-label="Sending"
    >
      <div
        className={`d3ls${variant === "dark" ? " d3ls--dark" : ""}`}
        style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        <span className="d3ls__b" />
        <span className="d3ls__b" />
        <span className="d3ls__b" />
        <span className="d3ls__b" />
        <span className="d3ls__b" />
      </div>
    </div>
  );
}

/* ---- 2 · SEND BUTTON -------------------------------------
   Espresso pill: dark dots feed in, caramel one launches out.
   Pass your own onClick / disabled etc. via `...rest`. ----- */
export function SendButton({
  label = "Sending…",
  className = "",
  style,
  ...rest
}: {
  label?: string;
  className?: string;
  style?: React.CSSProperties;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 13,
        background: "#2B2019",
        color: "#F6F0E3",
        border: "none",
        borderRadius: 11,
        padding: "15px 24px",
        fontFamily: "'Hanken Grotesk', sans-serif",
        fontSize: 15,
        fontWeight: 600,
        cursor: "pointer",
        ...style,
      }}
      {...rest}
    >
      <span className="d3dots" style={{ width: 40, height: 12 }} aria-hidden="true">
        <span className="d3dots__d d3dots__d--in"  style={{ left: 0,  width: 10, height: 10, background: "#F6F0E3" }} />
        <span className="d3dots__d d3dots__d--in"  style={{ left: 15, width: 10, height: 10, background: "#F6F0E3", animationDelay: "-0.18s" }} />
        <span className="d3dots__d d3dots__d--out" style={{ left: 30, width: 10, height: 10, background: "#D89E5C" }} />
      </span>
      {label}
    </button>
  );
}

/* ---- 3 · QUEUE TOAST -------------------------------------
   White status row: stream dots + title / subtitle. --------*/
export function QueueToast({
  title = "Sending your campaign",
  subtitle = "1,248 queued · going out now",
  className = "",
  style,
}: {
  title?: string;
  subtitle?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={className}
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        background: "#FFFFFF",
        borderRadius: 12,
        padding: "16px 20px",
        boxShadow: "0 4px 16px rgba(43,32,25,0.12)",
        width: 320,
        ...style,
      }}
    >
      <span className="d3dots" style={{ width: 46, height: 14 }} aria-hidden="true">
        <span className="d3dots__d d3dots__d--in"  style={{ left: 0,  width: 12, height: 12, background: "#2B2019" }} />
        <span className="d3dots__d d3dots__d--in"  style={{ left: 17, width: 12, height: 12, background: "#2B2019", animationDelay: "-0.18s" }} />
        <span className="d3dots__d d3dots__d--out" style={{ left: 34, width: 12, height: 12, background: "#C28A4D" }} />
      </span>
      <span style={{ flex: 1 }}>
        <span
          style={{
            display: "block",
            fontFamily: "'Hanken Grotesk', sans-serif",
            fontSize: 14,
            fontWeight: 600,
            color: "#2B2019",
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: "block",
            fontFamily: "'Hanken Grotesk', sans-serif",
            fontSize: 13,
            color: "#6F6555",
            marginTop: 2,
          }}
        >
          {subtitle}
        </span>
      </span>
    </div>
  );
}

import "./day3-ai-draft.css";

/* ============================================================
   Day3 — AI Draft loader for Next.js
   Pure CSS animation → Server Component by default, no
   "use client" needed.
   ============================================================ */

type CSSVars = React.CSSProperties & Record<string, string | number>;

/* ---- AiDraftMark ----------------------------------------
   Just the animated three-block mark. Size it with `size`
   (px per block); colors default to the brand. -------------*/
export function AiDraftMark({
  size = 16,
  color = "#2B2019",
  accent = "#C28A4D",
  className = "",
  style,
}: {
  size?: number;
  color?: string;
  accent?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const vars: CSSVars = {
    "--d3ai-size": `${size}px`,
    "--d3ai-color": color,
    "--d3ai-accent": accent,
    ...style,
  };
  return (
    <span className={`d3ai ${className}`} style={vars} role="status" aria-label="Drafting">
      <span className="d3ai__b" />
      <span className="d3ai__b" />
      <span className="d3ai__b" />
    </span>
  );
}

/* ---- DraftWithAIButton ----------------------------------
   Espresso primary (default) or light secondary. The mark
   sits in front of the label. Forwards onClick / disabled /
   type … via `...rest`. ------------------------------------*/
export function DraftWithAIButton({
  label = "Draft with AI",
  variant = "primary",
  className = "",
  style,
  ...rest
}: {
  label?: string;
  variant?: "primary" | "light";
  className?: string;
  style?: React.CSSProperties;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const isLight = variant === "light";
  return (
    <button
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        background: isLight ? "#FFFFFF" : "#2B2019",
        color: isLight ? "#2B2019" : "#F6F0E3",
        border: isLight ? "1px solid #E2D9C7" : "none",
        borderRadius: 11,
        padding: isLight ? "14px 23px" : "15px 24px",
        fontFamily: "'Hanken Grotesk', sans-serif",
        fontSize: 15,
        fontWeight: 600,
        cursor: "pointer",
        boxShadow: isLight ? "0 1px 2px rgba(43,32,25,0.06)" : "none",
        ...style,
      }}
      {...rest}
    >
      <AiDraftMark
        size={11}
        color={isLight ? "#2B2019" : "#F6F0E3"}
        accent={isLight ? "#C28A4D" : "#D89E5C"}
      />
      {label}
    </button>
  );
}

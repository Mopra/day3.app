import type { CSSProperties } from "react";
import type { Form } from "@/db/schema";
import { resolveFormDesign, type FormDesign, type FormDesignInput } from "@/lib/form-design";
import { isThemeColor } from "@/lib/theme";

// Server-rendered, fully self-contained signup form. Uses inline styles only so
// it renders identically whether shown as a hosted page, inside an embed iframe
// (where it must ignore the host site), or under the app's dark root layout. The
// form is a NATIVE <form> posting to the public submit endpoint — it works with
// JavaScript disabled; the only script is the optional iframe auto-resize.
//
// Interactive polish (focus rings, hover, transitions) can't be expressed inline,
// so it lives in one scoped <style> block using `.d3f-` classes; user-configured
// colors stay inline (gated by isThemeColor) and reach the CSS through the
// --d3f-accent custom property. The class names are prefixed so the block is also
// safe when the form-editor preview renders this component inside the app.

type FormState =
  | "default"
  | "check-inbox"
  | "subscribed"
  | "confirmed"
  | "opted-out"
  | "link-invalid"
  | "unavailable"
  | "error";

// The presentation fields the view reads. Narrowed from the full row so the live
// editor (which holds a client-side SignupForm) can render the same component with
// unsaved edits, while server callers still pass the full Drizzle `Form`.
export type PublicFormFields = Pick<
  Form,
  | "id"
  | "accentColor"
  | "headline"
  | "description"
  | "footerText"
  | "collectName"
  | "fields"
  | "buttonLabel"
  | "doubleOptIn"
  | "successMessage"
> & {
  // The stored JSON string (server render) or an already-resolved design object (the
  // live editor). resolveFormDesign normalizes either into a complete FormDesign.
  design: string | FormDesignInput | null;
};

// Map a custom field type to a native HTML input type.
function htmlInputType(type: string): string {
  switch (type) {
    case "email":
    case "tel":
    case "url":
    case "number":
      return type;
    default:
      return "text";
  }
}

export type PublicFormViewProps = {
  form: PublicFormFields;
  companyName: string;
  state?: string;
  reason?: string;
  embed?: boolean;
};

function safeAccent(value: string | null): string {
  return value && isThemeColor(value) ? value : "#1d1d1f";
}

function normalizeState(state?: string): FormState {
  switch (state) {
    case "check-inbox":
    case "subscribed":
    case "confirmed":
    case "opted-out":
    case "link-invalid":
    case "unavailable":
    case "error":
      return state;
    default:
      return "default";
  }
}

// Card padding — also the inset the banner image cancels so it sits flush to the edges.
const CARD_PADDING = 28;

// Interactive states + micro-transitions. The accent arrives via --d3f-accent (set
// inline on the root, isThemeColor-gated, so it can't break out of the block). The
// grey focus shadows are the fallback; browsers with color-mix() tint them from the
// accent instead. Everything here is progressive enhancement — with the block
// stripped the form still renders and submits fine.
const FORM_CSS = `
.d3f-input{transition:border-color .16s ease,box-shadow .16s ease;appearance:none;-webkit-appearance:none;outline:none}
.d3f-input::placeholder{color:#a1a1a6}
.d3f-input:hover{border-color:rgba(0,0,0,.22)}
.d3f-input:focus{border-color:var(--d3f-accent);box-shadow:0 0 0 4px rgba(0,0,0,.06)}
.d3f-button{transition:filter .16s ease,transform .16s ease,box-shadow .16s ease;outline:none;-webkit-tap-highlight-color:transparent}
.d3f-button:hover{filter:brightness(1.12)}
.d3f-button:active{transform:scale(.985);filter:brightness(.97)}
.d3f-button:focus-visible{box-shadow:0 0 0 4px rgba(0,0,0,.12)}
.d3f-status-icon{background:#f2f2f7}
@supports (color:color-mix(in srgb,red,red)){
.d3f-input:focus{box-shadow:0 0 0 4px color-mix(in srgb,var(--d3f-accent) 14%,transparent)}
.d3f-button:focus-visible{box-shadow:0 0 0 4px color-mix(in srgb,var(--d3f-accent) 28%,transparent)}
.d3f-status-icon{background:color-mix(in srgb,currentColor 10%,#fff)}
}
.d3f-powered{transition:color .16s ease}
.d3f-powered:hover{color:#6e6e73}
@media (prefers-reduced-motion:reduce){.d3f-root *{transition:none !important;animation:none !important}}
`;

// Embeds stay transparent so they blend into the host site; the hosted page paints the
// user's page background behind the card.
const wrapper = (embed: boolean, design: FormDesign, accent: string): CSSProperties =>
  ({
    boxSizing: "border-box",
    minHeight: embed ? "auto" : "100vh",
    margin: 0,
    padding: embed ? "12px" : "48px 20px",
    display: "flex",
    alignItems: embed ? "stretch" : "center",
    justifyContent: "center",
    background: embed ? "transparent" : design.pageBg,
    fontFamily:
      "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    color: design.textColor,
    WebkitFontSmoothing: "antialiased",
    "--d3f-accent": accent,
  }) as CSSProperties;

const card = (design: FormDesign): CSSProperties => ({
  boxSizing: "border-box",
  width: "100%",
  maxWidth: 440,
  background: design.cardBg,
  borderRadius: design.cornerRadius,
  // Clip the flush banner image's corners to the card's roundness.
  overflow: "hidden",
  padding: CARD_PADDING,
  // Hairline edge + a soft, low ambient shadow — reads as a surface, not a box.
  boxShadow:
    "0 0 0 1px rgba(17,17,20,.04), 0 2px 6px rgba(17,17,20,.04), 0 16px 40px -12px rgba(17,17,20,.1)",
});

// The top banner image, rendered flush across the card by cancelling the card padding.
function BannerImage({ design }: { design: FormDesign }) {
  if (!design.imageUrl) return null;
  return (
    // Plain <img> (not next/image): a self-contained, inline-styled form rendered
    // standalone (hosted page / iframe), where next/image isn't available.
    <img
      src={design.imageUrl}
      alt={design.imageAlt}
      style={{
        display: "block",
        width: `calc(100% + ${CARD_PADDING * 2}px)`,
        maxHeight: 220,
        objectFit: "cover",
        margin: `-${CARD_PADDING}px -${CARD_PADDING}px 22px`,
      }}
    />
  );
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 500,
  marginBottom: 7,
  color: "#3a3a3c",
};

// 16px input text is deliberate: anything smaller makes iOS Safari zoom the page on
// focus, which is the single most common way embedded forms feel broken on phones.
const inputStyle: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  padding: "12px 14px",
  fontSize: 16,
  borderRadius: 10,
  border: "1px solid rgba(0,0,0,.12)",
  marginBottom: 16,
  background: "#fff",
  color: "#1d1d1f",
};

const AUTO_RESIZE_SCRIPT = `(function(){function h(){var d=document.documentElement,b=document.body;var height=Math.max(b.scrollHeight,d.scrollHeight,b.offsetHeight,d.offsetHeight);try{parent.postMessage({type:'day3:resize',height:height},'*');}catch(e){}}if(document.readyState!=='loading'){h();}else{document.addEventListener('DOMContentLoaded',h);}window.addEventListener('load',h);if(window.ResizeObserver){new ResizeObserver(h).observe(document.body);}})();`;

function StatusCard({
  title,
  body,
  accent,
  design,
}: {
  title: string;
  body: string;
  accent: string;
  design: FormDesign;
}) {
  return (
    <div style={{ textAlign: "center", padding: "8px 0" }}>
      <div
        aria-hidden
        className="d3f-status-icon"
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          color: accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 18px",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path
            d="M4 10.5l4.2 4.2L16 6.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h1
        style={{
          margin: "0 0 8px",
          fontSize: 21,
          fontWeight: 600,
          letterSpacing: "-0.014em",
          lineHeight: 1.3,
          color: design.headingColor,
        }}
      >
        {title}
      </h1>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: design.textColor }}>{body}</p>
    </div>
  );
}

export function PublicFormView({ form, companyName, state, reason, embed = false }: PublicFormViewProps) {
  const accent = safeAccent(form.accentColor);
  const design = resolveFormDesign(form.design);
  const view = normalizeState(state);
  const action = `/api/public/forms/${form.id}/submit`;
  const headline = form.headline?.trim() || `Subscribe to ${companyName}`;
  const footerText = form.footerText?.trim();

  let content: React.ReactNode;

  if (view === "check-inbox") {
    content = (
      <StatusCard
        accent={accent}
        design={design}
        title="Almost there — check your inbox"
        body={
          form.successMessage?.trim() ||
          `We sent a confirmation link to your email. Click it to finish subscribing to ${companyName}.`
        }
      />
    );
  } else if (view === "subscribed" || view === "confirmed") {
    content = (
      <StatusCard
        accent={accent}
        design={design}
        title="You're subscribed"
        body={form.successMessage?.trim() || `Thanks for subscribing to ${companyName}.`}
      />
    );
  } else if (view === "opted-out") {
    content = (
      <StatusCard
        accent={accent}
        design={design}
        title="You're not subscribed"
        body="This address previously opted out, so we didn't re-subscribe it."
      />
    );
  } else if (view === "link-invalid") {
    content = (
      <StatusCard
        accent="#9ca3af"
        design={design}
        title="This link is invalid or has expired"
        body="Please sign up again to receive a fresh confirmation link."
      />
    );
  } else if (view === "unavailable") {
    content = (
      <StatusCard
        accent="#9ca3af"
        design={design}
        title="This form is no longer available"
        body="The owner has turned off this signup form."
      />
    );
  } else {
    // default + error → render the form
    content = (
      <>
        <h1
          style={{
            margin: "0 0 8px",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            lineHeight: 1.25,
            color: design.headingColor,
          }}
        >
          {headline}
        </h1>
        {form.description?.trim() ? (
          <p
            style={{
              margin: "0 0 22px",
              fontSize: 15,
              lineHeight: 1.55,
              letterSpacing: "-0.008em",
              color: design.textColor,
            }}
          >
            {form.description}
          </p>
        ) : (
          <div style={{ height: 14 }} />
        )}

        {view === "error" ? (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              color: "#b91c1c",
              border: "1px solid rgba(185,28,28,.15)",
              borderRadius: 10,
              padding: "11px 14px",
              fontSize: 13,
              lineHeight: 1.5,
              marginBottom: 16,
            }}
          >
            {reason === "email"
              ? "Please enter a valid email address."
              : "Something went wrong. Please try again."}
          </div>
        ) : null}

        <form method="post" action={action}>
          {form.fields.map((field) => (
            <div key={field.key}>
              <label style={labelStyle} htmlFor={`day3-${field.key}`}>
                {field.label}
                {field.required ? <span style={{ color: accent }}> *</span> : null}
              </label>
              <input
                id={`day3-${field.key}`}
                className="d3f-input"
                style={inputStyle}
                type={htmlInputType(field.type)}
                name={field.key}
                required={field.required}
                autoComplete={
                  field.key === "first_name"
                    ? "given-name"
                    : field.key === "last_name"
                      ? "family-name"
                      : "off"
                }
                maxLength={500}
              />
            </div>
          ))}

          <label style={labelStyle} htmlFor="day3-email">
            Email
          </label>
          <input
            id="day3-email"
            className="d3f-input"
            style={inputStyle}
            type="email"
            name="email"
            required
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="email"
            placeholder="you@example.com"
          />

          {/* Honeypot: hidden from humans, catches naive bots. */}
          <div aria-hidden style={{ position: "absolute", left: "-9999px", top: "auto", height: 0, overflow: "hidden" }}>
            <label htmlFor="day3-hp">Leave this field empty</label>
            <input id="day3-hp" type="text" name="_hp" tabIndex={-1} autoComplete="off" />
          </div>

          <button
            type="submit"
            className="d3f-button"
            style={{
              width: "100%",
              padding: "13px 18px",
              marginTop: 6,
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              fontFamily: "inherit",
              color: "#fff",
              background: accent,
              border: "none",
              // Pill — the one deliberately expressive shape on an otherwise quiet card.
              borderRadius: 980,
              cursor: "pointer",
            }}
          >
            {form.buttonLabel || "Subscribe"}
          </button>
        </form>

        {form.doubleOptIn ? (
          <p style={{ margin: "14px 0 0", fontSize: 12, lineHeight: 1.5, color: "#86868b", textAlign: "center" }}>
            We&apos;ll email you a link to confirm your subscription.
          </p>
        ) : null}

        {footerText ? (
          <p
            style={{
              margin: "18px 0 0",
              fontSize: 13,
              lineHeight: 1.6,
              color: design.textColor,
              textAlign: "center",
              whiteSpace: "pre-line",
            }}
          >
            {footerText}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <main className="d3f-root" style={wrapper(embed, design, accent)}>
      <style dangerouslySetInnerHTML={{ __html: FORM_CSS }} />
      <div style={card(design)}>
        <BannerImage design={design} />
        {content}
        <p style={{ margin: "20px 0 0", fontSize: 11, letterSpacing: "0.01em", color: "#b4b4b9", textAlign: "center" }}>
          {/* Marketing site (apex), not the app host — this link is shown to the
              form's visitors, who are prospects, not signed-in users. */}
          <a
            href="https://day3.app"
            target="_blank"
            rel="noopener noreferrer"
            className="d3f-powered"
            style={{ color: "inherit", textDecoration: "none" }}
          >
            Powered by Day3
          </a>
        </p>
      </div>
      {embed ? <script dangerouslySetInnerHTML={{ __html: AUTO_RESIZE_SCRIPT }} /> : null}
    </main>
  );
}

import type { CSSProperties } from "react";
import type { Form } from "@/db/schema";

// Server-rendered, fully self-contained signup form. Uses inline styles only so
// it renders identically whether shown as a hosted page, inside an embed iframe
// (where it must ignore the host site), or under the app's dark root layout. The
// form is a NATIVE <form> posting to the public submit endpoint — it works with
// JavaScript disabled; the only script is the optional iframe auto-resize.

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
  | "collectName"
  | "fields"
  | "buttonLabel"
  | "doubleOptIn"
  | "successMessage"
>;

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
  return value && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : "#111827";
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

const wrapper = (embed: boolean): CSSProperties => ({
  boxSizing: "border-box",
  minHeight: embed ? "auto" : "100vh",
  margin: 0,
  padding: embed ? "12px" : "40px 16px",
  display: "flex",
  alignItems: embed ? "stretch" : "center",
  justifyContent: "center",
  background: embed ? "transparent" : "#f6f7f9",
  fontFamily:
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  color: "#111827",
});

const card: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  maxWidth: 440,
  background: "#ffffff",
  borderRadius: 14,
  padding: 28,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.04)",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
  color: "#374151",
};

const inputStyle: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  padding: "11px 12px",
  fontSize: 15,
  borderRadius: 8,
  border: "1px solid #d1d5db",
  marginBottom: 14,
  background: "#fff",
  color: "#111827",
};

const AUTO_RESIZE_SCRIPT = `(function(){function h(){var d=document.documentElement,b=document.body;var height=Math.max(b.scrollHeight,d.scrollHeight,b.offsetHeight,d.offsetHeight);try{parent.postMessage({type:'day3:resize',height:height},'*');}catch(e){}}if(document.readyState!=='loading'){h();}else{document.addEventListener('DOMContentLoaded',h);}window.addEventListener('load',h);if(window.ResizeObserver){new ResizeObserver(h).observe(document.body);}})();`;

function StatusCard({
  title,
  body,
  accent,
}: {
  title: string;
  body: string;
  accent: string;
}) {
  return (
    <div style={{ textAlign: "center" }}>
      <div
        aria-hidden
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: accent,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 16px",
          fontSize: 22,
          lineHeight: 1,
        }}
      >
        ✓
      </div>
      <h1 style={{ margin: "0 0 8px", fontSize: 19 }}>{title}</h1>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#4b5563" }}>{body}</p>
    </div>
  );
}

export function PublicFormView({ form, companyName, state, reason, embed = false }: PublicFormViewProps) {
  const accent = safeAccent(form.accentColor);
  const view = normalizeState(state);
  const action = `/api/public/forms/${form.id}/submit`;
  const headline = form.headline?.trim() || `Subscribe to ${companyName}`;

  let content: React.ReactNode;

  if (view === "check-inbox") {
    content = (
      <StatusCard
        accent={accent}
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
        title="You're subscribed! 🎉"
        body={form.successMessage?.trim() || `Thanks for subscribing to ${companyName}.`}
      />
    );
  } else if (view === "opted-out") {
    content = (
      <StatusCard
        accent={accent}
        title="You're not subscribed"
        body="This address previously opted out, so we didn't re-subscribe it."
      />
    );
  } else if (view === "link-invalid") {
    content = (
      <StatusCard
        accent="#9ca3af"
        title="This link is invalid or has expired"
        body="Please sign up again to receive a fresh confirmation link."
      />
    );
  } else if (view === "unavailable") {
    content = (
      <StatusCard
        accent="#9ca3af"
        title="This form is no longer available"
        body="The owner has turned off this signup form."
      />
    );
  } else {
    // default + error → render the form
    content = (
      <>
        <h1 style={{ margin: "0 0 6px", fontSize: 20 }}>{headline}</h1>
        {form.description?.trim() ? (
          <p style={{ margin: "0 0 18px", fontSize: 14, lineHeight: 1.6, color: "#4b5563" }}>
            {form.description}
          </p>
        ) : (
          <div style={{ height: 12 }} />
        )}

        {view === "error" ? (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              color: "#991b1b",
              border: "1px solid #fecaca",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 13,
              marginBottom: 14,
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
            style={inputStyle}
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />

          {/* Honeypot: hidden from humans, catches naive bots. */}
          <div aria-hidden style={{ position: "absolute", left: "-9999px", top: "auto", height: 0, overflow: "hidden" }}>
            <label htmlFor="day3-hp">Leave this field empty</label>
            <input id="day3-hp" type="text" name="_hp" tabIndex={-1} autoComplete="off" />
          </div>

          <button
            type="submit"
            style={{
              width: "100%",
              padding: "12px 16px",
              fontSize: 15,
              fontWeight: 600,
              color: "#fff",
              background: accent,
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            {form.buttonLabel || "Subscribe"}
          </button>
        </form>

        {form.doubleOptIn ? (
          <p style={{ margin: "12px 0 0", fontSize: 12, lineHeight: 1.5, color: "#9ca3af", textAlign: "center" }}>
            We&apos;ll email you a link to confirm your subscription.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <main style={wrapper(embed)}>
      <div style={card}>
        {content}
        <p style={{ margin: "18px 0 0", fontSize: 11, color: "#cbd5e1", textAlign: "center" }}>
          <a
            href="https://go.day3.app"
            target="_blank"
            rel="noopener noreferrer"
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

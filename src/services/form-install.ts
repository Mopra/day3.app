import type { Form } from "../db/schema";
import { formsBaseUrl, hostedFormUrl, prettyFormUrl } from "../lib/public-url";

// Ready-to-paste install assets for a form's dashboard "Install" panel. Built
// server-side so the public base URL (FORMS_URL) is the single source of truth.
export type FormInstall = {
  hostedUrl: string; // stable share/embed page
  prettyUrl: string | null; // human-friendly share link (needs an account slug)
  iframeSnippet: string; // recommended embed (works in every no-code builder)
  htmlSnippet: string; // raw <form> for full control / no-JS
  inlineSnippet: string; // JS widget, rendered inline where the div sits
  popupSnippet: string; // JS widget, opens as a modal on click
  aiPrompt: string; // self-contained prompt to paste into an AI coding assistant
};

export function buildFormInstall(form: Form, accountSlug: string | null): FormInstall {
  const base = formsBaseUrl();
  const hostedUrl = hostedFormUrl(base, form.id);
  const prettyUrl = accountSlug ? prettyFormUrl(base, accountSlug, form.slug) : null;
  const submitUrl = `${base}/api/public/forms/${form.id}/submit`;

  // The iframe + a tiny listener that resizes it to the form's content height
  // (the form posts its height via postMessage — see public-form-view.tsx).
  const iframeSnippet = `<iframe src="${hostedUrl}?embed=1" data-day3-form="${form.id}" title="${escapeAttr(form.name)}" style="border:0;width:100%;max-width:440px;height:520px;overflow:hidden" loading="lazy"></iframe>
<script>
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "day3:resize") return;
    var f = document.querySelector('iframe[data-day3-form="${form.id}"]');
    if (f) f.style.height = e.data.height + "px";
  });
</script>`;

  // A native HTML form. Cross-origin POST (no CORS preflight), works with JS
  // disabled; on submit the browser is redirected to the hosted result page.
  const customFieldsHtml = (form.fields ?? [])
    .map(
      (f) => `
  <label>
    ${escapeText(f.label)}
    <input type="${htmlInputType(f.type)}" name="${escapeAttr(f.key)}"${f.required ? " required" : ""} />
  </label>`,
    )
    .join("");
  const htmlSnippet = `<form action="${submitUrl}" method="post">${customFieldsHtml}
  <label>
    Email
    <input type="email" name="email" placeholder="you@example.com" required />
  </label>
  <!-- anti-spam honeypot: keep this hidden -->
  <input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true" />
  <button type="submit">${escapeText(form.buttonLabel)}</button>
</form>`;

  // JS widget (embed.js): convenience over the iframe — supports inline render
  // and click/auto popups. Loads the form from its own <script> origin.
  const scriptUrl = `${base}/embed.js`;
  const inlineSnippet = `<div data-day3-form="${form.id}"></div>
<script src="${scriptUrl}" async></script>`;
  const popupSnippet = `<button data-day3-form="${form.id}" data-day3-mode="popup">${escapeText(form.buttonLabel)}</button>
<script src="${scriptUrl}" async></script>

<!-- Or open automatically instead of on click — put this on any element:
     data-day3-trigger="delay:5000"   (after 5s)
     data-day3-trigger="exit-intent"  (when leaving)
     data-day3-trigger="scroll:50"    (after scrolling 50%) -->`;

  // A copy-paste prompt for the user's own AI assistant (ChatGPT, Claude, Cursor,
  // Copilot…). It bundles the two snippets the AI shouldn't tamper with and the
  // rules that keep signups flowing, so a non-technical user can hand the whole
  // integration to an AI without knowing what an iframe or a form action is.
  const collected = ["Email", ...(form.fields ?? []).map((f) => f.label)].join(", ");
  const aiPrompt = `I want to add my newsletter signup form to my website. The form is hosted by Day3 — please integrate it cleanly so visitors can subscribe. It collects: ${collected}.

RECOMMENDED — embed this iframe. It auto-resizes and works on any site. Paste it exactly as-is where the form should appear; do NOT change the src, the data-day3-form attribute, or the <script>:

${iframeSnippet}

ALTERNATIVE — if you'd rather build a native form so it fully matches my site's design, use this raw HTML instead. You may restyle it freely, but keep the action URL, every name="..." attribute, and the hidden "_hp" honeypot field exactly as written — those are what deliver signups to Day3:

${htmlSnippet}

Please:
- First ask me what my website is built with (e.g. plain HTML, WordPress, Webflow, Squarespace, Shopify, React/Next.js), then give me step-by-step instructions for that platform.
- Place the form somewhere sensible (a footer, a dedicated section, or a popup) and make sure it's responsive on mobile.
- Pick ONE of the two options above — don't include both.
- You don't need to build any backend or database: after someone signs up, Day3 handles confirmation emails and stores the subscriber automatically.`;

  return { hostedUrl, prettyUrl, iframeSnippet, htmlSnippet, inlineSnippet, popupSnippet, aiPrompt };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlInputType(type: string): string {
  return ["email", "tel", "url", "number"].includes(type) ? type : "text";
}

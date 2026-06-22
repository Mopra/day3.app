import type { Form } from "../db/schema";
import { formsBaseUrl, hostedFormUrl, prettyFormUrl } from "../lib/public-url";

// Ready-to-paste install assets for a form's dashboard "Install" panel. Built
// server-side so the public base URL (FORMS_URL) is the single source of truth.
export type FormInstall = {
  hostedUrl: string; // stable share/embed page
  prettyUrl: string | null; // human-friendly share link (needs an account slug)
  iframeSnippet: string; // recommended embed (works in every no-code builder)
  htmlSnippet: string; // raw <form> for full control / no-JS
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
  const htmlSnippet = `<form action="${submitUrl}" method="post">
  <label>
    Email
    <input type="email" name="email" placeholder="you@example.com" required />
  </label>${
    form.collectName
      ? `
  <label>
    First name
    <input type="text" name="firstName" />
  </label>`
      : ""
  }
  <!-- anti-spam honeypot: keep this hidden -->
  <input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true" />
  <button type="submit">${escapeText(form.buttonLabel)}</button>
</form>`;

  return { hostedUrl, prettyUrl, iframeSnippet, htmlSnippet };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

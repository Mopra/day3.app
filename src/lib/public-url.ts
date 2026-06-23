// Public signup forms live under /f on the app domain (production runs on
// go.day3.app, so the forms are at go.day3.app/f/...). They are intentionally
// NOT on a separate host — a host-based rewrite would hijack the whole app.
//   • stable / embed URL:  /f/<id>                       (rename-proof)
//   • pretty share URL:    /f/<account-slug>/<form-slug>
// Both are plain public routes (see proxy.ts); the two depths never collide.

/** Absolute, public-facing URL of a hosted form's stable page (used for embeds). */
export function hostedFormUrl(baseUrl: string, formId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/f/${formId}`;
}

/** Absolute, public-facing pretty URL (account slug + form slug). */
export function prettyFormUrl(baseUrl: string, accountSlug: string, formSlug: string): string {
  return `${baseUrl.replace(/\/$/, "")}/f/${accountSlug}/${formSlug}`;
}

// Absolute base for form links built off-request (e.g. the worker's confirmation
// email, and the dashboard install snippets). Defaults to APP_URL — which in
// production is the app domain (go.day3.app) — and can be overridden with
// FORMS_URL if forms are ever served from a different base.
export function formsBaseUrl(): string {
  const explicit = process.env.FORMS_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const app = process.env.APP_URL ?? "";
  return app.replace(/\/$/, "");
}

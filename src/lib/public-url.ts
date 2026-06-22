// The public signup-form surface lives on its own host (go.day3.app) so the
// pretty share path go.day3.app/<account-slug>/<form-slug> can occupy the root
// namespace without colliding with the authenticated app's routes. The proxy
// (proxy.ts) rewrites that host's page paths under /hosted; the API
// (/api/public/...) and Next internals are left untouched. In local dev there is
// no such host, so the same pages are reachable directly at /hosted/... .
// (The segment must not be underscore-prefixed — Next treats _folders as private
// and excludes them from routing.)

export const FORMS_HOST = (process.env.FORMS_HOST ?? "go.day3.app").toLowerCase();

export function isFormsHost(host: string | null | undefined): boolean {
  if (!host) return false;
  // Strip a port (dev/proxies) before comparing.
  return host.split(":")[0].toLowerCase() === FORMS_HOST.split(":")[0];
}

// Page paths are served verbatim on the forms host (rewritten to /hosted by the
// proxy) and under the explicit /hosted prefix everywhere else (dev / app host).
export function formsPathPrefix(host: string | null | undefined): string {
  return isFormsHost(host) ? "" : "/hosted";
}

/** Absolute, public-facing URL of a hosted form's stable page (used for embeds). */
export function hostedFormUrl(baseUrl: string, formId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/f/${formId}`;
}

/** Absolute, public-facing pretty URL (account slug + form slug). */
export function prettyFormUrl(baseUrl: string, accountSlug: string, formSlug: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${accountSlug}/${formSlug}`;
}

// Absolute base of the public forms host, for links built off-request (e.g. the
// worker's confirmation email). Falls back to APP_URL so a single-domain dev
// setup still produces working links.
export function formsBaseUrl(): string {
  const explicit = process.env.FORMS_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const app = process.env.APP_URL ?? "";
  return app.replace(/\/$/, "");
}

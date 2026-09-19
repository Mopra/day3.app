/**
 * Every outbound link to written help, in one place.
 *
 * Help lives on two domains and they are not interchangeable:
 *
 *   - `docs.day3.app` is the **API reference**. It is written for someone with
 *     an editor open, and it covers only what the v1 API covers. It has no page
 *     on automations, forms, metrics or billing, and no "how do I send a
 *     campaign" page at all.
 *   - `day3.app` carries the long-form, non-API help — deliverability, SPF/DKIM,
 *     double opt-in, the GDPR — which is what most of this app's users actually
 *     need when they get stuck.
 *
 * So a link is chosen per surface, not per app: an API panel deep-links the
 * reference, the Sending page links the DNS explainer. `kind` is what lets a
 * surface say which of the two it is showing, and `helpLinksForPath` is the one
 * route→help map. One resolver rather than a link literal at each call site,
 * for the same reason `footer-address.ts` is one resolver: four copies of a URL
 * drift, and a dead help link is worse than no help link.
 */

/** The API reference. */
export const DOCS_ORIGIN = "https://docs.day3.app";
/** The marketing site, which carries the long-form guides. */
export const SITE_ORIGIN = "https://day3.app";

export type HelpLinkKind =
  /** A page of the API reference on docs.day3.app. */
  | "reference"
  /** Long-form help on day3.app — readable without writing any code. */
  | "guide";

export type HelpLink = {
  /** Link text. Short enough to sit in a popover row. */
  label: string;
  href: string;
  /** One line saying what the page answers, shown under the label. */
  blurb: string;
  kind: HelpLinkKind;
};

/** Absolute URL for a path on the API reference. */
export function docsUrl(path = "/"): string {
  return `${DOCS_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Absolute URL for a path on the marketing site. */
export function siteUrl(path = "/"): string {
  return `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The API reference, page by page. Keys mirror the routes in the docs repo
 * (`day3.app.docs/app/<key>/page.mdx`) so a page that is renamed there is
 * findable here.
 */
export const REFERENCE: Record<string, HelpLink> = {
  home: {
    label: "API reference",
    href: docsUrl("/"),
    blurb: "Every endpoint, with real request and response shapes.",
    kind: "reference",
  },
  quickstart: {
    label: "Quickstart",
    href: docsUrl("/quickstart"),
    blurb: "From nothing to a delivered email in three steps.",
    kind: "reference",
  },
  authentication: {
    label: "Authentication",
    href: docsUrl("/authentication"),
    blurb: "API keys, the two scopes, and how to send them.",
    kind: "reference",
  },
  conventions: {
    label: "Conventions",
    href: docsUrl("/conventions"),
    blurb: "Pagination, idempotency and the shape every response shares.",
    kind: "reference",
  },
  errors: {
    label: "Errors",
    href: docsUrl("/errors"),
    blurb: "What each error code means and what to do about it.",
    kind: "reference",
  },
  emails: {
    label: "Emails",
    href: docsUrl("/emails"),
    blurb: "Send transactional mail: receipts, resets, magic links.",
    kind: "reference",
  },
  audiences: {
    label: "Audiences",
    href: docsUrl("/audiences"),
    blurb: "Create and manage the lists your contacts live in.",
    kind: "reference",
  },
  contacts: {
    label: "Contacts",
    href: docsUrl("/contacts"),
    blurb: "Add, update and unsubscribe contacts in bulk.",
    kind: "reference",
  },
  fields: {
    label: "Fields",
    href: docsUrl("/fields"),
    blurb: "Custom fields, and using them as merge tags.",
    kind: "reference",
  },
  segments: {
    label: "Segments",
    href: docsUrl("/segments"),
    blurb: "Saved filters that scope a send to part of a list.",
    kind: "reference",
  },
  topics: {
    label: "Topics",
    href: docsUrl("/topics"),
    blurb: "Let people opt out of one kind of mail, not all of it.",
    kind: "reference",
  },
  suppressions: {
    label: "Suppressions",
    href: docsUrl("/suppressions"),
    blurb: "The addresses Day3 will never mail, and why.",
    kind: "reference",
  },
  campaigns: {
    label: "Campaigns",
    href: docsUrl("/campaigns"),
    blurb: "Draft, preview, test and send campaigns from code.",
    kind: "reference",
  },
  webhooks: {
    label: "Webhooks",
    href: docsUrl("/webhooks"),
    blurb: "Event payloads and how to verify a signature.",
    kind: "reference",
  },
  webhookEndpoints: {
    label: "Managing endpoints",
    href: docsUrl("/webhooks/endpoints"),
    blurb: "Retries, delivery history and rotating a secret.",
    kind: "reference",
  },
  mcp: {
    label: "MCP server",
    href: docsUrl("/mcp"),
    blurb: "Drive Day3 from Claude, Cursor or VS Code.",
    kind: "reference",
  },
  guides: {
    label: "Guides",
    href: docsUrl("/guides"),
    blurb: "Walkthroughs for the jobs that cross several endpoints.",
    kind: "reference",
  },
  migrateList: {
    label: "Migrate a list",
    href: docsUrl("/guides/migrate-a-list"),
    blurb: "Move a list off another provider without losing deliverability.",
    kind: "reference",
  },
};

/**
 * Long-form help on the marketing site. These are the pages that answer the
 * questions the reference deliberately does not — and they are the only help
 * that is useful to someone who will never call the API.
 */
export const GUIDE: Record<string, HelpLink> = {
  deliverability: {
    label: "Deliverability, end to end",
    href: siteUrl("/deliverability"),
    blurb: "Everything that decides whether your mail reaches the inbox.",
    kind: "guide",
  },
  spfDkimDmarc: {
    label: "SPF, DKIM and DMARC explained",
    href: siteUrl("/blog/spf-dkim-dmarc-explained"),
    blurb: "What each DNS record does, with the actual records.",
    kind: "guide",
  },
  whySpam: {
    label: "Why email goes to spam",
    href: siteUrl("/blog/why-email-goes-to-spam"),
    blurb: "The causes worth fixing, in the order they matter.",
    kind: "guide",
  },
  doubleOptIn: {
    label: "Double opt-in and the GDPR",
    href: siteUrl("/blog/gdpr-double-opt-in"),
    blurb: "Why confirmation emails are on by default, and when to turn them off.",
    kind: "guide",
  },
  optInVsOptOut: {
    label: "Opt-in vs opt-out",
    href: siteUrl("/blog/gdpr-opt-in-vs-opt-out"),
    blurb: "What consent has to look like before you can mail someone.",
    kind: "guide",
  },
  oneClickUnsubscribe: {
    label: "One-click unsubscribe",
    href: siteUrl("/blog/one-click-unsubscribe-rfc-8058"),
    blurb: "What Gmail and Yahoo now require, and what Day3 adds for you.",
    kind: "guide",
  },
  oneDomain: {
    label: "Transactional and marketing on one domain",
    href: siteUrl("/blog/transactional-and-marketing-one-domain"),
    blurb: "How to run both without one poisoning the other.",
    kind: "guide",
  },
  migrateWithoutLosing: {
    label: "Migrate a list without losing deliverability",
    href: siteUrl("/blog/migrate-email-list-without-losing-deliverability"),
    blurb: "Warming up on a new domain, and the first send that goes wrong.",
    kind: "guide",
  },
  pricing: {
    label: "Plans and pricing",
    href: siteUrl("/pricing"),
    blurb: "What each plan includes, and what happens at the limits.",
    kind: "guide",
  },
  perSendPricing: {
    label: "Per-subscriber vs per-send pricing",
    href: siteUrl("/blog/per-subscriber-vs-per-send-email-pricing"),
    blurb: "Why Day3 meters emails and never the size of your list.",
    kind: "guide",
  },
  gdpr: {
    label: "Day3 and the GDPR",
    href: siteUrl("/gdpr"),
    blurb: "Where data sits, who processes it, and the paperwork.",
    kind: "guide",
  },
  security: {
    label: "Security",
    href: siteUrl("/security"),
    blurb: "How the platform is built and what it is audited against.",
    kind: "guide",
  },
};

/**
 * Route → the help that answers the question someone has on that page.
 *
 * Matched by longest prefix, so `/audiences/aud_123` picks the `/audiences/`
 * entry over `/audiences`, and any route with no entry of its own still gets
 * `FALLBACK_HELP`. Keep each list to three: this renders in a popover, and a
 * list long enough to scan is a list nobody reads.
 */
const ROUTE_HELP: { prefix: string; links: HelpLink[] }[] = [
  // The work
  { prefix: "/dashboard", links: [GUIDE.deliverability, GUIDE.doubleOptIn, REFERENCE.quickstart] },
  {
    prefix: "/campaigns",
    links: [GUIDE.whySpam, GUIDE.oneClickUnsubscribe, REFERENCE.campaigns],
  },
  // No reference page covers automations — the long-form help is the honest link.
  { prefix: "/automations", links: [GUIDE.doubleOptIn, GUIDE.deliverability] },
  { prefix: "/audiences", links: [REFERENCE.audiences, REFERENCE.migrateList, GUIDE.optInVsOptOut] },
  {
    prefix: "/audiences/",
    links: [REFERENCE.contacts, REFERENCE.fields, REFERENCE.migrateList],
  },
  { prefix: "/forms", links: [GUIDE.doubleOptIn, GUIDE.optInVsOptOut, REFERENCE.fields] },
  { prefix: "/activity", links: [REFERENCE.webhooks, REFERENCE.errors, GUIDE.whySpam] },
  { prefix: "/metrics", links: [GUIDE.deliverability, GUIDE.whySpam, GUIDE.oneClickUnsubscribe] },
  {
    prefix: "/sending",
    links: [GUIDE.spfDkimDmarc, GUIDE.oneDomain, GUIDE.deliverability],
  },
  { prefix: "/domains", links: [GUIDE.spfDkimDmarc, GUIDE.deliverability] },
  { prefix: "/senders", links: [GUIDE.spfDkimDmarc, GUIDE.oneDomain] },

  // Account
  { prefix: "/billing", links: [GUIDE.pricing, GUIDE.perSendPricing] },
  {
    prefix: "/api-keys",
    links: [REFERENCE.quickstart, REFERENCE.authentication, REFERENCE.mcp],
  },
  { prefix: "/settings", links: [GUIDE.gdpr, GUIDE.security] },
];

/** Shown on any route with no help of its own — never an empty popover. */
export const FALLBACK_HELP: HelpLink[] = [
  GUIDE.deliverability,
  REFERENCE.home,
  REFERENCE.quickstart,
];

/**
 * The help worth offering on `pathname`. Longest matching prefix wins; a route
 * nobody mapped falls back rather than showing nothing.
 */
export function helpLinksForPath(pathname: string): HelpLink[] {
  let best: { prefix: string; links: HelpLink[] } | null = null;
  for (const entry of ROUTE_HELP) {
    // `/audiences` matches the route itself and anything below it, but must not
    // match `/audiences-archive`.
    const matches =
      pathname === entry.prefix ||
      pathname.startsWith(entry.prefix.endsWith("/") ? entry.prefix : `${entry.prefix}/`);
    if (matches && (best === null || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return best?.links ?? FALLBACK_HELP;
}

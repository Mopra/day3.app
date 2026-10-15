import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// A local HTTP server that plays beehiiv, Kit, Mailchimp and MailerLite from the
// fixtures in test/fixtures/importers (shaped from each provider's official API
// spec). The import code runs unmodified: tests redirect the providers' real
// hosts here by wrapping global fetch (see providerFetch below).

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "importers");
const fixture = (rel: string) => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8"));

export const KEYS = {
  beehiiv: "bh_live_test_key_0001",
  kit: "kit_test_key_00000001",
  mailchimp: "fake_mailchimp_test_key-us21",
  mailerlite: "ml_test_token_00000001",
};
// A key the provider recognises but whose plan or scope has no API access.
export const FORBIDDEN_KEY = "forbidden_key_0000001";

export type RecordedRequest = { path: string; query: URLSearchParams; auth: string | null };
type Injected = { status: number; headers?: Record<string, string>; body: unknown };

export class MockProviderServer {
  private server: Server;
  origin = "";
  requests: RecordedRequest[] = [];
  // Responses served, in order, before the fixtures, to any request whose path
  // starts with the given prefix (429 bursts, outages).
  private injected: { prefix: string; res: Injected }[] = [];

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  inject(prefix: string, res: Injected, times = 1): void {
    for (let i = 0; i < times; i++) this.injected.push({ prefix, res });
  }

  reset(): void {
    this.requests = [];
    this.injected = [];
  }

  /** A fetch that sends the providers' real hosts to this server instead. */
  providerFetch(realFetch: typeof fetch): typeof fetch {
    const origin = () => this.origin;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const providerHost =
        url.hostname === "api.beehiiv.com" ||
        url.hostname === "api.kit.com" ||
        url.hostname === "connect.mailerlite.com" ||
        url.hostname.endsWith(".api.mailchimp.com");
      if (!providerHost) return realFetch(input, init);
      const rewritten = `${origin()}${url.pathname}${url.search}`;
      return realFetch(rewritten, init);
    }) as typeof fetch;
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://mock");
    const auth = (req.headers["authorization"] as string | undefined) ?? (req.headers["x-kit-api-key"] as string | undefined) ?? null;
    this.requests.push({ path: url.pathname, query: url.searchParams, auth });

    const idx = this.injected.findIndex((i) => url.pathname.startsWith(i.prefix));
    if (idx >= 0) {
      const [{ res: inj }] = this.injected.splice(idx, 1);
      return this.send(res, inj.status, inj.body, inj.headers);
    }

    const p = url.pathname;
    const q = url.searchParams;

    // beehiiv v2: Authorization: Bearer <key>
    if (p.startsWith("/v2/")) {
      if (auth === `Bearer ${FORBIDDEN_KEY}`) return this.send(res, 403, fixture("beehiiv/error-403.json"));
      if (auth !== `Bearer ${KEYS.beehiiv}`) return this.send(res, 401, fixture("beehiiv/error-401.json"));
      if (p === "/v2/publications") return this.send(res, 200, fixture("beehiiv/publications.json"));
      const m = /^\/v2\/publications\/([^/]+)\/subscriptions$/.exec(p);
      if (m) {
        if (m[1] !== "pub_00000000-0000-0000-0000-000000000001") {
          return this.send(res, 404, { status: 404, statusText: "Not Found", errors: [{ message: "Publication not found", code: "not_found" }] });
        }
        const cursor = q.get("cursor");
        if (!cursor) return this.send(res, 200, fixture("beehiiv/subscriptions-page1.json"));
        if (cursor === "eyJpZCI6InN1Yl81In0") return this.send(res, 200, fixture("beehiiv/subscriptions-page2.json"));
        return this.send(res, 400, { status: 400, statusText: "Bad Request", errors: [{ message: "Invalid cursor", code: "bad_request" }] });
      }
    }

    // Kit v4: X-Kit-Api-Key
    if (p.startsWith("/v4/")) {
      if (auth !== KEYS.kit) return this.send(res, 401, fixture("kit/error-401.json"));
      if (p === "/v4/account") return this.send(res, 200, fixture("kit/account.json"));
      if (p === "/v4/subscribers") {
        if (q.get("status") === "active") return this.send(res, 200, fixture("kit/subscribers-active-count.json"));
        if (q.get("status") !== "all") return this.send(res, 422, { errors: ["unexpected status filter"] });
        const after = q.get("after");
        if (!after) return this.send(res, 200, fixture("kit/subscribers-page1.json"));
        if (after === "WzIwNl0=") return this.send(res, 200, fixture("kit/subscribers-page2.json"));
      }
    }

    // Mailchimp 3.0: Basic base64(any:key)
    if (p.startsWith("/3.0/")) {
      const expected = `Basic ${Buffer.from(`day3:${KEYS.mailchimp}`).toString("base64")}`;
      if (auth !== expected) return this.send(res, 401, fixture("mailchimp/error-401.json"));
      if (p === "/3.0/lists") return this.send(res, 200, fixture("mailchimp/lists.json"));
      if (p === "/3.0/lists/a1b2c3d4e5/members") {
        // Serve 4 per page whatever `count` asks for, so offset paging is
        // exercised (Mailchimp may return fewer than `count`).
        const all = fixture("mailchimp/members.json");
        const offset = Number(q.get("offset") ?? 0);
        return this.send(res, 200, { ...all, members: all.members.slice(offset, offset + 4) });
      }
    }

    // MailerLite: Authorization: Bearer <token>
    if (p.startsWith("/api/")) {
      if (auth !== `Bearer ${KEYS.mailerlite}`) return this.send(res, 401, { message: "Unauthenticated." });
      if (p === "/api/subscribers") {
        if (q.get("limit") === "0") return this.send(res, 200, fixture("mailerlite/count.json"));
        const status = q.get("filter[status]");
        const cursor = q.get("cursor");
        if (status === "active" && !cursor) return this.send(res, 200, fixture("mailerlite/active-page1.json"));
        if (status === "active" && cursor === "eyJpZCI6Mn0") return this.send(res, 200, fixture("mailerlite/active-page2.json"));
        if (status === "unsubscribed") return this.send(res, 200, fixture("mailerlite/unsubscribed-page1.json"));
        return this.send(res, 200, { data: [], links: {}, meta: { next_cursor: null } });
      }
    }

    this.send(res, 404, { error: `mock: no route for ${p}` });
  }
}

// Ready-to-paste assets for the API keys page. Everything a user copies from
// that page is built here — one place to keep the docs honest against the real
// routes in app/api/v1/**.
//
// Two rules shape the content:
//   1. **Snippets never contain a live key.** They read DAY3_API_KEY from the
//      environment. The only place a real key appears is the `export ...` line
//      of the quickstart, which is where a secret belongs — and the AI prompts
//      are pasted into third-party chat tools, so a key must never ride along.
//   2. **The agent prompts are self-contained.** Each one carries the whole
//      reference, so an assistant with no knowledge of Day3 writes working code
//      on the first try instead of inventing endpoints.

import { MARKDOWN_DIALECT_REFERENCE } from "./campaign-markdown-docs";

export const PLACEHOLDER_KEY = "day3_live_xxxxxxxxxxxxxxxxxxxx";
export const PLACEHOLDER_AUDIENCE = "aud_YOUR_AUDIENCE_ID";
export const PLACEHOLDER_FROM_DOMAIN = "yourdomain.com";

/**
 * Remaining subscriber headroom on a capped (free) plan. `null` on paid tiers,
 * which are uncapped. Carried into the prompts so the assistant can check the
 * export size up front instead of discovering the cap on the first batch.
 */
export type SubscriberLimit = { cap: number; used: number; headroom: number };

export type ApiDocsContext = {
  /** Origin the app is served from — the API lives on the same host. */
  origin: string;
  /** A real audience id when the account has one, else the placeholder. */
  audienceId: string;
  /** Human name of that audience, for prompt context. */
  audienceName: string | null;
  /** Set only when the plan caps subscribers; absent means unlimited. */
  subscriberLimit?: SubscriberLimit | null;
  /** A verified sending domain when the account has one, else the placeholder
   *  — makes the transactional `from` examples paste-and-run. */
  sendingDomain?: string | null;
};

function fromDomain(ctx: ApiDocsContext): string {
  return ctx.sendingDomain ?? PLACEHOLDER_FROM_DOMAIN;
}

export function apiBaseUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/v1`;
}

// ── MCP ──────────────────────────────────────────────────────────────────────

/** The Model Context Protocol endpoint — one URL, same bearer key as REST. */
export function mcpUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/mcp`;
}

export type McpSetup = { id: string; label: string; blurb: string; code: string };

/**
 * Per-editor install snippets. All three do the same thing — point the editor at
 * one HTTP endpoint and attach the key as a header — they just disagree about
 * where that gets written down.
 */
export function buildMcpSetups(ctx: ApiDocsContext, key: string | null): McpSetup[] {
  const url = mcpUrl(ctx.origin);
  const bearer = key ?? PLACEHOLDER_KEY;
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      blurb: "Run this in your project, then ask Claude to write you an email.",
      code: `claude mcp add --transport http day3 ${url} \\
  --header "Authorization: Bearer ${bearer}"`,
    },
    {
      id: "cursor",
      label: "Cursor",
      blurb: "Add to .cursor/mcp.json in your project (or ~/.cursor/mcp.json for every project).",
      code: JSON.stringify(
        {
          mcpServers: {
            day3: { url, headers: { Authorization: `Bearer ${bearer}` } },
          },
        },
        null,
        2,
      ),
    },
    {
      id: "vscode",
      label: "VS Code",
      blurb: "Add to .vscode/mcp.json. The input prompt keeps the key out of the file.",
      code: JSON.stringify(
        {
          inputs: [
            { type: "promptString", id: "day3-key", description: "Day3 API key", password: true },
          ],
          servers: {
            day3: {
              type: "http",
              url,
              headers: { Authorization: "Bearer ${input:day3-key}" },
            },
          },
        },
        null,
        2,
      ),
    },
  ];
}

// ── Quickstart ───────────────────────────────────────────────────────────────

/**
 * Step 1 of the quickstart. Takes the freshly-minted key when one is still in
 * memory (right after creation) so the line is paste-and-run; otherwise the
 * placeholder, since we can never recover a stored key.
 */
export function exportKeyLine(key: string | null): string {
  return `export DAY3_API_KEY="${key ?? PLACEHOLDER_KEY}"`;
}

/** Step 2 — the smallest request that proves the key works. */
export function verifyCurl(ctx: ApiDocsContext): string {
  return `curl ${apiBaseUrl(ctx.origin)}/audiences \\
  -H "Authorization: Bearer $DAY3_API_KEY"`;
}

// ── Task snippets (cURL / JavaScript / Python) ───────────────────────────────

export type SnippetTask = {
  id: string;
  label: string;
  blurb: string;
  curl: string;
  js: string;
  python: string;
};

/** The transactional-email snippets — the /emails page panel and the top of the
 *  api-keys snippet list share these. */
export function buildEmailSnippets(ctx: ApiDocsContext): SnippetTask[] {
  const base = apiBaseUrl(ctx.origin);
  const from = `Acme <notifications@${fromDomain(ctx)}>`;

  return [
    {
      id: "send-email",
      label: "Send an email",
      blurb:
        "One transactional email — password reset, receipt, magic link. `from` is any address on a verified sending domain; `to` takes up to 50 addresses. Set `Idempotency-Key` so a network retry can never double-send.",
      curl: `curl -X POST "${base}/emails" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "from": "${from}",
    "to": ["jane@acme.com"],
    "subject": "Reset your password",
    "html": "<p>Click <a href=\\"https://acme.com/reset?t=...\\">here</a> to reset.</p>"
  }'`,
      js: `const res = await fetch("${base}/emails", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({
    from: "${from}",
    to: ["jane@acme.com"],
    subject: "Reset your password",
    html: '<p>Click <a href="https://acme.com/reset?t=...">here</a> to reset.</p>',
  }),
});
const email = await res.json();
if (!res.ok) throw new Error(email.error.message);
console.log(email.id, email.status); // "eml_…" "queued"`,
      python: `import os, uuid, requests

res = requests.post(
    "${base}/emails",
    headers={
        "Authorization": f"Bearer {os.environ['DAY3_API_KEY']}",
        "Idempotency-Key": str(uuid.uuid4()),
    },
    json={
        "from": "${from}",
        "to": ["jane@acme.com"],
        "subject": "Reset your password",
        "html": '<p>Click <a href="https://acme.com/reset?t=...">here</a> to reset.</p>',
    },
)
res.raise_for_status()
email = res.json()  # {"id": "eml_...", "status": "queued", ...}`,
    },
    {
      id: "email-status",
      label: "Check delivery",
      blurb:
        "The send call returns as soon as the email is accepted; delivery happens within seconds. Poll the id to see it move queued → sent → delivered (or bounced/complained, with `events` telling the story).",
      curl: `curl "${base}/emails/eml_YOUR_EMAIL_ID" \\
  -H "Authorization: Bearer $DAY3_API_KEY"`,
      js: `const res = await fetch(\`${base}/emails/\${emailId}\`, {
  headers: { Authorization: \`Bearer \${process.env.DAY3_API_KEY}\` },
});
const email = await res.json();
console.log(email.status);        // "delivered"
console.log(email.events);        // [{ type: "sent", ... }, { type: "delivery", ... }]`,
      python: `import os, requests

email = requests.get(
    f"${base}/emails/{email_id}",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
).json()
print(email["status"], email["events"])`,
    },
    {
      id: "list-emails",
      label: "List sends",
      blurb:
        "Everything sent through the API, newest first, cursor-paginated. `?status=failed` (or bounced/complained) is the fastest way to find what needs attention.",
      curl: `curl "${base}/emails?status=failed&limit=50" \\
  -H "Authorization: Bearer $DAY3_API_KEY"`,
      js: `const res = await fetch("${base}/emails?status=failed&limit=50", {
  headers: { Authorization: \`Bearer \${process.env.DAY3_API_KEY}\` },
});
const page = await res.json(); // { data, has_more, next_cursor }`,
      python: `import os, requests

page = requests.get(
    "${base}/emails",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    params={"status": "failed", "limit": 50},
).json()  # {"data": [...], "has_more": ..., "next_cursor": ...}`,
    },
  ];
}

export function buildSnippetTasks(ctx: ApiDocsContext): SnippetTask[] {
  const base = apiBaseUrl(ctx.origin);
  const aud = ctx.audienceId;

  return [
    ...buildEmailSnippets(ctx).filter((t) => t.id === "send-email"),
    {
      id: "add",
      label: "Add a contact",
      blurb:
        "Creates one contact. `?upsert=true` updates instead of failing when the email already exists — use it whenever you're syncing from your own database.",
      curl: `curl -X POST "${base}/audiences/${aud}/contacts?upsert=true" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "jane@acme.com",
    "first_name": "Jane",
    "attributes": { "company": "Acme", "plan": "pro" }
  }'`,
      js: `const res = await fetch(
  "${base}/audiences/${aud}/contacts?upsert=true",
  {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "jane@acme.com",
      first_name: "Jane",
      attributes: { company: "Acme", plan: "pro" },
    }),
  },
);
if (!res.ok) throw new Error((await res.json()).error.message);
const contact = await res.json();`,
      python: `import os, requests

res = requests.post(
    "${base}/audiences/${aud}/contacts",
    params={"upsert": "true"},
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={
        "email": "jane@acme.com",
        "first_name": "Jane",
        "attributes": {"company": "Acme", "plan": "pro"},
    },
)
res.raise_for_status()
contact = res.json()`,
    },
    {
      id: "import",
      label: "Import a list",
      blurb:
        "The migration workhorse: up to 1,000 contacts per call, one rate-limit charge, and per-row results so one bad address never sinks the batch. `status: \"unsubscribed\"` carries opt-outs over from your old provider.",
      curl: `curl -X POST "${base}/audiences/${aud}/contacts/batch" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "upsert": true,
    "contacts": [
      { "email": "a@acme.com", "first_name": "Ada" },
      { "email": "b@acme.com", "status": "unsubscribed" }
    ]
  }'`,
      js: `// Send in chunks of 1,000. Idempotency-Key makes a retry after a network
// failure safe — the replay returns the original result instead of re-writing.
async function importContacts(contacts) {
  for (let i = 0; i < contacts.length; i += 1000) {
    const chunk = contacts.slice(i, i + 1000);
    const res = await fetch(
      "${base}/audiences/${aud}/contacts/batch",
      {
        method: "POST",
        headers: {
          Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ upsert: true, contacts: chunk }),
      },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error.message);
    console.log(body.summary); // { created, updated, failed }
    for (const r of body.results) {
      if (r.status === "failed") console.warn(chunk[r.index].email, r.error.code);
    }
  }
}`,
      python: `import os, uuid, requests

def import_contacts(contacts):
    headers = {"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"}
    for i in range(0, len(contacts), 1000):
        chunk = contacts[i : i + 1000]
        res = requests.post(
            "${base}/audiences/${aud}/contacts/batch",
            headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
            json={"upsert": True, "contacts": chunk},
        )
        res.raise_for_status()
        body = res.json()
        print(body["summary"])  # {"created": .., "updated": .., "failed": ..}
        for r in body["results"]:
            if r["status"] == "failed":
                print("skipped", chunk[r["index"]]["email"], r["error"]["code"])`,
    },
    {
      id: "unsubscribe",
      label: "Unsubscribe",
      blurb:
        "Address a contact by plain email — no id lookup first. Prefer this over DELETE: deleting erases the contact, unsubscribing keeps the record of their opt-out.",
      curl: `curl -X PATCH "${base}/audiences/${aud}/contacts/jane%40acme.com" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "status": "unsubscribed" }'`,
      js: `const email = encodeURIComponent("jane@acme.com");
await fetch(
  \`${base}/audiences/${aud}/contacts/\${email}\`,
  {
    method: "PATCH",
    headers: {
      Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "unsubscribed" }),
  },
);`,
      python: `import os, requests
from urllib.parse import quote

email = quote("jane@acme.com", safe="")
requests.patch(
    f"${base}/audiences/${aud}/contacts/{email}",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={"status": "unsubscribed"},
).raise_for_status()`,
    },
    {
      id: "list",
      label: "List contacts",
      blurb:
        "Cursor pagination — follow `next_cursor` until `has_more` is false. Filter with `?status=`, `?email=`, or `?segment_id=` to walk a segment's live members.",
      curl: `curl "${base}/audiences/${aud}/contacts?status=subscribed&limit=100" \\
  -H "Authorization: Bearer $DAY3_API_KEY"`,
      js: `async function* allContacts() {
  let cursor = null;
  do {
    const url = new URL("${base}/audiences/${aud}/contacts");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("after", cursor);
    const res = await fetch(url, {
      headers: { Authorization: \`Bearer \${process.env.DAY3_API_KEY}\` },
    });
    const page = await res.json();
    if (!res.ok) throw new Error(page.error.message);
    yield* page.data;
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
}`,
      python: `import os, requests

def all_contacts():
    headers = {"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"}
    cursor = None
    while True:
        params = {"limit": 100}
        if cursor:
            params["after"] = cursor
        page = requests.get(
            "${base}/audiences/${aud}/contacts", headers=headers, params=params
        ).json()
        yield from page["data"]
        if not page["has_more"]:
            return
        cursor = page["next_cursor"]`,
    },
    {
      id: "suppress",
      label: "Suppression list",
      blurb:
        "Bring your old provider's bounces and complaints with you so your first send doesn't re-mail addresses that already failed. Add-only over the API — un-suppressing is done here in the app, on purpose.",
      curl: `curl -X POST "${base}/suppressions" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "reason": "bounced",
    "emails": ["dead@acme.com", "gone@acme.com"]
  }'`,
      js: `const res = await fetch("${base}/suppressions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
    "Content-Type": "application/json",
  },
  // "unsubscribed" | "bounced" | "complained" — required, and stored per entry
  body: JSON.stringify({ reason: "bounced", emails: ["dead@acme.com"] }),
});
const summary = await res.json();
// { added, already_suppressed, invalid,
//   total_suppressed_before, total_suppressed_after }`,
      python: `import os, requests

summary = requests.post(
    "${base}/suppressions",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={"reason": "bounced", "emails": ["dead@acme.com"]},
).json()
# check total_suppressed_after before/after — suppression is account-wide`,
    },
  ];
}

// ── The reference every agent prompt carries ─────────────────────────────────

/**
 * A compact, complete Markdown reference (llms.txt in spirit): enough for a
 * coding assistant to write correct calls without guessing, short enough to sit
 * inside a prompt. Kept in sync with app/api/v1/** by hand — if you add a route
 * there, add it here.
 */
export function buildReferenceMarkdown(ctx: ApiDocsContext): string {
  const base = apiBaseUrl(ctx.origin);
  const aud = ctx.audienceId;

  return `# Day3 API v1 — reference

Day3 is an email platform. This API sends transactional emails (password
resets, receipts, magic links) and manages audiences and everything inside
them. Campaign (newsletter) sending is done in the Day3 web app, not over the
API.

- **Base URL**: \`${base}\`
- **Auth**: \`Authorization: Bearer day3_live_...\` on every request. Read the key
  from the \`DAY3_API_KEY\` environment variable — never hard-code or commit it.
- **Format**: JSON in, JSON out. Field names are \`snake_case\`. Ids are prefixed
  strings (\`eml_\`, \`aud_\`, \`sub_\`, \`seg_\`, \`top_\`, \`fld_\`). Timestamps are ISO-8601 UTC.
- Ignore unknown response fields — new ones get added without a version bump.

## Objects

- **Email** (\`eml_...\`) — one transactional email sent through the API.
- **Audience** (\`aud_...\`) — a list of contacts. Everything else lives inside one.
- **Contact** (\`sub_...\`) — a subscriber. Unique by email within an audience.
- **Field** (\`fld_...\`) — a registered custom attribute key.
- **Segment** (\`seg_...\`) — a saved filter, evaluated live at read time.
- **Topic** (\`top_...\`) — a subscription category a contact can opt out of alone.
- **Suppression** — an account-wide "never email this address" entry.

Email object:

\`\`\`json
{
  "id": "eml_...", "object": "email",
  "from": "Acme <notifications@${fromDomain(ctx)}>",
  "to": ["jane@acme.com"],
  "reply_to": null,
  "subject": "Reset your password",
  "status": "delivered",
  "error": null,
  "tags": { "type": "password-reset" },
  "sandbox": false,
  "created_at": "2026-08-01T08:00:00.000Z",
  "sent_at": "2026-08-01T08:00:01.000Z",
  "delivered_at": "2026-08-01T08:00:03.000Z",
  "bounced_at": null, "complained_at": null
}
\`\`\`

\`status\` walks \`queued\` → \`sent\` → \`delivered\`, or ends at \`bounced\`,
\`complained\`, \`failed\`, or \`suppressed\`. \`GET /emails/{id}\` additionally
carries \`events\`, the raw timeline.

Contact object:

\`\`\`json
{
  "id": "sub_...", "object": "contact",
  "email": "jane@acme.com",
  "first_name": "Jane", "last_name": "Doe",
  "attributes": { "company": "Acme", "plan": "pro" },
  "status": "subscribed",
  "source": "api",
  "topics": null,
  "unsubscribed_at": null,
  "created_at": "2026-03-10T08:00:00.000Z",
  "updated_at": "2026-07-01T10:00:00.000Z"
}
\`\`\`

## Endpoints

Emails (transactional sending)
- \`POST /emails\` — send one email. Body:
  \`\`\`json
  { "from": "Acme <notifications@${fromDomain(ctx)}>",
    "to": ["jane@acme.com"],
    "subject": "...",
    "html": "<p>...</p>", "text": "...",
    "reply_to": "support@${fromDomain(ctx)}",
    "headers": { "X-Entity-Ref-ID": "..." },
    "tags": { "type": "password-reset" } }
  \`\`\`
  \`from\` + \`to\` + \`subject\` + (\`html\` and/or \`text\`) are required; the rest is
  optional. \`to\` is a string or an array of up to 50 addresses (one message,
  all visible in the To header). Returns the Email object with \`status:
  "queued"\` — delivery is asynchronous and takes a couple of seconds.
- \`GET  /emails\` — list, newest first. Filter with \`?status=\`.
- \`GET  /emails/{id}\` — one email + its delivery \`events\`.

Audiences
- \`GET    /audiences\` — list
- \`POST   /audiences\` — create, body \`{ "name": "..." }\`
- \`GET    /audiences/{id}\` — includes \`contact_counts\`
- \`PATCH  /audiences/{id}\` — rename
- \`DELETE /audiences/{id}\` — **also deletes every contact, field, segment and topic in it**

Contacts
- \`GET    /audiences/{aud}/contacts\` — filters: \`?status=\`, \`?email=\` (exact), \`?segment_id=\`
- \`POST   /audiences/{aud}/contacts\` — add \`?upsert=true\` to update on conflict
- \`POST   /audiences/{aud}/contacts/batch\` — up to 1,000 per call ← use for bulk
- \`GET    /audiences/{aud}/contacts/{id_or_email}\` — add \`?expand=topics\` for the topic map
- \`PATCH  /audiences/{aud}/contacts/{id_or_email}\`
- \`DELETE /audiences/{aud}/contacts/{id_or_email}\` — erases the contact
- \`GET    /audiences/{aud}/contacts/{id_or_email}/topics\` — effective per-topic state
- \`PATCH  /audiences/{aud}/contacts/{id_or_email}/topics\` — body \`{ "topics": { "top_x": false } }\`

Fields
- \`GET/POST        /audiences/{aud}/fields\` — body \`{ "key", "label"?, "type"?, "fallback"? }\`
- \`GET/PATCH/DELETE /audiences/{aud}/fields/{id_or_key}\`

Segments
- \`GET/POST        /audiences/{aud}/segments\` — body \`{ "name", "filter" }\`
- \`GET/PATCH/DELETE /audiences/{aud}/segments/{id}\`
- \`GET             /audiences/{aud}/segments/{id}/contacts\` — live members

Topics
- \`GET/POST        /audiences/{aud}/topics\` — body \`{ "name", "description"?, "default_subscribed"? }\`
- \`GET/PATCH/DELETE /audiences/{aud}/topics/{id}\`

A segment's \`filter\` is the whole contract — \`match\` is \`"all"\` or \`"any"\`, with
1–10 conditions. \`field\` is \`email\`, \`first_name\`, \`last_name\`, or any custom
attribute key. \`op\` is one of \`equals\`, \`not_equals\`, \`contains\`,
\`not_contains\`, \`is_set\`, \`is_not_set\`, \`greater_than\`, \`less_than\`.
\`is_set\`/\`is_not_set\` take no \`value\`; \`greater_than\`/\`less_than\` need a numeric
one:

\`\`\`json
{ "name": "Pro customers",
  "filter": { "match": "all",
              "conditions": [ { "field": "plan", "op": "equals", "value": "pro" },
                              { "field": "company", "op": "is_set" } ] } }
\`\`\`

Campaigns (newsletters — one email to a whole audience)
- \`GET    /campaigns\` — list, newest first. Filter with \`?status=\`.
- \`POST   /campaigns\` — create a draft. Every field is optional; a draft can be
  incomplete, exactly as in the app. Body:
  \`\`\`json
  { "subject": "...", "markdown": "# Hello\\n\\nBody copy.",
    "name": "internal name", "preview_text": "...",
    "audience_id": "${PLACEHOLDER_AUDIENCE}", "segment_id": null, "topic_id": null,
    "sender_id": "snd_...", "from_name": "...", "reply_to": "...", "footer_text": "..." }
  \`\`\`
  Give the body as exactly ONE of \`markdown\` (Day3 Markdown — preferred),
  \`sections\` (the composer's own structure), or \`html\` (sanitized, stored
  without structure). \`audience_id\` defaults to the only audience when there is
  one; the From identity defaults to the account's default sender.
- \`GET    /campaigns/{id}\` — the campaign plus its body as \`markdown\`,
  \`sections\` and \`html\`. Read before editing so composer changes aren't lost.
- \`PATCH  /campaigns/{id}\` — same body as create; only fields you send change.
  \`409\` once the campaign has left \`draft\`/\`scheduled\`.
- \`DELETE /campaigns/{id}\` — drafts and scheduled campaigns only.
- \`GET    /campaigns/{id}/preview\` — the rendered email (theme, merge tags and
  compliance footer applied). Add \`?format=html\` to get the document itself.
- \`POST   /campaigns/{id}/test\` — body \`{ "to": "you@example.com" }\` (or an array,
  max 5). Goes only to the addresses you name, never the audience.
- \`POST   /campaigns/{id}/send\` — **send to the whole audience, now.** Requires a
  key with the \`campaigns:send\` scope. Irreversible: it starts the automated
  risk review and delivery follows if that passes. There is no confirmation step.
- \`POST   /campaigns/{id}/schedule\` — body \`{ "send_at": "2026-09-01T09:00:00Z" }\`,
  at least a minute ahead. Same scope, same consequences, just later.
- \`DELETE /campaigns/{id}/schedule\` — back to draft. Needs no scope.

Suppressions (account-wide, not per audience)
- \`GET  /suppressions\` — list
- \`GET  /suppressions/{email}\` — 200 with the reason, or 404 if not suppressed
- \`POST /suppressions\` — body \`{ "reason": "unsubscribed"|"bounced"|"complained", "emails": [...] }\`, max 1,000. **Add-only** — there is no delete.

## Rules that will bite you if you guess

1. **Contacts are addressable by plain email**, URL-encoded — no id lookup first:
   \`GET /audiences/${aud}/contacts/jane%40acme.com\`
2. **Bulk goes through \`/contacts/batch\`.** Up to 1,000 items, and the whole call
   costs one request against the rate limit. Never loop single creates for an
   import. It returns \`200\` even when individual rows fail:
   \`\`\`json
   { "object": "batch_result",
     "summary": { "created": 940, "updated": 55, "failed": 5 },
     "results": [ { "index": 0, "status": "created", "id": "sub_..." },
                  { "index": 2, "status": "failed",
                    "error": { "code": "invalid_email", "message": "..." } } ] }
   \`\`\`
   The whole request is rejected only for caller bugs: >1,000 items, duplicate
   emails inside one payload, an unknown topic id, or crossing a plan limit.
3. **Upsert merge**: provided fields overwrite; \`attributes\` is a *shallow merge*
   (absent keys survive, an explicit \`null\` value deletes that key).
4. **\`attributes\` is a flat map of string → string.** Unknown keys auto-register
   as fields — no need to declare them first — and become \`{{merge_tags}}\` in
   campaigns. Three things bite here when importing a provider export:
   - **Values must be strings.** A number or boolean (\`{"orders": 5}\`) fails
     schema validation and rejects the **entire batch** with \`400
     invalid_request\`, not that one row. Stringify every value before sending.
   - \`email\`, \`first_name\` and \`last_name\` are **reserved**: they are real
     columns, so putting them in \`attributes\` is silently ignored. Send them as
     top-level fields.
   - Keys are normalized to \`snake_case\` (\`"Company / Org"\` → \`company_org\`),
     so two source columns can collide into one key.
5. **Unknown top-level fields are silently dropped, not rejected** — so a payload
   can look accepted while quietly losing data. In particular **you cannot
   backdate a contact**: a \`created_at\` in the payload is ignored and there is no
   way to preserve original signup dates. \`unsubscribed_at\` is the one exception
   — honoured on create, so opt-out dates *do* survive a migration. Map every
   source column onto a field listed above (or into \`attributes\`), and tell the
   user what couldn't be carried over rather than pretending it was.
6. **Writable statuses are \`subscribed\` and \`unsubscribed\` only.** \`bounced\`,
   \`complained\`, \`suppressed\` and \`pending\` are owned by the delivery pipeline;
   an upsert against such a contact updates the other fields and leaves the
   status alone.
7. **Emails are canonicalized (trimmed and lowercased) before anything else.**
   So \`Ada@Acme.com\` and \`ada@acme.com\` are the *same* contact — and two such
   rows in one batch payload are a duplicate, which rejects the whole request.
   De-duplicate case-insensitively before sending a chunk.
8. **DELETE erases** (GDPR). To stop mailing someone while keeping the record,
   \`PATCH { "status": "unsubscribed" }\`.
9. **Suppressed emails are rejected** with \`email_suppressed\` — the contact is
   not created. Suppression is account-wide and beats everything, so if you
   import a suppression list first, contacts for those addresses will fail on
   the way in. That is correct behaviour, not an error to retry.
10. **Pagination**: \`?limit=\` (1–100, default 50) and \`?after={next_cursor}\`.
    Responses are \`{ "data": [...], "has_more": true, "next_cursor": "..." }\`.
    Loop until \`has_more\` is false. There are no page numbers or offsets.
11. **Idempotency**: send \`Idempotency-Key: <uuid>\` on any POST. A retry with the
    same key within 24h replays the original response instead of writing twice —
    always set it on imports. The same key with a *different* body is a \`409\`.
12. **Rate limit**: 600 requests per minute per account. Every response carries
    \`RateLimit-Limit\` and \`RateLimit-Remaining\`; a \`429\` carries \`Retry-After\`
    (seconds) — sleep for that long and retry rather than backing off blindly.
13. **\`403 plan_limit_reached\` means the account is out of subscriber headroom**
    (the free plan caps at 500). The batch is rejected whole, never partially
    applied, so the import can simply be re-run after upgrading. Tell the user
    to upgrade — don't retry, and don't split the batch to sneak under the cap.
    On \`POST /emails\` the same code means the monthly send allowance is used up.
14. **\`POST /emails\` requires \`from\` on a verified sending domain** — any
    local-part works (\`noreply@\`, \`receipts@\`, …) once the domain is verified
    under Domains in the app. An unverified domain is \`403
    domain_not_verified\`; verify first, don't retry.
15. **Transactional email ignores unsubscribes but honours deliverability
    suppressions.** A contact who unsubscribed from newsletters still gets
    their password reset; an address that hard-bounced or complained is
    rejected with \`400 email_suppressed\` and must not be retried.
16. **Free plans send in sandbox mode**: recipients must be
    members of the caller's own organization (anything else is \`403
    sandbox_recipient_not_allowed\`) and there is a small monthly allowance —
    enough to integrate and test, not to run production email. Responses carry
    \`"sandbox": true\`. Upgrading lifts both restrictions with no code change.
    The allowance is shared with the app's own sandbox sends (campaigns and test
    sends), so a free org draws all three from one monthly pool.
17. **Transactional sends have their own rate bucket** (default 120/min per
    account) inside the general limit — a \`429\` still carries \`Retry-After\`.

## Errors

Every failure uses one envelope. Branch on \`code\`, never on \`message\`:

\`\`\`json
{ "error": { "code": "contact_already_exists",
             "message": "A contact with this email already exists in this audience",
             "param": "email",
             "request_id": "req_..." } }
\`\`\`

| HTTP | codes |
|------|-------|
| 400 | \`invalid_request\`, \`invalid_email\`, \`invalid_filter\`, \`batch_too_large\`, \`email_suppressed\` |
| 401 | \`invalid_api_key\`, \`revoked_api_key\` |
| 403 | \`plan_limit_reached\`, \`sending_disabled\`, \`domain_not_verified\`, \`sandbox_recipient_not_allowed\`, \`insufficient_scope\`, \`test_keys_not_supported\`, \`forbidden\` |
| 404 | \`not_found\` (also returned for another account's ids — existence is never leaked) |
| 409 | \`contact_already_exists\`, \`email_suppressed\`, \`idempotency_conflict\` |
| 422 | \`immutable_field\` (e.g. changing a field's \`key\`) |
| 429 | \`rate_limit_exceeded\` |
| 500 | \`internal_error\` |

Include \`request_id\` when reporting a problem to Day3 support.

## Campaign bodies: Day3 Markdown

${MARKDOWN_DIALECT_REFERENCE}

## Not in v1

Domains and senders, webhooks, and OAuth have no endpoints yet. Don't invent
them — if a task needs one, say so instead.
`;
}

// ── Agent prompts ────────────────────────────────────────────────────────────

export type AgentPrompt = {
  id: string;
  label: string;
  blurb: string;
  text: string;
};

// Rules shared verbatim by every prompt we hand to an AI tool — the agent
// prompts on /api-keys and the per-resource context pack in the API panel.
const KEY_AND_CONDUCT_RULES = `- My API key is in the \`DAY3_API_KEY\` environment variable. Read it from there.
  Never hard-code it, never print it, never commit it, and never put it in a
  file that isn't gitignored.
- Use only the endpoints in the reference below. If something I ask for isn't
  covered, tell me instead of inventing an endpoint.
- Handle errors by the \`error.code\` field, not by matching on message text.
- Respect the rate limit (600 requests/minute): on a \`429\`, sleep for the
  \`Retry-After\` seconds and retry.`;

// A capped account is the one thing that can sink an otherwise-correct
// migration on the very first batch, so it goes in the ground rules where the
// assistant reads it before writing anything — not left to a 403.
function subscriberLimitLine(limit: SubscriberLimit | null | undefined): string {
  return limit
    ? `\n- **My plan caps me at ${limit.cap.toLocaleString()} contacts in total, and I already have ${limit.used.toLocaleString()} — so I can add at most ${limit.headroom.toLocaleString()} more.** Count my source rows BEFORE writing anything. If there are more than that, stop and tell me I need to upgrade my Day3 plan first. Do not import a partial list, and do not split the work to get under the cap.`
    : "";
}

/**
 * Prompts to hand to an AI coding assistant. Each is self-contained: task,
 * project-specific facts (the real audience id), house rules, and the full
 * reference appended — so the assistant has no reason to guess at an endpoint.
 */
export function buildAgentPrompts(ctx: ApiDocsContext): AgentPrompt[] {
  const aud = ctx.audienceId;
  const audLine =
    ctx.audienceId === PLACEHOLDER_AUDIENCE
      ? `- My audience id: I don't have one yet — create one with \`POST /audiences\` first, or ask me for it.`
      : `- My audience id: \`${aud}\`${ctx.audienceName ? ` ("${ctx.audienceName}")` : ""}`;

  const shared = `
Ground rules:
${audLine}${subscriberLimitLine(ctx.subscriberLimit)}
${KEY_AND_CONDUCT_RULES}

---

`;

  return [
    {
      id: "integrate",
      label: "Integrate into my app",
      blurb:
        "For adding Day3 to a codebase — a small client plus the calls your app actually needs.",
      text: `I want to integrate the Day3 email API into my application. Read the API reference at the end of this message before writing any code.

Please:
1. First look at my codebase and tell me what language, framework, and HTTP client it already uses — then match that style. Don't add a dependency if something suitable is already there.
2. Write a small, typed Day3 client module wrapping the calls I need, with the API key read from the environment and errors surfaced as real exceptions carrying \`error.code\` and \`request_id\`.
3. Wire it into the obvious places in my app (for example: subscribe a user on signup, update their attributes when their profile or plan changes, unsubscribe them when they opt out or delete their account).
4. Show me exactly which environment variable to set and where, and add it to my \`.env.example\` (never the real key).
5. Keep it simple — no retry frameworks or queues unless I ask. One clear module I can read.

Before you start, ask me anything you need to know about my app's user model.
${shared}${buildReferenceMarkdown(ctx)}`,
    },
    {
      id: "migrate",
      label: "Migrate from another provider",
      blurb:
        "For moving a list off Mailchimp, Resend, ConvertKit, Substack, Klaviyo, Brevo — subscribers, custom fields, opt-outs and bounces.",
      text: `I'm moving my email list to Day3 from another provider and I want you to write and run the migration for me. Read the API reference at the end of this message before writing any code.

Please:
1. Ask me which provider I'm coming from and whether I have an export file (CSV) or API credentials for it. Wait for my answer.
2. Write a migration script that reads my contacts from that source and loads them into Day3 through \`POST /audiences/{id}/contacts/batch\` — 1,000 per call, \`"upsert": true\`, and a fresh \`Idempotency-Key\` per batch so an interrupted run can be re-run safely.
3. Bring over everything, not just the email addresses:
   - names as top-level \`first_name\`/\`last_name\`, and any custom/merge fields as \`attributes\` (they auto-register — no setup needed). **Stringify every attribute value** — a number or boolean rejects the whole batch.
   - people who had **unsubscribed**, as \`status: "unsubscribed"\` with their original \`unsubscribed_at\` date if the export has one. This matters: re-mailing someone who opted out is illegal in most places.
   - **hard bounces and spam complaints only** from the old provider's suppression list, via \`POST /suppressions\` with the right \`reason\`. Do this *before* importing contacts so those addresses are rejected on the way in. Do **not** put plain unsubscribes on the suppression list — they belong in the audience as \`status: "unsubscribed"\`, and suppressing them would stop them being imported at all.
4. Expect these and handle them rather than treating them as bugs:
   - rows failing with \`email_suppressed\` — that is the bounce list doing its job
   - the same address twice in one chunk (compare lowercased) — de-duplicate before sending, or the whole chunk is rejected
   - \`403 plan_limit_reached\` — the account needs a bigger plan; stop and tell me, don't split the batch to get under the cap
5. Make the script re-runnable and chatty: print the running \`created\`/\`updated\`/\`failed\` totals, and write every failed row (with its \`error.code\`) to a CSV I can inspect afterwards. Never let one bad address abort the run.
6. Before the full run, do a dry run with the first 10 contacts and show me the result so I can confirm the field mapping looks right.
7. Afterwards, tell me the final counts and how to verify them against my old provider, and tell me plainly what did **not** come across — original signup dates can't be preserved, and anything the old export didn't include obviously can't either.

Warn me clearly before anything irreversible. Suppression is account-wide and cannot be undone over the API (only by hand, one address at a time, on the Suppressions page in the app), and there is no sandbox — this runs against my real account, which is exactly why I want the dry run first.
${shared}${buildReferenceMarkdown(ctx)}`,
    },
    {
      id: "sync",
      label: "Keep my users in sync",
      blurb:
        "For a one-way sync from your own database, so Day3 always reflects who your users are right now.",
      text: `I want to keep my Day3 audience automatically in sync with the users in my own application. Read the API reference at the end of this message before writing any code.

Please:
1. Look at my codebase and find where users are created, updated, and deleted, and where they change plan/status. Show me the list before you change anything.
2. Add a sync that keeps Day3 current:
   - on signup (or on email confirmation, if I have one) → upsert the contact
   - on profile/plan change → upsert with updated \`attributes\` so I can segment on them
   - on marketing opt-out → \`PATCH { "status": "unsubscribed" }\` (do **not** delete — I need the record that they opted out)
   - on account deletion → \`DELETE\` the contact, which erases them
3. Use \`?upsert=true\` everywhere so the sync is idempotent and safe to replay.
4. Don't let Day3 being slow or down break my app: do the call outside the critical path (background job, queue, or after-response hook — whichever my stack already has) and log failures instead of throwing into the user's request.
5. Also write a one-off backfill script that pushes my existing users through \`/contacts/batch\` in chunks of 1,000, so the sync starts from a correct state.
6. Tell me which of my user fields you mapped to \`first_name\`, \`last_name\`, and each \`attributes\` key.
${shared}${buildReferenceMarkdown(ctx)}`,
    },
  ];
}

// ── The API panel (the </> slide-out on resource pages) ──────────────────────
//
// Every resource page carries a small </> button that opens a panel with the
// ids in view, snippets scoped to that resource, and an AI "context pack".
// Like everything else in this file: no live key ever appears in this content.

export const PLACEHOLDER_SEGMENT = "seg_YOUR_SEGMENT_ID";
export const PLACEHOLDER_TOPIC = "top_YOUR_TOPIC_ID";

export type PanelIdRow = { label: string; value: string };
export type PanelIdGroup = { title: string; rows: PanelIdRow[] };

export type ApiPanelContent = {
  /** One-liner under the panel title. */
  blurb: string;
  /** Copyable id rows, grouped ("Audience", "Segment ids", …). */
  idGroups: PanelIdGroup[];
  /** cURL/JS/Python snippets scoped to the resource in view. May be empty. */
  tasks: SnippetTask[];
  /**
   * Self-contained prompt for an AI tool: the real ids in view, the ground
   * rules, and the full reference. Null when the resource has no v1 endpoints.
   */
  prompt: string | null;
  /** Shown when the resource isn't in the public API yet. */
  note?: string;
};

/** Named ids the context-pack prompt can carry beyond the audience itself. */
type PanelPromptExtras = {
  audiences?: { id: string; name: string }[] | null;
  segments?: { id: string; name: string }[] | null;
  topics?: { id: string; name: string }[] | null;
  fieldKeys?: string[] | null;
  /** Verified sending domains — the `from` addresses transactional sends may use. */
  verifiedDomains?: string[] | null;
  /** True when the account sends in sandbox mode (free tier). */
  transactionalSandbox?: boolean;
};

/**
 * The panel's one AI prompt: unlike the task-shaped prompts on /api-keys, this
 * carries no task — just the caller's real workspace (every id in view) plus
 * the reference, so it can be pasted ahead of whatever the user wants to build.
 */
export function buildPanelPrompt(ctx: ApiDocsContext, extras: PanelPromptExtras = {}): string {
  const lines: string[] = [`- Base URL: \`${apiBaseUrl(ctx.origin)}\``];

  if (extras.audiences && extras.audiences.length > 0) {
    lines.push(`- My audiences:`);
    for (const a of extras.audiences) lines.push(`  - "${a.name}": \`${a.id}\``);
  } else if (ctx.audienceId !== PLACEHOLDER_AUDIENCE) {
    lines.push(
      `- My audience${ctx.audienceName ? ` "${ctx.audienceName}"` : ""}: \`${ctx.audienceId}\``,
    );
  } else {
    lines.push(`- I have no audience yet — create one with \`POST /audiences\` first, or ask me.`);
  }
  if (extras.segments && extras.segments.length > 0) {
    lines.push(`- Segments in that audience:`);
    for (const s of extras.segments) lines.push(`  - "${s.name}": \`${s.id}\``);
  }
  if (extras.topics && extras.topics.length > 0) {
    lines.push(`- Topics in that audience:`);
    for (const t of extras.topics) lines.push(`  - "${t.name}": \`${t.id}\``);
  }
  if (extras.fieldKeys && extras.fieldKeys.length > 0) {
    lines.push(
      `- Custom field keys (usable in \`attributes\` and segment filters): ${extras.fieldKeys
        .map((k) => `\`${k}\``)
        .join(", ")}`,
    );
  }
  if (extras.verifiedDomains !== undefined) {
    lines.push(
      extras.verifiedDomains && extras.verifiedDomains.length > 0
        ? `- My verified sending domains (any local-part works as \`from\` on \`POST /emails\`): ${extras.verifiedDomains
            .map((d) => `\`${d}\``)
            .join(", ")}`
        : `- I have no verified sending domain yet — \`POST /emails\` will be rejected until one is verified under Domains in the app.`,
    );
  }
  if (extras.transactionalSandbox) {
    lines.push(
      `- My account is on the free plan, so \`POST /emails\` runs in **sandbox mode**: recipients must be members of my own organization, on a small monthly allowance. Write the integration normally — upgrading lifts the restriction with no code change.`,
    );
  }

  return `I'm working with the Day3 email API. Below is my real workspace context — use these ids directly instead of asking me for them — then ground rules, then the full API reference.

My workspace:
${lines.join("\n")}

Ground rules:${subscriberLimitLine(ctx.subscriberLimit)}
${KEY_AND_CONDUCT_RULES}

---

${buildReferenceMarkdown(ctx)}`;
}

/** Fields tab: attributes are the feature; declaring a field is the refinement. */
export function buildFieldSnippets(
  ctx: ApiDocsContext,
  fieldKeys?: string[] | null,
): SnippetTask[] {
  const base = apiBaseUrl(ctx.origin);
  const aud = ctx.audienceId;
  // Use the audience's real keys in the example when it has any.
  const key = fieldKeys?.[0] ?? "company";

  return [
    {
      id: "set-attributes",
      label: "Set a value",
      blurb:
        "Field values live on the contact as `attributes` — a flat string→string map. Updates shallow-merge (absent keys survive, an explicit `null` deletes one), and every key becomes a `{{merge_tag}}` in campaigns.",
      curl: `curl -X PATCH "${base}/audiences/${aud}/contacts/jane%40acme.com" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "attributes": { "${key}": "some value" } }'`,
      js: `const email = encodeURIComponent("jane@acme.com");
await fetch(\`${base}/audiences/${aud}/contacts/\${email}\`, {
  method: "PATCH",
  headers: {
    Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
    "Content-Type": "application/json",
  },
  // Values must be strings — stringify numbers and booleans first.
  body: JSON.stringify({ attributes: { "${key}": "some value" } }),
});`,
      python: `import os, requests
from urllib.parse import quote

email = quote("jane@acme.com", safe="")
requests.patch(
    f"${base}/audiences/${aud}/contacts/{email}",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={"attributes": {"${key}": "some value"}},
).raise_for_status()`,
    },
    {
      id: "create-field",
      label: "Declare a field",
      blurb:
        "Fields auto-register the first time a contact arrives with a new attribute key — declare one explicitly when you want a label, a type, or a fallback value for its `{{merge_tag}}`.",
      curl: `curl -X POST "${base}/audiences/${aud}/fields" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "key": "plan", "label": "Plan", "type": "text", "fallback": "free" }'`,
      js: `const res = await fetch("${base}/audiences/${aud}/fields", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ key: "plan", label: "Plan", type: "text", fallback: "free" }),
});
const field = await res.json(); // field.id is "fld_…" — but the key is what you use`,
      python: `import os, requests

field = requests.post(
    "${base}/audiences/${aud}/fields",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={"key": "plan", "label": "Plan", "type": "text", "fallback": "free"},
).json()`,
    },
  ];
}

/** Segments tab: reading live membership is the feature; creating is second. */
export function buildSegmentSnippets(
  ctx: ApiDocsContext,
  segment?: { id: string; name: string } | null,
  fieldKeys?: string[] | null,
): SnippetTask[] {
  const base = apiBaseUrl(ctx.origin);
  const aud = ctx.audienceId;
  const seg = segment?.id ?? PLACEHOLDER_SEGMENT;
  const key = fieldKeys?.[0] ?? "plan";

  return [
    {
      id: "segment-contacts",
      label: "Who matches now",
      blurb: `Membership is evaluated live — this is who matches right now${
        segment ? ` in "${segment.name}"` : ""
      }. Cursor-paginate with \`?after=\`; the same list is also available as \`GET /contacts?segment_id=\`.`,
      curl: `curl "${base}/audiences/${aud}/segments/${seg}/contacts?limit=100" \\
  -H "Authorization: Bearer $DAY3_API_KEY"`,
      js: `const res = await fetch(
  "${base}/audiences/${aud}/segments/${seg}/contacts?limit=100",
  { headers: { Authorization: \`Bearer \${process.env.DAY3_API_KEY}\` } },
);
const page = await res.json(); // { data, has_more, next_cursor }`,
      python: `import os, requests

page = requests.get(
    "${base}/audiences/${aud}/segments/${seg}/contacts",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    params={"limit": 100},
).json()  # {"data": [...], "has_more": ..., "next_cursor": ...}`,
    },
    {
      id: "create-segment",
      label: "Create a segment",
      blurb:
        'A segment is a saved filter: `match` is "all" or "any" over 1–10 conditions on `email`, `first_name`, `last_name`, or any custom field key.',
      curl: `curl -X POST "${base}/audiences/${aud}/segments" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Pro customers",
    "filter": {
      "match": "all",
      "conditions": [ { "field": "${key}", "op": "equals", "value": "pro" } ]
    }
  }'`,
      js: `const res = await fetch("${base}/audiences/${aud}/segments", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "Pro customers",
    filter: {
      match: "all",
      conditions: [{ field: "${key}", op: "equals", value: "pro" }],
    },
  }),
});
const segment = await res.json(); // segment.id is "seg_…"`,
      python: `import os, requests

segment = requests.post(
    "${base}/audiences/${aud}/segments",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={
        "name": "Pro customers",
        "filter": {
            "match": "all",
            "conditions": [{"field": "${key}", "op": "equals", "value": "pro"}],
        },
    },
).json()`,
    },
  ];
}

/** Topics tab: setting a contact's choices is the feature; creating is second. */
export function buildTopicSnippets(
  ctx: ApiDocsContext,
  topic?: { id: string; name: string } | null,
): SnippetTask[] {
  const base = apiBaseUrl(ctx.origin);
  const aud = ctx.audienceId;
  const top = topic?.id ?? PLACEHOLDER_TOPIC;

  return [
    {
      id: "set-topics",
      label: "Set a contact's topics",
      blurb: `Per-topic opt-out for one contact — \`false\` opts them out${
        topic ? ` of "${topic.name}"` : ""
      }, \`true\` opts them back in. Read the effective state with GET on the same path.`,
      curl: `curl -X PATCH "${base}/audiences/${aud}/contacts/jane%40acme.com/topics" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "topics": { "${top}": false } }'`,
      js: `const email = encodeURIComponent("jane@acme.com");
const res = await fetch(
  \`${base}/audiences/${aud}/contacts/\${email}/topics\`,
  {
    method: "PATCH",
    headers: {
      Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ topics: { "${top}": false } }),
  },
);
const { data } = await res.json(); // [{ topic_id, name, subscribed, is_default }]`,
      python: `import os, requests
from urllib.parse import quote

email = quote("jane@acme.com", safe="")
state = requests.patch(
    f"${base}/audiences/${aud}/contacts/{email}/topics",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={"topics": {"${top}": False}},
).json()  # {"data": [{"topic_id": ..., "subscribed": ...}, ...]}`,
    },
    {
      id: "create-topic",
      label: "Create a topic",
      blurb:
        "`default_subscribed: true` is opt-out (everyone gets it unless they leave); `false` is opt-in. It can't be changed later, so pick deliberately.",
      curl: `curl -X POST "${base}/audiences/${aud}/topics" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Product updates",
    "description": "Release notes and changelogs",
    "default_subscribed": true
  }'`,
      js: `const res = await fetch("${base}/audiences/${aud}/topics", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "Product updates",
    description: "Release notes and changelogs",
    default_subscribed: true,
  }),
});
const topic = await res.json(); // topic.id is "top_…"`,
      python: `import os, requests

topic = requests.post(
    "${base}/audiences/${aud}/topics",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={
        "name": "Product updates",
        "description": "Release notes and changelogs",
        "default_subscribed": True,
    },
).json()`,
    },
  ];
}

/** Audiences list page: list + create, then the first write a developer makes. */
function buildAudienceCrudSnippets(ctx: ApiDocsContext): SnippetTask[] {
  const base = apiBaseUrl(ctx.origin);

  return [
    {
      id: "list-audiences",
      label: "List audiences",
      blurb: "The smallest call there is — also the standard way to verify a key works.",
      curl: `curl "${base}/audiences" \\
  -H "Authorization: Bearer $DAY3_API_KEY"`,
      js: `const res = await fetch("${base}/audiences", {
  headers: { Authorization: \`Bearer \${process.env.DAY3_API_KEY}\` },
});
const { data } = await res.json(); // [{ id: "aud_…", name, … }]`,
      python: `import os, requests

page = requests.get(
    "${base}/audiences",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
).json()  # {"data": [{"id": "aud_...", "name": ...}], ...}`,
    },
    {
      id: "create-audience",
      label: "Create an audience",
      blurb: "The response carries the new `aud_…` id — everything else in the API lives under it.",
      curl: `curl -X POST "${base}/audiences" \\
  -H "Authorization: Bearer $DAY3_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "Product updates" }'`,
      js: `const res = await fetch("${base}/audiences", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.DAY3_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "Product updates" }),
});
const audience = await res.json(); // audience.id is "aud_…"`,
      python: `import os, requests

audience = requests.post(
    "${base}/audiences",
    headers={"Authorization": f"Bearer {os.environ['DAY3_API_KEY']}"},
    json={"name": "Product updates"},
).json()`,
    },
  ];
}

export type AudiencePanelTab = "contacts" | "fields" | "segments" | "topics";

/** Panel content for the audience detail page — snippets follow the open tab. */
export function buildAudiencePanelContent(input: {
  origin: string;
  audienceId: string;
  audienceName: string | null;
  tab?: AudiencePanelTab;
  fields?: { key: string; label: string }[] | null;
  segments?: { id: string; name: string }[] | null;
  topics?: { id: string; name: string }[] | null;
  subscriberLimit?: SubscriberLimit | null;
}): ApiPanelContent {
  const ctx: ApiDocsContext = {
    origin: input.origin,
    audienceId: input.audienceId,
    audienceName: input.audienceName,
    subscriberLimit: input.subscriberLimit,
  };
  const fieldKeys = input.fields?.map((f) => f.key) ?? null;
  const tab = input.tab ?? "contacts";

  const tasks =
    tab === "fields"
      ? buildFieldSnippets(ctx, fieldKeys)
      : tab === "segments"
        ? buildSegmentSnippets(ctx, input.segments?.[0] ?? null, fieldKeys)
        : tab === "topics"
          ? buildTopicSnippets(ctx, input.topics?.[0] ?? null)
          : buildSnippetTasks(ctx).filter((t) => ["add", "list", "unsubscribe"].includes(t.id));

  const idGroups: PanelIdGroup[] = [
    {
      title: "Audience",
      rows: [{ label: input.audienceName ?? "This audience", value: input.audienceId }],
    },
  ];
  if (input.segments && input.segments.length > 0) {
    idGroups.push({
      title: "Segment ids",
      rows: input.segments.map((s) => ({ label: s.name, value: s.id })),
    });
  }
  if (input.topics && input.topics.length > 0) {
    idGroups.push({
      title: "Topic ids",
      rows: input.topics.map((t) => ({ label: t.name, value: t.id })),
    });
  }
  if (input.fields && input.fields.length > 0) {
    idGroups.push({
      title: "Field keys",
      rows: input.fields.map((f) => ({ label: f.label, value: f.key })),
    });
  }

  return {
    blurb: "Real ids and ready-to-run calls for this audience.",
    idGroups,
    tasks,
    prompt: buildPanelPrompt(ctx, {
      segments: input.segments,
      topics: input.topics,
      fieldKeys,
    }),
  };
}

/** Panel content for the audiences list page. */
export function buildAudiencesPanelContent(input: {
  origin: string;
  audiences: { id: string; name: string }[] | null;
}): ApiPanelContent {
  const list = input.audiences ?? [];
  const first = list[0] ?? null;
  const ctx: ApiDocsContext = {
    origin: input.origin,
    audienceId: first?.id ?? PLACEHOLDER_AUDIENCE,
    audienceName: first?.name ?? null,
  };

  return {
    blurb: "Manage audiences and their contacts from your own code.",
    idGroups:
      list.length > 0
        ? [{ title: "Audience ids", rows: list.map((a) => ({ label: a.name, value: a.id })) }]
        : [],
    tasks: [
      ...buildAudienceCrudSnippets(ctx),
      ...buildSnippetTasks(ctx).filter((t) => t.id === "add"),
    ],
    prompt: buildPanelPrompt(ctx, { audiences: list }),
  };
}

/** Panel content for the /emails page — the transactional log's own </> panel. */
export function buildEmailsPanelContent(input: {
  origin: string;
  /** Verified sending domains; the first one seeds the `from` examples. */
  verifiedDomains: string[];
  /** True when the account sends in sandbox mode (free tier). */
  sandbox: boolean;
}): ApiPanelContent {
  const ctx: ApiDocsContext = {
    origin: input.origin,
    audienceId: PLACEHOLDER_AUDIENCE,
    audienceName: null,
    sendingDomain: input.verifiedDomains[0] ?? null,
  };

  return {
    blurb: "Send transactional email — password resets, receipts, magic links — from your own code.",
    idGroups:
      input.verifiedDomains.length > 0
        ? [
            {
              title: "Verified from-domains",
              rows: input.verifiedDomains.map((d) => ({
                label: `any local-part works, e.g. notifications@${d}`,
                value: d,
              })),
            },
          ]
        : [],
    tasks: buildEmailSnippets(ctx),
    prompt: buildPanelPrompt(ctx, {
      verifiedDomains: input.verifiedDomains,
      transactionalSandbox: input.sandbox,
    }),
    note:
      input.verifiedDomains.length === 0
        ? "Sends are rejected until a sending domain is verified — set one up under Domains first."
        : undefined,
  };
}

// Domains and senders have no v1 endpoints (the reference says so explicitly) —
// their panels show ids without pretending there's an API to call.
const NOT_IN_V1_NOTE =
  "Domains and senders don't have public API endpoints yet — verification and sending setup happen here in the app. These ids identify your resources when you talk to Day3 support.";

/** Panel content for the domains pages (list or a single domain). */
export function buildDomainsPanelContent(input: {
  origin: string;
  domains: { id: string; domain: string }[];
}): ApiPanelContent {
  return {
    blurb: "Your sending-domain ids at a glance.",
    idGroups:
      input.domains.length > 0
        ? [
            {
              title: input.domains.length === 1 ? "Domain" : "Domain ids",
              rows: input.domains.map((d) => ({ label: d.domain, value: d.id })),
            },
          ]
        : [],
    tasks: [],
    prompt: null,
    note: NOT_IN_V1_NOTE,
  };
}

/** Panel content for the senders page. */
export function buildSendersPanelContent(input: {
  origin: string;
  senders: { id: string; fromName: string; fromEmail: string }[];
}): ApiPanelContent {
  return {
    blurb: "Your sender ids at a glance.",
    idGroups:
      input.senders.length > 0
        ? [
            {
              title: "Sender ids",
              rows: input.senders.map((s) => ({
                label: `${s.fromName} <${s.fromEmail}>`,
                value: s.id,
              })),
            },
          ]
        : [],
    tasks: [],
    prompt: null,
    note: NOT_IN_V1_NOTE,
  };
}

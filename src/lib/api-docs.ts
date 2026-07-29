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

export const PLACEHOLDER_KEY = "day3_live_xxxxxxxxxxxxxxxxxxxx";
export const PLACEHOLDER_AUDIENCE = "aud_YOUR_AUDIENCE_ID";

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
};

export function apiBaseUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/v1`;
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

export function buildSnippetTasks(ctx: ApiDocsContext): SnippetTask[] {
  const base = apiBaseUrl(ctx.origin);
  const aud = ctx.audienceId;

  return [
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

Day3 is an email newsletter service. This API manages audiences and everything
inside them. Sending campaigns is done in the Day3 web app, not over the API.

- **Base URL**: \`${base}\`
- **Auth**: \`Authorization: Bearer day3_live_...\` on every request. Read the key
  from the \`DAY3_API_KEY\` environment variable — never hard-code or commit it.
- **Format**: JSON in, JSON out. Field names are \`snake_case\`. Ids are prefixed
  strings (\`aud_\`, \`sub_\`, \`seg_\`, \`top_\`, \`fld_\`). Timestamps are ISO-8601 UTC.
- Ignore unknown response fields — new ones get added without a version bump.

## Objects

- **Audience** (\`aud_...\`) — a list of contacts. Everything else lives inside one.
- **Contact** (\`sub_...\`) — a subscriber. Unique by email within an audience.
- **Field** (\`fld_...\`) — a registered custom attribute key.
- **Segment** (\`seg_...\`) — a saved filter, evaluated live at read time.
- **Topic** (\`top_...\`) — a subscription category a contact can opt out of alone.
- **Suppression** — an account-wide "never email this address" entry.

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
| 400 | \`invalid_request\`, \`invalid_email\`, \`invalid_filter\`, \`batch_too_large\` |
| 401 | \`invalid_api_key\`, \`revoked_api_key\` |
| 403 | \`plan_limit_reached\`, \`test_keys_not_supported\`, \`forbidden\` |
| 404 | \`not_found\` (also returned for another account's ids — existence is never leaked) |
| 409 | \`contact_already_exists\`, \`email_suppressed\`, \`idempotency_conflict\` |
| 422 | \`immutable_field\` (e.g. changing a field's \`key\`) |
| 429 | \`rate_limit_exceeded\` |
| 500 | \`internal_error\` |

Include \`request_id\` when reporting a problem to Day3 support.

## Not in v1

Campaigns and sending, domains and senders, webhooks, and OAuth have no
endpoints yet. Don't invent them — if a task needs one, say so instead.
`;
}

// ── Agent prompts ────────────────────────────────────────────────────────────

export type AgentPrompt = {
  id: string;
  label: string;
  blurb: string;
  text: string;
};

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

  // A capped account is the one thing that can sink an otherwise-correct
  // migration on the very first batch, so it goes in the ground rules where the
  // assistant reads it before writing anything — not left to a 403.
  const limit = ctx.subscriberLimit;
  const limitLine = limit
    ? `\n- **My plan caps me at ${limit.cap.toLocaleString()} contacts in total, and I already have ${limit.used.toLocaleString()} — so I can add at most ${limit.headroom.toLocaleString()} more.** Count my source rows BEFORE writing anything. If there are more than that, stop and tell me I need to upgrade my Day3 plan first. Do not import a partial list, and do not split the work to get under the cap.`
    : "";

  const shared = `
Ground rules:
${audLine}${limitLine}
- My API key is in the \`DAY3_API_KEY\` environment variable. Read it from there.
  Never hard-code it, never print it, never commit it, and never put it in a
  file that isn't gitignored.
- Use only the endpoints in the reference below. If something I ask for isn't
  covered, tell me instead of inventing an endpoint.
- Handle errors by the \`error.code\` field, not by matching on message text.
- Respect the rate limit (600 requests/minute): on a \`429\`, sleep for the
  \`Retry-After\` seconds and retry.

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

Warn me clearly before anything irreversible. Suppression is account-wide and cannot be undone over the API, and there is no sandbox — this runs against my real account, which is exactly why I want the dry run first.
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

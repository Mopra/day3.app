# Webhooks — receiving Day3 events

The API lets your code call Day3. Webhooks let Day3 call your code.

This is the doc for the person writing the receiver. Product-level description
is `PRODUCT.md §6.16`; the implementation notes live next to the code.

## Why you want them

If you send through Day3 and take no events, your app cannot know that an
address hard-bounced. Day3 will stop mailing it (the suppression list is
enforced on our side), but *your* database still says the address is good: you
keep showing "we sent you an email", keep retrying, and have no suppression
state to reason about. `suppression.created` is the event that closes that gap.

## Setting one up

**API keys → Webhooks → Add endpoint.** Pick the events, save, copy the signing
secret. The secret is readable again later (unlike an API key) because it lives
in your deploy config and losing it should not mean an outage.

Endpoint URLs must be **public https on port 443 or 8443**. Loopback, private
ranges, and cloud-metadata addresses are refused — validated at the socket's own
DNS lookup, so a hostname that re-resolves to a private address after you save
it still won't be reached. Redirects are never followed: configure the final URL.

For local development, use a tunnel (`ngrok http 3000` and friends).

## The request

```
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: Day3-Webhooks/1.0 (+https://day3.app)
Day3-Event-Id: evt_2k4h9x…
Day3-Event-Type: email.bounced
Day3-Delivery-Attempt: 1
Day3-Signature: t=1755264000,v1=5f3a…
```

Body:

```json
{
  "id": "evt_2k4h9x…",
  "type": "email.bounced",
  "created_at": "2026-08-15T09:14:03.221Z",
  "data": {
    "object": "email",
    "email_id": "eml_7p2…",
    "to": ["user@example.com"],
    "email": "user@example.com",
    "subject": "Reset your password",
    "provider_message_id": "0100019…",
    "bounce_type": "Permanent",
    "bounce_subtype": "General"
  }
}
```

`data.object` is `email` for transactional sends (`POST /v1/emails`) and
`campaign_recipient` for newsletter sends. The campaign shape carries
`campaign_id`, `recipient_id` and `contact_id` instead of `email_id`/`to` — join
on those if you need the campaign's name or subject; we don't inline them,
because that would mean an extra read on every message we send.

### Events

| Type | Meaning |
| --- | --- |
| `email.sent` | Handed to the mail provider. Not yet delivered. |
| `email.delivered` | The receiving server accepted it. |
| `email.bounced` | Came back. Check `bounce_type`: `Permanent` and `Undetermined` suppress the address, `Transient` is informational. |
| `email.complained` | Recipient marked it as spam. The address is suppressed. |
| `email.failed` | Never left. `data.error` says why. |
| `suppression.created` | An address was added to the suppression list. `data.reason` is one of `hard_bounce`, `complaint`, `unsubscribe`, `manual`, `provider_suppressed`. |

A transactional message can carry up to 50 recipients, and the provider reports
per address — so you get one event per affected address, each with its own
`data.email`, all sharing a `provider_message_id`.

## Verifying the signature

`Day3-Signature` is `t=<unix seconds>,v1=<hex>`, where the hex is
**HMAC-SHA256** over the exact string `` `${t}.${rawBody}` `` keyed with your
endpoint's signing secret.

Verify against the **raw request body**, before any JSON parsing. A framework
that parses and re-serializes will change the bytes and every signature will
fail.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyDay3Signature(
  header: string | undefined,
  rawBody: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!header) return false;

  let t: number | undefined;
  const provided: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "t") t = Number(v);
    else if (k?.trim() === "v1") provided.push(v.trim());
  }
  if (!t || !Number.isFinite(t) || provided.length === 0) return false;

  // Bound replay. Pick your own tolerance; we don't pick it for you.
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return provided.some((sig) => {
    if (sig.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  });
}
```

In a Next.js route handler, `await req.text()` gives you the raw body:

```ts
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyDay3Signature(req.headers.get("day3-signature") ?? undefined, raw, process.env.DAY3_WEBHOOK_SECRET!)) {
    return new Response("bad signature", { status: 401 });
  }
  const event = JSON.parse(raw);
  // ... enqueue and return fast; see below.
  return new Response("ok");
}
```

## What your handler must do

**Return 2xx quickly.** Any 2xx counts as delivered. We time out after 10
seconds. Do the real work after responding (a queue, a background job) — a
handler that does its processing inline will eventually time out under load and
get retried, which is the failure mode retries are supposed to fix, not cause.

**Dedupe on `id`.** Delivery is at-least-once. In practice you will rarely see a
duplicate — every event is emitted from inside the same database guard that
makes the underlying write idempotent, so a provider redelivery or a retried job
does not re-emit it — but a crashed worker mid-POST is retried by design, and
that is the case where you'd see the same `id` twice. Storing processed event
ids for a day or two is enough.

**Don't assume ordering.** Events are delivered independently. A `delivered`
and a `bounced` for the same message can arrive out of order; trust the row you
build from all of them, not the last one you saw.

## Retries

Seven attempts — the first, then six retries at 30s, 2m, 10m, 30m, 1h, 6h,
spanning a little under eight hours. Anything that isn't 2xx is retried,
including 3xx (we don't follow redirects). `Day3-Delivery-Attempt` counts from
1. After the last attempt the delivery is marked failed and stays in the log,
where you can hit **Resend** — that re-sends the original payload, so the
signature still verifies.

An endpoint that fails repeatedly is **not** auto-disabled. A silently disabled
webhook looks healthy while your data quietly drifts out of sync, which is worse
than a noisy failing one. The endpoint list shows the failure streak and the last
error instead.

Delivery rows are kept for 30 days.

## Rotating the secret

We sign with exactly one secret, so rotation is not automatically zero-downtime.
The order that is:

1. Deploy a receiver that accepts **either** the old or the new secret.
2. Rotate in the Day3 UI, copy the new secret, deploy it.
3. Drop the old secret from your config.

## Managing endpoints from code

Endpoints can also be provisioned over the API, for deploy scripts and IaC:

```
GET    /v1/webhooks                        list endpoints
POST   /v1/webhooks                        create (returns `secret` — the only time)
GET    /v1/webhooks/{id}                   read one
PATCH  /v1/webhooks/{id}                   url / description / events / status
DELETE /v1/webhooks/{id}                   remove it and its delivery history
GET    /v1/webhooks/{id}/deliveries        delivery log (?status=…)
```

```bash
curl -X POST https://go.day3.app/api/v1/webhooks \
  -H "Authorization: Bearer $DAY3_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "url": "https://yourapp.com/webhooks/day3",
        "description": "production",
        "events": ["email.bounced", "email.complained", "suppression.created"]
      }'
```

Every one of these routes — **including the reads** — requires the
`webhooks:manage` scope, which is off by default and chosen when you mint the
key. Creating an endpoint is the only write in v1 that is an exfiltration
primitive rather than a content edit: a key with the base grant can read
contacts but has to keep asking, whereas a key that can add an endpoint gets
them pushed to a URL of its choosing forever. Reads are gated for the same
reason — the delivery log names the recipient of every event.

Two things stay out of the API on purpose:

- **The signing secret** is returned once by `POST` and has no other
  representation at any scope. Reveal and rotate live in the app UI behind a
  session; a key that could read the secret could forge our events into your own
  receiver.
- **The signed payload** is not in the API's delivery log (the app's log view
  shows it). Over the API it would be a paginated way to read back every event
  body, and therefore every address.

## Operating notes (Day3 side)
- Emission is best-effort at the queue and durable in Postgres: delivery rows are
  written before anything is enqueued, and the 15-minute cron sweep
  (`sweepWebhookDeliveries`) re-queues anything whose job was lost and returns
  stuck `delivering` rows to `pending`. A Redis outage delays events; it does not
  drop them.
- The worker needs `DNS_TOKEN_ENC_KEY` (or the `DNS_TOKEN_ENC_KEYS` keyring) to
  decrypt signing secrets. `validateEnv("worker")` enforces this at boot.

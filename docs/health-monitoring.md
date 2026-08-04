# Health, readiness & worker liveness

Day3 runs two tiers — the **web tier** on Vercel (Next.js: API + SPA, the queue
*producer*) and the **VPS worker** (BullMQ *consumer* + the 15-min cron sweep).
Each needs to be observable so a dead component is caught before customers notice
(a stalled worker means campaigns silently stop sending).

## The endpoint: `GET /api/health`

Public, unauthenticated, never cached. It returns a JSON body and an HTTP status:

- **200** — DB is reachable. The web tier is serving and should stay in rotation.
- **503** — DB is unreachable. A load balancer / uptime monitor should treat the
  instance as down.

A failing **cron** or **worker** sub-check does *not* flip the HTTP status to
503 (the web tier itself is still fine); instead `status` becomes `"degraded"`
while the HTTP code stays 200. Monitor the JSON body to alert on those.

### Body shape

```jsonc
{
  "status": "ok",            // "ok" | "degraded" | "unhealthy"
  "build": {
    "version": "0.1.0",      // package version
    "commit": "abc123def456", // VERCEL_GIT_COMMIT_SHA (short), or "unknown"
    "env": "production"       // VERCEL_ENV / NODE_ENV
  },
  "checks": {
    "db":     { "ok": true },
    "cron":   { "ok": true, "lastRunAt": "2026-06-19T03:00:00.000Z", "ageMs": 123456 },
    "worker": { "ok": true, "lastBeatAt": "2026-06-19T12:34:56.000Z", "ageMs": 4200 }
  },
  "timestamp": "2026-06-19T12:35:00.123Z"
}
```

Every DB-backed sub-check reports a `durationMs`, and each one runs under a
client-side deadline (4s per check, 9s for the whole handler). **The endpoint
always answers** — see "Why the probe can never hang" below for why that property
matters more than it sounds.

- **db** — a `select 1` round-trip. `ok:false` → HTTP 503.
- **cron** — the most recent `cron` row in `job_logs` (written at the end of every
  `runScheduledSweeps`). Stale if older than 40 minutes (>2 missed 15-min runs),
  which means the worker's repeatable job has stopped.
- **worker** — the worker's Redis heartbeat (`day3:worker:heartbeat`), written
  every 30s. Stale after 90s. If Redis is unreachable from the web tier the
  worker check reports `"heartbeat unavailable"` and stays `ok` — the cron check
  still catches a dead worker against the DB (which never needs Redis).

## Why the probe can never hang

Diagnosed 2026-08-04, after `go.day3.app/api/health` spent weeks flapping
"offline" in runs of ~5 consecutive checks and then recovering on its own. The
monitor recorded `TTFB timeout after 21000ms` every time — never a status code.

The cause was not slowness anywhere. TLS to the Vercel edge completed in ~100ms,
the Supabase pooler answered in ~330ms and Redis in ~25ms throughout, and other
API routes served normally during the outage windows. What happened is that a
serverless instance froze between invocations holding a Postgres socket whose peer
had gone away without ever delivering a FIN or RST. On thaw, the instance wrote
`select 1` into that half-open socket, and:

- `connect_timeout` did not apply — the connection was already established;
- `statement_timeout` did not apply — it is a **server-side** parameter, and the
  query never reached a server;
- **postgres.js has no client-side query timeout at all.**

So the query hung indefinitely. The request produced *no response byte*, which a
monitor can only record as a TTFB timeout — indistinguishable from the whole app
being down. And because the web pool is `max: 1`, the abandoned query held the
instance's only connection, so every later request routed to that warm instance
hung the same way. That is the run of ~5 failures; it ended when the platform
recycled the instance.

Reproduced with a TCP proxy that blackholes an established connection: a bare
`select 1` never returned in over 60 seconds despite `statement_timeout: 15000`.

Three properties keep it fixed (`src/lib/deadline.ts`, `src/db/client.ts`):

1. **Client-side deadlines** on every dependency (`withDeadline`). A wedged socket
   becomes a fast, explicit 503 rather than silence.
2. **`resetDb()` on a blown deadline.** A timed-out query is abandoned, not
   cancelled, and keeps occupying its connection — so the pool *must* be thrown
   away or the wedge outlives the request. This is what collapses a multi-minute
   run of failures into a single failed probe (verified: 1 of 5 vs 5 of 5).
3. **`max_lifetime` + `keep_alive`** on the web pool, so stale sockets are recycled
   and dead peers are detected instead of trusted indefinitely.

The general lesson, which applies well beyond this endpoint: **`statement_timeout`
is a runaway-query cap, not a hang guard.** Any web-tier query that must not hang
needs a client-side ceiling too.

### Querying cron staleness directly (SQL)

The worker's last sweep is queryable in Postgres without the endpoint:

```sql
select created_at, status, payload_json
from job_logs
where job_type = 'cron'
order by created_at desc
limit 1;
```

If `now() - created_at` exceeds ~40 minutes, the sweep has stopped.

## Wiring it up

### Vercel / uptime monitor (web tier)

Point any HTTP uptime monitor (Better Uptime, Pingdom, UptimeRobot, Checkly,
healthchecks.io, …) at:

```
https://go.day3.app/api/health
```

- Alert when the status code is **not 200** (covers the DB-down 503).
- **REQUIRED (not optional): also assert on the JSON body.** A dead/stalled
  worker keeps the HTTP status at **200** by design — a status-code-only monitor
  stays green while campaigns have silently stopped sending. Configure a
  body/content assertion so the check FAILS when either is true:
  - `status != "ok"`, or
  - `checks.worker.ok == false`

  Most monitors support this directly (Checkly: a Playwright/`expect` assertion
  on the JSON; Better Uptime / UptimeRobot: "keyword" / "response body" rule —
  alert when the body does **not** contain `"status":"ok"`). Without this, the
  single most important failure (worker down) is invisible. Treat wiring it as a
  go-live blocker.
- Recommended interval: 60s.

Vercel itself does not health-gate serverless functions, so this endpoint exists
for external monitors and for manual `curl` during incidents.

### VPS supervisor (the worker)

The worker (`npm run worker` → `worker/index.ts`) writes the Redis heartbeat and
logs `"worker ready"` / `"cron sweep scheduled"` on startup. Run it under a
supervisor that restarts on crash:

**pm2** (matches the go-live runbook — `pm2 restart day3-worker`):

```bash
pm2 start "npm run worker" --name day3-worker
pm2 save                      # persist across reboots
# pm2 auto-restarts on crash; inspect with:
pm2 logs day3-worker
pm2 status
```

**systemd** alternative (`/etc/systemd/system/day3-worker.service`):

```ini
[Unit]
Description=Day3 BullMQ worker
After=network-online.target

[Service]
WorkingDirectory=/opt/day3
EnvironmentFile=/opt/day3/.env.worker
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now day3-worker
sudo systemctl status day3-worker
journalctl -u day3-worker -f
```

The supervisor restarts the *process*; the **heartbeat + cron checks on
`/api/health`** are how you detect a worker that's running but wedged (e.g.
blocked on a hung Redis connection) — the process is up but not beating.

## Error reporting (the other half of "nothing pages")

`/api/health` catches a *dead* component. It does **not** catch errors in
otherwise-healthy code — a 500 on an API route, a dead-lettered job (retries
exhausted), or a **reputation auto-pause** (an account auto-disabled for a high
bounce/complaint rate, which can precede an SES account-level suspension that
affects every tenant). Those are shipped to the error sink instead.

Set `ERROR_REPORTING_DSN` (or `SENTRY_DSN`) on **both** tiers (Vercel env + the
worker `.env`). It's an HTTP collector URL; the app POSTs redacted JSON
(`{ message, error, context }` — never secrets) fire-and-forget (see
`src/lib/logger.ts`). A vanilla Sentry DSN needs a small collector/shim to accept
this shape; any HTTP endpoint (a webhook-to-Slack, a log drain's HTTP intake)
works directly.

If it is unset in production, both tiers log a loud boot warning
(`No ERROR_REPORTING_DSN/SENTRY_DSN set in production…`). **Set it before
launch** — without it, dead-lettered jobs and reputation auto-pauses page no one.

## Build/version info

`build.commit` comes from `VERCEL_GIT_COMMIT_SHA` (injected automatically on
Vercel) and `build.version` from the package version. No setup needed on Vercel;
locally both fall back to `dev`/`unknown`.

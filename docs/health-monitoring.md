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

- **db** — a `select 1` round-trip. `ok:false` → HTTP 503.
- **cron** — the most recent `cron` row in `job_logs` (written at the end of every
  `runScheduledSweeps`). Stale if older than 40 minutes (>2 missed 15-min runs),
  which means the worker's repeatable job has stopped.
- **worker** — the worker's Redis heartbeat (`day3:worker:heartbeat`), written
  every 30s. Stale after 90s. If Redis is unreachable from the web tier the
  worker check reports `"heartbeat unavailable"` and stays `ok` — the cron check
  still catches a dead worker against the DB (which never needs Redis).

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
- Optionally also alert on the JSON body: `status != "ok"` or
  `checks.worker.ok == false` to catch a stalled/dead worker — this is the
  signal that "campaigns stopped sending" before any customer reports it.
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

## Build/version info

`build.commit` comes from `VERCEL_GIT_COMMIT_SHA` (injected automatically on
Vercel) and `build.version` from the package version. No setup needed on Vercel;
locally both fall back to `dev`/`unknown`.

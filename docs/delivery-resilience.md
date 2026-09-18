# Delivery resilience: what happens when something dies

Last verified: 2026-09-18.

Day3 sends mail from one long-running worker (`worker/index.ts`) that drains a
BullMQ queue in Redis and runs a 15-minute cron sweep. Postgres is the only
source of truth; Redis carries IDs and timing, never content. This document is
the failure matrix: for each thing that can go wrong, what the system does on
its own, what a customer sees, and what (if anything) an operator must do.

Two rules shape every answer below:

1. **Never send the same email twice.** Every send path claims a Postgres row
   atomically (`pending → sending`) before the provider call and writes the
   outcome after. A row whose provider call *may* have happened is never retried
   automatically. A late email is recoverable; a duplicate password reset or a
   duplicate campaign email is not.
2. **Lose as little as possible inside rule 1.** Right before each provider
   call the handler stamps `attempted_at` on that one row, in a write guarded on
   `status = 'sending'`. After a crash, the sweep can therefore tell "claimed
   but never attempted" (safe to retry) from "attempted, outcome unknown"
   (must not be retried). A campaign batch sends serially, so a crash costs at
   most one recipient per lane.

## Recovery clocks

| Clock | Cadence | Owner |
| --- | --- | --- |
| BullMQ retry | 5 s, 10 s, 20 s, 40 s, 80 s … (5 attempts; 8 for transactional and form confirmations) | Redis |
| BullMQ stalled-job check | ~30 s lock, redelivered up to 3 times | Redis |
| Automation tick | every 60 s | worker scheduler |
| Cron sweep | every 15 min | worker scheduler |
| Stuck-lock window | 15 min since `locked_at` (batches refresh it every 5 min) | sweep |
| Worker heartbeat | every 30 s, stale after 90 s | `/api/health` |
| Scheduler re-registration | on every Redis reconnect and every 5 min | worker |

## The matrix

### Worker process dies (SIGKILL, OOM, power loss, VPS reboot)

- **Campaign batches in flight.** Claimed rows sit in `sending`. After 15 min
  the sweep returns the unattempted ones to `pending` and fails the at-most-one
  per lane that was mid-call. The same sweep sees pending rows with nothing in
  flight and re-fans the campaign out at full lane width. Customer sees: the
  campaign pauses for up to 15 minutes, then finishes; the recipient list shows
  at most `SEND_LANES` failures with the reason "send attempt did not complete".
- **Transactional email in flight.** The one claimed row (`sending`) is failed
  by the sweep after 15 min; the caller sees `failed` on `GET /v1/emails/{id}`
  and can resend deliberately. Rows still `queued` are unaffected: their job is
  redelivered by BullMQ when the worker returns, and the sweep re-enqueues any
  that have no live job.
- **Automation send in flight.** Enrollment and ledger row are failed by the
  sweep (never re-dispatched). Other enrollments are untouched and advance on
  the next tick.
- **Imports, recipient generation, review.** The BullMQ job is redelivered as
  stalled; each handler resumes idempotently (`onConflictDoNothing`).
- **The queue itself.** Jobs live in Redis with AOF persistence, so nothing
  enqueued is lost. Repeatable schedulers are re-asserted at boot.
- **Operator action:** none, provided the supervisor restarts the process
  (`pm2 startup` once per machine; see `health-monitoring.md`). Without a
  supervisor, `/api/health` reports `checks.worker.ok = false` within 90 s.

### Worker restarted on purpose (deploy, `pm2 restart`)

SIGTERM starts a drain: batches stop between recipients and hand the rest back
to `pending`; the follow-up batch is enqueued as usual. Bounded at 45 s, and
the pm2 file gives it 60 s before SIGKILL. Cost to the customer: a pause of a
few seconds. Nothing is failed.

### Worker is up but cannot reach Redis

- ioredis reconnects with capped backoff; TCP keepalive (10 s) surfaces a
  half-open socket instead of trusting it for hours.
- BullMQ guards its blocking fetch: if the blocking call overstays it drops and
  reopens that connection itself.
- Jobs already running continue (they need Postgres, not Redis) except for the
  follow-up enqueue at the end of a batch, which waits for the reconnect. The
  send pacer fails open after 2 s (unpaced sends; SES throttling still backs
  it up) and logs once.
- The heartbeat is skipped while the worker connection does not answer, so
  `/api/health` degrades within 90 s.
- **Redis came back empty** (restarted without AOF, cold failover, `FLUSHALL`):
  in-flight jobs are gone but every row they were driving is in Postgres, so
  the sweep re-enqueues stranded transactional rows, re-fans stalled campaigns,
  rescues pipeline states, and the automation tick re-dispatches due
  enrollments. The schedulers that run those sweeps are re-registered by the
  worker on the reconnect event and again every 5 minutes, so an empty Redis
  cannot silently disable recovery.
- **Operator action:** none unless Redis stays down. Then nothing sends; the
  web tier's enqueue fails fast (5 s command timeout) and API callers get a
  200 with the row `queued` (transactional) or a 5xx (campaign submit), both
  reconciled by the sweep once Redis is back.

### Worker is up but cannot reach Postgres

- Every handler throws on its first query; BullMQ retries with backoff. A
  campaign batch that had claimed rows returns them to `pending` on the way out
  if it still can; if it cannot (the unlock is also a query), the sweep restores
  them after 15 min under the attempted/unattempted rule.
- Retries exhaust after ~75 s (campaign) or ~10.5 min (transactional and form
  confirmations). Exhausted jobs are dead-lettered into `job_logs` (once the DB
  is back) and paged through the error sink. The sweep then does the recovery:
  transactional rows `queued` with no live job are re-enqueued; campaigns with
  pending rows and nothing in flight are re-fanned out.
- A half-open Postgres socket is detected by TCP keepalive (15 s idle, then OS
  probes, roughly 12 minutes on Linux defaults). Until then that one job's
  connection is wedged; the pool has headroom (`DB_POOL_MAX` 20 against 12
  concurrent jobs), so other lanes continue.
- **Operator action:** none for a blip. For an outage longer than the retry
  budget, expect dead-letter rows in `job_logs`; the sweep replays the work,
  the rows are the audit trail.

### SES rejects or throttles

- **Rate throttle:** the pacer keeps the account under its ceiling; a stray
  throttle is absorbed with a braked retry (3 attempts). A persistent one
  pauses the campaign with `paused_code = rate_limit`; the sweep auto-resumes
  after 10 min.
- **Daily quota:** campaign paused with `daily_limit`; auto-resumed every ~2 h
  until SES lets it through. Transactional rows return to `queued` and retry.
- **Account suspended / configuration set missing:** campaign paused
  (`suspended` / `config`), ops paged, never auto-resumed.
- **Identity not verified:** sending domain flipped to `failed`, campaign
  paused (`config`), customer notified.
- **Ambiguous transport error** (timeout, 5xx after the request was written):
  terminal for that one recipient, never retried. Ten identical failures in a
  row trip the circuit breaker and pause the campaign with `error`.
- **Connection never established** (DNS failure, refused): provably unsent;
  the batch returns its remainder to `pending` and throws for a BullMQ retry.

### Web tier cannot reach Redis when a customer acts

- `POST /v1/emails`: the row is committed (with the idempotency claim) before
  the enqueue, so the caller gets a 200 and the sweep enqueues the job within
  15 min. Delayed, never lost, never duplicated.
- Campaign submit: the status flip to `pending_review` commits, then the
  enqueue fails and the route 5xxs. The campaign is rescued by the sweep's
  pipeline stage after 30 min of sitting in `pending_review`; the user sees it
  "in review" until then and cannot double-submit (409).
- Webhook emission is best-effort by design; `webhook_deliveries` is the outbox
  and the sweep drains it.

## What is still single

The VPS hosts both Redis and the worker. Losing the machine loses the queue's
availability (not its content, with AOF) and all processing until it is back.
Every recovery above still holds once it returns. For the next order of
magnitude: run Redis as a managed instance with persistence and a replica, and
run two worker replicas (everything is claim-based, so replicas need no
coordination). Both are configuration, not code.

## Operator quick reference

```sql
-- Work that exhausted its retries (replayed by the sweep; this is the trail)
select * from job_logs where status in ('failed','dead_letter') order by created_at desc limit 50;

-- Last sweep, with what it fixed
select created_at, status, payload_json from job_logs where job_type = 'cron' order by created_at desc limit 1;

-- Recipients a crash cost (the at-most-one-per-lane rows)
select campaign_id, count(*) from campaign_recipients
where status = 'failed' and error = 'send attempt did not complete (stuck lock)'
group by 1 order by 2 desc;
```

`GET /api/health` reports `checks.worker` (heartbeat) and `checks.cron`
(last sweep). Wire a monitor to the body, not just the status code
(`health-monitoring.md`).

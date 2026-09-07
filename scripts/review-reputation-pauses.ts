// npm run accounts:review-pauses [-- --apply]
//
// One-off backfill for the reputation auto-pause rule change (services/health.ts):
// a pause now needs a bad RATE *and* an absolute count of bad addresses behind
// it (MIN_BOUNCED_FOR_PAUSE / MIN_COMPLAINED_FOR_PAUSE), because at the old
// rate-only bar 2 bounces or 1 complaint in a 50-email send was enough. This
// finds accounts sitting on a pause that the new rule would never have issued
// and lifts it.
//
// Dry run by default: it prints every paused account and its verdict and writes
// nothing. Pass --apply to actually resume the eligible ones.
//
// WHY IT DOES NOT JUST RE-RUN computeAccountHealth
// ------------------------------------------------
// Account health reads a TRAILING 14-day window, and the pause itself stopped
// the sending that filled that window. Re-running it on an account paused three
// weeks ago reads `attempted: 0` → "normal" for EVERY account, including one
// that earned its pause mailing a purchased list. That would quietly unblock the
// real spammers along with the false positives.
//
// So eligibility is judged over the account's WHOLE send history instead, and
// only against the new absolute-count floors. That is a necessary condition: if
// an account has never accumulated MIN_BOUNCED_FOR_PAUSE hard bounces or
// MIN_COMPLAINED_FOR_PAUSE complaints in its entire life, then no 14-day window
// inside that life could have contained enough of them either, so the pause
// cannot survive the new rule at any window. Anything above those counts is left
// paused for a human to look at — this script never resumes on a judgment call.
//
// It also refuses to touch a pause a human placed: only a `paused_reason` in the
// auto-pause format qualifies, and any account with an `account.pause` admin
// action in the audit log is skipped outright.
import postgres from "postgres";
import { FREE_PLAN, PLANS, isPlanKey } from "../src/lib/plans-catalog";
import { MIN_BOUNCED_FOR_PAUSE, MIN_COMPLAINED_FOR_PAUSE } from "../src/services/health";
import { newId, nowIso } from "../src/lib/ids";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (use the Supabase direct/session URL, port 5432)");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

// The two shapes services/health.ts writes. An admin pause carries free text.
const AUTO_PAUSE_REASON = "^(Bounce|Complaint) rate ";
// Matches the hard-bounce filter in computeAccountHealth: email_events holds
// soft bounces too, and those never counted toward reputation.
const HARD_BOUNCE = '"bounceType"[[:space:]]*:[[:space:]]*"(Permanent|Undetermined)"';

type PausedAccount = {
  id: string;
  name: string;
  plan: string;
  subscription_status: string;
  paused_reason: string | null;
  updated_at: string;
  auto_paused: boolean;
  admin_paused: boolean;
};

const paused = await sql<PausedAccount[]>`
  select
    a.id,
    a.name,
    a.plan,
    a.subscription_status,
    a.paused_reason,
    a.updated_at,
    (a.paused_reason ~ ${AUTO_PAUSE_REASON}) as auto_paused,
    exists (
      select 1 from job_logs j
      where j.job_type = 'admin_action'
        and j.entity_id = a.id
        and j.payload_json like '%"action":"account.pause"%'
    ) as admin_paused
  from accounts a
  where a.risk_status = 'paused'
  order by a.updated_at desc
`;

if (paused.length === 0) {
  console.log("No paused accounts.");
  await sql.end();
  process.exit(0);
}

type Totals = { attempted: number; bounced: number; complained: number };

// Lifetime, not windowed — see the header comment.
async function lifetimeTotals(accountId: string): Promise<Totals> {
  const [campaign] = await sql<
    { attempted: string; bounced: string; complained: string }[]
  >`
    select
      count(*) filter (
        where status in ('sent','delivered','bounced','complained','unsubscribed')
      )::text as attempted,
      count(*) filter (where status = 'bounced')::text as bounced,
      count(*) filter (where status = 'complained')::text as complained
    from campaign_recipients
    where account_id = ${accountId}
  `;

  const [txAttempted] = await sql<{ attempted: string }[]>`
    select coalesce(sum(jsonb_array_length(t."to")), 0)::text as attempted
    from transactional_emails t
    where t.account_id = ${accountId}
      and t.status in ('sent','delivered','bounced','complained')
  `;

  // Per ADDRESS, matching the corrected numerator in computeAccountHealth.
  const [txBad] = await sql<{ bounced: string; complained: string }[]>`
    select
      count(distinct (e.transactional_email_id || ':' || coalesce(e.email, ''))) filter (
        where e.event_type = 'bounce' and e.payload_json ~ ${HARD_BOUNCE}
      )::text as bounced,
      count(distinct (e.transactional_email_id || ':' || coalesce(e.email, ''))) filter (
        where e.event_type = 'complaint'
      )::text as complained
    from email_events e
    join transactional_emails t on t.id = e.transactional_email_id
    where e.account_id = ${accountId}
      and t.status in ('sent','delivered','bounced','complained')
  `;

  return {
    attempted: Number(campaign.attempted) + Number(txAttempted.attempted),
    bounced: Number(campaign.bounced) + Number(txBad.bounced),
    complained: Number(campaign.complained) + Number(txBad.complained),
  };
}

const eligible: { account: PausedAccount; totals: Totals }[] = [];
const kept: { account: PausedAccount; totals: Totals; why: string }[] = [];

for (const account of paused) {
  const totals = await lifetimeTotals(account.id);
  const pct = (n: number) =>
    totals.attempted > 0 ? `${((n / totals.attempted) * 100).toFixed(2)}%` : "n/a";
  const line =
    `${account.id}  ${account.name}\n` +
    `    plan=${account.plan} paused=${account.updated_at}\n` +
    `    reason: ${account.paused_reason ?? "(none)"}\n` +
    `    lifetime: ${totals.attempted} attempted, ` +
    `${totals.bounced} bounced (${pct(totals.bounced)}), ` +
    `${totals.complained} complaints (${pct(totals.complained)})`;

  if (account.admin_paused) {
    kept.push({ account, totals, why: "an operator paused this account by hand" });
    console.log(`SKIP  ${line}\n    → an operator paused this account by hand\n`);
    continue;
  }
  if (!account.auto_paused) {
    kept.push({ account, totals, why: "paused_reason is not in the auto-pause format" });
    console.log(`SKIP  ${line}\n    → paused_reason is not in the auto-pause format\n`);
    continue;
  }
  if (totals.bounced >= MIN_BOUNCED_FOR_PAUSE) {
    const why = `${totals.bounced} lifetime bounces >= MIN_BOUNCED_FOR_PAUSE (${MIN_BOUNCED_FOR_PAUSE})`;
    kept.push({ account, totals, why });
    console.log(`KEEP  ${line}\n    → ${why}, needs a human\n`);
    continue;
  }
  if (totals.complained >= MIN_COMPLAINED_FOR_PAUSE) {
    const why = `${totals.complained} lifetime complaints >= MIN_COMPLAINED_FOR_PAUSE (${MIN_COMPLAINED_FOR_PAUSE})`;
    kept.push({ account, totals, why });
    console.log(`KEEP  ${line}\n    → ${why}, needs a human\n`);
    continue;
  }
  eligible.push({ account, totals });
  console.log(`LIFT  ${line}\n    → under both count floors; the new rule would not have paused this\n`);
}

console.log(
  `\n${paused.length} paused account(s): ${eligible.length} eligible to resume, ${kept.length} left paused.`,
);

if (!apply) {
  console.log("\nDry run — nothing was written. Re-run with --apply to resume the eligible accounts.");
  await sql.end();
  process.exit(0);
}

for (const { account, totals } of eligible) {
  // Mirrors POST /api/admin/accounts/[id]/resume: sending comes back only if the
  // plan and subscription would have allowed it anyway.
  const plan = isPlanKey(account.plan) ? PLANS[account.plan] : PLANS[FREE_PLAN];
  const sendingEnabled = plan.sendingEnabled && account.subscription_status === "active";
  const now = nowIso();

  await sql.begin(async (tx) => {
    // The risk_status guard keeps this a no-op if something paused the account
    // again between the read above and now.
    const updated = await tx`
      update accounts
         set risk_status = 'normal',
             paused_reason = null,
             sending_enabled = ${sendingEnabled},
             updated_at = ${now}
       where id = ${account.id}
         and risk_status = 'paused'
      returning id
    `;
    if (updated.length === 0) return;
    // Privileged cross-tenant mutation: audit it the way the admin routes do.
    await tx`
      insert into job_logs (id, job_type, entity_type, entity_id, status, payload_json, created_at, updated_at)
      values (
        ${newId("job")}, 'admin_action', 'account', ${account.id}, 'completed',
        ${JSON.stringify({
          action: "account.resume",
          actorEmail: "scripts/review-reputation-pauses.ts",
          actorUserId: "system",
          note: "reputation auto-pause rescinded: below the new absolute-count floors",
          previousReason: account.paused_reason,
          lifetimeAttempted: totals.attempted,
          lifetimeBounced: totals.bounced,
          lifetimeComplained: totals.complained,
        })},
        ${now}, ${now}
      )
    `;
  });
  console.log(`resumed ${account.id} (${account.name}) sending_enabled=${sendingEnabled}`);
}

console.log(`\nResumed ${eligible.length} account(s).`);
await sql.end();

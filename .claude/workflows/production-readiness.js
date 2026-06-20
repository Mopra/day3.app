export const meta = {
  name: 'production-readiness',
  description: 'Harden the whole app to production-ready, one PR per piece: author → adversarial review loop → AI-merge, sequentially.',
  whenToUse: 'Drive the app from MVP to production-ready autonomously. Full AI-approval-and-merge. Run deliberately — this opens, reviews, and merges real PRs.',
  phases: [
    { title: 'Plan',   detail: 'Scout the app and decompose into discrete, PR-sized hardening pieces' },
    { title: 'Harden', detail: 'Per piece: author a PR, run an adversarial 2-lens review loop, then AI-merge' },
    { title: 'Report', detail: 'Summarize what shipped, what was blocked, and what only a human can finish' },
  ],
}

// ----- Tunables -------------------------------------------------------------
const MAX_PIECES = 25      // hard cap on how many PRs this run will attempt
const MAX_ROUNDS = 4       // author<->review iterations before a piece is parked for a human
const ORACLE = 'npm run typecheck && npm run lint && npm test && npm run build'

// ----- Schemas --------------------------------------------------------------
const PLAN_SCHEMA = {
  type: 'object',
  required: ['pieces'],
  properties: {
    pieces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'rationale', 'area', 'risk'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string', description: 'PR-sized, single-concern' },
          rationale: { type: 'string', description: 'Why this is needed for production / onboarding many users' },
          area: { type: 'string', description: 'e.g. auth, billing, domains, campaigns, sending, data, UX, observability' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'Checkable conditions that mean this piece is done' },
        },
      },
    },
  },
}

const PR_SCHEMA = {
  type: 'object',
  required: ['opened', 'number', 'branch', 'summary', 'oracleGreen'],
  properties: {
    opened: { type: 'boolean', description: 'true if a PR was actually opened' },
    number: { type: 'number', description: 'PR number, or 0 if not opened' },
    branch: { type: 'string' },
    summary: { type: 'string' },
    oracleGreen: { type: 'boolean', description: 'true only if typecheck+lint+test+build all passed locally before pushing' },
    notes: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['approved', 'ranOracle', 'oracleGreen', 'blocking'],
  properties: {
    approved: { type: 'boolean' },
    ranOracle: { type: 'boolean', description: 'true if YOU ran typecheck+lint+test+build on the PR branch' },
    oracleGreen: { type: 'boolean' },
    blocking: { type: 'array', items: { type: 'string' }, description: 'Issues that MUST be fixed before approval' },
    nonBlocking: { type: 'array', items: { type: 'string' } },
  },
}

// ----- Phase 1: Plan --------------------------------------------------------
phase('Plan')
log('Scouting the app and building the production-readiness piece-list...')

const plan = await agent(
  `You are scoping work to take this Next.js newsletter SaaS (Clerk auth + Organizations, Drizzle/Postgres,
BullMQ/Redis queues, AWS SES sending, Cloudflare DNS automation) from MVP to PRODUCTION-READY — able to
onboard many real users. The app must stay SIMPLE; do not invent features outside MVP scope.

Read AGENTS.md (note: it is STALE — it describes an old Cloudflare Workers/D1 stack; the real stack is in
package.json), then survey app/, src/, and test/. Produce a decomposed, prioritized list of PR-sized,
single-concern hardening pieces. Each piece must be independently shippable and ordered so earlier pieces
do not depend on later ones.

Cover the dimensions that actually block onboarding many users: correctness bugs, error handling & edge
cases, security (account_id scoping on EVERY query, secrets, webhook signature verification, input
validation), data integrity (migrations, idempotency of queue jobs, dedupe of sends), rate limiting &
abuse, observability/logging, and the user-facing flows being genuinely polished (sign-up → org → first
campaign sent; domain verification; billing). Also include a piece to fix the stale AGENTS.md.

Keep it to the highest-value pieces (<= ${MAX_PIECES}). For each, give checkable acceptance criteria.
Return ONLY the structured plan.`,
  { label: 'scout+decompose', phase: 'Plan', schema: PLAN_SCHEMA, effort: 'high' }
)

const pieces = (plan.pieces || []).slice(0, MAX_PIECES)
log(`Plan: ${pieces.length} pieces. Order: ${pieces.map(p => p.id).join(', ')}`)

// ----- Phase 2: Harden (sequential — each piece builds on the prior merge) ---
phase('Harden')
const results = []

for (let i = 0; i < pieces.length; i++) {
  const piece = pieces[i]
  log(`[${i + 1}/${pieces.length}] ${piece.id}: ${piece.title}`)

  // -- Author: implement on a fresh branch off the latest main, prove it green, open the PR --
  const pr = await agent(
    `Implement ONE production-hardening piece as a single PR.

PIECE: ${piece.title}
AREA: ${piece.area}   RISK: ${piece.risk}
WHY: ${piece.rationale}
ACCEPTANCE CRITERIA (all must hold):
${(piece.acceptance || []).map(a => '  - ' + a).join('\n')}

Steps:
1. git fetch origin && create a branch off origin/main named "harden/${piece.id}".
2. Make the change. Keep it minimal and in keeping with the existing code's style. Do NOT expand scope.
3. Prove it green locally — you MUST run: ${ORACLE}. Fix until ALL pass. Add/adjust tests where it
   strengthens the acceptance criteria. Set oracleGreen=true ONLY if every check passed.
4. git push -u origin the branch and open a PR with "gh pr create" — body must list the acceptance
   criteria and how you verified each. Base = main.
5. Return the PR number, branch, a summary, and oracleGreen. If you could not get it green, still return
   with opened=false and explain in notes — do NOT open a broken PR.`,
    { label: `author:${piece.id}`, phase: 'Harden', schema: PR_SCHEMA, effort: 'high' }
  )

  if (!pr || !pr.opened || !pr.number) {
    results.push({ piece, status: 'author-failed', detail: pr?.notes || 'author did not open a PR' })
    log(`  ✗ ${piece.id}: author could not open a clean PR — parked for human`)
    continue
  }

  // -- Review loop: two independent lenses, BOTH must approve. Author addresses blocking comments. --
  let approved = false
  let round = 0
  let lastVerdicts = []

  while (!approved && round < MAX_ROUNDS) {
    round++

    const [correctness, ux] = await Promise.all([
      agent(
        `Adversarially review PR #${pr.number} (branch ${pr.branch}) through a CORRECTNESS & SECURITY lens.
Default to skeptical. git fetch && checkout the branch and READ the diff. You MUST run ${ORACLE} yourself
and report whether it is green (ranOracle/oracleGreen). Look hard for: account_id scoping on every query,
auth/permission gaps, unhandled errors, race conditions, non-idempotent queue jobs, missing input
validation, secrets/PII leaks. Approve ONLY if there are zero blocking issues AND the oracle is green.
Post your blocking findings to the PR as review comments via "gh pr review --request-changes" or
"--comment". Return the structured verdict.`,
        { label: `review:correctness:${piece.id}#${round}`, phase: 'Harden', schema: VERDICT_SCHEMA, effort: 'high' }
      ),
      agent(
        `Review PR #${pr.number} (branch ${pr.branch}) through a UX & SIMPLICITY lens for a NON-TECHNICAL
end user onboarding for the first time. git fetch && checkout the branch and read the diff. Check: clear
copy, loading/empty/error states, the happy path is obvious, no dead ends, accessible and consistent with
the existing UI, and that the change keeps the app SIMPLE (flag added complexity). You do not need to run
the full oracle, but set ranOracle/oracleGreen honestly if you do. Approve ONLY if there are zero blocking
UX issues. Post blocking findings via "gh pr review". Return the structured verdict.`,
        { label: `review:ux:${piece.id}#${round}`, phase: 'Harden', schema: VERDICT_SCHEMA, effort: 'high' }
      ),
    ])

    lastVerdicts = [correctness, ux].filter(Boolean)
    const blocking = lastVerdicts.flatMap(v => v.blocking || [])
    approved = lastVerdicts.length === 2 &&
      lastVerdicts.every(v => v.approved) &&
      correctness && correctness.ranOracle && correctness.oracleGreen

    if (approved) break
    if (round >= MAX_ROUNDS) break

    // Author addresses the blocking comments, must re-prove green.
    await agent(
      `Address the blocking review comments on PR #${pr.number} (branch ${pr.branch}). git fetch && checkout
the branch. Fix EVERY blocking item below, then re-run ${ORACLE} until all pass, then push.
BLOCKING:
${blocking.map(b => '  - ' + b).join('\n')}
Reply on the PR summarizing what you changed. Do not merge.`,
      { label: `address:${piece.id}#${round}`, phase: 'Harden', effort: 'high' }
    )
  }

  if (!approved) {
    results.push({ piece, status: 'review-blocked', pr: pr.number, rounds: round,
      detail: lastVerdicts.flatMap(v => v.blocking || []) })
    log(`  ⚠ ${piece.id}: not approved after ${round} rounds — PR #${pr.number} left open for human`)
    continue
  }

  // -- AI-merge (main is unprotected, so this is authoritative) --
  const merged = await agent(
    `PR #${pr.number} (branch ${pr.branch}) passed independent correctness+security AND UX review with a
green oracle. Merge it: "gh pr merge ${pr.number} --squash --delete-branch". Then git checkout main &&
git pull origin main so the next piece builds on it. Confirm the merge succeeded. Return a one-line status.`,
    { label: `merge:${piece.id}`, phase: 'Harden', effort: 'low' }
  )

  results.push({ piece, status: 'merged', pr: pr.number, rounds: round, detail: merged })
  log(`  ✓ ${piece.id}: merged PR #${pr.number} after ${round} review round(s)`)
}

// ----- Phase 3: Report ------------------------------------------------------
phase('Report')
const merged = results.filter(r => r.status === 'merged')
const blocked = results.filter(r => r.status !== 'merged')

const report = await agent(
  `Write a concise production-readiness report for the app owner. Here is what this run did:

MERGED (${merged.length}):
${merged.map(r => `  - ${r.piece.id} (PR #${r.pr}, ${r.rounds} round(s)): ${r.piece.title}`).join('\n') || '  (none)'}

NOT COMPLETED (${blocked.length}):
${blocked.map(r => `  - ${r.piece.id} [${r.status}]: ${r.piece.title} — ${JSON.stringify(r.detail)}`).join('\n') || '  (none)'}

Then add a "What only a human can finish" section covering things this run could NOT verify or do:
production secrets/env, real DNS for sending domains, a real Clerk Billing/plan config, real SES
production access (out of sandbox), load/abuse testing at scale, and a final human smoke test of
sign-up → org → first campaign sent. Be honest about residual risk. Keep it tight.`,
  { label: 'final-report', phase: 'Report', effort: 'high' }
)

return { mergedCount: merged.length, blockedCount: blocked.length, results, report }

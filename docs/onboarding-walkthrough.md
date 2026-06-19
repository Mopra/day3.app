# Onboarding walkthrough (sign-up → first campaign)

This documents the guided conversion path and the manual checks for each state.
The path is: **sign up → create/select an org → activate plan → verify a domain
→ import an audience → create → send a first campaign.**

## Flow

1. **Sign up / sign in.** Unauthenticated users hitting any `/(app)` route are
   redirected to `/sign-in` by `app/(app)/layout.tsx` (server-side).
2. **No active org → org picker.** A signed-in user without an active Clerk org
   is redirected to `/select-org` (Clerk `OrganizationList`) — never a raw 403.
   The same invariant holds server-side: `requireAccount()` throws a 403 only if
   the layout gate is bypassed (e.g. a direct API call), and that gate routes the
   user to `/select-org` first.
3. **Dashboard checklist.** `/dashboard` renders `OnboardingChecklist`, computed
   from real account state via `GET /api/account/onboarding`
   (`src/services/onboarding.ts`). Steps, in order:
   - Activate your plan → `/billing`
   - Verify a sending domain → `/domains`
   - Import an audience → `/audiences`
   - Create a campaign → `/campaigns/new`
   - Send your first campaign → `/campaigns`
   The checklist hides itself once all steps are complete. The next actionable
   step is highlighted.
4. **Send-blocking conditions are actionable.** Both the dashboard and the
   campaign detail page surface each blocker (billing inactive, unverified
   domain, no subscribers, account paused) as an `Alert` with a link to the
   page that fixes it. On the campaign page the **Submit & send** button is
   disabled while blocked, so the user fixes the cause instead of clicking into a
   raw API error. The server still enforces the same gates in
   `app/api/campaigns/[id]/submit/route.ts` (defence in depth).

## Manual checks (states)

Run `npm run dev` and exercise:

| State | How to reproduce | Expected UI |
|-------|------------------|-------------|
| No session | Open `/dashboard` signed out | Redirect to `/sign-in` |
| No org | Sign in, leave/destroy org | Redirect to `/select-org`, org picker shown |
| Loading | First dashboard load | Skeletons in stat cards / campaign table |
| Billing inactive | Account with `subscriptionStatus != active` | Dashboard alert "Activate your plan…" + checklist step incomplete |
| No verified domain | New account, plan active | Checklist "Verify a sending domain" highlighted; campaign submit blocked with link to `/domains` |
| No subscribers | Verified domain, empty audience | Checklist "Import an audience" highlighted; campaign submit blocked with link to `/audiences` |
| Account paused | `riskStatus = paused` | Destructive "Sending is paused" alert with reason; submit blocked |
| Fully set up | Verified domain + subscribers + active plan | Checklist hidden; submit enabled |
| Empty campaigns | No campaigns | "No campaigns yet" empty state with create link |
| API error | Make `/api/account` fail | Toast error; no unhandled rejection |

All fetches use the `useApi()` wrapper with `.catch(...)` handlers, so failures
become toasts rather than unhandled promise rejections in the console.

# Day3 MVP (Distribution Loop Engine)

**Product name:** Day3

**Core narrative:**

- Day 1: Build
- Day 2: Ship
- Day 3: Distribute

**Positioning (MVP):** You built it. Now get it seen.

---

## Goal

Build the smallest possible working product that proves this loop:

**Do X -> earn credits -> spend credits -> get promotion**

This MVP is not trying to solve trust, reputation, marketplace quality, or deep automation. It is only trying to prove that users will:

1. sign up
2. connect a basic profile
3. browse promotion opportunities
4. complete promotion tasks manually
5. earn credits
6. submit their own campaign
7. spend credits to get others to promote it

Everything should be optimized for speed of shipping, clarity, and manual oversight.

---

## Product framing

This is a **manual distribution exchange** for X/Twitter.

Users do simple promotion tasks for other users.
When a task is approved, they earn credits.
They can then spend those credits to create promotion requests for their own product or post.

The MVP should feel like:

- simple
- fast
- low-friction
- real
- slightly manual behind the scenes

It should **not** try to feel like a polished marketplace yet.

---

## Core MVP principle

**Manual first. Software second.**

Anything that is hard to automate should be handled by:

- admin review
- proof submission
- simple status changes
- manual approval in Firebase

Do not block the MVP on API integrations with X.
Do not block the MVP on advanced trust systems.
Do not block the MVP on recommendation engines.

---

# Scope

## In scope

- auth
- onboarding
- basic user profile
- credit balance
- list of available tasks
- task detail page
- task submission with proof link/text
- admin approval of completed tasks
- campaign creation
- campaign credit cost
- campaign task generation
- basic user dashboard
- admin dashboard

## Out of scope for MVP

- X OAuth/integration
- automated post verification
- feeds personalized by AI
- public user reputation system
- payment system
- referral system
- notifications beyond basic UI state
- comments/chat between users
- mobile app
- multi-platform support
- advanced moderation tooling
- recommendation engine
- automatic fraud detection

---

# MVP user flow

## New user flow

1. User signs up with Clerk
2. User completes onboarding:
   - name / handle
   - X username
   - short bio
   - interests/topics
3. User lands on dashboard
4. User sees available promotion tasks
5. User opens a task
6. User completes it manually on X
7. User submits proof
8. Admin approves
9. Credits are added
10. User creates their own promotion campaign
11. Credits are deducted
12. Their campaign becomes available as tasks for others

---

# The smallest workable action model

Keep actions extremely narrow.

## Supported task types for MVP

Only support these 3 task types:

1. **Like a post**
2. **Reply to a post**
3. **Quote repost a post**

These are simple to understand and easy to execute manually.

### Credit values

Start with fixed credit values:

- Like post = 1 credit
- Reply to post = 3 credits
- Quote repost = 5 credits

This is intentionally crude.
It is good enough for MVP.

Later, this can evolve into weighted credits.

---

# Core entities

Use Firestore as the source of truth.

## 1. User

Collection: `users`

Fields:

- `id`
- `clerkUserId`
- `email`
- `name`
- `username`
- `xHandle`
- `bio`
- `interests: string[]`
- `credits: number`
- `role: 'user' | 'admin'`
- `createdAt`
- `updatedAt`

## 2. Campaign

A campaign is something a user wants promoted.

Collection: `campaigns`

Fields:

- `id`
- `ownerUserId`
- `title`
- `description`
- `targetUrl`
- `topics: string[]`
- `status: 'draft' | 'active' | 'paused' | 'completed'`
- `budgetCredits`
- `remainingCredits`
- `createdAt`
- `updatedAt`

## 3. CampaignTask

Each campaign creates individual tasks that users can claim and complete.

Collection: `campaignTasks`

Fields:

- `id`
- `campaignId`
- `ownerUserId`
- `type: 'like' | 'reply' | 'quote'`
- `instructions`
- `targetUrl`
- `creditReward`
- `status: 'open' | 'claimed' | 'submitted' | 'approved' | 'rejected'`
- `claimedByUserId: string | null`
- `claimedAt: timestamp | null`
- `submittedAt: timestamp | null`
- `reviewedAt: timestamp | null`
- `reviewedByUserId: string | null`
- `proofText: string | null`
- `proofUrl: string | null`
- `createdAt`

## 4. CreditTransaction

Collection: `creditTransactions`

Fields:

- `id`
- `userId`
- `type: 'earned' | 'spent' | 'refund'`
- `amount`
- `sourceType: 'task_approval' | 'campaign_creation' | 'manual_adjustment'`
- `sourceId`
- `description`
- `createdAt`

## 5. TaskSubmissionLog (optional)

You may skip this for MVP and keep submission fields on `campaignTasks`.
If added later, this stores audit history.

---

# Simplified business logic

## Earning credits

A user earns credits when:

- they claim a task
- complete it externally on X
- submit proof
- admin approves the task

On approval:

- task status becomes `approved`
- user credits increase by `creditReward`
- create `creditTransactions` record

## Spending credits

A user spends credits when creating a campaign.

Example:

- budget = 30 credits
- system generates tasks based on selected mix:
  - 10 likes x 1 credit = 10
  - 5 replies x 3 credits = 15
  - 1 quote x 5 credits = 5

Total = 30 credits

On campaign creation:

- ensure user has enough credits
- deduct credits from user balance
- create campaign
- create campaign tasks
- create `creditTransactions` record

---

# MVP constraints

These are important to keep the product usable.

## User constraints

- one user can only claim a limited number of tasks at a time
- recommended: max 3 claimed open tasks
- users cannot claim their own campaign tasks

## Campaign constraints

- campaign must include target URL
- campaign must include at least one task
- campaign owner must have enough credits
- only X/Twitter URLs allowed for MVP

## Submission constraints

- proof is required
- proof can be either:
  - reply URL
  - quote post URL
  - text description for like actions
- all submissions go to admin review

---

# Product surfaces

## 1. Marketing / landing page

Purpose:

- explain the loop in one sentence
- get users to sign up

Sections:

- headline
- subheadline
- how it works
- CTA

Suggested copy:

**Earn distribution by helping others get seen.**
Complete simple promotion tasks on X, earn credits, and spend them to get your own product or post promoted.

---

## 2. Auth

Use Clerk.

Pages:

- sign-in
- sign-up

Protect app routes with Clerk middleware.

---

## 3. Onboarding

Page: `/onboarding`

Fields:

- name
- x handle
- bio
- interests/topics

On submit:

- create or update `users` doc
- set initial credits to `25` (signup bonus)
- redirect to dashboard

---

## 4. User dashboard

Page: `/dashboard`

Show:

- current credits
- active claimed tasks
- available open tasks
- own campaigns
- CTA to create campaign

This is the main logged-in home.

---

## 5. Task marketplace

Page: `/tasks`

Show cards for open tasks with:

- task type
- campaign title
- short instructions
- reward credits
- topic tags
- target URL
- claim button

Filtering can be minimal:

- all
- like
- reply
- quote

Optional later:

- filter by topics

---

## 6. Task detail page

Page: `/tasks/[id]`

Show:

- task instructions
- link to target post/product
- reward
- campaign context
- claim button if open
- submission form if claimed by current user

Submission form fields:

- proof URL
- notes

Actions:

- claim task
- submit proof

---

## 7. Campaign creation page

Page: `/campaigns/new`

Purpose:

Allow a user to spend credits to request promotion.

Fields:

- campaign title
- description
- target URL
- target type
- topics
- number of like tasks
- number of reply tasks
- number of quote tasks

Derived UI:

- live total cost calculation
- current available credits
- submit disabled if insufficient credits

On submit:

- create campaign
- create child tasks
- deduct credits

---

## 8. My campaigns page

Page: `/campaigns`

Show:

- list of user campaigns
- status
- budget
- remaining credits
- task completion progress

Simple progress example:

- total tasks
- approved tasks
- submitted tasks
- open tasks

---

## 9. Admin dashboard

Page: `/admin`

Only for admin role.

Show:

- pending task submissions
- approve / reject actions
- users overview
- campaigns overview

This can be ugly.
It only needs to work.

Admin task review card:

- task type
- campaign title
- submitter
- proof URL
- notes
- approve button
- reject button

On approve:

- update task status
- add credits to user
- add credit transaction

On reject:

- update task status to `rejected`
- optionally allow resubmission later

---

# Recommended app structure

## Frontend

- Next.js App Router
- TailwindCSS
- shadcn/ui
- Clerk auth

## Backend

- Firebase Firestore
- Firebase Functions for secure mutations
- Firebase Hosting if desired, or deploy Next separately and keep Firebase for backend

Given the selected stack, simplest path:

- Next.js app handles UI
- Firebase handles Firestore and Cloud Functions
- Clerk handles auth
- server actions or API routes call Firebase logic

---

# Suggested folder structure

```txt
/src
  /app
    /(marketing)
      /page.tsx
    /(auth)
      /sign-in/[[...sign-in]]/page.tsx
      /sign-up/[[...sign-up]]/page.tsx
    /(app)
      /dashboard/page.tsx
      /onboarding/page.tsx
      /tasks/page.tsx
      /tasks/[id]/page.tsx
      /campaigns/page.tsx
      /campaigns/new/page.tsx
      /admin/page.tsx
    /api
      /webhooks/clerk/route.ts
  /components
    /ui
    /layout
    /tasks
    /campaigns
    /dashboard
  /lib
    /clerk.ts
    /firebase.ts
    /auth.ts
    /db.ts
    /credits.ts
    /validators.ts
    /types.ts
  /server
    /actions
      /tasks.ts
      /campaigns.ts
      /admin.ts
```

---

# Minimal technical architecture

## Auth flow

- Clerk authenticates the user
- Store `clerkUserId` on the `users` Firestore document
- Use Clerk middleware to protect logged-in routes
- Use Clerk webhook to sync basic user info into Firestore if desired

## Data access

Keep data access thin and boring.

Use:

- Firestore for collections
- helper functions in `lib/db.ts`
- server-side actions or API routes for mutations

Do not over-engineer repositories/services for MVP.

---

# Required server actions / mutations

## User

- `createOrUpdateProfile`
- `getCurrentUserProfile`

## Tasks

- `listOpenTasks`
- `getTaskById`
- `claimTask(taskId)`
- `submitTaskProof(taskId, proofUrl, proofText)`

## Campaigns

- `createCampaign(payload)`
- `listMyCampaigns(userId)`

## Admin

- `listPendingSubmissions()`
- `approveTask(taskId)`
- `rejectTask(taskId, reason?)`
- `adjustUserCredits(userId, amount)`

---

# Validation rules

Use Zod for request validation.

## Campaign validation

- title required
- target URL required and valid
- at least one task count > 0
- all task counts >= 0
- total credit cost > 0

## Task submission validation

- task must be claimed by current user
- proof URL optional for likes, but note required
- proof URL required for replies and quote posts

---

# Firestore security approach

Keep it simple.

## Client can read

- own user profile
- open tasks
- own claimed tasks
- own campaigns

## Client cannot directly write critical fields

Important writes should happen through server actions / cloud functions:

- claiming task
- submitting proof
- creating campaign
- approving task
- changing credits

This reduces fraud and race conditions.

---

# Admin model

Add a simple `role` field to the user document.

Admin pages check:

- Clerk user exists
- matching Firestore user doc has `role = 'admin'`

Do not overcomplicate admin permissions for MVP.

---

# Bare bones UI plan

Use shadcn/ui components only where useful.

## Needed UI components

- Button
- Card
- Input
- Textarea
- Badge
- Select
- Tabs
- Table
- Dialog
- Form

## Design direction

- clean
- neutral
- utility-first
- no fancy branding needed
- prioritize readability and task completion

---

# Exact pages to build

## Public

### `/`
Landing page

### `/sign-in`
Clerk

### `/sign-up`
Clerk

## Authenticated

### `/onboarding`
Create profile

### `/dashboard`
Overview page

### `/tasks`
Available tasks

### `/tasks/[id]`
Task details + claim/submit

### `/campaigns`
My campaigns

### `/campaigns/new`
Create campaign

## Admin

### `/admin`
Review submissions

That is enough.

---

# Dashboard widgets

Keep the dashboard dead simple.

## Top stats

- current credits
- claimed tasks in progress
- active campaigns

## Sections

1. Available tasks
2. My claimed tasks
3. My campaigns

---

# Campaign creation logic

## Credit cost formula

Fixed pricing for MVP:

- like count * 1
- reply count * 3
- quote count * 5

### Example function

```ts
const totalCost = likeCount * 1 + replyCount * 3 + quoteCount * 5;
```

## Task generation

When a campaign is created, generate one `campaignTasks` document per task.

Example:

- if likeCount = 10
- generate 10 tasks of type `like`

Each task stores:

- campaign reference
- task type
- target URL
- reward
- short instructions

---

# Task instructions templates

Use fixed templates.

## Like

"Open the target X post and like it from your real account. Then submit a short note confirming completion."

## Reply

"Write a genuine reply to the target X post. No generic spam. Submit the reply URL as proof."

## Quote

"Quote repost the target X post with your own commentary. Submit the quote post URL as proof."

These can be stored in code.

---

# Approval logic

## Approve task

When admin approves:

1. verify task is in `submitted`
2. set task to `approved`
3. increment submitter credits by `creditReward`
4. create `creditTransactions` record
5. decrement campaign remaining open workload if needed

## Reject task

When admin rejects:

1. set task to `rejected`
2. optionally store reason
3. allow admin to manually reopen later if needed

---

# Anti-abuse for MVP

Keep this minimal but real.

## Add these checks now

- max 3 claimed open tasks per user
- cannot claim own task
- duplicate proof URL rejected
- basic URL validation
- admin approval required for all rewards

## Do not build yet

- automated fraud detection
- account quality scoring
- audience matching engine
- semantic spam detection

Those are later-stage problems.

---

# Analytics to track from day one

Even for MVP, track a few things.

## Key metrics

- total signups
- onboarded users
- tasks claimed
- tasks submitted
- task approval rate
- credits earned
- credits spent
- campaigns created
- campaign completion rate

If easiest, track these by querying Firestore, not a dedicated analytics pipeline.

---

# Seed data

To make the MVP usable instantly, seed:

- 1 admin user
- 5 to 10 fake or real starter campaigns
- 20 to 50 initial open tasks

Without seed tasks, a new user sees an empty marketplace and the product feels broken.

---

# Development phases

## Phase 1: Foundation

Build:

- Next app setup
- Tailwind
- shadcn/ui
- Clerk auth
- Firebase config
- protected routes
- user profile model

## Phase 2: Core loop

Build:

- tasks list
- task detail
- claim task
- submit proof
- admin approval
- credit balance updates

## Phase 3: Spend credits

Build:

- create campaign form
- budget calculation
- credit deduction
- task generation
- my campaigns page

## Phase 4: Cleanup

Build:

- empty states
- loading states
- basic error handling
- simple admin UX improvements

---

# Definition of done

The MVP is done when this full scenario works end-to-end:

1. User signs up
2. User completes onboarding
3. User sees available tasks
4. User claims one
5. User submits proof
6. Admin approves it
7. User credit balance increases
8. User creates a campaign with those credits
9. Campaign tasks appear in marketplace
10. Another user can claim them

If that works, the MVP is valid.

---

# Build order for the AI agent

Use this exact order.

## Step 1
Set up project:

- Next.js App Router with TypeScript
- TailwindCSS
- shadcn/ui
- Clerk
- Firebase SDK
- Zod

## Step 2
Create core types and Firestore schema helpers.

## Step 3
Implement auth and onboarding.

## Step 4
Implement user dashboard.

## Step 5
Implement tasks list and task detail.

## Step 6
Implement claim task flow.

## Step 7
Implement submission flow.

## Step 8
Implement admin review flow.

## Step 9
Implement credits ledger and balance updates.

## Step 10
Implement campaign creation and task generation.

## Step 11
Implement my campaigns page.

## Step 12
Seed starter data and verify the full loop.

---

# Notes for the AI builder

## Priorities

Always prefer:

1. simple working implementation
2. server-side safety for credit mutations
3. readable code
4. minimal abstractions

## Avoid

- premature optimization
- deep architecture patterns
- generic plugin systems
- background job complexity
- fancy animations
- complex state management libraries unless clearly needed

## Preferred implementation style

- server actions where practical
- Firestore queries kept simple
- forms with clear validation
- status-based UI
- no hidden magic

---

# Nice-to-have after MVP

Only after the MVP loop works:

- topic-based matching
- reputation score
- better proof verification
- notifications
- campaign performance page
- review reasons and resubmission flow
- lightweight moderation tools
- waitlist / invite flow
- Stripe credits top-up
- X API integration

---

# Final instruction

Build the smallest working version that proves the exchange loop is real.

Do not optimize for elegance.
Optimize for:

- shipping speed
- end-to-end functionality
- easy manual oversight
- easy future iteration

The MVP succeeds if users can earn credits by promoting others, then spend those credits to get promoted themselves.


# Day3

The app behind [day3.app](https://day3.app).

## Stack

- [Next.js](https://nextjs.org) (App Router) + React
- [Tailwind CSS](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)
- [Clerk](https://clerk.com) — authentication (middleware-protected routes, user webhooks)
- [Supabase](https://supabase.com) — Postgres database
- Deployed on [Vercel](https://vercel.com)

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` from the template and fill in the values (see `.env.example`).

3. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Project layout

- `src/app` — routes (landing page, Clerk sign-in/sign-up, Clerk webhook)
- `src/components/ui` — shadcn/ui components
- `src/lib` — Supabase client (`supabase.ts`), utilities (`utils.ts`)
- `src/middleware.ts` — Clerk auth middleware (all routes protected except `/`, sign-in/up, and webhooks)
- `supabase/` — database schema and migrations

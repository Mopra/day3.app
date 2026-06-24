-- Local development seed (npm run db:seed). Idempotent via ON CONFLICT DO NOTHING.
-- To attach the seeded account to YOUR Clerk org, replace clerk_org_id below
-- with your real org id (org_...) BEFORE first dashboard load, or just use
-- the app normally and let it create its own account.

INSERT INTO accounts (
  id, clerk_org_id, name, plan, subscription_status,
  monthly_email_limit, monthly_email_sent_count,
  sending_enabled, risk_status, company_address, created_at, updated_at
) VALUES (
  'acc_seed000000000000000000', 'org_seed_replace_me', 'Seed Co', '10k_plan', 'active',
  10000, 0,
  true, 'normal', 'Seed Co, 1 Example Street, Copenhagen, DK',
  '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
) ON CONFLICT DO NOTHING;

INSERT INTO sending_domains (
  id, account_id, domain, from_name, from_email,
  provider, verification_status, dkim_status, admin_override_verified,
  created_at, updated_at
) VALUES (
  'dom_seed000000000000000000', 'acc_seed000000000000000000', 'updates.seed.co',
  'Seed Co', 'news@updates.seed.co',
  'ses', 'pending', 'pending', true,
  '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
) ON CONFLICT DO NOTHING;

INSERT INTO audiences (id, account_id, name, created_at, updated_at)
VALUES (
  'aud_seed000000000000000000', 'acc_seed000000000000000000', 'Product updates',
  '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
) ON CONFLICT DO NOTHING;

INSERT INTO subscribers (
  id, account_id, audience_id, email, first_name, status, source, created_at, updated_at
) VALUES
  ('sub_seed000000000000000001', 'acc_seed000000000000000000', 'aud_seed000000000000000000', 'alice@example.com',   'Alice',   'subscribed', 'seed', '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'),
  ('sub_seed000000000000000002', 'acc_seed000000000000000000', 'aud_seed000000000000000000', 'bob@example.com',     'Bob',     'subscribed', 'seed', '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'),
  ('sub_seed000000000000000003', 'acc_seed000000000000000000', 'aud_seed000000000000000000', 'charlie@example.com', 'Charlie', 'subscribed', 'seed', '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'),
  ('sub_seed000000000000000004', 'acc_seed000000000000000000', 'aud_seed000000000000000000', 'dana@example.com',    'Dana',    'subscribed', 'seed', '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'),
  ('sub_seed000000000000000005', 'acc_seed000000000000000000', 'aud_seed000000000000000000', 'erik@example.com',    'Erik',    'subscribed', 'seed', '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z')
ON CONFLICT DO NOTHING;

INSERT INTO campaigns (
  id, account_id, audience_id, sending_domain_id,
  name, subject, from_name, from_email, html_body, status,
  created_at, updated_at
) VALUES (
  'cmp_seed000000000000000000', 'acc_seed000000000000000000', 'aud_seed000000000000000000', 'dom_seed000000000000000000',
  'Welcome update', 'What''s new at Seed Co', 'Seed Co', 'news@updates.seed.co',
  '<h1>Hello {{first_name}}!</h1><p>We shipped a brand new dashboard this week.</p>', 'draft',
  '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
) ON CONFLICT DO NOTHING;

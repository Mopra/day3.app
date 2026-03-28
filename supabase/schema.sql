-- Day3 Supabase Schema
-- Run this in the Supabase SQL Editor to create the database tables.

-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clerk_user_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  x_handle TEXT NOT NULL,
  bio TEXT DEFAULT '',
  interests TEXT[] DEFAULT '{}',
  credits INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE campaigns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  target_url TEXT NOT NULL,
  topics TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  budget_credits INTEGER NOT NULL,
  remaining_credits INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE campaign_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('like', 'reply', 'quote')),
  instructions TEXT NOT NULL,
  target_url TEXT NOT NULL,
  credit_reward INTEGER NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'submitted', 'approved', 'rejected')),
  claimed_by_user_id TEXT,
  claimed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by_user_id TEXT,
  proof_text TEXT,
  proof_url TEXT,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE credit_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('earned', 'spent', 'refund')),
  amount INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('task_approval', 'campaign_creation', 'signup_bonus')),
  source_id TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Indexes (matching the compound queries in db.ts)
-- ============================================================

CREATE INDEX idx_users_clerk_user_id ON users(clerk_user_id);
CREATE INDEX idx_campaign_tasks_status_created ON campaign_tasks(status, created_at DESC);
CREATE INDEX idx_campaign_tasks_claimed_by ON campaign_tasks(claimed_by_user_id, status, claimed_at DESC);
CREATE INDEX idx_campaign_tasks_owner_status ON campaign_tasks(owner_user_id, status, submitted_at ASC);
CREATE INDEX idx_campaign_tasks_campaign_id ON campaign_tasks(campaign_id);
CREATE INDEX idx_campaign_tasks_proof_url ON campaign_tasks(proof_url) WHERE proof_url IS NOT NULL;
CREATE INDEX idx_campaigns_owner ON campaigns(owner_user_id, created_at DESC);
CREATE INDEX idx_credit_transactions_user ON credit_transactions(user_id);

-- ============================================================
-- RPC: Atomically increment user credits
-- ============================================================

CREATE OR REPLACE FUNCTION increment_credits(row_id UUID, amount INTEGER)
RETURNS void AS $$
BEGIN
  UPDATE users SET credits = credits + amount WHERE id = row_id;
END;
$$ LANGUAGE plpgsql;

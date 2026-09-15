-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- The "Tracker" tool (Tools -> Tracker). Two independent, PERMANENT tables —
-- neither has a foreign key to tiktok_campaigns / campaign_creator_campaigns
-- on purpose, so deleting a campaign from Detailed Metrics (or its Campaign
-- Creator row) never touches Tracker history. Never touched by the daily
-- retention job (netlify/functions/cleanup.js).
--
-- tracker_tests — one row per campaign launched through Campaign Creator.
-- Auto-populated once that campaign's NY test day is over (see
-- netlify/functions/tracker-run.js, the daily cron) with campaign_id/sn/type/
-- cpa/cpnc/epc/roas/result/test_date. offer/hook/notes are user-entered and
-- are NEVER touched by the auto-populate upsert (it only sets the auto
-- columns) — see _shared/tracker.js. A row is "frozen" (never auto-updated
-- again) once test_date is in the past relative to the run's target date.
create extension if not exists pgcrypto;

create table if not exists tracker_tests (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   text not null unique,      -- TikTok campaign_id; upsert key for auto-populate
  sn            text not null,             -- campaign name, e.g. "ad1" (display "SN" column)
  offer         text,                      -- 'CPI' | 'SWEEPS' — user-entered
  type          text not null default 'SLIDES', -- 'SLIDES' | 'VIDEOS' — auto (interactive card used?)
  hook          text,                      -- user-entered
  spend         numeric not null default 0, -- that test day's TikTok spend; rows with 0 are never even inserted (see _shared/tracker.js) but the column stays for older rows / filtering
  cpa           numeric not null default 0,
  cpnc          numeric not null default 0,
  epc           numeric not null default 0,
  roas          numeric not null default 0,
  result        text not null default 'DEAD', -- 'DEAD' | 'BREAK_EVEN' | 'WINNER' — derived from roas
  notes         text,                      -- user-entered
  test_date     date not null,             -- NY date these auto stats belong to
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Existing installs: the table already existed before the `spend` column was
-- added, so `create table if not exists` above won't add it.
alter table tracker_tests add column if not exists spend numeric not null default 0;

create index if not exists tracker_tests_test_date_idx on tracker_tests (test_date);

-- tracker_winners — fully manual, entered by hand from the Winners page. No
-- auto-population, no link to any campaign. "SN" (1, 2, 3, ...) is just the
-- row's position and is NOT stored — the frontend numbers rows by created_at.
create table if not exists tracker_winners (
  id              uuid primary key default gen_random_uuid(),
  offer           text,                  -- 'CPI' | 'SWEEPS'
  type            text,                  -- 'SLIDES' | 'VIDEOS'
  hook            text,
  total_spend     numeric not null default 0,
  total_revenue   numeric not null default 0,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists tracker_winners_created_idx on tracker_winners (created_at);

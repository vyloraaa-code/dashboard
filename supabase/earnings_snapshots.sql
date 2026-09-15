-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Backs ONLY the Live Performance graph's "Earnings" series — mirrors
-- tiktok_spend_snapshots.sql exactly, but for combined Glitchy+Mabac
-- earnings instead of TikTok spend. Neither affiliate network gives us
-- hourly-broken-out earnings (Mabac's Everflow report is a same-day total
-- only), so we snapshot the running combined total once per America/New_York
-- hour and derive each hour's earnings as the difference between
-- consecutive snapshots.
--
-- One row per (NY date, NY hour). The row for the CURRENT hour is overwritten
-- on every Glitchy poll (~60s while the dashboard is open), so the current
-- hour's bar rises live as new conversions land instead of only appearing
-- once the hour is over. Rows older than ~14 days are swept automatically.
-- Nothing here touches Detailed Metrics or daily_totals.

create table if not exists earnings_snapshots (
  date                date    not null,
  hour                integer not null check (hour >= 0 and hour <= 23),
  cumulative_earnings numeric not null default 0,   -- combined Glitchy+Mabac earnings today, as of the last write in this hour
  updated_at          timestamptz not null default now(),
  primary key (date, hour)
);

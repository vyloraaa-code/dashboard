-- Run this once in the Supabase SQL editor. Idempotent.
--
-- Lets a campaign be "hidden" from Kryzxr Ads when TikTok refuses to delete it
-- (e.g. the advertiser account is suspended/limited). The campaign still exists
-- in TikTok; it just no longer clutters the Detailed Metrics table, and a
-- campaign re-sync will NOT bring it back (the sync upsert doesn't touch these
-- columns, so hidden=true is preserved).
--
-- No historical daily-performance data is affected.

alter table tiktok_campaigns add column if not exists hidden    boolean not null default false;
alter table tiktok_campaigns add column if not exists hidden_at timestamptz;

create index if not exists tiktok_campaigns_hidden_idx on tiktok_campaigns (hidden) where hidden;

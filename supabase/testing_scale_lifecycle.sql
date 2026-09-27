-- Idempotent. Backs the Phase-1 shadow-mode testing/scale decision engine
-- (netlify/functions/_shared/testing-scale-engine.js). Columns bolted onto
-- tiktok_campaigns following the existing alter-table convention (see
-- auto_budget_bump.sql, tiktok_campaign_metrics.sql).
--
-- lifecycle_state — current verdict: 'testing' (default) | 'scaling' | 'killed'.
--   Phase 1 never acts on this — no campaign_update/pause is ever issued from
--   it. 'scaling' and 'killed' are terminal for Phase 1: once set, the engine
--   stops re-evaluating that campaign (see decide() in testing-scale-engine.js).
-- lifecycle_state_since — when the CURRENT state was entered (used to display
--   "time in state" later; also anchors the accumulators below).
-- lifecycle_*_accum — cumulative spend / affiliate payout / affiliate
--   conversions SINCE entering the current lifecycle_state, folded in every
--   poll from the marginal (not blindly re-added) delta of the day's running
--   total — because a test can span more than one calendar day and
--   today_spend (and today's Glitchy/Mabac totals) reset to 0 at NY midnight.
--   Reset to 0 whenever lifecycle_state changes.
-- lifecycle_last_seen_today_* — the day's running total (TikTok spend /
--   affiliate payout / affiliate conversions) as observed on the PREVIOUS
--   poll, used only to compute this poll's marginal delta. Reset to 0 at NY
--   day rollover (see foldStaleLifecycleAccumBeforeReset, called from both
--   tiktok-campaigns.js's "metrics" action and cleanup.js's daily cron,
--   BEFORE either zeroes today_spend for a stale date) — never reset on a
--   lifecycle_state change (today's running counters don't care about state).
alter table tiktok_campaigns add column if not exists lifecycle_state text not null default 'testing';
alter table tiktok_campaigns add column if not exists lifecycle_state_since timestamptz;
alter table tiktok_campaigns add column if not exists lifecycle_spend_accum numeric not null default 0;
alter table tiktok_campaigns add column if not exists lifecycle_payout_accum numeric not null default 0;
alter table tiktok_campaigns add column if not exists lifecycle_conversions_accum numeric not null default 0;
alter table tiktok_campaigns add column if not exists lifecycle_last_seen_today_spend numeric not null default 0;
alter table tiktok_campaigns add column if not exists lifecycle_last_seen_today_payout numeric not null default 0;
alter table tiktok_campaigns add column if not exists lifecycle_last_seen_today_conversions numeric not null default 0;

create index if not exists tiktok_campaigns_lifecycle_state_idx on tiktok_campaigns (lifecycle_state);

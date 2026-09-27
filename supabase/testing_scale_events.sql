-- Idempotent. Append-only audit log for the Phase-1 testing/scale decision
-- engine — the actual record of what the bot decided and why. The
-- lifecycle_* columns on tiktok_campaigns (see testing_scale_lifecycle.sql)
-- are a snapshot only (overwritten every poll); this table is the history.
create table if not exists testing_scale_events (
  id bigint generated always as identity primary key,
  campaign_id text not null,
  campaign_name text,
  connection_id uuid,
  advertiser_id text,
  ts timestamptz not null default now(),
  from_state text not null,
  to_state text not null,
  reason text not null,
  spend_at_decision numeric not null default 0,
  payout_at_decision numeric not null default 0,
  conversions_at_decision numeric not null default 0,
  roas_at_decision numeric not null default 0
);

create index if not exists testing_scale_events_campaign_idx on testing_scale_events (campaign_id, ts desc);

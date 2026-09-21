-- Run this once in the Supabase SQL editor for this project.
-- Backs the TikTok Ads MCP integration: OAuth connection storage + advertiser
-- account discovery/selection. Completely independent of the Glitchy tables
-- (reset_baselines, daily_totals) — nothing existing is modified.
--
-- See netlify/functions/tiktok-auth-start.mjs, tiktok-auth-callback.mjs,
-- tiktok-connections.mjs and _shared/tiktok-mcp.mjs.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- The OAuth client this deployment dynamically-registered with the TikTok MCP
-- authorization server (RFC 7591). Keyed by redirect_uri so that moving the
-- dashboard to a new domain forces a fresh registration rather than reusing a
-- client whose redirect URI no longer matches.
-- ---------------------------------------------------------------------------
create table if not exists tiktok_oauth_client (
  redirect_uri        text primary key,
  server_url          text not null,
  client_id           text not null,
  client_secret       text,                 -- TikTok MCP is a public client; expected null
  client_id_issued_at bigint,
  registration        jsonb,                -- full DCR response, for debugging
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Short-lived: one row per in-flight authorization. Holds the PKCE code
-- verifier and the OAuth `state` used to correlate the browser redirect back
-- to this server. Rows are deleted on successful callback; stale rows are
-- swept on each auth-start.
-- ---------------------------------------------------------------------------
create table if not exists tiktok_oauth_transactions (
  state         text primary key,
  code_verifier text not null,
  label         text,                       -- optional user-supplied name for the connection
  redirect_uri  text not null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- One row per authenticated TikTok for Business user. `tokens` holds the
-- access + refresh tokens and is NEVER sent to the browser (the read endpoint
-- projects columns explicitly). Keyed by tiktok_core_user_id so re-authorizing
-- the same login refreshes tokens in place instead of creating a duplicate,
-- and authorizing a *different* login just adds a row — no code changes.
-- ---------------------------------------------------------------------------
create table if not exists tiktok_connections (
  id                  uuid primary key default gen_random_uuid(),
  label               text,
  tiktok_core_user_id text unique,
  tiktok_email        text,
  tiktok_display_name text,
  tokens              jsonb not null,       -- { access_token, refresh_token, token_type, scope, expires_at }
  scope               text,
  status              text not null default 'active',   -- active | error | revoked
  last_verified_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Advertiser (ad account) rows discovered under each connection. `tracked` is
-- the user's selection of which accounts Kryzxr Ads should follow. Discovery
-- upserts the descriptive columns only, so a re-scan never clobbers `tracked`.
-- ---------------------------------------------------------------------------
create table if not exists tiktok_advertisers (
  connection_id     uuid not null references tiktok_connections(id) on delete cascade,
  advertiser_id     text not null,
  advertiser_name   text,
  bc_id             text,
  bc_name           text,
  currency          text,
  timezone          text,
  display_timezone  text,
  status            text,                   -- e.g. STATUS_ENABLE / STATUS_LIMIT
  role              text,
  country           text,
  tracked           boolean not null default false,
  discovered_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (connection_id, advertiser_id)
);

create index if not exists tiktok_advertisers_tracked_idx
  on tiktok_advertisers (tracked) where tracked;

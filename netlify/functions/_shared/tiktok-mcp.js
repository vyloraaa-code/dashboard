// Shared by the tiktok-* Netlify functions.
//
// This module is the "MCP client" tier of the intended architecture:
//
//   Chigla Ads frontend
//     -> our Netlify function
//       -> this module (@modelcontextprotocol/sdk client + OAuth)
//         -> official TikTok Ads MCP (https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat)
//           -> TikTok Ads
//
// Claude Code is NOT part of this path. The SDK's auth() + StreamableHTTPClient
// transport handle discovery, Dynamic Client Registration (RFC 7591), PKCE and
// token refresh; SupabaseOAuthProvider just persists everything to Supabase so
// the flow works statelessly across separate function invocations.
//
// CommonJS on purpose — matches the existing glitchy-* functions and avoids
// ESM/CJS interop hazards when Netlify's bundler inlines `ws` / the SDK.

const { createClient } = require("@supabase/supabase-js");
const WebSocketImpl = require("ws");
const { randomUUID } = require("node:crypto");
const { auth } = require("@modelcontextprotocol/sdk/client/auth.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { submitEngagementOrder, providerConfigured } = require("./engagement-provider.js");

const DEFAULT_MCP_SERVER_URL =
  "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat";

const MCP_SCOPE = "mcp:tt4b";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function resolveConfig() {
  const serverUrl = process.env.TIKTOK_MCP_SERVER_URL || DEFAULT_MCP_SERVER_URL;

  // Vercel exposes the host without a protocol.
  // VERCEL_PROJECT_PRODUCTION_URL is the STABLE production domain (best for a
  // stable OAuth redirect); VERCEL_URL is per-deployment (fallback only).
  const withHttps = (h) => (h ? (/^https?:\/\//.test(h) ? h : `https://${h}`) : "");
  const vercelBase =
    withHttps(process.env.VERCEL_PROJECT_PRODUCTION_URL) || withHttps(process.env.VERCEL_URL);

  const base = (
    process.env.APP_BASE_URL || // set this explicitly on Vercel (production URL / custom domain)
    vercelBase || // Vercel auto-provided
    process.env.URL || // Netlify: site's primary URL
    process.env.DEPLOY_PRIME_URL || // Netlify: deploy-specific URL
    ""
  ).replace(/\/+$/, "");

  // Path stays under /.netlify/functions/ on BOTH platforms: Netlify serves it
  // natively; Vercel rewrites it to /api/... via vercel.json.
  const redirectUrl =
    process.env.TIKTOK_OAUTH_REDIRECT_URL ||
    (base ? `${base}/.netlify/functions/tiktok-auth-callback` : null);

  if (!redirectUrl) {
    throw new Error(
      "Cannot resolve the OAuth redirect URL. Set APP_BASE_URL (or TIKTOK_OAUTH_REDIRECT_URL) in the deployment's environment variables."
    );
  }
  return { serverUrl, redirectUrl, base };
}

// Postgrest wraps a fetch failure with the underlying `cause` in `error.details`
// ("... Caused by: Error: getaddrinfo ENOTFOUND <host> ...") but only the bare
// `error.message` ("TypeError: fetch failed") in `error.message`. Always surface
// `details` so URL / DNS / TLS problems are diagnosable from the response.
function sbErr(error) {
  if (!error) return "unknown error";
  const d = String(error.details || "");
  // postgrest-js puts the real root cause on a "Caused by:" line (DNS / TLS /
  // Invalid URL); fall back to the first detail line, else the bare message.
  const causedBy = (d.match(/Caused by:[^\n]*/) || [])[0];
  const extra = (causedBy || d.split("\n")[0] || "").trim();
  return extra && extra !== error.message ? `${error.message} — ${extra}` : error.message || "Supabase error";
}

function getSupabase() {
  // .trim() defends against the single most common hosting-env mistake: a
  // trailing newline / space pasted into the value, which makes the URL string
  // concatenation inside supabase-js produce an invalid URL -> "fetch failed".
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_KEY || "").trim();
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.");
  }
  // Catch the obviously-wrong values (DB connection string, dashboard link,
  // trailing path) but stay permissive about the host (custom domains allowed).
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SUPABASE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:" || parsed.pathname.replace(/\/+$/, "") !== "" || parsed.search) {
    throw new Error("SUPABASE_URL must be the bare project URL, e.g. https://<project-ref>.supabase.co");
  }
  // @supabase/supabase-js builds a RealtimeClient inside createClient(), which
  // demands a WebSocket constructor at construction time. Netlify's Lambda Node
  // runtime does not reliably expose a global `WebSocket` (only Node >= 22.4
  // does, and the functions runtime may lag the build's NODE_VERSION), so we
  // hand it an explicit implementation. We never use Realtime — this just keeps
  // createClient() from throwing "native WebSocket not found".
  return createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: WebSocketImpl },
  });
}

// Dashboard admin password for TikTok write operations. Uses TIKTOK_ADMIN_PASSWORD
// if set, otherwise falls back to the existing NEW_DAY_PASSWORD env var so no
// Netlify config change is needed (the "New Day" feature itself is gone).
function checkPassword(supplied) {
  const want = process.env.TIKTOK_ADMIN_PASSWORD || process.env.NEW_DAY_PASSWORD || null;
  if (!want) {
    return {
      ok: false,
      code: 500,
      error: "No admin password configured. Set TIKTOK_ADMIN_PASSWORD or NEW_DAY_PASSWORD in Netlify.",
    };
  }
  if (supplied !== want) return { ok: false, code: 401, error: "Incorrect password." };
  return { ok: true };
}

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

// ---------------------------------------------------------------------------
// Token shape helpers
// ---------------------------------------------------------------------------

// SDK OAuthTokens use `expires_in` (relative). We persist `expires_at`
// (absolute ISO) so a later invocation can recompute remaining lifetime.
function toStoredTokens(sdkTokens, prev) {
  return {
    access_token: sdkTokens.access_token,
    refresh_token: sdkTokens.refresh_token || prev?.refresh_token || null,
    token_type: sdkTokens.token_type || "Bearer",
    scope: sdkTokens.scope || prev?.scope || null,
    expires_at: sdkTokens.expires_in
      ? new Date(Date.now() + Number(sdkTokens.expires_in) * 1000).toISOString()
      : prev?.expires_at || null,
  };
}

function toSdkTokens(stored) {
  if (!stored?.access_token) return undefined;
  const remaining = stored.expires_at
    ? Math.max(0, Math.floor((Date.parse(stored.expires_at) - Date.now()) / 1000))
    : undefined;
  return {
    access_token: stored.access_token,
    token_type: stored.token_type || "Bearer",
    ...(stored.refresh_token ? { refresh_token: stored.refresh_token } : {}),
    ...(stored.scope ? { scope: stored.scope } : {}),
    ...(remaining !== undefined ? { expires_in: remaining } : {}),
  };
}

// ---------------------------------------------------------------------------
// OAuthClientProvider implementation, backed by Supabase.
//
//   - fresh auth-start : new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl })
//   - OAuth callback   : ... ({ ..., transaction: { state, code_verifier } })
//   - API calls        : ... ({ ..., connection: <tiktok_connections row> })
// ---------------------------------------------------------------------------

class SupabaseOAuthProvider {
  constructor({ supabase, serverUrl, redirectUrl, transaction = null, connection = null }) {
    this.supabase = supabase;
    this.serverUrl = serverUrl;
    this._redirectUrl = redirectUrl;
    this._transaction = transaction;
    this._connection = connection;

    this._state = transaction?.state || randomUUID();
    this._codeVerifier = transaction?.code_verifier || null;

    this._authorizationUrl = null; // captured from redirectToAuthorization()
    this._pendingTokens = null; // raw SDK tokens from the current flow
    this._resolvedTokens = null; // stored-shape tokens for the caller to persist
  }

  // -- interactive redirect target --
  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: "Chigla Ads Dashboard",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPE,
    };
  }

  state() {
    return this._state;
  }

  // -- dynamically-registered client, shared across all connections --
  async clientInformation() {
    const { data } = await this.supabase
      .from("tiktok_oauth_client")
      .select("client_id, client_secret")
      .eq("redirect_uri", this._redirectUrl)
      .maybeSingle();
    if (!data) return undefined;
    return {
      client_id: data.client_id,
      ...(data.client_secret ? { client_secret: data.client_secret } : {}),
    };
  }

  async saveClientInformation(info) {
    const now = new Date().toISOString();
    await this.supabase.from("tiktok_oauth_client").upsert(
      {
        redirect_uri: this._redirectUrl,
        server_url: this.serverUrl,
        client_id: info.client_id,
        client_secret: info.client_secret || null,
        client_id_issued_at: info.client_id_issued_at || null,
        registration: info,
        updated_at: now,
      },
      { onConflict: "redirect_uri" }
    );
  }

  // -- tokens --
  async tokens() {
    if (this._pendingTokens) return this._pendingTokens;
    if (this._connection?.tokens) return toSdkTokens(this._connection.tokens);
    return undefined;
  }

  async saveTokens(sdkTokens) {
    this._pendingTokens = sdkTokens;
    const stored = toStoredTokens(sdkTokens, this._connection?.tokens);
    this._resolvedTokens = stored;
    if (this._connection?.id) {
      await this.supabase
        .from("tiktok_connections")
        .update({ tokens: stored, status: "active", updated_at: new Date().toISOString() })
        .eq("id", this._connection.id);
      this._connection.tokens = stored;
    }
  }

  redirectToAuthorization(authorizationUrl) {
    this._authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(verifier) {
    this._codeVerifier = verifier;
  }

  codeVerifier() {
    if (!this._codeVerifier) throw new Error("Missing PKCE code verifier for this session.");
    return this._codeVerifier;
  }

  async invalidateCredentials(scope) {
    if ((scope === "tokens" || scope === "all") && this._connection?.id) {
      await this.supabase
        .from("tiktok_connections")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", this._connection.id);
    }
    if (scope === "client" || scope === "all") {
      await this.supabase
        .from("tiktok_oauth_client")
        .delete()
        .eq("redirect_uri", this._redirectUrl);
    }
  }

  // -- plain accessors for the handlers --
  get authorizationUrl() {
    return this._authorizationUrl;
  }
  getCodeVerifier() {
    return this._codeVerifier;
  }
  getResolvedTokens() {
    return this._resolvedTokens;
  }
}

// ---------------------------------------------------------------------------
// MCP client helpers
// ---------------------------------------------------------------------------

async function connectMcp({ provider, serverUrl }) {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: provider,
  });
  const client = new Client(
    { name: "chigla-ads-dashboard", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport };
}

// The TikTok MCP wraps every result as JSON text: { code, message, data, request_id }.
async function mcpCall(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (res.isError || (payload && typeof payload.code === "number" && payload.code !== 0)) {
    throw new Error(`TikTok MCP "${name}" failed: ${payload?.message || text || "unknown error"}`);
  }
  return payload?.data ?? payload;
}

const ADV_FIELDS = [
  "advertiser_id",
  "name",
  "currency",
  "timezone",
  "display_timezone",
  "status",
  "role",
  "country",
  "owner_bc_id",
];

// bc_get returns `data.list[]` where the Business Center fields live under
// `item.bc_info` ({ bc_id, name, company, status, timezone, currency, ... }).
function extractBusinessCenters(bcListRaw) {
  return (bcListRaw || [])
    .map((item) => {
      const info = item.bc_info || item;
      const id = info.bc_id != null ? String(info.bc_id) : null;
      if (!id) return null;
      return { bc_id: id, bc_name: info.name || info.bc_name || info.company || null };
    })
    .filter(Boolean);
}

// Walks the authenticated TikTok user's Business Centers + advertiser accounts
// and upserts them into tiktok_advertisers. Descriptive columns only — `tracked`
// and `discovered_at` are left untouched so a re-scan preserves the selection.
// Also records the connection's Business Center identity on tiktok_connections.
async function discoverAndStoreAdvertisers({ supabase, client, connectionId }) {
  let bcs = [];
  try {
    const d = await mcpCall(client, "bc_get", {});
    bcs = extractBusinessCenters(d?.list);
  } catch {
    // A user with no Business Center still has directly-authorized advertisers.
  }

  const authList = (await mcpCall(client, "auth_advertiser_get", {}))?.list || [];
  const ids = [...new Set(authList.map((a) => String(a.advertiser_id)).filter(Boolean))];
  const nameFromAuth = new Map(
    authList.map((a) => [String(a.advertiser_id), a.advertiser_name || null])
  );

  const info = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const d = await mcpCall(client, "advertiser_info_get", {
      advertiser_ids: chunk,
      fields: ADV_FIELDS,
    });
    info.push(...(d?.list || []));
  }

  const bcName = new Map(bcs.map((b) => [b.bc_id, b.bc_name]));
  const now = new Date().toISOString();
  const seen = new Set();

  // auth_advertiser_get's own list order is the best available proxy for "the
  // order this account appears in the Business Center" — advertiser_info_get
  // (queried in chunks right above) does not promise to preserve that order,
  // so list_order is captured from `ids`, not from iteration order below.
  const rows = info.map((a) => {
    const id = String(a.advertiser_id);
    seen.add(id);
    return {
      connection_id: connectionId,
      advertiser_id: id,
      advertiser_name: a.name || nameFromAuth.get(id) || null,
      bc_id: a.owner_bc_id ? String(a.owner_bc_id) : null,
      bc_name: a.owner_bc_id ? bcName.get(String(a.owner_bc_id)) || null : null,
      currency: a.currency || null,
      timezone: a.timezone || null,
      display_timezone: a.display_timezone || null,
      status: a.status || null,
      role: a.role || null,
      country: a.country || null,
      list_order: ids.indexOf(id),
      updated_at: now,
    };
  });

  // Advertisers listed by auth_advertiser_get but absent from advertiser_info_get.
  for (const id of ids) {
    if (seen.has(id)) continue;
    rows.push({
      connection_id: connectionId,
      advertiser_id: id,
      advertiser_name: nameFromAuth.get(id) || null,
      list_order: ids.indexOf(id),
      updated_at: now,
    });
  }

  if (rows.length) {
    let { error } = await supabase
      .from("tiktok_advertisers")
      .upsert(rows, { onConflict: "connection_id,advertiser_id" });
    if (error && /list_order/.test(error.message || "")) {
      // Not migrated yet (supabase/tiktok_advertiser_order.sql) — retry without
      // it so discovery still works; ordering just falls back to alphabetical
      // until the migration runs.
      const bare = rows.map(({ list_order, ...r }) => r);
      ({ error } = await supabase.from("tiktok_advertisers").upsert(bare, { onConflict: "connection_id,advertiser_id" }));
    }
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  // Record the connection's Business Center identity. If bc_get returned exactly
  // one BC, use its name/id; otherwise fall back to a count so the UI label can
  // degrade gracefully (never invented from advertiser names).
  const bcSeenFromAdvertisers = new Map();
  for (const a of info) {
    if (a.owner_bc_id) {
      const bid = String(a.owner_bc_id);
      bcSeenFromAdvertisers.set(bid, bcName.get(bid) || bcSeenFromAdvertisers.get(bid) || null);
    }
  }
  // Prefer bc_get's list; supplement with any BC ids only seen via advertisers.
  const bcMerged = new Map(bcs.map((b) => [b.bc_id, b.bc_name]));
  for (const [bid, bname] of bcSeenFromAdvertisers) if (!bcMerged.has(bid)) bcMerged.set(bid, bname);

  const bcList = [...bcMerged.entries()].map(([bc_id, bc_name]) => ({ bc_id, bc_name }));
  const connPatch = { updated_at: now };
  if (bcList.length === 1) {
    connPatch.bc_id = bcList[0].bc_id;
    connPatch.bc_name = bcList[0].bc_name || null;
    connPatch.bc_count = 1;
  } else {
    connPatch.bc_id = null;
    connPatch.bc_name = bcList.map((b) => b.bc_name).filter(Boolean).join(", ") || null;
    connPatch.bc_count = bcList.length;
  }

  // affiliate_network is user-controlled (modal toggle) — never touched here.
  // Non-fatal: if the bc_* columns aren't added yet, the UI label just falls
  // back to the authenticated email until the migration is run.
  const up = await supabase.from("tiktok_connections").update(connPatch).eq("id", connectionId);
  if (up.error && /bc_(id|name|count)/.test(up.error.message || "")) {
    await supabase.from("tiktok_connections").update({ updated_at: now }).eq("id", connectionId);
  }

  return { advertiserCount: rows.length, businessCenterCount: bcList.length, businessCenters: bcList };
}

// ---------------------------------------------------------------------------
// Effective campaign status
//
// The authoritative CURRENT state comes from the live `secondary_status` /
// `operation_status` fields on the ad group (`/adgroup/get/`) and campaign
// (`/campaign/get/`). `/adgroup/review_info/` is used ONLY for review facts
// that are themselves current — `contains_rejected_ads` and `appeal_status` —
// never as a standalone "was once rejected" trigger, so a historical
// rejection that has since been appealed and approved does NOT keep the row
// marked Rejected.
//
// Real samples: campaign `CAMPAIGN_STATUS_DISABLE` / `CAMPAIGN_STATUS_BUDGET_EXCEED`
// / `ADVERTISER_ACCOUNT_PUNISH`; ad group `ADGROUP_STATUS_CAMPAIGN_DISABLE` /
// `ADGROUP_STATUS_DELIVERY_OK` / `ADGROUP_STATUS_DISABLE` / `ADGROUP_STATUS_AUDIT`;
// advertiser `STATUS_ENABLE` / `STATUS_LIMIT`. adgroup/review_info gives
// `is_approved`, `review_status` (`ALL_AVAILABLE`/`PART_AVAILABLE`/`UNAVAILABLE`),
// `contains_rejected_ads` (bool), `appeal_status` (`NOT_APPEALED` / appeal states).
// ---------------------------------------------------------------------------

function accountHealthy(raw) {
  const s = String(raw || "").toUpperCase();
  return s === "" || s === "STATUS_ENABLE";
}

function accountLooksPunished(campaignSecondary) {
  const s = String(campaignSecondary || "").toUpperCase();
  return s.includes("ADVERTISER") || s.includes("ACCOUNT") || s.includes("PUNISH");
}

// Coarse bucket for one ad group's CURRENT operating status.
function classifyDelivery(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return "unknown";
  if (s.includes("DENY") || s.includes("REJECT") || s.includes("DISAPPROV") || s.includes("NOT_APPROV"))
    return "rejected";
  if (s.includes("DELIVERY_OK") || s.endsWith("_OK") || s.includes("DELIVERING")) return "active";
  if (s.includes("AUDIT") || s.includes("REVIEW") || s.includes("PENDING") || s.includes("CHECKING"))
    return "in_review";
  if (s.includes("NOT_START") || s.includes("NOT_YET") || s.includes("SCHEDULE")) return "scheduled";
  if (s.includes("BALANCE") || s.includes("BUDGET") || s.includes("EXCEED") || s.includes("NO_BUDGET"))
    return "budget";
  if (s.includes("DONE") || s.includes("FINISH") || s.includes("COMPLETE") || s.includes("EXPIR"))
    return "done";
  if (s.includes("CAMPAIGN_DISABLE") || s.includes("CAMPAIGN_PAUSE")) return "campaign_paused";
  if (s.includes("ADVERTISER") || s.includes("ACCOUNT") || s.includes("PUNISH") || s.includes("FROZEN") || s.includes("LIMIT"))
    return "account";
  if (s.includes("DELETE")) return "deleted";
  if (s.includes("DISABLE") || s.includes("PAUSE")) return "paused"; // ad group / ad paused
  return "other";
}

function humanizeStatus(raw) {
  const s = String(raw || "").replace(/^(AD|ADGROUP|CAMPAIGN)_STATUS_/i, "").replace(/^STATUS_/i, "");
  if (!s) return null;
  return s
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Is this ad group CURRENTLY rejected / in review, per its own review record?
// `review` is one entry from adgroup/review_info's `ad_group_review_map`.
function reviewState(review) {
  if (!review) return null;
  const rs = String(review.review_status || "").toUpperCase();
  const appeal = String(review.appeal_status || "").toUpperCase();

  const appealPending =
    appeal.includes("PENDING") || appeal.includes("PROCESSING") || appeal.includes("APPEALING") || appeal.includes("IN_REVIEW");
  if (appealPending) return "in_review";

  const currentlyRejected =
    review.contains_rejected_ads === true ||
    (review.is_approved === false && (rs.includes("UNAVAILABLE") || rs === "" ));
  if (currentlyRejected) return "rejected";

  if (rs.includes("AUDIT") || rs.includes("REVIEW") || rs.includes("PENDING") || rs.includes("CHECKING"))
    return "in_review";

  return null; // approved / not a review problem -> defer to delivery status
}

// Derives ONE display status for a campaign row. Priority (as specified):
//   1. account suspended/limited/punished
//   2. an ad currently rejected (and not since re-approved / not mid-appeal)
//   3. an ad currently pending / in review / mid-appeal
//   4. campaign active with >= 1 delivering ad copy
//   5. scheduled / out of budget
//   6. whole campaign manually paused
//   7. all ad groups individually paused (campaign itself not paused)
// A few manually-paused ad groups never hide an "Active" row.
// ---------------------------------------------------------------------------
// Campaign Creator campaigns under a live automatic appeal show a clearer
// label/tone than TikTok's raw status — this is the ONE place that decides
// that relabeling. Every code path that surfaces OR persists a campaign's
// effective_status must go through this, or they disagree with each other:
// a previous version applied this only inside the "list" GET handler, so any
// OTHER path that refreshed the same campaign (expanding its ad groups,
// toggling it on/off, the appeal-processing tick) wrote/returned TikTok's
// raw status instead — the dashboard would flip to the raw label the moment
// that path ran, then flip back once "list" was re-fetched. Never masks a
// campaign that is genuinely Active/serving right now.
// ---------------------------------------------------------------------------
function applyAppealOverlay(campaignRow, appealState) {
  const st = appealState;
  // Current reality always wins over a stale/terminal appeal_state — not just
  // Active. An account-level state (Suspended, or Pending/under its own
  // review) is definitively past the ad-level appeal, so showing "Appeal
  // Rejected" instead would hide the actual, more urgent problem.
  const current = String(campaignRow.effective_status || "");
  if (!st || st === "NONE" || current === "Active" || current === "Account Suspended" || current === "Account Pending")
    return campaignRow;
  if (st === "APPEAL_UNDER_REVIEW" || st === "APPEAL_SUBMITTING") {
    return {
      ...campaignRow,
      effective_status: "Appeal Under Review",
      effective_tone: "warn",
      status_detail: "Automatic appeal submitted — awaiting TikTok's decision",
    };
  }
  if (st === "APPEAL_REJECTED") {
    return {
      ...campaignRow,
      effective_status: "Appeal Rejected",
      effective_tone: "bad",
      status_detail: "TikTok rejected the automatic appeal",
    };
  }
  return campaignRow; // REJECTED / UNSUPPORTED / APPEAL_APPROVED keep TikTok's own label
}

// Async version for callers that don't already have appeal_state in hand
// (adgroups / set_campaign_status / set_adgroup_status all look it up by
// campaign_id). Best-effort: any failure — table not migrated yet, no
// matching row — just means "no appeal tracking for this campaign", so the
// row is returned unchanged rather than blocking the caller.
async function applyAppealOverlayByCampaignId(supabase, campaignId, campaignRow) {
  try {
    const { data } = await supabase
      .from("campaign_creator_campaigns")
      .select("appeal_state")
      .eq("campaign_id", String(campaignId))
      .maybeSingle();
    return applyAppealOverlay(campaignRow, data?.appeal_state || null);
  } catch (_) {
    return campaignRow;
  }
}

function deriveEffectiveStatus({ advertiserStatus, campaign, adGroups, reviewByAdGroupId }) {
  const campSecondary = campaign?.secondary_status || "";
  if (!accountHealthy(advertiserStatus) || accountLooksPunished(campSecondary)) {
    const s = String(advertiserStatus || "").toUpperCase();
    if (s.includes("PENDING") || s.includes("CONFIRM") || s.includes("UNAUDITED") || s.includes("VERIF"))
      return { label: "Account Pending", tone: "warn", detail: advertiserStatus || campSecondary || null };
    return { label: "Account Suspended", tone: "bad", detail: advertiserStatus || campSecondary || null };
  }

  const list = adGroups || [];
  const classes = list.map((ag) => {
    const rv = reviewState(reviewByAdGroupId ? reviewByAdGroupId[String(ag.adgroup_id)] : null);
    if (rv) return rv;
    // Manual pause on this ad group takes precedence over its (masked) secondary status.
    if (String(ag.operation_status || "").toUpperCase() === "DISABLE") return "paused";
    return classifyDelivery(ag.secondary_status || ag.operation_status);
  });

  const n = (c) => classes.filter((x) => x === c).length;
  const total = classes.length;
  const activeAdCount = n("active");

  if (total > 0) {
    if (n("rejected") > 0)
      return { label: "Rejected", tone: "bad", detail: "One or more ads are currently not approved", activeAdCount };
    if (n("in_review") > 0)
      return { label: "In Review", tone: "warn", detail: null, activeAdCount };
    if (activeAdCount > 0) return { label: "Active", tone: "good", detail: null, activeAdCount };
    if (n("scheduled") > 0) return { label: "Scheduled", tone: "neutral", detail: null, activeAdCount };
    if (n("budget") > 0) return { label: "Out of Budget", tone: "warn", detail: null, activeAdCount };
    if (n("campaign_paused") === total)
      return { label: "Paused", tone: "neutral", detail: "Campaign paused", activeAdCount };
    if (n("paused") > 0 && n("campaign_paused") === 0)
      return { label: "Ad Groups Paused", tone: "warn", detail: "All ad groups are paused", activeAdCount };
    if (n("done") === total) return { label: "Completed", tone: "neutral", detail: null, activeAdCount };
    if (n("deleted") === total) return { label: "Deleted", tone: "bad", detail: null, activeAdCount };
  }

  const camp = String(campSecondary || campaign?.operation_status || "").toUpperCase();
  if (camp.includes("DELETE")) return { label: "Deleted", tone: "bad", detail: null, activeAdCount };
  if (camp.includes("BUDGET") || camp.includes("EXCEED"))
    return { label: "Out of Budget", tone: "warn", detail: null, activeAdCount };
  if (camp.includes("DISABLE") || camp.includes("PAUSE"))
    return { label: "Paused", tone: "neutral", detail: null, activeAdCount };
  if (camp.includes("ENABLE"))
    return { label: total ? "Inactive" : "No Ads", tone: "warn", detail: total ? null : "Campaign has no ads yet", activeAdCount };
  return { label: humanizeStatus(camp) || "Unknown", tone: "neutral", detail: null, activeAdCount };
}

// Per-ad-group display status for the expanded sub-rows. Manual pause wins;
// otherwise use current review state, then the live secondary status.
function deriveAdGroupStatus(adGroup, review) {
  const op = String(adGroup.operation_status || "").toUpperCase();
  const rv = reviewState(review);
  if (rv === "rejected") return { label: "Rejected", tone: "bad" };
  if (rv === "in_review") return { label: "In Review", tone: "warn" };
  if (op === "DISABLE") return { label: "Paused", tone: "neutral" };
  switch (classifyDelivery(adGroup.secondary_status || adGroup.operation_status)) {
    case "active":
      return { label: "Active", tone: "good" };
    case "in_review":
      return { label: "In Review", tone: "warn" };
    case "rejected":
      return { label: "Rejected", tone: "bad" };
    case "scheduled":
      return { label: "Scheduled", tone: "neutral" };
    case "budget":
      return { label: "Out of Budget", tone: "warn" };
    case "campaign_paused":
      return { label: "Campaign Paused", tone: "neutral" };
    case "paused":
      return { label: "Paused", tone: "neutral" };
    case "account":
      return { label: "Account Suspended", tone: "bad" };
    case "done":
      return { label: "Completed", tone: "neutral" };
    case "deleted":
      return { label: "Deleted", tone: "bad" };
    default:
      return { label: humanizeStatus(adGroup.secondary_status) || "Unknown", tone: "neutral" };
  }
}

const CAMPAIGN_FIELDS = [
  "campaign_id",
  "campaign_name",
  "operation_status",
  "secondary_status",
  "objective_type",
  "budget",
  "budget_mode",
  "create_time",
];

const ADGROUP_STATUS_FIELDS = [
  "adgroup_id",
  "adgroup_name",
  "campaign_id",
  "operation_status",
  "secondary_status",
];

// Pulls every ad group + its current review record for one advertiser, grouped
// by campaign id. One adgroup/review_info call per 20 ad groups.
async function loadAdGroupsForAdvertiser(client, advertiserId) {
  const res = await mcpCall(client, "adgroup_get", {
    advertiser_id: advertiserId,
    fields: ADGROUP_STATUS_FIELDS,
    page_size: 1000,
  });
  const adGroups = res?.list || [];
  const ids = adGroups.map((g) => String(g.adgroup_id)).filter(Boolean);

  const reviewByAdGroupId = {};
  for (let i = 0; i < ids.length; i += 20) {
    try {
      const rev = await mcpCall(client, "adgroup_review_info_get", {
        advertiser_id: advertiserId,
        adgroup_ids: ids.slice(i, i + 20),
      });
      Object.assign(reviewByAdGroupId, rev?.ad_group_review_map || {});
    } catch {
      /* review lookup is best-effort */
    }
  }

  const byCampaign = {};
  for (const g of adGroups) {
    const cid = String(g.campaign_id);
    (byCampaign[cid] = byCampaign[cid] || []).push(g);
  }
  return { byCampaign, reviewByAdGroupId };
}

// Discovers current campaigns (all non-deleted) inside the tracked advertiser
// accounts under one connection, derives an effective status for each from the
// CURRENT ad group + review state, and upserts them into tiktok_campaigns.
// Reuses a single MCP client for every advertiser in the connection.
async function discoverAndStoreCampaigns({ supabase, client, connectionId, trackedAdvertisers, affiliateNetwork }) {
  const now = new Date().toISOString();
  const rows = [];
  const seenCampaignIds = [];
  const activeCampaignIds = []; // genuinely-Active campaigns this run (engagement trigger)
  const scannedAdvIds = []; // advertisers whose campaign list we actually read
  const perAdvertiser = {};

  // WH Warmup campaigns ARE surfaced in Detailed Metrics while they exist (a
  // tracked advertiser's campaign like any other) — they just auto-delete once
  // Active and are kept out of engagement automation + the permanent
  // daily_totals calendar (see withoutTemporaryCampaigns / tiktokSpendForToday).

  for (const adv of trackedAdvertisers) {
    const advId = String(adv.advertiser_id);
    try {
      const campRes = await mcpCall(client, "campaign_get", {
        advertiser_id: advId,
        fields: CAMPAIGN_FIELDS,
        page_size: 200,
      });
      const campaigns = campRes?.list || [];

      let byCampaign = {};
      let reviewByAdGroupId = {};
      try {
        ({ byCampaign, reviewByAdGroupId } = await loadAdGroupsForAdvertiser(client, advId));
      } catch {
        /* fall back to campaign-level status only */
      }

      for (const campaign of campaigns) {
        const cid = String(campaign.campaign_id);
        const campAdGroups = byCampaign[cid] || [];
        const eff = deriveEffectiveStatus({
          advertiserStatus: adv.status,
          campaign,
          adGroups: campAdGroups,
          reviewByAdGroupId,
        });
        seenCampaignIds.push(cid);
        if (eff.label === "Active") activeCampaignIds.push(cid);
        rows.push({
          campaign_id: cid,
          connection_id: connectionId,
          advertiser_id: advId,
          advertiser_name: adv.advertiser_name || null,
          bc_id: adv.bc_id || null,
          bc_name: adv.bc_name || null,
          affiliate_network: resolveBcNetwork(adv.bc_id, adv.bc_name, affiliateNetwork),
          campaign_name: campaign.campaign_name || cid,
          objective_type: campaign.objective_type || null,
          budget: campaign.budget != null ? Number(campaign.budget) : null,
          budget_mode: campaign.budget_mode || null,
          campaign_operation_status: campaign.operation_status || null,
          campaign_secondary_status: campaign.secondary_status || null,
          effective_status: eff.label,
          effective_tone: eff.tone,
          status_detail: eff.detail || null,
          ad_count: campAdGroups.length,
          active_ad_count: eff.activeAdCount || 0,
          create_time: parseTikTokTime(campaign.create_time),
          updated_at: now,
        });
      }
      scannedAdvIds.push(advId);
      perAdvertiser[advId] = campaigns.length;
    } catch (err) {
      perAdvertiser[advId] = `error: ${err.message}`;
    }
  }

  if (rows.length) {
    let { error } = await supabase.from("tiktok_campaigns").upsert(rows, { onConflict: "campaign_id" });
    // Degrade gracefully if the bc_id/bc_name/affiliate_network columns aren't
    // added yet (migration supabase/tiktok_bc_networks.sql).
    if (error && /bc_(id|name)|affiliate_network/.test(error.message || "")) {
      const stripped = rows.map(({ bc_id, bc_name, affiliate_network, ...rest }) => rest);
      ({ error } = await supabase.from("tiktok_campaigns").upsert(stripped, { onConflict: "campaign_id" }));
    }
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  // Drop rows for campaigns that no longer exist — but only for advertisers we
  // actually scanned this run (a failed campaign_get must not wipe that
  // account's rows) and never a locally-hidden row (suspended-account case).
  if (scannedAdvIds.length) {
    const runDelete = (withHiddenGuard) => {
      let q = supabase.from("tiktok_campaigns").delete().in("advertiser_id", scannedAdvIds);
      if (seenCampaignIds.length) q = q.not("campaign_id", "in", `(${seenCampaignIds.join(",")})`);
      if (withHiddenGuard) q = q.neq("hidden", true);
      return q;
    };
    const del = await runDelete(true);
    if (del.error && /hidden/.test(del.error.message || "")) await runDelete(false);
  }

  // Engagement FOUNDATION only: flip PENDING/FAILED -> READY for campaigns that
  // are genuinely Active AND already have a TikTok post URL. Idempotent (the
  // WHERE clause makes repeat runs a no-op) and never sends anything anywhere.
  await markEngagementReadyIfActive(supabase, activeCampaignIds);

  return { campaignCount: rows.length, perAdvertiser };
}

// Drop any campaign_id that belongs to a temporary automation (WH Warmup) — those
// must NEVER enter normal engagement processing. WH campaigns live only in
// wh_warmup_campaigns (they're already excluded from tiktok_campaigns), so this
// is defence-in-depth. Returns the safe subset.
async function withoutTemporaryCampaigns(supabase, ids) {
  if (!ids.length) return ids;
  try {
    const { data } = await supabase.from("wh_warmup_campaigns").select("campaign_id").in("campaign_id", ids);
    const wh = new Set((data || []).map((r) => String(r.campaign_id)));
    return ids.filter((id) => !wh.has(id));
  } catch (_) {
    return ids; // table not migrated -> nothing to exclude
  }
}

// Idempotent engagement-readiness flag. Marks a campaign READY only when it is
// currently Active, has a non-empty tiktok_post_url (the authoritative
// campaign_id -> post-link mapping — never derived by name/order), and isn't
// already READY/COMPLETED. No external calls — READY is just a local lifecycle
// flag. After flipping, it invokes the FUTURE provider hook for those campaigns
// (a no-op today). Silently no-ops if the engagement columns aren't migrated yet
// (supabase/tiktok_engagement.sql). WH Warmup campaigns are explicitly excluded.
async function markEngagementReadyIfActive(supabase, campaignIds) {
  let ids = [...new Set((campaignIds || []).map(String).filter(Boolean))];
  if (!ids.length) return { updated: 0 };
  ids = await withoutTemporaryCampaigns(supabase, ids);
  if (!ids.length) return { updated: 0, skipped: "wh_warmup" };
  try {
    const { data, error } = await supabase
      .from("tiktok_campaigns")
      .update({ engagement_status: "READY", updated_at: new Date().toISOString() })
      .in("campaign_id", ids)
      .not("tiktok_post_url", "is", null)
      .neq("tiktok_post_url", "")
      .not("engagement_status", "in", "(READY,COMPLETED)")
      .select("campaign_id");
    if (error) {
      if (/engagement_status|tiktok_post_url/.test(error.message || "")) return { updated: 0, unmigrated: true };
      throw error;
    }
    await autoProcessReadyEngagements(supabase, ids);
    return { updated: (data || []).length };
  } catch (err) {
    console.error(`[engagement] markEngagementReadyIfActive failed: ${err.message}`);
    return { updated: 0, error: err.message };
  }
}

// AUTO ENGAGEMENT — likes + saves, placed the moment a campaign is genuinely
// Active AND has a tiktok_post_url. Comments are NEVER auto-placed (the operator
// adds those by hand in the Add-comments modal).
//
// Fully idempotent: one engagement_orders row per (campaign_id, kind). A row that
// already reached SUBMITTED/COMPLETED is never re-ordered. A FAILED row is
// retried on the next Active tick up to AUTO_ORDER_ATTEMPT_CAP, then left alone.
// When both LIKES and SAVES have a SUBMITTED/COMPLETED row the campaign flips to
// engagement_status='COMPLETED'. If neither kind has an API key configured the
// campaign stays READY (so configuring a key later still fires it).
//
// Credentials (ENGAGEMENT_*_API_KEY) live only in engagement-provider.js, read
// from process.env, never returned to the browser or logged.
const AUTO_ENGAGEMENT_KINDS = ["LIKES", "SAVES"];
const AUTO_ORDER_ATTEMPT_CAP = 4;
const AUTO_ENGAGEMENT_BUDGET_MS = 6000; // stay well inside the function limit

async function autoProcessReadyEngagements(supabase, campaignIds) {
  let ids = [...new Set((campaignIds || []).map(String).filter(Boolean))];
  if (!ids.length) return;
  ids = await withoutTemporaryCampaigns(supabase, ids); // never touch WH Warmup
  if (!ids.length) return;

  let ready;
  try {
    const { data, error } = await supabase
      .from("tiktok_campaigns")
      .select("campaign_id, tiktok_post_url")
      .in("campaign_id", ids)
      .eq("engagement_status", "READY");
    if (error) return; // unmigrated / transient — nothing to do
    ready = (data || []).filter((c) => String(c.tiktok_post_url || "").trim());
  } catch (_) {
    return;
  }
  if (!ready.length) return;

  // Existing auto orders for this batch, keyed campaign_id -> kind -> row.
  const existing = {};
  const cidList = ready.map((c) => String(c.campaign_id));
  let ex = await supabase
    .from("engagement_orders")
    .select("id, campaign_id, kind, status, attempts, provider_ref")
    .in("campaign_id", cidList)
    .in("kind", AUTO_ENGAGEMENT_KINDS);
  if (ex.error && /attempts/.test(ex.error.message || "")) {
    ex = await supabase
      .from("engagement_orders")
      .select("id, campaign_id, kind, status, provider_ref")
      .in("campaign_id", cidList)
      .in("kind", AUTO_ENGAGEMENT_KINDS);
  }
  if (ex.error) return; // table missing / transient — nothing safe to do this tick
  for (const r of ex.data || []) {
    (existing[String(r.campaign_id)] = existing[String(r.campaign_id)] || {})[r.kind] = r;
  }

  const deadline = Date.now() + AUTO_ENGAGEMENT_BUDGET_MS;
  for (const c of ready) {
    if (Date.now() > deadline) break; // rest stay READY -> next tick picks them up
    const cid = String(c.campaign_id);
    const link = String(c.tiktok_post_url).trim();
    const byKind = existing[cid] || {};
    let allSettled = true;

    for (const kind of AUTO_ENGAGEMENT_KINDS) {
      const settled = await ensureAutoOrder(supabase, cid, kind, link, byKind[kind]);
      if (!settled) allSettled = false;
    }

    if (allSettled) {
      await supabase
        .from("tiktok_campaigns")
        .update({ engagement_status: "COMPLETED", updated_at: new Date().toISOString() })
        .eq("campaign_id", cid)
        .eq("engagement_status", "READY");
    }
  }
}

// Places (or retries) ONE auto engagement order for a campaign. Returns true
// ONLY when a real order was placed for this kind (status SUBMITTED/COMPLETED).
// A campaign flips to engagement_status COMPLETED only when every auto kind
// returns true — so a permanently-failing kind keeps it READY (visible in the
// Add-comments modal) rather than masking the failure.
async function ensureAutoOrder(supabase, campaignId, kind, link, row) {
  const st = row ? String(row.status).toUpperCase() : null;
  if (st === "SUBMITTED" || st === "COMPLETED") return true;
  if (st === "FAILED" && Number(row.attempts || 0) >= AUTO_ORDER_ATTEMPT_CAP) return false; // gave up retrying
  if (!providerConfigured(kind)) return false; // no API key — leave the campaign READY

  const now = new Date().toISOString();
  const stripAttempts = (obj) => {
    const { attempts, ...rest } = obj;
    return rest;
  };

  // Claim a row BEFORE calling the panel so a concurrent tick can't double-order
  // (the partial unique index on (campaign_id, kind) enforces this).
  let rowId = row ? row.id : null;
  if (!rowId) {
    const claim = {
      campaign_id: campaignId,
      kind,
      link,
      quantity: 0,
      status: "PENDING",
      attempts: 0,
      updated_at: now,
    };
    let ins = await supabase.from("engagement_orders").insert(claim).select("id").maybeSingle();
    if (ins.error && /attempts/.test(ins.error.message || "")) {
      ins = await supabase.from("engagement_orders").insert(stripAttempts(claim)).select("id").maybeSingle();
    }
    if (ins.error) {
      // Unique-violation => another invocation owns it this tick; try again next.
      return false;
    }
    rowId = ins.data ? ins.data.id : null;
  }

  let result;
  try {
    result = await submitEngagementOrder({ kind, campaignId, link });
  } catch (_) {
    // Bump attempts so a persistent error still hits the cap eventually.
    if (rowId) {
      const bump = { attempts: Number(row?.attempts || 0) + 1, status: "FAILED", updated_at: new Date().toISOString() };
      let u = await supabase.from("engagement_orders").update(bump).eq("id", rowId);
      if (u.error && /attempts/.test(u.error.message || "")) {
        await supabase.from("engagement_orders").update({ status: "FAILED", updated_at: bump.updated_at }).eq("id", rowId);
      }
    }
    return false; // a provider error must never break the status refresh
  }

  const patch = {
    provider: result.provider || null,
    quantity: result.quantity || 0,
    status: result.submitted ? "SUBMITTED" : result.ok ? "READY" : "FAILED",
    provider_ref: result.providerRef || null,
    note: result.message || null,
    attempts: Number(row?.attempts || 0) + (result.submitted ? 0 : 1),
    updated_at: new Date().toISOString(),
  };
  if (rowId) {
    let upd = await supabase.from("engagement_orders").update(patch).eq("id", rowId);
    if (upd.error && /attempts/.test(upd.error.message || "")) {
      await supabase.from("engagement_orders").update(stripAttempts(patch)).eq("id", rowId);
    }
  }
  return !!result.submitted;
}

function parseTikTokTime(raw) {
  if (!raw) return null;
  const d = new Date(String(raw).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(raw)) ? "" : "Z"));
  return isNaN(d) ? null : d.toISOString();
}

// YYYY-MM-DD "today" in a given IANA timezone (report_integrated_get interprets
// its date range in the ad account's timezone). Falls back to America/New_York.
function localToday(tzName) {
  const tz = tzName || "America/New_York";
  try {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return p; // en-CA formats as YYYY-MM-DD
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  }
}

// The dashboard's single reporting boundary — the America/New_York calendar
// date. EVERYTHING daily is keyed to this: Glitchy (todayEst), Mabac,
// daily_totals, the calendar, and now TikTok campaign metrics. Never the
// viewer's browser tz and never the ad account's tz. (report_integrated_get
// still interprets the date in the ad account tz — see the note in
// tiktok-campaigns.js's metrics action.)
const DASHBOARD_TZ = "America/New_York";
function dashboardToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DASHBOARD_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// TikTok's CPA for this business == cost per optimization conversion (the
// instant-form / instant-page completion). `cost_per_result` is a fallback for
// campaigns whose "result" event is configured; last resort spend/conversion.
function tiktokCpa(m) {
  const cpc = num(m.cost_per_conversion);
  if (cpc > 0) return cpc;
  const cpr = num(m.cost_per_result);
  if (cpr > 0) return cpr;
  const conv = num(m.conversion) || num(m.result);
  const spend = num(m.spend);
  return conv > 0 ? spend / conv : 0;
}

// -------- campaign-level day metrics for ONE advertiser account --------
//
// One `report_integrated_get` (BASIC / AUCTION / AUCTION_CAMPAIGN, grouped by
// campaign_id) returns EVERY non-deleted campaign in the advertiser account for
// `date` — no per-campaign requests. Paginated. `date` is a YYYY-MM-DD string;
// TikTok reads it in the ad account's own timezone (callers pass the dashboard
// NY date and accept a small near-midnight skew for non-Eastern accounts).
//
// Returns { [campaign_id]: { advertiser_id, spend, impressions, clicks,
//                            conversions, cpm, cpa } } — all finite numbers.
const CAMPAIGN_METRIC_FIELDS = [
  "spend",
  "impressions",
  "clicks",
  "cpc",
  "cpm",
  "conversion",
  "cost_per_conversion",
  "result",
  "cost_per_result",
];

async function loadCampaignMetricsForAdvertiser(client, advertiserId, { date } = {}) {
  const advId = String(advertiserId);
  const byId = {};
  let page = 1;
  for (;;) {
    const rep = await mcpCall(client, "report_integrated_get", {
      report_type: "BASIC",
      service_type: "AUCTION",
      data_level: "AUCTION_CAMPAIGN",
      advertiser_id: advId,
      dimensions: ["campaign_id"],
      metrics: CAMPAIGN_METRIC_FIELDS,
      start_date: date,
      end_date: date,
      page,
      page_size: 1000,
    });

    for (const row of rep?.list || []) {
      const id = String(row.dimensions?.campaign_id || "");
      if (!id) continue;
      const m = row.metrics || {};
      const spend = round2(num(m.spend));
      const impressions = Math.round(num(m.impressions));
      const clicks = Math.round(num(m.clicks));
      const conversions = num(m.conversion) || num(m.result);
      const directCpm = num(m.cpm);
      const cpm = directCpm > 0 ? round2(directCpm) : impressions > 0 ? round2((spend / impressions) * 1000) : 0;
      byId[id] = {
        advertiser_id: advId,
        spend,
        impressions,
        clicks,
        conversions,
        cpm,
        cpa: round2(tiktokCpa(m)),
      };
    }

    const info = rep?.page_info || {};
    if (!info.total_page || page >= info.total_page) break;
    page += 1;
    if (page > 50) break; // safety
  }
  return byId;
}

// Fallback for campaigns TikTok's AUCTION_CAMPAIGN report simply omits a row
// for (observed for some auto/Smart+-style campaigns) even though the
// account's own AUCTION_ADGROUP report has real data for their ad groups —
// the same report_integrated_get call the ad-group detail panel already
// relies on (loadCampaignDetail below). Sums each missing campaign's ad
// groups into one campaign-shaped metrics row. One adgroup_get + one report
// call total, batched across every missing campaign_id for this advertiser.
async function loadCampaignMetricsViaAdGroups(client, advertiserId, campaignIds, date) {
  const advId = String(advertiserId);
  const ids = [...new Set((campaignIds || []).map(String))].filter(Boolean);
  if (!ids.length) return {};

  const gRes = await mcpCall(client, "adgroup_get", {
    advertiser_id: advId,
    fields: ADGROUP_STATUS_FIELDS,
    filtering: { campaign_ids: ids },
    page_size: 1000,
  });
  const campaignByAdgroup = new Map();
  for (const g of gRes?.list || []) {
    const gid = String(g.adgroup_id || "");
    const cid = String(g.campaign_id || "");
    if (gid && cid) campaignByAdgroup.set(gid, cid);
  }
  if (!campaignByAdgroup.size) return {};

  const sums = {}; // campaign_id -> running totals
  let page = 1;
  for (;;) {
    const rep = await mcpCall(client, "report_integrated_get", {
      report_type: "BASIC",
      service_type: "AUCTION",
      data_level: "AUCTION_ADGROUP",
      advertiser_id: advId,
      dimensions: ["adgroup_id"],
      metrics: CAMPAIGN_METRIC_FIELDS,
      start_date: date,
      end_date: date,
      filtering: [{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify(ids) }],
      page,
      page_size: 1000,
    });
    for (const row of rep?.list || []) {
      const gid = String(row.dimensions?.adgroup_id || "");
      const cid = campaignByAdgroup.get(gid);
      if (!cid) continue;
      const m = row.metrics || {};
      const acc = sums[cid] || { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      acc.spend += num(m.spend);
      acc.impressions += num(m.impressions);
      acc.clicks += num(m.clicks);
      acc.conversions += num(m.conversion) || num(m.result);
      sums[cid] = acc;
    }
    const info = rep?.page_info || {};
    if (!info.total_page || page >= info.total_page) break;
    page += 1;
    if (page > 20) break; // safety
  }

  const byId = {};
  for (const [cid, acc] of Object.entries(sums)) {
    const spend = round2(acc.spend);
    const impressions = Math.round(acc.impressions);
    byId[cid] = {
      advertiser_id: advId,
      spend,
      impressions,
      clicks: Math.round(acc.clicks),
      conversions: acc.conversions,
      cpm: impressions > 0 ? round2((spend / impressions) * 1000) : 0,
      cpa: acc.conversions > 0 ? round2(spend / acc.conversions) : 0,
    };
  }
  return byId;
}

// -------- lazy: one campaign's live detail (row status + ad groups + today) --
// Verifies nothing — the caller must confirm the campaign belongs to a tracked
// advertiser first. Returns the freshly-derived campaign status AND the ad
// group sub-rows (name/id/status/today's spend/today's CPA/operation_status).
async function loadCampaignDetail({ client, advertiserId, advertiserStatus, campaignId, timezone }) {
  let campaign = null;
  try {
    const cRes = await mcpCall(client, "campaign_get", {
      advertiser_id: advertiserId,
      fields: CAMPAIGN_FIELDS,
      filtering: { campaign_ids: [String(campaignId)] },
    });
    campaign = (cRes?.list || []).find((c) => String(c.campaign_id) === String(campaignId)) || null;
  } catch {
    /* keep going with ad-group data only */
  }

  const gRes = await mcpCall(client, "adgroup_get", {
    advertiser_id: advertiserId,
    fields: ADGROUP_STATUS_FIELDS,
    filtering: { campaign_ids: [String(campaignId)] },
    page_size: 1000,
  });
  const adGroups = (gRes?.list || []).filter((g) => String(g.campaign_id) === String(campaignId));
  const ids = adGroups.map((g) => String(g.adgroup_id));

  const reviewById = {};
  for (let i = 0; i < ids.length; i += 20) {
    try {
      const rev = await mcpCall(client, "adgroup_review_info_get", {
        advertiser_id: advertiserId,
        adgroup_ids: ids.slice(i, i + 20),
      });
      Object.assign(reviewById, rev?.ad_group_review_map || {});
    } catch {
      /* best-effort */
    }
  }

  const metricsById = {};
  if (ids.length) {
    // Same NY reporting boundary as the campaign row / KPIs / daily_totals.
    // `timezone` is kept in the signature for callers but no longer used here.
    const today = dashboardToday();
    try {
      const rep = await mcpCall(client, "report_integrated_get", {
        report_type: "BASIC",
        service_type: "AUCTION",
        data_level: "AUCTION_ADGROUP",
        advertiser_id: advertiserId,
        dimensions: ["adgroup_id"],
        metrics: ["spend", "conversion", "cost_per_conversion", "result", "cost_per_result", "impressions", "clicks"],
        start_date: today,
        end_date: today,
        filtering: [{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([String(campaignId)]) }],
        page_size: 1000,
      });
      for (const row of rep?.list || []) {
        const id = String(row.dimensions?.adgroup_id || "");
        if (id) metricsById[id] = row.metrics || {};
      }
    } catch {
      /* metrics best-effort — rows still render with 0 */
    }
  }

  const eff = deriveEffectiveStatus({
    advertiserStatus,
    campaign: campaign || {},
    adGroups,
    reviewByAdGroupId: reviewById,
  });

  const rows = adGroups.map((g) => {
    const id = String(g.adgroup_id);
    const m = metricsById[id] || {};
    const st = deriveAdGroupStatus(g, reviewById[id]);
    return {
      adgroup_id: id,
      adgroup_name: g.adgroup_name || id,
      operation_status: g.operation_status || null, // ENABLE / DISABLE -> button label
      status_label: st.label,
      status_tone: st.tone,
      spend: num(m.spend),
      cpa: tiktokCpa(m),
      conversions: num(m.conversion) || num(m.result),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
    };
  });

  return {
    campaign_operation_status: campaign?.operation_status || null,
    campaign_secondary_status: campaign?.secondary_status || null,
    effective_status: eff.label,
    effective_tone: eff.tone,
    status_detail: eff.detail || null,
    ad_count: adGroups.length,
    active_ad_count: eff.activeAdCount || 0,
    adGroups: rows,
  };
}

// -------- writes --------

async function setCampaignStatus({ client, advertiserId, campaignId, operationStatus }) {
  await mcpCall(client, "campaign_status_update", {
    advertiser_id: advertiserId,
    campaign_ids: [String(campaignId)],
    operation_status: operationStatus, // ENABLE | DISABLE
  });
  const res = await mcpCall(client, "campaign_get", {
    advertiser_id: advertiserId,
    fields: CAMPAIGN_FIELDS,
    filtering: { campaign_ids: [String(campaignId)] },
  });
  return (res?.list || []).find((c) => String(c.campaign_id) === String(campaignId)) || null;
}

// Permanently deletes a campaign in TikTok. `campaign_status_update` with
// operation_status DELETE is the documented delete operation — "Deleted
// campaigns cannot be modified afterward." Throws (via mcpCall) when TikTok
// refuses, e.g. the advertiser account is suspended/limited; the caller decides
// whether to fall back to hiding the row locally.
async function deleteCampaign({ client, advertiserId, campaignId }) {
  await mcpCall(client, "campaign_status_update", {
    advertiser_id: String(advertiserId),
    campaign_ids: [String(campaignId)],
    operation_status: "DELETE",
  });
  return { ok: true };
}

async function setAdGroupStatus({ client, advertiserId, adGroupId, operationStatus }) {
  await mcpCall(client, "adgroup_status_update", {
    advertiser_id: advertiserId,
    adgroup_ids: [String(adGroupId)],
    operation_status: operationStatus, // ENABLE | DISABLE
  });
  const res = await mcpCall(client, "adgroup_get", {
    advertiser_id: advertiserId,
    fields: ADGROUP_STATUS_FIELDS,
    filtering: { adgroup_ids: [String(adGroupId)] },
  });
  return (res?.list || []).find((g) => String(g.adgroup_id) === String(adGroupId)) || null;
}

// -------- affiliate network association --------

const NETWORKS = ["GLITCHY", "MABAC"];
function normalizeNetwork(v) {
  const s = String(v || "").toUpperCase();
  return NETWORKS.includes(s) ? s : "GLITCHY";
}

// Which affiliate network owns a Business Center's campaigns. The single source
// of truth is the per-connection tiktok_connections.affiliate_network column
// (set from the modal's Glitchy/Mabac toggle). Missing -> GLITCHY (preserves
// existing behaviour).
function resolveBcNetwork(_bcId, _bcName, storedNetwork) {
  return normalizeNetwork(storedNetwork);
}

// -------- advertiser account budget / Business Center balance --------
//
// Real TikTok model (verified against the live BC):
//  * bc/balance/get      -> ONE shared balance pool per Business Center
//                           (valid_account_balance). Ad accounts under a SHARED
//                           payment portfolio all draw from this pool.
//  * advertiser/balance/get (needs bc_id) -> per ad account:
//        budget_mode  (UNLIMITED | MONTHLY_BUDGET | DAILY_BUDGET | CUSTOM_BUDGET)
//        budget       (the cap amount; 0 when UNLIMITED)
//        budget_cost  (spent against that cap)
//        budget_remaining (cap - cost; only with the extra `fields`)
//  * advertiser/update (bc_id + advertiser_budgets + budget_update_type=UPDATE)
//        -> sets/changes/removes the per-account cap. Caller must be BC Admin
//           with finance_role MANAGER.

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getBcBalance({ client, bcId }) {
  try {
    const d = await mcpCall(client, "bc_balance_get", { bc_id: bcId });
    return {
      balance: toNum(d.valid_account_balance ?? d.account_balance),
      cash_balance: toNum(d.valid_cash_balance ?? d.cash_balance),
      currency: d.currency || "USD",
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Every ad account's budget/cap under a BC, keyed by advertiser_id.
async function getAdvertiserBudgets({ client, bcId }) {
  const byId = {};
  let page = 1;
  for (;;) {
    let d;
    try {
      d = await mcpCall(client, "advertiser_balance_get", {
        bc_id: bcId,
        fields: ["budget_remaining", "budget_amount_restriction"],
        page,
        page_size: 50,
      });
    } catch (err) {
      // retry without the extra fields (older BCs)
      if (page === 1) {
        try {
          d = await mcpCall(client, "advertiser_balance_get", { bc_id: bcId, page, page_size: 50 });
        } catch (e2) {
          return { error: e2.message };
        }
      } else {
        break;
      }
    }
    const list = d?.advertiser_account_list || [];
    for (const a of list) {
      const id = String(a.advertiser_id);
      const mode = String(a.budget_mode || "UNLIMITED").toUpperCase();
      const cap = toNum(a.budget);
      const spent = toNum(a.budget_cost);
      const remaining = a.budget_remaining != null ? toNum(a.budget_remaining) : Math.max(0, cap - spent);
      byId[id] = {
        advertiser_id: id,
        budget_mode: mode,
        capped: mode !== "UNLIMITED" && cap > 0,
        cap,
        spent,
        remaining,
        min_cap: toNum(a.budget_amount_restriction?.minimum_amount),
        account_balance: toNum(a.valid_account_balance ?? a.account_balance),
        currency: a.currency || "USD",
        status: a.advertiser_status || null,
      };
    }
    const info = d?.page_info || {};
    if (!info.total_page || page >= info.total_page) break;
    page += 1;
    if (page > 40) break; // safety
  }
  return { byId };
}

// UPDATE / set / remove one ad account's cap.
//   budgetMode: UNLIMITED | MONTHLY_BUDGET | DAILY_BUDGET | CUSTOM_BUDGET
//   budget:     cap amount (ignored when UNLIMITED)
async function setAdvertiserBudget({ client, bcId, advertiserId, budgetMode, budget }) {
  const mode = String(budgetMode || "").toUpperCase();
  const item = { advertiser_id: String(advertiserId), budget_mode: mode };
  if (mode !== "UNLIMITED") item.budget = toNum(budget);

  await mcpCall(client, "advertiser_update", {
    bc_id: bcId,
    budget_update_type: "UPDATE",
    advertiser_budgets: [item],
  });

  // Re-read this one account.
  const d = await mcpCall(client, "advertiser_balance_get", {
    bc_id: bcId,
    fields: ["budget_remaining", "budget_amount_restriction"],
    filtering: { keyword: String(advertiserId) },
    page_size: 50,
  });
  const a = (d?.advertiser_account_list || []).find((x) => String(x.advertiser_id) === String(advertiserId));
  if (!a) return null;
  const m = String(a.budget_mode || "UNLIMITED").toUpperCase();
  const cap = toNum(a.budget);
  const spent = toNum(a.budget_cost);
  return {
    advertiser_id: String(advertiserId),
    budget_mode: m,
    capped: m !== "UNLIMITED" && cap > 0,
    cap,
    spent,
    remaining: a.budget_remaining != null ? toNum(a.budget_remaining) : Math.max(0, cap - spent),
    account_balance: toNum(a.valid_account_balance ?? a.account_balance),
    currency: a.currency || "USD",
  };
}

module.exports = {
  DEFAULT_MCP_SERVER_URL,
  MCP_SCOPE,
  NETWORKS,
  normalizeNetwork,
  resolveBcNetwork,
  auth,
  resolveConfig,
  getSupabase,
  sbErr,
  checkPassword,
  json,
  SupabaseOAuthProvider,
  connectMcp,
  mcpCall,
  dashboardToday,
  discoverAndStoreAdvertisers,
  discoverAndStoreCampaigns,
  markEngagementReadyIfActive,
  autoProcessReadyEngagements,
  withoutTemporaryCampaigns,
  deriveEffectiveStatus,
  applyAppealOverlay,
  applyAppealOverlayByCampaignId,
  deriveAdGroupStatus,
  loadCampaignMetricsForAdvertiser,
  loadCampaignMetricsViaAdGroups,
  loadCampaignDetail,
  setCampaignStatus,
  setAdGroupStatus,
  deleteCampaign,
  getBcBalance,
  getAdvertiserBudgets,
  setAdvertiserBudget,
};

// Talks to the Netlify functions (glitchy-stats, daily-totals, tiktok-*) and
// caches the last successful Glitchy result in localStorage so the dashboard
// never has to render an empty state — even on a fresh browser with no network.

const CACHE_KEY = "chigla_glitchy_cache_v1";
const DAILY_CACHE_KEY = "chigla_daily_totals_cache_v1";
const MABAC_CACHE_KEY = "chigla_mabac_cache_v1";
const THEME_KEY = "chigla_theme_v1";

export async function fetchGlitchyStats(startDate, endDate) {
  const res = await fetch(`/.netlify/functions/glitchy-stats?startDate=${startDate}&endDate=${endDate}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details || data.message;
    throw err;
  }
  saveCache(startDate, endDate, data);
  return data;
}

// Mabac affiliate report (grouped by sub1 == campaign name). Never throws.
// Caches the last good result so a Mabac outage shows last-known data instead
// of dropping Mabac rows to zero.
export async function fetchMabacStats(startDate, endDate) {
  const qs = startDate && endDate ? `?startDate=${startDate}&endDate=${endDate}` : "";
  let data;
  try {
    const res = await fetch(`/.netlify/functions/mabac-stats${qs}`);
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (data && data.configured && !data.error) {
    try {
      localStorage.setItem(MABAC_CACHE_KEY, JSON.stringify({ data, savedAt: Date.now() }));
    } catch (_) {}
    return data;
  }
  // Not configured, or an error / network failure -> fall back to last good.
  try {
    const raw = localStorage.getItem(MABAC_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw).data;
      if (cached) return { ...cached, stale: true };
    }
  } catch (_) {}
  return data || { configured: false, sources: [] };
}

export async function fetchDailyTotals(month) {
  const res = await fetch(`/.netlify/functions/daily-totals?month=${month}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  saveDailyCache(month, data);
  return data;
}

function saveCache(startDate, endDate, data) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ startDate, endDate, data, savedAt: Date.now() })
    );
  } catch (_) {
    /* localStorage unavailable — non-fatal, just skip caching */
  }
}

export function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveDailyCache(month, data) {
  try {
    localStorage.setItem(DAILY_CACHE_KEY, JSON.stringify({ month, data, savedAt: Date.now() }));
  } catch (_) {}
}

export function loadDailyCache() {
  try {
    const raw = localStorage.getItem(DAILY_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

// ---------------- TikTok Ads (MCP OAuth) ----------------
// Auth + advertiser discovery/selection. All token handling is server-side in
// the tiktok-* Netlify functions — nothing sensitive is returned here.

// Surfaces the function's `details` alongside `error` so failures are debuggable
// from the dashboard instead of a bare "Request failed".
async function readTiktokResponse(res, fallback) {
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }
  if (!res.ok || data.error) {
    const msg = data.error || `${fallback} (${res.status})`;
    const err = new Error(data.details ? `${msg} — ${data.details}` : msg);
    err.status = res.status;
    err.details = data.details;
    throw err;
  }
  return data;
}

export async function fetchTiktokConnections() {
  const res = await fetch("/.netlify/functions/tiktok-connections");
  return readTiktokResponse(res, "Request failed"); // { connections: [...], advertisers: [...] }
}

export async function startTiktokAuth(password, label) {
  const res = await fetch("/.netlify/functions/tiktok-auth-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, label }),
  });
  return readTiktokResponse(res, "Auth start failed"); // { authorizeUrl }
}

export async function postTiktokAction(payload) {
  const res = await fetch("/.netlify/functions/tiktok-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readTiktokResponse(res, "Request failed");
}

// TikTok campaign discovery. GET is fast (reads Supabase); the sync POST hits
// the TikTok MCP for every tracked advertiser account.
export async function fetchTiktokCampaigns() {
  const res = await fetch("/.netlify/functions/tiktok-campaigns");
  return readTiktokResponse(res, "Request failed"); // { campaigns: [...] }
}

// "Refresh Data" — re-scans advertisers + re-discovers campaigns. Pass a
// connectionId to scope it to one Business Center; omit for a full sync across
// every connection. Not password-gated.
export async function syncTiktokCampaigns(connectionId) {
  const body = connectionId ? { action: "sync", connection_id: connectionId } : { action: "sync" };
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readTiktokResponse(res, "Refresh failed");
}

// Lazy: one campaign's ad groups + today's spend/CPA + status. Read-only.
export async function fetchCampaignAdGroups(campaignId) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "adgroups", campaign_id: campaignId }),
  });
  return readTiktokResponse(res, "Couldn't load ad groups");
}

// Write: pause / enable a whole campaign. Not password-gated (server still
// verifies the campaign belongs to a tracked advertiser account).
export async function setCampaignStatus(campaignId, operationStatus) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set_campaign_status", campaign_id: campaignId, operation_status: operationStatus }),
  });
  return readTiktokResponse(res, "Campaign update failed");
}

// Write: pause / enable one ad group. Not password-gated.
export async function setAdgroupStatus(campaignId, adgroupId, operationStatus) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "set_adgroup_status",
      campaign_id: campaignId,
      adgroup_id: adgroupId,
      operation_status: operationStatus,
    }),
  });
  return readTiktokResponse(res, "Ad group update failed");
}

// Read: advertiser-account budgets/caps + Business Center shared balances for
// every tracked account. Hits the MCP — call on load / manual refresh, not on
// the 60s poll.
export async function fetchTiktokBudgets() {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "budgets" }),
  });
  return readTiktokResponse(res, "Couldn't load budgets"); // { advertisers: {...}, bc: {...} }
}

// Read: today's live TikTok campaign metrics (spend / CPM / CPA / impressions /
// clicks / conversions) for every tracked advertiser account, keyed by
// campaign_id. NY reporting date. Hits the MCP — call on load / the 60s refresh,
// not more often. Partial failures come back 200 with a populated `errors` map
// (the caller keeps last-known values for the affected advertisers).
export async function fetchTiktokMetrics() {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "metrics" }),
  });
  return readTiktokResponse(res, "Couldn't load campaign metrics"); // { metrics, okAdvertiserIds, errors, date }
}

// Write: set / change / remove one advertiser account's spend cap.
// budgetMode: UNLIMITED | MONTHLY_BUDGET | DAILY_BUDGET | CUSTOM_BUDGET
export async function setAdvertiserBudget(advertiserId, budgetMode, budget) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set_advertiser_budget", advertiser_id: advertiserId, budget_mode: budgetMode, budget }),
  });
  return readTiktokResponse(res, "Budget update failed");
}

// Write: permanently delete a campaign in TikTok. Not password-gated (server
// still verifies the campaign belongs to a tracked advertiser account). When
// TikTok refuses because the advertiser is suspended, the campaign is hidden
// locally instead — the response `outcome` is "deleted" or "hidden".
export async function deleteTiktokCampaign(campaignId) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete_campaign", campaign_id: campaignId }),
  });
  return readTiktokResponse(res, "Campaign delete failed");
}

// Set / clear a campaign's TikTok post URL. Pass "" to clear. No external calls.
export async function setCampaignPostUrl(campaignId, tiktokPostUrl) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set_post_url", campaign_id: campaignId, tiktok_post_url: tiktokPostUrl }),
  });
  return readTiktokResponse(res, "Couldn't save the post URL"); // { tiktok_post_url }
}

// Queue the SAME comment batch (one per line) against one or many campaigns'
// own tiktok_post_url — pass a single id or an array. Server-side each
// campaign gets its own engagement_orders row and, if
// ENGAGEMENT_COMMENTS_API_KEY is configured, is sent to the comments provider
// (DripFeedPanel) with the given Service ID. No credentials are ever returned.
// -> { results: [{ campaign_id, ok, message, ... }] }
export async function queueEngagementComments(campaignIds, serviceId, comments) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "queue_engagement_comments", campaign_ids: [].concat(campaignIds), service_id: serviceId, comments }),
  });
  return readTiktokResponse(res, "Couldn't queue the comments");
}

// On-demand LIKES/SAVES push for one or many campaigns — a fallback for
// campaigns the ~60s auto-trigger missed or gave up on. Bypasses that
// trigger's own state entirely; a 0/omitted quantity skips that kind.
// -> { results: [{ campaign_id, ok, likes?, saves? }] }
export async function queueEngagementManual(campaignIds, likesQuantity, savesQuantity) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "queue_engagement_manual",
      campaign_ids: [].concat(campaignIds),
      likes_quantity: likesQuantity,
      saves_quantity: savesQuantity,
    }),
  });
  return readTiktokResponse(res, "Couldn't queue the engagement");
}

// Current LIKES/SAVES panel defaults — used to pre-fill the Engagement
// modal with "default = whatever auto-engagement currently uses."
// -> { likes: { quantity, configured }, saves: { quantity, configured } }
export async function fetchEngagementDefaults() {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "engagement_defaults" }),
  });
  return readTiktokResponse(res, "Couldn't load engagement defaults");
}

// Read-only: the engagement orders (likes / saves / comments) recorded for one
// campaign, newest first. Used by the Add-comments modal to show what the
// Active-trigger auto-placed. { orders: [{ kind, provider, status, provider_ref, quantity, note }] }
export async function fetchEngagementOrders(campaignId) {
  const res = await fetch("/.netlify/functions/tiktok-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "engagement_orders", campaign_id: campaignId }),
  });
  return readTiktokResponse(res, "Couldn't load engagement orders");
}

// ---------------- Campaign Creator (auto-duplicate initial ad group) ----------------
// Foundation only. Nothing registers campaigns yet — that's the future
// Campaign Creator tool's job. `processCampaignCreatorDuplication` runs on the
// existing ~60s refresh; it's a no-op while the table is empty.

export async function processCampaignCreatorDuplication() {
  const res = await fetch("/.netlify/functions/campaign-creator", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "process_duplication" }),
  });
  return readTiktokResponse(res, "Campaign-Creator duplication failed");
}

// Called by the future Campaign Creator after it builds campaign -> initial
// ad group -> ad. Records the exact payloads so duplicates are an exact replay.
export async function registerCampaignCreatorCampaign(payload) {
  const res = await fetch("/.netlify/functions/campaign-creator", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "register", ...payload }),
  });
  return readTiktokResponse(res, "Couldn't register the campaign");
}

// Registered campaigns + duplication state — used by the "Dupe" modal to show
// each Active campaign's current progress (dupe_status/dupe_created/dupe_target).
export async function listCampaignCreatorCampaigns() {
  const res = await fetch("/.netlify/functions/campaign-creator", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list" }),
  });
  return readTiktokResponse(res, "Couldn't load duplication status"); // { campaigns: [...] }
}

// Manual duplication trigger (the "Dupe" button). Duplication no longer
// starts automatically once a campaign goes Active — this is the only thing
// that does. Partial per-campaign failures come back 200 with results[].
export async function runManualDupe(campaignIds, count) {
  const res = await fetch("/.netlify/functions/campaign-creator", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "manual_dupe", campaign_ids: campaignIds, count }),
  });
  return readTiktokResponse(res, "Duplication failed"); // { results: [...] }
}

// ---------------- Campaign Creator (templates + batch create) ----------------
// Templates hold reusable settings only. The runner creates one campaign per
// selected advertiser and registers each with the existing duplication +
// auto-appeal monitoring. All TikTok writes are server-side.

export async function listCampaignTemplates() {
  const res = await fetch("/.netlify/functions/campaign-creator-templates");
  return readTiktokResponse(res, "Couldn't load templates"); // { templates: [...] }
}
export async function saveCampaignTemplate(payload) {
  // payload: { action:'create'|'update', id?, name, campaign_type, config }
  const res = await fetch("/.netlify/functions/campaign-creator-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readTiktokResponse(res, "Couldn't save the template"); // { template }
}
export async function deleteCampaignTemplate(id) {
  const res = await fetch("/.netlify/functions/campaign-creator-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  return readTiktokResponse(res, "Couldn't delete the template");
}

// Per-advertiser preflight: identities/forms/instant-page events valid across ALL
// selected accounts, plus each account's timezone + newest Instant Page.
// `formIds` = Instant Form IDs the operator has used before (remembered locally),
// re-validated server-side so they appear in the dropdown with real names.
export async function campaignCreatorResources(connectionId, campaignType, advertiserIds, formIds) {
  const res = await fetch("/.netlify/functions/campaign-creator-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "resources",
      connection_id: connectionId,
      campaign_type: campaignType,
      advertiser_ids: advertiserIds,
      form_ids: formIds || [],
    }),
  });
  return readTiktokResponse(res, "Couldn't load campaign resources");
}

// Confirm an Instant Form ID is usable by the selected Approved accounts (uses
// page_field_get, which resolves a form assigned to the accounts even when the
// API won't list it). -> { ok, page_id, name, checks: [...] }
export async function validateCampaignForm(connectionId, advertiserIds, pageId) {
  const res = await fetch("/.netlify/functions/campaign-creator-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "validate_form", connection_id: connectionId, advertiser_ids: advertiserIds, page_id: pageId }),
  });
  return readTiktokResponse(res, "Couldn't validate the Form ID");
}

// Instant Form IDs the operator has used, remembered in this browser only.
const CC_FORMS_KEY = "chigla_cc_forms_v1";
export function loadRememberedForms() {
  try {
    const raw = localStorage.getItem(CC_FORMS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((f) => f && /^\d{6,25}$/.test(String(f.id))) : [];
  } catch (_) {
    return [];
  }
}
export function rememberForm(id, name) {
  try {
    const list = loadRememberedForms().filter((f) => String(f.id) !== String(id));
    list.unshift({ id: String(id), name: name || String(id) });
    localStorage.setItem(CC_FORMS_KEY, JSON.stringify(list.slice(0, 20)));
  } catch (_) {}
}

// Create one campaign per selected advertiser. Partial failures come back 200
// with a populated results[] (status Created | Failed | Skipped).
export async function runCampaignCreator(payload) {
  const res = await fetch("/.netlify/functions/campaign-creator-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", ...payload }),
  });
  return readTiktokResponse(res, "Campaign creation failed"); // { results: [...] }
}

// ---------------- Comment templates (global, reusable) ----------------

export async function listCommentTemplates() {
  const res = await fetch("/.netlify/functions/comment-templates");
  return readTiktokResponse(res, "Couldn't load templates"); // { templates: [...] }
}
export async function createCommentTemplate(name, comments) {
  const res = await fetch("/.netlify/functions/comment-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", name, comments }),
  });
  return readTiktokResponse(res, "Couldn't save the template"); // { template }
}
export async function updateCommentTemplate(id, name, comments) {
  const res = await fetch("/.netlify/functions/comment-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", id, name, comments }),
  });
  return readTiktokResponse(res, "Couldn't update the template"); // { template }
}
export async function deleteCommentTemplate(id) {
  const res = await fetch("/.netlify/functions/comment-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  return readTiktokResponse(res, "Couldn't delete the template");
}

// Config: which affiliate network supplies clicks/earnings for a connection's
// campaigns. Not password-gated.
export async function setConnectionNetwork(connectionId, affiliateNetwork) {
  const res = await fetch("/.netlify/functions/tiktok-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set_network", connection_id: connectionId, affiliate_network: affiliateNetwork }),
  });
  return readTiktokResponse(res, "Couldn't set network");
}

// ---------------- WH Warmup ----------------
// Bulk temporary Traffic-CBO warmup campaigns that auto-delete once Active.
// All TikTok writes are server-side; nothing sensitive is returned here.

// `campaignNames` (optional, same length/order as advertiserIds): the exact
// "whN" name to use for each account. A large batch is sent as several
// smaller requests (see js/app.js submitWhWarmup) so continuous numbering
// across requests needs the caller to compute names once up front, the same
// way Campaign Creator's own chunked create does — without this, each
// request would restart naming from wh1 and collide with an earlier chunk's.
export async function createWhWarmup(connectionId, advertiserIds, targetCountry, sparkCode, locationId, campaignNames) {
  const res = await fetch("/.netlify/functions/wh-warmup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create",
      connection_id: connectionId,
      advertiser_ids: advertiserIds,
      target_country: targetCountry,
      location_id: locationId || null,
      spark_code: sparkCode,
      ...(campaignNames ? { campaign_names: campaignNames } : {}),
    }),
  });
  return readTiktokResponse(res, "WH Warmup creation failed"); // { results: [...] }
}

// Valid country-level TikTok target locations for one advertiser (WH country
// autocomplete). { countries: [{ location_id, name, code }] }
export async function fetchWhCountries(connectionId, advertiserId) {
  const res = await fetch("/.netlify/functions/wh-warmup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "countries", connection_id: connectionId, advertiser_id: advertiserId }),
  });
  return readTiktokResponse(res, "Couldn't load countries");
}

// Union of country-level TikTok target locations across every approved
// advertiser on every connection — used by Campaign Creator templates, which
// aren't tied to one ad account/BC and so must not be limited to what a single
// account can currently target. { countries: [{ location_id, name, code }] }
export async function fetchTemplateCountries() {
  const res = await fetch("/.netlify/functions/wh-warmup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "template_countries" }),
  });
  return readTiktokResponse(res, "Couldn't load countries");
}

// Poll + auto-delete WH campaigns that have reached Active. Idempotent; called
// on the existing ~60s refresh. Never throws for the caller's purposes.
export async function cleanupWhWarmup() {
  const res = await fetch("/.netlify/functions/wh-warmup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cleanup" }),
  });
  return readTiktokResponse(res, "WH Warmup cleanup failed");
}

// `connectionId` (optional): scopes the list to one Business Center — the
// "WHs Warming Up" box sits right under the BC selector in the WH Warmup
// creator, so it only shows that same BC's campaigns. Omit for every BC.
export async function listWhWarmup(connectionId) {
  const res = await fetch("/.netlify/functions/wh-warmup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list", ...(connectionId ? { connection_id: connectionId } : {}) }),
  });
  return readTiktokResponse(res, "Couldn't load WH Warmup campaigns"); // { campaigns: [...] }
}

// ---------------- Tracker (Tests + Winners) ----------------
// Password-gated on every action (the user asked the tool itself to be gated
// on open, not just on write). All TikTok/Glitchy calls for the auto-populated
// numbers happen server-side on the daily cron — this endpoint only ever
// reads/writes Supabase.

export async function trackerList(password) {
  const res = await fetch("/.netlify/functions/tracker", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list", password }),
  });
  return readTiktokResponse(res, "Couldn't load the Tracker"); // { tests: [...], winners: [...] }
}
export async function trackerUpdateTest(password, id, patch) {
  const res = await fetch("/.netlify/functions/tracker", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update_test", password, id, patch }),
  });
  return readTiktokResponse(res, "Couldn't save"); // { test }
}
export async function trackerDeleteTest(password, id) {
  const res = await fetch("/.netlify/functions/tracker", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete_test", password, id }),
  });
  return readTiktokResponse(res, "Couldn't delete the row");
}
export async function trackerCreateWinner(password) {
  const res = await fetch("/.netlify/functions/tracker", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create_winner", password }),
  });
  return readTiktokResponse(res, "Couldn't add the row"); // { winner }
}
export async function trackerUpdateWinner(password, id, patch) {
  const res = await fetch("/.netlify/functions/tracker", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update_winner", password, id, patch }),
  });
  return readTiktokResponse(res, "Couldn't save"); // { winner }
}
export async function trackerDeleteWinner(password, id) {
  const res = await fetch("/.netlify/functions/tracker", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete_winner", password, id }),
  });
  return readTiktokResponse(res, "Couldn't delete the row");
}

// ---------------- Theme persistence ----------------

export function loadTheme(defaultTheme) {
  try {
    return localStorage.getItem(THEME_KEY) || defaultTheme;
  } catch (_) {
    return defaultTheme;
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {}
}

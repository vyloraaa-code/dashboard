import {
  fetchGlitchyStats,
  fetchMabacStats,
  fetchDailyTotals,
  loadCache,
  fetchTiktokConnections,
  startTiktokAuth,
  postTiktokAction,
  fetchTiktokCampaigns,
  fetchTiktokMetrics,
  syncTiktokCampaigns,
  fetchCampaignAdGroups,
  setCampaignStatus,
  setAdgroupStatus,
  fetchTiktokBudgets,
  setAdvertiserBudget,
  setConnectionNetwork,
  deleteTiktokCampaign,
  setCampaignPostUrl,
  queueEngagementComments,
  queueEngagementManual,
  fetchEngagementDefaults,
  fetchEngagementOrders,
  listCommentTemplates,
  createCommentTemplate,
  updateCommentTemplate,
  deleteCommentTemplate,
  createWhWarmup,
  cleanupWhWarmup,
  listWhWarmup,
  fetchWhCountries,
  fetchTemplateCountries,
  processCampaignCreatorDuplication,
  listCampaignTemplates,
  saveCampaignTemplate,
  deleteCampaignTemplate,
  campaignCreatorResources,
  validateCampaignForm,
  loadRememberedForms,
  rememberForm,
  runCampaignCreator,
  listCampaignCreatorCampaigns,
  runManualDupe,
  trackerList,
  trackerUpdateTest,
  trackerDeleteTest,
  trackerCreateWinner,
  trackerUpdateWinner,
  trackerDeleteWinner,
} from "./api.js";
import { initTheme } from "./theme.js";
import { createMainChart, updateMainChart } from "./charts.js";

// ---------------------------------------------------------------------------
// Fallback dataset — only ever used on a brand-new browser with no cache AND
// a failed first network call, so the dashboard never renders empty.
// ---------------------------------------------------------------------------
function fallbackSources() {
  return [
    { source: "US_Sweeps_ABO_AdA", offer_name: "iPhone 16 Sweepstakes", clicks: 812, conversions: 34, payout: 289.0, entries_count: 40, reset_applied: true },
    { source: "US_Sweeps_ABO_AdB", offer_name: "iPhone 16 Sweepstakes", clicks: 540, conversions: 19, payout: 152.5, entries_count: 26, reset_applied: true },
    { source: "CBO_CPI_Android_Global", offer_name: "SuperApp Install", clicks: 1204, conversions: 88, payout: 176.0, entries_count: 61, reset_applied: false },
    { source: "UK_CPI_iOS_CBO", offer_name: "Fitness Tracker App", clicks: 396, conversions: 21, payout: 94.5, entries_count: 18, reset_applied: false },
  ];
}

// Glitchy's "hour" field is EST-anchored, so "today" here means the same EST
// calendar date the backend uses. The dashboard day rolls over automatically
// at EST midnight — there is no manual "New Day".
function todayStr() {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${est.getFullYear()}-${String(est.getMonth() + 1).padStart(2, "0")}-${String(est.getDate()).padStart(2, "0")}`;
}
function currentEstHour() {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return est.getHours();
}
function estDateLabel() {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return est.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
const money = (n) => `$${(Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2)}`;
const num = (n) => (n || 0).toLocaleString("en-US");
const signedMoney = (n) => `${n >= 0 ? "+" : "-"}${money(Math.abs(n))}`;
// Coerce anything (null / undefined / "" / NaN / Infinity) to a finite number.
const toNum = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
// a / b, but only when b > 0 and the result is finite — else 0. Kills every
// NaN / Infinity path in the derived metrics (CPNC, EPC, ROAS).
const ratio = (a, b) => {
  const r = toNum(a) / toNum(b);
  return toNum(b) > 0 && Number.isFinite(r) ? r : 0;
};

// Smooth ROAS → colour ramp for the ROAS cell. 0 red · 0.5 orange · 1 yellow ·
// 1.5 yellow-green · 2+ strong green (clamped, so 2x and 5x read the same). HSL
// so it interpolates cleanly; lightness kept high enough to stay readable on the
// dark themes.
function roasColor(roas) {
  const r = Math.max(0, Math.min(2, Number(roas) || 0));
  const stops = [
    [0, 0],
    [0.5, 25],
    [1, 55],
    [1.5, 92],
    [2, 142],
  ];
  let hue = 142;
  for (let i = 1; i < stops.length; i++) {
    if (r <= stops[i][0]) {
      const [x0, h0] = stops[i - 1];
      const [x1, h1] = stops[i];
      hue = h0 + ((h1 - h0) * (r - x0)) / (x1 - x0);
      break;
    }
  }
  return `hsl(${Math.round(hue)}, 85%, 62%)`;
}

const state = {
  sources: [],
  glitchyRows: [], // per-source rows from Glitchy (clicks/payout/conversions)
  mabacRows: [], // per-sub1 rows from Mabac (clicks/conversions/revenue)
  mabacConfigured: false,
  tiktokCampaigns: [], // rows from tiktok-campaigns (campaign_name == source)
  campaignMetrics: {}, // campaign_id -> { advertiser_id, spend, cpm, cpa, impressions, clicks, conversions } — today, NY date
  campaignMetricsDate: null, // NY date the metrics belong to
  campaignMetricsStale: false, // last metrics refresh had a partial/total failure
  spendToday: null, // { date, currentHour, cumulative, byHour } — Live Performance Spend series ONLY
  earningsToday: null, // { date, currentHour, cumulative, byHour } — Live Performance Earnings series ONLY (combined Glitchy+Mabac)
  budgets: {}, // advertiser_id -> { budget_mode, capped, cap, spent, remaining, account_balance, currency, bc_id }
  bcBalances: {}, // bc_id -> { balance, currency, bc_name }
  detailBcFilter: "all", // "all" | bc_id — VIEW filter only, never untracks anything
  adGroupsByCampaign: {}, // campaign_id -> { loadedAt, rows, error }
  pendingActions: new Set(), // in-flight campaign/adgroup writes (double-click guard)
  hasFetchedOnce: false,
  prevConversions: new Map(),
  baseSpendTotal: 0,
  baseEarningsTotal: 0,
  kpiPrevText: {}, // KPI element id -> its last-rendered text, so the flash-on-change animation only fires on an actual change
  expandedSources: new Set(),
  selectedCampaigns: new Set(), // campaign_ids checked in the Select column
  tracker: {
    unlocked: false, // password verified this session
    password: null, // cached after the first successful call — never persisted
    tab: "tests", // "tests" | "winners"
    offerFilter: "all", // "all" | "CPI" | "SWEEPS"
    tests: [],
    winners: [],
  },
};

let lastUpdatedAt = null;
let refreshInFlight = false; // guards refreshAll() against overlapping runs
let metricsInFlight = false; // guards loadTiktokMetrics() against overlapping runs
let whCleanupInFlight = false; // guards the WH Warmup cleanup poll
let ccDupeInFlight = false; // guards the Campaign-Creator duplication poll
let mainChartCanvas = null;
let openRowMenuFor = null; // campaignId whose ⋮ menu is open, or null
let rowMenuEl = null; // the floating menu element (appended to <body>)
let deleteCampaignTargets = []; // source row(s) pending delete confirmation
let engagementManualTargets = []; // source row(s) for the open Engagement modal — 1 = single-campaign UI, >1 = batch
const ENGAGEMENT_SERVICE_ID_KEY = "chigla_engagement_service_id_v1";
// Which engagement kinds to actually send when "Add" is clicked — all on by
// default; the modal's per-kind toggle switches flip these.
const engagementToggles = { likes: true, saves: true, comments: true };

// ============================== INIT ==============================

document.addEventListener("DOMContentLoaded", () => {
  updateDateDisplay();

  initTheme(() => {
    // Chart colors are read from CSS vars at creation time — rebuild on theme swap.
    renderChart(true);
  });

  mainChartCanvas = document.getElementById("mainChart");

  renderFromCacheOrFallback();
  wireEvents();
  handleTiktokReturn();
  startTimers();
  refreshAll();
  loadTiktokCampaigns();
  loadTiktokBudgets();
  loadTiktokConnectionsForBcFilter();
});

// Loads the full connections/advertisers list once at startup purely so the
// Detailed Metrics Business Center selector lists every connected BC — not
// just ones with campaigns currently showing (the TikTok Ads / WH Warmup /
// Campaign Creator modals already load this same data themselves, on open;
// this just makes it available before any of them are ever opened). Shares
// tiktokState with those modals; harmless if it runs again after them.
async function loadTiktokConnectionsForBcFilter() {
  try {
    const data = await fetchTiktokConnections();
    tiktokState.connections = data.connections || [];
    tiktokState.advertisers = data.advertisers || [];
    renderDetailBcSelector();
  } catch (_) {
    /* non-fatal — the selector just stays however it last was */
  }
}

// Loads stored TikTok campaign rows (fast, from Supabase) and merges them into
// the Detailed Metrics table. Does not hit the TikTok API — that only happens
// on an explicit "Refresh TikTok Data". Runs on load and on the 60s cycle so
// status changes (Active / Rejected / Appeal Under Review / Appeal Rejected)
// that the server derives in the background surface without a manual reload.
let campaignsInFlight = false;
async function loadTiktokCampaigns() {
  if (campaignsInFlight) return;
  campaignsInFlight = true;
  try {
    const data = await fetchTiktokCampaigns();
    state.tiktokCampaigns = data.campaigns || [];
    renderDetailBcSelector();
    rebuildSources();
  } catch (_) {
    /* non-fatal — table still renders from Glitchy data */
  } finally {
    campaignsInFlight = false;
  }
}

// Advertiser-account budgets + BC balances. Hits the MCP — runs on load and
// inside the 60s refresh cycle (like loadTiktokMetrics), not just a manual
// refresh, so the Budget column stays current instead of needing a full page
// reload. Guarded so a slow request never overlaps the next tick.
let budgetsInFlight = false;
async function loadTiktokBudgets() {
  if (budgetsInFlight) return;
  budgetsInFlight = true;
  try {
    const data = await fetchTiktokBudgets();
    state.budgets = data.advertisers || {};
    state.bcBalances = data.bc || {};
    renderDetailBcSelector();
    rebuildSources();
  } catch (err) {
    // Non-fatal — the Budget column just keeps its last-known values — but
    // log it: this used to fail silently with no trace, which made a
    // permanently-blank Budget column impossible to diagnose from the console.
    console.error(`[budgets] refresh failed: ${err.message}`);
  } finally {
    budgetsInFlight = false;
  }
}

// Mabac affiliate report for today. Optional network — Glitchy keeps working
// regardless.
async function loadMabac() {
  try {
    const today = todayStr();
    const data = await fetchMabacStats(today, today);
    state.mabacConfigured = !!data.configured;
    state.mabacRows = data.sources || [];
    rebuildSources();
  } catch (_) {
    /* non-fatal */
  }
}

// Today's live TikTok campaign metrics (spend / CPM / CPA) for every tracked
// advertiser account. Hits the MCP — runs on load and inside the 60s refresh
// cycle. Guarded so a slow request never overlaps the next tick.
async function loadTiktokMetrics() {
  if (metricsInFlight) return;
  metricsInFlight = true;
  try {
    const data = await fetchTiktokMetrics();
    applyTiktokMetrics(data);
  } catch (_) {
    // Total failure (e.g. function 500 / offline) — keep every last-known value,
    // just flag them as stale. Never zero out real numbers on a failed refresh.
    state.campaignMetricsStale = true;
  } finally {
    metricsInFlight = false;
  }
}

// WH Warmup auto-cleanup — deletes warmup campaigns once they reach Active.
// Piggybacks the existing ~60s refresh. Fire-and-forget, fully server-side,
// guarded against overlap. Nothing it does touches the Detailed Metrics table.
async function runWhWarmupCleanup() {
  if (whCleanupInFlight) return;
  whCleanupInFlight = true;
  try {
    await cleanupWhWarmup();
  } catch (_) {
    /* non-fatal — next cycle retries */
  } finally {
    whCleanupInFlight = false;
  }
}

// Campaign Creator — auto-duplicate the initial ad group once Active. Piggybacks
// the ~60s refresh, guarded. No-op while campaign_creator_campaigns is empty
// (nothing registers campaigns until the Campaign Creator tool is built).
async function runCampaignCreatorDuplication() {
  if (ccDupeInFlight) return;
  ccDupeInFlight = true;
  try {
    await processCampaignCreatorDuplication();
  } catch (_) {
    /* non-fatal — next cycle retries */
  } finally {
    ccDupeInFlight = false;
  }
}

// Merge a metrics snapshot into state. For advertiser accounts that reported OK
// this round we REPLACE their campaigns' metrics (so a campaign that genuinely
// spent $0 today, or is gone, drops to 0 rather than keeping a stale value).
// For advertiser accounts missing from `okAdvertiserIds` (their report failed)
// we KEEP the previous values — a failed request must not look like real $0.
function applyTiktokMetrics(data) {
  if (!data || typeof data !== "object") return;
  const fresh = data.metrics || {};
  const okAdv = new Set((data.okAdvertiserIds || []).map(String));

  // NY day rolled over since our cached metrics belong to → do NOT carry any
  // stale value into the new day, not even for advertisers whose report failed.
  const dayChanged = !!(data.date && state.campaignMetricsDate && data.date !== state.campaignMetricsDate);

  const merged = {};
  if (!dayChanged) {
    for (const [cid, m] of Object.entries(state.campaignMetrics)) {
      if (!okAdv.has(String(m && m.advertiser_id))) merged[cid] = m; // stale, but its account didn't refresh
    }
  }
  for (const [cid, m] of Object.entries(fresh)) merged[cid] = m;

  state.campaignMetrics = merged;
  state.campaignMetricsDate = data.date || null;
  state.campaignMetricsStale = !!(data.errors && Object.keys(data.errors).length);
  // Live Performance Spend series only — keep the last snapshot if this cycle
  // didn't return one (e.g. the spend-snapshot table isn't migrated yet).
  if (data.spendToday) state.spendToday = data.spendToday;
  rebuildSources();
}

function updateDateDisplay() {
  const el = document.getElementById("dateDisplay");
  if (el) el.textContent = estDateLabel();
}

function renderFromCacheOrFallback() {
  const cache = loadCache();
  if (cache && cache.data && cache.data.sources && cache.data.sources.length) {
    applyGlitchyResponse(cache.data, { flagNewConversions: false });
    lastUpdatedAt = cache.savedAt || Date.now();
  } else {
    applyGlitchyResponse({ sources: fallbackSources() }, { flagNewConversions: false });
    lastUpdatedAt = Date.now();
  }
}

// ============================== EVENTS ==============================

function wireEvents() {
  document.getElementById("refreshBtn").addEventListener("click", () => refreshAll());

  // ---- Tools panel ----
  document.getElementById("toolsBtn").addEventListener("click", openToolsDrawer);
  document.getElementById("closeToolsBtn").addEventListener("click", closeToolsDrawer);
  document.getElementById("drawerBackdrop").addEventListener("click", closeToolsDrawer);

  document.getElementById("toolsThemesToggle").addEventListener("click", () => {
    document.getElementById("toolsThemesGroup").classList.toggle("open");
  });

  document.getElementById("toolsAccountsBtn").addEventListener("click", () => {
    openAccountsModal();
    renderTiktokAccounts();
  });
  document.getElementById("closeAccountsModal").addEventListener("click", closeAccountsModal);
  document.getElementById("accountsModal").addEventListener("click", (e) => {
    if (e.target.id === "accountsModal") closeAccountsModal();
  });
  wireTiktokEvents();
  wireWhWarmupEvents();
  wireWhWarmingUpEvents();
  wireCampaignCreatorEvents();
  wireDupeEvents();

  document.getElementById("toolsCalendarBtn").addEventListener("click", openCalendarModal);
  document.getElementById("closeCalendarModal").addEventListener("click", closeCalendarModal);
  document.getElementById("calendarModal").addEventListener("click", (e) => {
    if (e.target.id === "calendarModal") closeCalendarModal();
  });
  document.getElementById("calPrevMonth").addEventListener("click", () => shiftCalendarMonth(-1));
  document.getElementById("calNextMonth").addEventListener("click", () => shiftCalendarMonth(1));

  document.getElementById("toolsTrackerBtn").addEventListener("click", openTrackerModal);
  wireTrackerEvents();

  document.getElementById("detailBcSelect").addEventListener("change", (e) => {
    state.detailBcFilter = e.target.value;
    updateBcBalanceBanner();
    rebuildSources();
  });

  // ---- Advertiser budget modal ----
  document.getElementById("closeBudgetModal").addEventListener("click", closeBudgetModal);
  document.getElementById("cancelBudgetBtn").addEventListener("click", closeBudgetModal);
  document.getElementById("budgetModal").addEventListener("click", (e) => {
    if (e.target.id === "budgetModal") closeBudgetModal();
  });
  document.getElementById("budgetModeSelect").addEventListener("change", syncBudgetAmountVisibility);
  document.getElementById("confirmBudgetBtn").addEventListener("click", submitBudgetEdit);
  document.getElementById("setMinBudgetBtn").addEventListener("click", submitBudgetMinimum);

  // ---- ⋮ row menu: close on outside click / scroll / Escape ----
  document.addEventListener("click", (e) => {
    if (!openRowMenuFor) return;
    if (e.target.closest(".rowmenu") || e.target.closest("[data-row-menu]")) return;
    closeRowMenu();
  });
  window.addEventListener("scroll", () => closeRowMenu(), true);
  window.addEventListener("resize", () => closeRowMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRowMenu();
  });

  // ---- delete campaign modal ----
  document.getElementById("closeDeleteCampaignModal").addEventListener("click", closeDeleteCampaignModal);
  document.getElementById("cancelDeleteCampaignBtn").addEventListener("click", closeDeleteCampaignModal);
  document.getElementById("deleteCampaignModal").addEventListener("click", (e) => {
    if (e.target.id === "deleteCampaignModal") closeDeleteCampaignModal();
  });
  document.getElementById("confirmDeleteCampaignBtn").addEventListener("click", confirmDeleteCampaign);

  // ---- rejection reason modal ----
  document.getElementById("closeRejectionReasonModal").addEventListener("click", closeRejectionReasonModal);
  document.getElementById("closeRejectionReasonBtn2").addEventListener("click", closeRejectionReasonModal);
  document.getElementById("rejectionReasonModal").addEventListener("click", (e) => {
    if (e.target.id === "rejectionReasonModal") closeRejectionReasonModal();
  });

  // ---- engagement modal (Likes / Saves / Comments, each toggleable) ----
  document.getElementById("closeEngagementManualModal").addEventListener("click", closeEngagementManualModal);
  document.getElementById("cancelEngagementManualBtn").addEventListener("click", closeEngagementManualModal);
  document.getElementById("engagementManualModal").addEventListener("click", (e) => {
    if (e.target.id === "engagementManualModal") closeEngagementManualModal();
  });
  document.getElementById("submitEngagementManualBtn").addEventListener("click", submitEngagementManual);
  document.getElementById("engToggleLikes").addEventListener("click", () => toggleEngagementKind("likes"));
  document.getElementById("engToggleSaves").addEventListener("click", () => toggleEngagementKind("saves"));
  document.getElementById("engToggleComments").addEventListener("click", () => toggleEngagementKind("comments"));
  wireCommentTemplateEvents();

  document.getElementById("sourcesBody").addEventListener("click", (e) => {
    // Select checkbox — must NOT toggle the row (its own `change` listener
    // below handles the actual selection).
    if (e.target.closest("[data-select-campaign]")) {
      e.stopPropagation();
      return;
    }
    // Campaign pause/unpause button — must NOT toggle the row.
    const campBtn = e.target.closest("[data-campaign-action]");
    if (campBtn) {
      e.stopPropagation();
      handleCampaignAction(campBtn);
      return;
    }
    // Ad group pause/unpause button inside an expanded row.
    const agBtn = e.target.closest("[data-adgroup-action]");
    if (agBtn) {
      e.stopPropagation();
      handleAdgroupAction(agBtn);
      return;
    }
    // "Rejection reason" button inside an expanded row.
    const rrBtn = e.target.closest("[data-rejection-reason]");
    if (rrBtn) {
      e.stopPropagation();
      openRejectionReasonModal(rrBtn.dataset.rejectionReason);
      return;
    }
    const row = e.target.closest("tr.source-row");
    if (!row) return;
    toggleRowExpand(row.dataset.source);
  });
  document.getElementById("sourcesBody").addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-select-campaign]");
    if (!cb) return;
    const id = String(cb.dataset.selectCampaign);
    if (cb.checked) state.selectedCampaigns.add(id);
    else state.selectedCampaigns.delete(id);
    syncDetailActionsButton();
  });
  // Double-click any select checkbox: if every campaign is already selected,
  // deselect all; otherwise select all. So double-click -> select all, tweak
  // the selection by hand, double-click again -> back to select-all, double-
  // click once more -> deselect all. It only ever clears everything when
  // everything is already checked.
  document.getElementById("sourcesBody").addEventListener("dblclick", (e) => {
    if (!e.target.closest("[data-select-campaign]")) return;
    const allIds = state.sources.filter((s) => s.hasTiktok && s.campaignId).map((s) => String(s.campaignId));
    const allSelected = allIds.length > 0 && allIds.every((id) => state.selectedCampaigns.has(id));
    if (allSelected) state.selectedCampaigns.clear();
    else allIds.forEach((id) => state.selectedCampaigns.add(id));
    renderTable();
  });
  document.getElementById("detailBulkActionsBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDetailActionsMenu(e.currentTarget);
  });
}

function startTimers() {
  // "last updated Xs ago" ticker — also refreshes the (purely cosmetic) date
  // label so it keeps up if the dashboard is left open across EST midnight.
  setInterval(() => {
    const el = document.getElementById("lastUpdated");
    if (lastUpdatedAt) {
      const secs = Math.floor((Date.now() - lastUpdatedAt) / 1000);
      el.textContent = secs < 2 ? "updated just now" : secs < 60 ? `updated ${secs}s ago` : `updated ${Math.floor(secs / 60)}m ago`;
    }
    updateDateDisplay();
  }, 1000);

  // Auto-refresh real data periodically. This only re-fetches the running
  // session's totals — it never starts a new session.
  setInterval(() => refreshAll(), 60000);

  // Chrome (and other browsers) throttle setInterval in a BACKGROUND tab —
  // after a while it can fire far less often than every 60s, so data looks
  // stale until the next tick finally lands. Force an immediate refresh the
  // moment the tab becomes visible again, so switching back always shows the
  // freshest data Chigla Ads can get right then, instead of waiting on a
  // throttled timer to catch up. Guarded so a rapid re-focus (e.g. alt-tabbing
  // back and forth) can't fire back-to-back refreshes.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (lastUpdatedAt && Date.now() - lastUpdatedAt < 5000) return;
    refreshAll();
  });
}

// ============================== DATA FETCH ==============================

// One refresh cycle: Glitchy (primary affiliate) + Mabac (optional affiliate) +
// live TikTok campaign metrics. Runs on load and every 60s. Guarded so that if a
// cycle is still running when the interval fires, the new one is skipped rather
// than stacked.
async function refreshAll() {
  if (refreshInFlight) return;
  refreshInFlight = true;

  const refreshBtn = document.getElementById("refreshBtn");
  refreshBtn.classList.add("spinning");
  try {
    const today = todayStr();

    // Glitchy is the primary affiliate source and must not be blocked by Mabac
    // or TikTok. Fetch it first; the other two run alongside and never throw
    // out of here (each keeps its own last-known data on failure).
    let glitchyErr = null;
    const [g] = await Promise.allSettled([fetchGlitchyStats(today, today)]);
    if (g.status === "fulfilled") {
      applyGlitchyResponse(g.value, { flagNewConversions: state.hasFetchedOnce });
      state.hasFetchedOnce = true;
      lastUpdatedAt = Date.now();
    } else {
      glitchyErr = g.reason;
    }

    await Promise.allSettled([
      loadMabac(),
      loadTiktokMetrics(),
      loadTiktokCampaigns(),
      loadTiktokBudgets(),
      runWhWarmupCleanup(),
      runCampaignCreatorDuplication(),
    ]);

    if (glitchyErr) {
      setStatus(`Couldn't reach Glitchy: ${glitchyErr.message} — showing last known data.`, true);
    } else if (state.campaignMetricsStale) {
      setStatus("Some TikTok campaign metrics couldn't be refreshed — showing last known values for those.");
    } else {
      setStatus(null);
    }
  } finally {
    refreshBtn.classList.remove("spinning");
    refreshInFlight = false;
  }
}

function setStatus(msg, isError) {
  const el = document.getElementById("statusMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("error", !!isError);
}

function applyGlitchyResponse(data, { flagNewConversions }) {
  const sources = data.sources || [];

  const newConversionSources = new Set();
  if (flagNewConversions) {
    for (const s of sources) {
      const prev = state.prevConversions.get(s.source);
      if (prev !== undefined && s.conversions > prev) newConversionSources.add(s.source);
    }
  }
  state.prevConversions = new Map(sources.map((s) => [s.source, s.conversions]));

  state.glitchyRows = sources;
  // Live Performance Earnings series only — keep the last snapshot if this
  // cycle didn't return one (e.g. the snapshot table isn't migrated yet).
  if (data.earningsToday) state.earningsToday = data.earningsToday;

  rebuildSources({ newConversionSources });
}

// Builds the Detailed Metrics table rows.
//
// Affiliate-network ownership (deterministic, never double-counts):
//   - A row backed by a tracked TikTok campaign uses THAT campaign's
//     affiliate_network (from its connection). Its clicks/earning come only
//     from that one network's data by name.
//   - An affiliate row with no TikTok campaign: GLITCHY if it's a Glitchy
//     source, MABAC if it's only in Mabac. Shown only in the "All Business
//     Centers" view.
// Glitchy earnings + Mabac earnings for the same name are NEVER summed.
//
// The Business Center selector (state.detailBcFilter) is a VIEW filter only —
// it never changes tracked selections.
function rebuildSources(opts = {}) {
  const glitchyByName = new Map(state.glitchyRows.map((s) => [s.source, s]));
  const mabacByName = new Map(state.mabacRows.map((s) => [s.sub1, s]));

  const bcFilter = state.detailBcFilter || "all";
  const tiktokByName = new Map();
  for (const c of state.tiktokCampaigns) {
    if (!c || !c.campaign_name) continue;
    if (c.is_wh_warmup) continue; // WH Warmup campaigns never belong in Detailed Metrics — no matter their status
    if (c.is_stray) continue; // stray (unwatched) campaigns show in the WHs Warming Up panel instead
    if (bcFilter !== "all" && String(c.bc_id || "") !== String(bcFilter)) continue;
    tiktokByName.set(c.campaign_name, c);
  }

  const names = new Set(tiktokByName.keys());
  if (bcFilter === "all") {
    for (const k of glitchyByName.keys()) names.add(k);
    for (const k of mabacByName.keys()) names.add(k);
  }

  const merged = [...names].map((name) => {
    const tk = tiktokByName.get(name);
    const g = glitchyByName.get(name);
    const m = mabacByName.get(name);

    // Which network owns this row's affiliate figures?
    let network;
    if (tk) network = String(tk.affiliate_network || "GLITCHY").toUpperCase();
    else if (m && !g) network = "MABAC";
    else network = "GLITCHY";

    // Affiliate-network figures (clicks / earnings) — from the ONE owning
    // network only, joined by name (Glitchy source == Mabac sub1 == campaign).
    const aff = network === "MABAC" ? m : g;
    const clicks = toNum(network === "MABAC" ? aff?.clicks : aff?.clicks);
    const conversions = toNum(network === "MABAC" ? aff?.conversions : aff?.conversions);
    const payout = toNum(network === "MABAC" ? aff?.revenue : aff?.payout);

    // TikTok-side campaign metrics for TODAY (NY date), matched by campaign_id —
    // NOT by name. Absent => genuinely no TikTok data for this campaign yet
    // (either untracked, or a tracked campaign with zero delivery so far), which
    // correctly reads as 0. state.campaignMetrics keeps last-known values when a
    // report request fails (see applyTiktokMetrics).
    const mx = tk && tk.campaign_id ? state.campaignMetrics[String(tk.campaign_id)] : null;
    const spend = mx ? toNum(mx.spend) : 0;
    const cpm = mx ? toNum(mx.cpm) : 0;
    const cpa = mx ? toNum(mx.cpa) : 0;
    const impressions = mx ? toNum(mx.impressions) : 0;

    // Derived — every division guarded (0 when the denominator is 0 / missing).
    const roas = ratio(payout, spend); // affiliate earnings ÷ TikTok spend
    const cpnc = ratio(spend, clicks); // TikTok spend ÷ affiliate clicks
    const epc = ratio(payout, clicks); // affiliate earnings ÷ affiliate clicks
    const profit = payout - spend;

    const budget = tk && tk.advertiser_id ? state.budgets[String(tk.advertiser_id)] || null : null;

    return {
      source: name,
      offer_name: g?.offer_name || null,
      network,
      clicks,
      conversions,
      payout,
      spend,
      cpm,
      cpa,
      impressions,
      cpnc,
      epc,
      roas,
      profit,
      status: tk
        ? { label: tk.effective_status || "Unknown", tone: tk.effective_tone || "neutral", detail: tk.status_detail || null }
        : null,
      hasTiktok: !!tk,
      hasGlitchy: !!g,
      hasMabac: !!m,
      campaignId: tk ? String(tk.campaign_id) : null,
      campaignOpStatus: tk ? tk.campaign_operation_status || null : null, // ENABLE / DISABLE
      advertiserId: tk ? String(tk.advertiser_id || "") : null,
      advertiserName: tk ? tk.advertiser_name || null : null,
      bcId: tk ? tk.bc_id || null : null,
      budget,
      tiktokPostUrl: tk ? tk.tiktok_post_url || null : null,
      engagementStatus: tk ? tk.engagement_status || "PENDING" : null,
    };
  });

  state.sources = merged;
  state.baseSpendTotal = merged.reduce((a, s) => a + s.spend, 0);
  state.baseEarningsTotal = merged.reduce((a, s) => a + s.payout, 0);

  renderKpis();
  renderTable(opts.newConversionSources);
  renderChart();
}

// ============================== KPI ROW ==============================

function renderKpis() {
  // Totals over the currently displayed rows (respects the Business Center view
  // filter, same as the table). Overall ROAS is total ÷ total — NEVER an average
  // of the per-row ROAS values.
  const totalSpend = toNum(state.baseSpendTotal);
  const totalEarnings = toNum(state.baseEarningsTotal);
  const netProfit = totalEarnings - totalSpend;
  const roas = ratio(totalEarnings, totalSpend);

  setKpi("kpiSpend", money(totalSpend));
  setKpi("kpiEarnings", money(totalEarnings));
  setKpi("kpiProfit", (netProfit >= 0 ? "+" : "-") + money(Math.abs(netProfit)), netProfit >= 0 ? "positive" : "negative");
  setKpi("kpiRoas", `${roas.toFixed(2)}x`);
}

function setKpi(id, text, sentiment) {
  const el = document.getElementById(id);
  if (!el) return;
  // Only flash when the displayed value actually changed since the last
  // render — this used to flash on EVERY ~60s refresh regardless (Net
  // Profit's sentiment is always "positive" or "negative", never neither),
  // which was a real, recurring "blink" at the top of the page even when
  // nothing had changed. `undefined` (first render) never flashes either.
  const prevText = state.kpiPrevText[id];
  const changed = prevText !== undefined && prevText !== text;
  state.kpiPrevText[id] = text;

  const flashClass = sentiment === "positive" ? "kpi-flash-up" : sentiment === "negative" ? "kpi-flash-down" : null;
  el.textContent = text;
  el.classList.remove("positive", "negative");
  if (sentiment) el.classList.add(sentiment);
  const card = el.closest(".kpi-card");
  if (changed && flashClass && card) {
    card.classList.remove("kpi-flash-up", "kpi-flash-down");
    void card.offsetWidth; // restart animation
    card.classList.add(flashClass);
  }
}

// ============================== TABLE ==============================

function renderTable(newConversionSources) {
  const tbody = document.getElementById("sourcesBody");
  closeRowMenu(); // any re-render invalidates the floating menu's anchor

  // Drop selections for campaigns that no longer exist in this render (e.g.
  // deleted, or filtered out by the BC view).
  const liveIds = new Set(state.sources.filter((s) => s.campaignId).map((s) => String(s.campaignId)));
  for (const id of [...state.selectedCampaigns]) if (!liveIds.has(id)) state.selectedCampaigns.delete(id);

  // Winners first: highest ROAS, then (tie-break) highest spend. Re-sorted on
  // every rebuild so the table re-orders itself as fresh metrics land.
  const sorted = [...state.sources].sort((a, b) => b.roas - a.roas || b.spend - a.spend);
  // Crown the single best-ROAS row — but only once at least one row has a real
  // (> 0) ROAS, so rows with no TikTok spend yet don't get an arbitrary crown.
  const bestRoas = sorted.reduce((best, s) => (s.roas > (best?.roas ?? 0) ? s : best), null);

  // Reuse existing <tr> elements (keyed by source name) instead of tearing
  // down and rebuilding the whole tbody on every refresh. Destroying every
  // row on the ~60s auto-refresh was what actually caused the visible
  // "blink" and the page nudging up/down: it restarted every row's CSS
  // animation (the 3x+ ROAS glow) all at once, and reordering from live ROAS
  // changes moved a freshly-recreated element instead of just relocating the
  // one already there. Same content, same node — nothing for the browser to
  // flash, and no layout thrash from wiping ~30+ rows at once.
  const existingRows = new Map();
  for (const child of tbody.children) {
    if (child.classList.contains("source-row")) existingRows.set(child.dataset.source, child);
  }

  let anchor = null; // insert/keep each row+detail pair immediately after this node
  sorted.forEach((s) => {
    let tr = existingRows.get(s.source);
    let detailTr;
    if (tr) {
      existingRows.delete(s.source);
      detailTr = tr.nextElementSibling;
    } else {
      tr = document.createElement("tr");
      tr.dataset.source = s.source;
      detailTr = document.createElement("tr");
      detailTr.className = "row-detail";
    }

    tr.className = "source-row " + (s.profit >= 0 ? "profit-positive" : "profit-negative");
    // Premium winner highlight: golden border at 2x+, add an animated glow at 3x+.
    if (s.roas >= 3) tr.classList.add("roas-gold", "roas-fire");
    else if (s.roas >= 2) tr.classList.add("roas-gold");

    const crown = bestRoas && s === bestRoas ? `<span class="crown" title="Best ROAS today">👑</span>` : "";

    tr.innerHTML = `
      <td class="select-cell">${selectCell(s)}</td>
      <td class="toggle-cell">${campaignToggle(s)}</td>
      <td>${statusBadge(s.status)}</td>
      <td class="source-name"><span class="expand-caret">▸</span>${crown}${escapeHtml(s.source)}</td>
      <td class="num">${money(s.spend)}</td>
      <td class="num">${money(s.cpm)}</td>
      <td class="num">${money(s.cpa)}</td>
      <td class="num">${money(s.cpnc)}</td>
      <td class="num">${num(s.clicks)}</td>
      <td class="num">${money(s.payout)}</td>
      <td class="num">${money(s.epc)}</td>
      <td class="num roas-cell" style="color:${roasColor(s.roas)}">${s.roas.toFixed(2)}x</td>
      <td class="budget-cell">${budgetCell(s)}</td>
    `;

    if (newConversionSources && newConversionSources.has(s.source)) {
      // Force the glow to restart even if this row (rare, but possible across
      // two conversions in quick succession) still had it from last time.
      tr.classList.remove("new-conversion");
      void tr.offsetWidth;
      tr.classList.add("new-conversion");
      setTimeout(() => tr.classList.remove("new-conversion"), 2500);
    }

    detailTr.innerHTML = `<td colspan="13"><div class="row-detail-inner"><div class="adgroups-panel" data-adgroups-for="${escapeHtml(s.campaignId || "")}"></div></div></td>`;

    if (state.expandedSources.has(s.source)) {
      tr.classList.add("expanded");
      requestAnimationFrame(() => renderAdGroupsPanel(s));
    }

    // Position this pair right after `anchor` — a no-op (no DOM move at all)
    // when it's already there, which is the common case on a routine refresh.
    const afterAnchor = anchor ? anchor.nextElementSibling : tbody.firstElementChild;
    if (afterAnchor !== tr) tbody.insertBefore(tr, afterAnchor);
    if (tr.nextElementSibling !== detailTr) tbody.insertBefore(detailTr, tr.nextElementSibling);
    anchor = detailTr;
  });

  // Anything left is a source no longer in state.sources (deleted, or
  // filtered out by the current Business Center view) — remove its pair.
  for (const tr of existingRows.values()) {
    const detailTr = tr.nextElementSibling;
    tr.remove();
    if (detailTr && detailTr.classList.contains("row-detail")) detailTr.remove();
  }

  syncDetailActionsButton();
}

// Greys out the header ⋮ campaign-actions button whenever nothing is
// selected — clicking it then does nothing (native disabled behavior), which
// is a much clearer signal than the click silently falling through to a
// status-bar message that's easy to miss.
function syncDetailActionsButton() {
  const btn = document.getElementById("detailBulkActionsBtn");
  if (!btn) return;
  const n = state.selectedCampaigns.size;
  btn.disabled = n === 0;
  btn.title = n > 0 ? `Campaign actions (${n} selected)` : "Select a campaign first";
}

// Compact ON/OFF switch for the campaign row. ON = campaign ENABLE, OFF =
// DISABLE. Only for rows backed by a tracked TikTok campaign. Clicking toggles
// the campaign via the same MCP action; it never expands the row.
function campaignToggle(s) {
  if (!s.hasTiktok || !s.campaignId) return "";
  const on = String(s.campaignOpStatus || "").toUpperCase() === "ENABLE";
  const pending = state.pendingActions.has(`c:${s.campaignId}`);
  return switchHtml({
    on,
    pending,
    attrs: `data-campaign-action="${on ? "DISABLE" : "ENABLE"}" data-campaign-id="${escapeHtml(s.campaignId)}"`,
    title: on ? "Campaign running — click to pause" : "Campaign paused — click to enable",
  });
}

// Shared toggle-switch markup (campaign rows + ad-group rows).
function switchHtml({ on, pending, attrs, title }) {
  return `<button type="button" role="switch" aria-checked="${on ? "true" : "false"}" title="${escapeHtml(title || "")}" class="tk-switch${on ? " on" : ""}${pending ? " busy" : ""}" ${pending ? "disabled" : ""} ${attrs}></button>`;
}

// ADVERTISER-ACCOUNT budget/spend-cap (NOT campaign CBO budget). Keyed by
// advertiser_id — one advertiser account can own several campaign rows.
function budgetCell(s) {
  if (!s.hasTiktok || !s.advertiserId) return "";
  const b = s.budget;
  const pending = state.pendingActions.has(`b:${s.advertiserId}`);
  if (!b) {
    return `<span class="bud-none" title="Budget info not loaded for this account">—</span>`;
  }
  if (b.capped) {
    // remaining >= $3 green · >$1 and <$3 yellow · <=$1 red
    const rem = toNum(b.remaining);
    const leftTone = rem >= 3 ? "ok" : rem > 1 ? "warn" : "bad";
    return `
      <div class="bud${pending ? " busy" : ""}" title="Spent ${money(b.spent)} of ${money(b.cap)}">
        <span class="bud-left ${leftTone}">${money(b.remaining)} left</span>
        <span class="bud-sub">of ${money(b.cap)} cap</span>
      </div>`;
  }
  return `
    <div class="bud${pending ? " busy" : ""}" title="No spend cap on this ad account">
      <span class="bud-left muted">Uncapped</span>
      <span class="bud-sub">bal ${money(b.account_balance)}</span>
    </div>`;
}

// Selector checkbox — the table's leftmost column. Only for rows backed by a
// tracked TikTok campaign (the bulk actions all need a campaign_id).
function selectCell(s) {
  if (!s.hasTiktok || !s.campaignId) return "";
  const checked = state.selectedCampaigns.has(String(s.campaignId));
  return `<input type="checkbox" class="row-select" data-select-campaign="${escapeHtml(s.campaignId)}" ${checked ? "checked" : ""} title="Select" />`;
}

// ---- campaign actions menu — top-right of Detailed Metrics, next to Dupe.
// Acts on whatever's currently checked in the Select column (one or many),
// replacing the old per-row ⋮ button. Shares the same floating-menu plumbing
// (openRowMenuFor / rowMenuEl / closeRowMenu) as the WH Warmup panel's menu —
// keyed "bulk" so it can't collide with a campaign_id or "wh:<id>" key. ----

function closeRowMenu() {
  openRowMenuFor = null;
  if (rowMenuEl) {
    rowMenuEl.remove();
    rowMenuEl = null;
  }
  document.querySelectorAll(".rowmenu-btn.active, .icon-btn.active").forEach((b) => b.classList.remove("active"));
}

function toggleDetailActionsMenu(btn) {
  if (openRowMenuFor === "bulk") {
    closeRowMenu();
    return;
  }
  const ids = [...state.selectedCampaigns];
  if (!ids.length) {
    setStatus("Select at least one campaign first.", true);
    return;
  }
  closeRowMenu();
  const selected = state.sources.filter((s) => s.campaignId && ids.includes(String(s.campaignId)));
  if (!selected.length) return;

  openRowMenuFor = "bulk";
  btn.classList.add("active");

  // Engagement runs the same call as a batch across every selected campaign's
  // own tiktok_post_url (the modal handles the 1-vs-many UI difference
  // itself) — same as Edit budget and Delete. Comments live inside the
  // Engagement modal now (a toggleable kind alongside Likes/Saves), not as a
  // separate menu entry. (WH Warmup campaigns never reach this list at all —
  // they're excluded from Detailed Metrics entirely — so there's no
  // engagement exclusion to account for here anymore.)
  const menu = document.createElement("div");
  menu.className = "rowmenu";
  menu.innerHTML = `
    <button type="button" class="rowmenu-item" data-menu-action="edit-budget">Edit budget${selected.length > 1 ? ` (${selected.length})` : ""}</button>
    <button type="button" class="rowmenu-item" data-menu-action="engagement">Engagement${selected.length > 1 ? ` (${selected.length})` : ""}</button>
    <button type="button" class="rowmenu-item danger" data-menu-action="delete-campaign">Delete campaign${selected.length > 1 ? `s (${selected.length})` : ""}</button>`;
  document.body.appendChild(menu);
  rowMenuEl = menu;

  const r = btn.getBoundingClientRect();
  let left = r.right + window.scrollX - menu.offsetWidth;
  if (left < 8) left = 8;
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.left = `${left}px`;

  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-menu-action]");
    if (!item || item.disabled) return;
    const act = item.dataset.menuAction;
    closeRowMenu();
    if (act === "edit-budget") {
      const advIds = [...new Set(selected.map((s) => s.advertiserId).filter(Boolean))];
      if (advIds.length) openBudgetModal(advIds);
      else setStatus("No ad-account budget is available for the selected campaign(s).", true);
    } else if (act === "engagement") {
      openEngagementManualModal(selected);
    } else if (act === "delete-campaign") {
      openDeleteCampaignModal(selected);
    }
  });
}

// ---- delete campaign(s) (always confirmed first) ----

function openDeleteCampaignModal(sources) {
  deleteCampaignTargets = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  if (!deleteCampaignTargets.length) return;
  document.getElementById("deleteCampaignName").textContent =
    deleteCampaignTargets.length === 1 ? deleteCampaignTargets[0].source : `${deleteCampaignTargets.length} campaigns`;
  document.getElementById("deleteCampaignError").textContent = "";
  const btn = document.getElementById("confirmDeleteCampaignBtn");
  btn.disabled = false;
  btn.textContent = deleteCampaignTargets.length > 1 ? `Delete ${deleteCampaignTargets.length} Campaigns` : "Delete Campaign";
  document.getElementById("deleteCampaignModal").classList.add("open");
}

function closeDeleteCampaignModal() {
  document.getElementById("deleteCampaignModal").classList.remove("open");
  deleteCampaignTargets = [];
}

async function confirmDeleteCampaign() {
  if (!deleteCampaignTargets.length) return;
  const targets = deleteCampaignTargets;
  const btn = document.getElementById("confirmDeleteCampaignBtn");
  const errEl = document.getElementById("deleteCampaignError");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = targets.length > 1 ? `Deleting ${targets.length}…` : "Deleting…";

  const failed = [];
  let lastRes = null;
  for (const s of targets) {
    try {
      const res = await deleteTiktokCampaign(s.campaignId);
      lastRes = res;
      // Remove locally right away — whether TikTok deleted it or we hid it, it
      // should leave the table now. A background reload confirms.
      state.tiktokCampaigns = state.tiktokCampaigns.filter((c) => String(c.campaign_id) !== String(s.campaignId));
      delete state.adGroupsByCampaign[s.campaignId];
      delete state.campaignMetrics[String(s.campaignId)];
      state.expandedSources.delete(s.source);
      state.selectedCampaigns.delete(String(s.campaignId));
    } catch (err) {
      failed.push(`${s.source}: ${err.message}`);
    }
  }
  renderDetailBcSelector();
  rebuildSources();

  if (failed.length) {
    btn.disabled = false;
    btn.textContent = targets.length > 1 ? `Delete ${targets.length} Campaigns` : "Delete Campaign";
    errEl.textContent = `${failed.length} failed — ${failed.join("; ")}`;
    return;
  }

  closeDeleteCampaignModal();
  setStatus(
    targets.length > 1
      ? `${targets.length} campaigns deleted.`
      : lastRes?.message || (lastRes?.outcome === "hidden" ? "Campaign hidden from Chigla Ads." : "Campaign deleted from TikTok."),
    false
  );
  loadTiktokCampaigns();
}

// ---- engagement: comments (a toggleable kind inside the Engagement modal) ----
// Stages a comment batch server-side against each selected campaign's OWN
// stored tiktok_post_url, and sends it to the configured comments provider
// (DripFeedPanel) via the given Service ID — see _shared/engagement-provider.js.
// One selected campaign shows the full single-campaign UI (editable URL, this
// campaign's own auto-order history); more than one runs the same
// template/service id as a batch against each campaign's own URL.

// Global reusable comment templates (Supabase `comment_templates`). Never
// touched by any cleanup. Selecting one loads its comments into the textarea;
// the textarea stays freely editable for this one order.
const ecState = { templates: [], selectedId: null, confirmDeleteId: null, editId: null };

// THE shared comment-counting rule: one comment per non-empty trimmed line.
// Accepts a raw textarea string OR an array (stored template.comments). Blank
// and whitespace-only lines never count. Used by the live counter, the template
// list count, Save validation, and the selected-template comments sent to the
// order — so every surface agrees on the number.
function commentLines(input) {
  const lines = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  return lines.map((l) => String(l).trim()).filter(Boolean);
}
function commentCountLabel(input) {
  const n = commentLines(input).length;
  return `${n} comment${n === 1 ? "" : "s"}`;
}

function wireCommentTemplateEvents() {
  document.getElementById("ecTplAddBtn").addEventListener("click", () => openTemplateForm(null));
  document.getElementById("ecTplCancelBtn").addEventListener("click", () => showEcView("main"));
  document.getElementById("ecTplSaveBtn").addEventListener("click", saveTemplateForm);

  const cInput = document.getElementById("ecTplCommentsInput");
  cInput.addEventListener("input", updateTemplateCommentCount);

  document.getElementById("ecTplList").addEventListener("click", (e) => {
    const sel = e.target.closest("[data-tpl-select]");
    if (sel) return selectTemplate(sel.dataset.tplSelect);
    const edit = e.target.closest("[data-tpl-edit]");
    if (edit) return openTemplateForm(edit.dataset.tplEdit);
    const del = e.target.closest("[data-tpl-del]");
    if (del) {
      ecState.confirmDeleteId = del.dataset.tplDel;
      renderTemplateList();
      return;
    }
    if (e.target.closest("[data-tpl-del-cancel]")) {
      ecState.confirmDeleteId = null;
      renderTemplateList();
      return;
    }
    const confirmDel = e.target.closest("[data-tpl-del-confirm]");
    if (confirmDel) confirmTemplateDelete(confirmDel.dataset.tplDelConfirm);
  });
}

function updateTemplateCommentCount() {
  const el = document.getElementById("ecTplCommentsCount");
  if (el) el.textContent = commentCountLabel(document.getElementById("ecTplCommentsInput").value);
}

function showEcView(which) {
  document.getElementById("engManualMain").hidden = which !== "main";
  document.getElementById("ecTemplateForm").hidden = which !== "form";
  document.getElementById("engagementManualTitle").textContent =
    which === "form" ? (ecState.editId ? "Edit template" : "New template") : "Engagement";
}

async function loadCommentTemplates() {
  const listEl = document.getElementById("ecTplList");
  try {
    const data = await listCommentTemplates();
    ecState.templates = (data.templates || []).map((t) => ({
      ...t,
      comments: Array.isArray(t.comments) ? t.comments : [],
    }));
  } catch (_) {
    ecState.templates = [];
  }
  renderTemplateList();
  void listEl;
}

function renderTemplateList() {
  const el = document.getElementById("ecTplList");
  if (!ecState.templates.length) {
    el.innerHTML = `<div class="ec-tpl-empty">No templates yet — click + to create one.</div>`;
    return;
  }
  el.innerHTML = ecState.templates
    .map((t) => {
      const selected = String(ecState.selectedId) === String(t.id);
      const right =
        String(ecState.confirmDeleteId) === String(t.id)
          ? `<div class="ec-tpl-confirm">Can't be undone.
               <button type="button" data-tpl-del-confirm="${escapeHtml(t.id)}">Confirm</button>
               <button type="button" data-tpl-del-cancel title="Cancel">✕</button>
             </div>`
          : `<div class="ec-tpl-actions">
               <button type="button" data-tpl-edit="${escapeHtml(t.id)}" title="Edit">✎</button>
               <button type="button" data-tpl-del="${escapeHtml(t.id)}" title="Delete">🗑</button>
             </div>`;
      const label = `${t.name} — ${commentCountLabel(t.comments)}`;
      return `<div class="ec-tpl-row${selected ? " selected" : ""}" data-tpl-id="${escapeHtml(t.id)}">
        <button type="button" class="ec-tpl-name" data-tpl-select="${escapeHtml(t.id)}">${escapeHtml(label)}</button>
        ${right}
      </div>`;
    })
    .join("");
}

function selectTemplate(id) {
  const t = ecState.templates.find((x) => String(x.id) === String(id));
  if (!t) return;
  ecState.selectedId = String(id);
  ecState.confirmDeleteId = null;
  document.getElementById("engagementManualError").textContent = "";
  renderTemplateList();
}

function selectedTemplateComments() {
  const t = ecState.templates.find((x) => String(x.id) === String(ecState.selectedId));
  return t ? commentLines(t.comments) : [];
}

function openTemplateForm(id) {
  ecState.editId = id ? String(id) : null;
  const t = id ? ecState.templates.find((x) => String(x.id) === String(id)) : null;
  document.getElementById("ecTplFormTitle").textContent = id ? "Edit template" : "New template";
  document.getElementById("ecTplNameInput").value = t ? t.name : "";
  document.getElementById("ecTplCommentsInput").value = t ? commentLines(t.comments).join("\n") : "";
  document.getElementById("ecTplFormError").textContent = "";
  updateTemplateCommentCount();
  const btn = document.getElementById("ecTplSaveBtn");
  btn.disabled = false;
  btn.textContent = "Save";
  showEcView("form");
  document.getElementById("ecTplNameInput").focus();
}

async function saveTemplateForm() {
  const name = document.getElementById("ecTplNameInput").value.trim();
  const comments = commentLines(document.getElementById("ecTplCommentsInput").value);
  const errEl = document.getElementById("ecTplFormError");
  errEl.textContent = "";
  if (!name) return (errEl.textContent = "Enter a template name.");
  if (!comments.length) return (errEl.textContent = "Enter at least one comment (one per line).");

  const btn = document.getElementById("ecTplSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const res = ecState.editId
      ? await updateCommentTemplate(ecState.editId, name, comments)
      : await createCommentTemplate(name, comments);
    const saved = { ...res.template, comments: Array.isArray(res.template.comments) ? res.template.comments : comments };
    if (ecState.editId) {
      const i = ecState.templates.findIndex((x) => String(x.id) === String(ecState.editId));
      if (i >= 0) ecState.templates[i] = saved;
    } else {
      ecState.templates.push(saved);
    }
    ecState.templates.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    // A just-created / just-edited template becomes the selected one.
    ecState.selectedId = String(saved.id);
    renderTemplateList();
    showEcView("main");
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

async function confirmTemplateDelete(id) {
  try {
    await deleteCommentTemplate(id);
  } catch (err) {
    setStatus(`Couldn't delete template: ${err.message}`, true);
    return;
  }
  ecState.templates = ecState.templates.filter((x) => String(x.id) !== String(id));
  if (String(ecState.selectedId) === String(id)) ecState.selectedId = null;
  ecState.confirmDeleteId = null;
  renderTemplateList();
}

const DEFAULT_SERVICE_ID = "5824";
function loadServiceId() {
  try {
    return localStorage.getItem(ENGAGEMENT_SERVICE_ID_KEY) || DEFAULT_SERVICE_ID;
  } catch (_) {
    return DEFAULT_SERVICE_ID;
  }
}
function saveServiceId(v) {
  try {
    if (v) localStorage.setItem(ENGAGEMENT_SERVICE_ID_KEY, v);
  } catch (_) {}
}

// ---- Engagement modal: Likes / Saves / Comments, each independently
// toggleable (on by default) ----
// Fires the same panels the ~60s auto-trigger uses (see
// _shared/engagement-provider.js) on demand, for campaigns it missed or
// hasn't reached yet, or to explicitly re-send one kind. Likes/Saves defaults
// pre-fill from the provider's own configured quantity so "Add" with no
// edits matches what auto-engagement would place; Comments keeps its
// existing template picker exactly as it worked as a standalone modal.
let engagementManualDefaults = null; // cached { likes: {quantity,configured}, saves: {...} } for this session

function syncEngagementToggleUI() {
  const ids = { likes: "engToggleLikes", saves: "engToggleSaves", comments: "engToggleComments" };
  for (const [kind, id] of Object.entries(ids)) {
    const btn = document.getElementById(id);
    const on = engagementToggles[kind];
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }
  document.getElementById("engagementManualLikes").classList.toggle("eng-kind-off", !engagementToggles.likes);
  document.getElementById("engagementManualSaves").classList.toggle("eng-kind-off", !engagementToggles.saves);
  document.getElementById("engCommentsSection").classList.toggle("eng-kind-off", !engagementToggles.comments);
}
function toggleEngagementKind(kind) {
  engagementToggles[kind] = !engagementToggles[kind];
  syncEngagementToggleUI();
}

// One campaign: the TikTok Post URL is prefilled from the campaign's stored
// tiktok_post_url (Campaign Creation Automation will usually have set it) but
// stays editable — editing it here saves back to tiktok_post_url before
// staging (required only when Comments is on; Likes/Saves-only fall back to
// each campaign's already-stored URL, same as before this modal merged
// comments in). Many campaigns: the URL field is hidden (each uses its own
// stored URL; any missing one is called out and skipped) and the same
// template/Service ID is queued against every one of them in a single batch.
function openEngagementManualModal(sources) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter((s) => s && s.campaignId);
  if (!list.length) return;
  engagementManualTargets = list;
  const single = list.length === 1;

  engagementToggles.likes = true;
  engagementToggles.saves = true;
  engagementToggles.comments = true;
  syncEngagementToggleUI();

  ecState.selectedId = null;
  ecState.confirmDeleteId = null;
  ecState.editId = null;
  showEcView("main");

  document.getElementById("engagementManualCampaignName").textContent = single ? list[0].source : `${list.length} campaigns selected`;
  document.getElementById("ecUrlField").hidden = !single;
  document.getElementById("engagementCommentsUrl").value = single ? list[0].tiktokPostUrl || "" : "";
  document.getElementById("engagementServiceIdInput").value = loadServiceId();
  document.getElementById("engagementManualError").textContent = "";

  const resultEl = document.getElementById("engagementManualResult");
  resultEl.className = "eng-placeholder";
  const missing = list.filter((s) => !String(s.tiktokPostUrl || "").trim());
  if (!single && missing.length) {
    resultEl.className = "eng-placeholder warn";
    resultEl.textContent = `${missing.length} of ${list.length} selected campaign(s) have no TikTok post URL yet and will be skipped: ${missing.map((s) => s.source).join(", ")}`;
  } else {
    resultEl.textContent = "";
  }

  const btn = document.getElementById("submitEngagementManualBtn");
  btn.disabled = false;
  btn.textContent = "Add";

  const likesInput = document.getElementById("engagementManualLikes");
  const savesInput = document.getElementById("engagementManualSaves");
  const fillDefaults = (d) => {
    likesInput.value = d?.likes?.quantity || "";
    savesInput.value = d?.saves?.quantity || "";
  };
  if (engagementManualDefaults) {
    fillDefaults(engagementManualDefaults);
  } else {
    likesInput.value = "";
    savesInput.value = "";
    fetchEngagementDefaults()
      .then((d) => {
        engagementManualDefaults = d;
        if (document.getElementById("engagementManualModal").classList.contains("open")) fillDefaults(d);
      })
      .catch(() => {});
  }

  document.getElementById("engagementManualModal").classList.add("open");

  document.getElementById("ecTplList").innerHTML = `<div class="ec-tpl-empty">Loading templates…</div>`;
  loadCommentTemplates();
  const autoEl = document.getElementById("ecAutoOrders");
  autoEl.hidden = true;
  autoEl.innerHTML = "";
  if (single) loadEngagementOrders(String(list[0].campaignId));
}

// Shows what the Active-trigger auto-placed for this campaign (likes / saves)
// and any prior comment batch — including the provider's own failure reason
// (`note`), so a stuck/failed order is diagnosable right here instead of
// needing a database lookup. Read-only. Single-campaign view only.
async function loadEngagementOrders(campaignId) {
  const el = document.getElementById("ecAutoOrders");
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
  let orders = [];
  try {
    const data = await fetchEngagementOrders(campaignId);
    orders = data.orders || [];
  } catch (_) {
    return;
  }
  if (engagementManualTargets.length !== 1 || String(engagementManualTargets[0].campaignId) !== String(campaignId)) return; // modal moved on
  if (!orders.length) return;

  const latest = {};
  for (const o of orders) if (!latest[o.kind]) latest[o.kind] = o; // orders come newest-first
  const tone = (s) => {
    const u = String(s || "").toUpperCase();
    if (["SUBMITTED", "COMPLETED"].includes(u) || /progress|complete|process/i.test(s)) return "ok";
    if (u === "FAILED" || /cancel|error/i.test(s)) return "bad";
    return "warn";
  };
  const rows = ["LIKES", "SAVES", "COMMENTS"]
    .filter((k) => latest[k])
    .map((k) => {
      const o = latest[k];
      const qty = o.quantity ? `${o.quantity} ` : "";
      const ref = o.provider_ref ? ` · #${escapeHtml(String(o.provider_ref))}` : "";
      const label = o.status === "SUBMITTED" ? "ordered" : (o.status || "").toLowerCase();
      const failNote = String(o.status || "").toUpperCase() === "FAILED" && o.note ? ` — ${escapeHtml(o.note)}` : "";
      return `<div class="ec-auto-row ${tone(o.status)}">${qty}${k.toLowerCase()} — ${escapeHtml(label)}${ref}${failNote}</div>`;
    })
    .join("");
  el.innerHTML = rows;
  el.hidden = !rows;
}

function closeEngagementManualModal() {
  document.getElementById("engagementManualModal").classList.remove("open");
  engagementManualTargets = [];
  showEcView("main"); // never leave the modal parked on the template form
}

// Combines queue_engagement_manual (Likes/Saves) and queue_engagement_comments
// results — whichever kinds were actually toggled on — into one result box
// per campaign. A campaign counts as failed if ANY kind it was sent for
// failed. A single-campaign batch shows that one campaign's combined message;
// a multi-campaign batch shows a success count plus which campaigns failed
// and why, by name, so a partial failure is never silently swallowed.
function renderCombinedEngagementResult(resultEl, targets, { manualResults, commentsResults }) {
  resultEl.textContent = "";
  resultEl.className = "eng-placeholder";
  const manualById = new Map((manualResults || []).map((r) => [String(r.campaign_id), r]));
  const commentsById = new Map((commentsResults || []).map((r) => [String(r.campaign_id), r]));
  const ids = [...new Set([...manualById.keys(), ...commentsById.keys()])];
  if (!ids.length) return;

  const summarize = (cid) => {
    const parts = [];
    const mr = manualById.get(cid);
    if (mr) {
      const sub = [mr.likes, mr.saves].filter(Boolean).map((k) => k.message).filter(Boolean);
      parts.push(...(sub.length ? sub : mr.ok ? [] : [mr.error || "likes/saves failed"]));
    }
    const cr = commentsById.get(cid);
    if (cr) parts.push(cr.ok ? cr.message || "comments queued" : cr.error || "comments failed");
    return parts.join(" · ") || "Done.";
  };
  const okFor = (cid) => {
    const mr = manualById.get(cid);
    const cr = commentsById.get(cid);
    return (!mr || mr.ok) && (!cr || cr.ok);
  };

  if (ids.length === 1) {
    const cid = ids[0];
    resultEl.classList.add(okFor(cid) ? "ok" : "bad");
    resultEl.textContent = summarize(cid);
    return;
  }
  const byId = new Map(targets.map((s) => [String(s.campaignId), s]));
  const okCount = ids.filter(okFor).length;
  const lines = [`${okCount}/${ids.length} succeeded.`];
  for (const cid of ids) {
    if (!okFor(cid)) {
      const name = byId.get(cid)?.source || cid;
      lines.push(`✕ ${name}: ${summarize(cid)}`);
    }
  }
  resultEl.classList.add(okCount === ids.length ? "ok" : okCount === 0 ? "bad" : "warn");
  resultEl.textContent = lines.join("\n");
}

async function submitEngagementManual() {
  if (!engagementManualTargets.length) return;
  const single = engagementManualTargets.length === 1;
  const errEl = document.getElementById("engagementManualError");
  const resultEl = document.getElementById("engagementManualResult");
  const btn = document.getElementById("submitEngagementManualBtn");
  errEl.textContent = "";
  resultEl.textContent = "";
  resultEl.className = "eng-placeholder";

  const likes = engagementToggles.likes
    ? Math.max(0, Math.floor(Number(document.getElementById("engagementManualLikes").value) || 0))
    : 0;
  const saves = engagementToggles.saves
    ? Math.max(0, Math.floor(Number(document.getElementById("engagementManualSaves").value) || 0))
    : 0;

  let serviceId = "";
  let commentBody = [];
  if (engagementToggles.comments) {
    serviceId = document.getElementById("engagementServiceIdInput").value.trim();
    if (!serviceId) {
      errEl.textContent = "Enter a Service ID (or turn Comments off).";
      return;
    }
    if (!ecState.selectedId) {
      errEl.textContent = "Select a comment template (or turn Comments off).";
      return;
    }
    commentBody = selectedTemplateComments();
    if (!commentBody.length) {
      errEl.textContent = "That template has no comments — edit it first.";
      return;
    }
  }

  if (!likes && !saves && !engagementToggles.comments) {
    errEl.textContent = "Turn on at least one of Likes, Saves, or Comments.";
    return;
  }

  let targets = engagementManualTargets;
  if (single) {
    const url = document.getElementById("engagementCommentsUrl").value.trim();
    if (engagementToggles.comments && !url) {
      errEl.textContent = "Enter the TikTok post URL for this campaign.";
      return;
    }
    const s = engagementManualTargets[0];
    if (url && url !== (s.tiktokPostUrl || "")) {
      // If the URL was edited (or the campaign had none), persist it to the
      // campaign's tiktok_post_url first so the rest of the app stays in sync.
      try {
        const r = await setCampaignPostUrl(s.campaignId, url);
        const tk = state.tiktokCampaigns.find((c) => String(c.campaign_id) === String(s.campaignId));
        if (tk) tk.tiktok_post_url = r.tiktok_post_url ?? url;
        rebuildSources();
        s.tiktokPostUrl = url;
      } catch (err) {
        errEl.textContent = err.message;
        return;
      }
    }
  } else {
    targets = engagementManualTargets.filter((s) => String(s.tiktokPostUrl || "").trim());
    if (!targets.length) {
      errEl.textContent = "None of the selected campaigns have a TikTok post URL yet.";
      return;
    }
  }

  if (engagementToggles.comments) saveServiceId(serviceId);
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const ids = targets.map((s) => s.campaignId);
    const [manualRes, commentsRes] = await Promise.all([
      likes || saves ? queueEngagementManual(ids, likes, saves) : Promise.resolve(null),
      engagementToggles.comments ? queueEngagementComments(ids, serviceId, commentBody) : Promise.resolve(null),
    ]);
    renderCombinedEngagementResult(resultEl, targets, {
      manualResults: manualRes ? manualRes.results : null,
      commentsResults: commentsRes ? commentsRes.results : null,
    });
    btn.textContent = "Done";
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Add";
  }
}

// ============================== WH WARMUP ==============================
// Bulk temporary Traffic-CBO warmup campaigns that auto-delete once Active.
// Reuses the TikTok connection/advertiser data already fetched for the TikTok
// Ads modal (tiktokState). All creation + cleanup is server-side.

const whState = {
  connectionId: null,
  selected: new Set(), // advertiser_ids chosen on step 1
  step: 1,
  countries: [], // [{ location_id, name, code }] — from TikTok for the picked advertiser
  countriesForAdv: null, // advertiser_id the country list was fetched for
  countryLoading: false,
  selectedCountry: null, // { location_id, name } — a confirmed pick; required to create
  suggestActive: -1, // keyboard-highlighted suggestion index
  spark: "", // Spark code textarea, mirrored here so it survives a minimize
  minimized: false, // true = modal hidden but the draft is kept for resume
};

// Ordered per whAdvsForConnection() (not Set order) — the account whose
// country list step 2 uses, and the one Back/Next re-picking-invalidation
// compares against. See whGoToStep().
function whRepresentativeAdvId() {
  const first = whAdvsForConnection().find((a) => whState.selected.has(String(a.advertiser_id)));
  return first ? String(first.advertiser_id) : null;
}

function wireWhWarmupEvents() {
  document.getElementById("toolsWhWarmupBtn").addEventListener("click", openWhWarmupModal);
  // X and backdrop MINIMIZE (keep the draft) — Cancel/Done are the explicit
  // discard, matching Campaign Creator's minimize logic exactly.
  document.getElementById("closeWhWarmupModal").addEventListener("click", minimizeWhWarmup);
  const whMinBtn = document.getElementById("whMinimizeModal");
  if (whMinBtn) whMinBtn.addEventListener("click", minimizeWhWarmup);
  document.getElementById("whWarmupModal").addEventListener("click", (e) => {
    if (e.target.id === "whWarmupModal") minimizeWhWarmup();
  });
  document.getElementById("whCancelBtn1").addEventListener("click", () => { whResetDraft(); closeWhWarmupModal(); });
  document.getElementById("whCancelBtn2").addEventListener("click", () => { whResetDraft(); closeWhWarmupModal(); });
  document.getElementById("whDoneBtn").addEventListener("click", () => { whResetDraft(); closeWhWarmupModal(); });
  document.getElementById("whBackBtn").addEventListener("click", () => whGoToStep(1));
  document.getElementById("whNextBtn").addEventListener("click", () => whGoToStep(2));
  document.getElementById("whCreateBtn").addEventListener("click", submitWhWarmup);

  document.getElementById("whBcSelect").addEventListener("change", (e) => {
    whState.connectionId = e.target.value;
    whState.selected.clear();
    renderWhAdvertisers();
    refreshWhWarmingCount(); // the "WHs Warming Up" badge is scoped to this BC too
  });
  document.getElementById("whSelectAll").addEventListener("change", (e) => {
    const approved = whAdvsForConnection().filter((a) => advIsApproved(a));
    if (e.target.checked) approved.forEach((a) => whState.selected.add(String(a.advertiser_id)));
    else approved.forEach((a) => whState.selected.delete(String(a.advertiser_id)));
    renderWhAdvertisers();
  });
  // Static — lives outside whAdvList, so re-rendering the list below it never
  // touches (or steals focus from) this input.
  document.getElementById("whAdvSearch").addEventListener("input", renderWhAdvertisers);
  document.getElementById("whAdvList").addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-wh-adv]');
    if (!cb) return;
    const id = String(cb.dataset.whAdv);
    if (cb.checked) whState.selected.add(id);
    else whState.selected.delete(id);
    syncWhSelectAll();
    updateWhNextButton();
  });

  // ---- Target country autocomplete ----
  const cIn = document.getElementById("whCountryInput");
  cIn.addEventListener("input", () => {
    // Any keystroke invalidates a previous pick — a valid suggestion must be chosen.
    whState.selectedCountry = null;
    document.getElementById("whCountryOk").textContent = "";
    renderCountrySuggest(cIn.value);
  });
  cIn.addEventListener("focus", () => renderCountrySuggest(cIn.value));
  cIn.addEventListener("keydown", (e) => {
    const box = document.getElementById("whCountrySuggest");
    if (box.hidden) return;
    const opts = [...box.querySelectorAll("button")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      whState.suggestActive = Math.max(0, Math.min(opts.length - 1, whState.suggestActive + (e.key === "ArrowDown" ? 1 : -1)));
      opts.forEach((o, i) => o.classList.toggle("active", i === whState.suggestActive));
    } else if (e.key === "Enter" && opts[whState.suggestActive]) {
      e.preventDefault();
      pickCountry(opts[whState.suggestActive].dataset.locId, opts[whState.suggestActive].dataset.name);
    } else if (e.key === "Escape") {
      hideCountrySuggest();
    }
  });
  cIn.addEventListener("blur", () => setTimeout(hideCountrySuggest, 150)); // let a click land first
  document.getElementById("whCountrySuggest").addEventListener("mousedown", (e) => {
    const b = e.target.closest("button[data-loc-id]");
    if (b) {
      e.preventDefault();
      pickCountry(b.dataset.locId, b.dataset.name);
    }
  });

  // Mirrored into whState so a minimize/resume never loses what was typed.
  document.getElementById("whSparkInput").addEventListener("input", (e) => {
    whState.spark = e.target.value;
  });
}

function hideCountrySuggest() {
  const box = document.getElementById("whCountrySuggest");
  box.hidden = true;
  box.innerHTML = "";
  whState.suggestActive = -1;
}

function renderCountrySuggest(query) {
  const box = document.getElementById("whCountrySuggest");
  whState.suggestActive = -1;

  if (whState.countryLoading) {
    box.hidden = false;
    box.innerHTML = `<div class="wh-country-none">Loading countries…</div>`;
    return;
  }
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    hideCountrySuggest();
    return;
  }
  if (!whState.countries.length) {
    box.hidden = false;
    box.innerHTML = `<div class="wh-country-none">No country list — pick an account first.</div>`;
    return;
  }

  const starts = [];
  const contains = [];
  for (const c of whState.countries) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q) || c.code.toLowerCase() === q) starts.push(c);
    else if (n.includes(q)) contains.push(c);
  }
  const hits = [...starts, ...contains].slice(0, 8);
  if (!hits.length) {
    box.hidden = false;
    box.innerHTML = `<div class="wh-country-none">No TikTok country matches “${escapeHtml(query)}”.</div>`;
    return;
  }
  box.hidden = false;
  box.innerHTML = hits
    .map(
      (c) =>
        `<button type="button" data-loc-id="${escapeHtml(c.location_id)}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`
    )
    .join("");
}

function pickCountry(locationId, name) {
  whState.selectedCountry = { location_id: String(locationId), name: String(name) };
  document.getElementById("whCountryInput").value = name;
  document.getElementById("whCountryOk").textContent = `✓ ${name}`;
  hideCountrySuggest();
}

async function loadWhCountries(advertiserId) {
  if (!advertiserId) return;
  if (whState.countriesForAdv === advertiserId && whState.countries.length) return; // cached for this advertiser
  whState.countryLoading = true;
  whState.countries = [];
  whState.countriesForAdv = advertiserId;
  renderCountrySuggest(document.getElementById("whCountryInput").value);
  try {
    const data = await fetchWhCountries(whState.connectionId, advertiserId);
    whState.countries = data.countries || [];
  } catch (_) {
    whState.countries = [];
  } finally {
    whState.countryLoading = false;
    renderCountrySuggest(document.getElementById("whCountryInput").value);
  }
}

// Approved first, Suspended after — but WITHIN each group, keeps whatever
// order tiktokState.advertisers already arrived in (the backend orders by
// list_order, i.e. the Business Center's own order), never alphabetical.
// Array.prototype.sort is stable, so sorting on rank alone preserves that.
function whAdvsForConnection() {
  return tiktokState.advertisers
    .filter((a) => a.connection_id === whState.connectionId)
    .slice()
    .sort((a, b) => advApprovedRank(a) - advApprovedRank(b));
}

// Reopen: if the user minimized mid-flow, resume exactly where they were —
// same logic as Campaign Creator (openCampaignCreatorModal).
async function openWhWarmupModal() {
  closeToolsDrawer();
  document.getElementById("whWarmupModal").classList.add("open");
  refreshWhWarmingCount(); // best-effort, non-blocking

  if (whState.minimized) {
    whState.minimized = false;
    whRestoreDom();
    return;
  }

  whResetDraft();
  whGoToStep(1);
  document.getElementById("whAdvList").innerHTML = `<p class="tk-loading">Loading accounts…</p>`;
  document.getElementById("whStep1Error").textContent = "";

  try {
    const data = await fetchTiktokConnections();
    tiktokState.connections = data.connections || [];
    tiktokState.advertisers = data.advertisers || [];
  } catch (err) {
    document.getElementById("whAdvList").innerHTML = `<p class="tk-error">Couldn't load connections: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const sel = document.getElementById("whBcSelect");
  if (!tiktokState.connections.length) {
    sel.innerHTML = "";
    document.getElementById("whAdvList").innerHTML = `<p class="tk-empty">No TikTok Business Centers connected. Add one under Tools → TikTok Ads first.</p>`;
    document.getElementById("whSummary").innerHTML = "";
    return;
  }
  sel.innerHTML = tiktokState.connections
    .map((c) => `<option value="${c.id}">${escapeHtml(connBcOptionLabel(c))}</option>`)
    .join("");
  whState.connectionId = tiktokState.connections[0].id;
  sel.value = whState.connectionId;
  renderWhAdvertisers();
}

function closeWhWarmupModal() {
  document.getElementById("whWarmupModal").classList.remove("open");
}

// Minimize — hide the modal but keep the full draft (step, accounts, country,
// spark code). Session only; reopening from Tools resumes it. Mirrors
// Campaign Creator's minimizeCampaignCreator exactly.
function minimizeWhWarmup() {
  if (whState.step !== 1 || whState.selected.size) {
    whSnapshotDom();
    whState.minimized = true;
  }
  document.getElementById("whWarmupModal").classList.remove("open");
}

function whResetDraft() {
  whState.minimized = false;
  whState.selected.clear();
  whState.step = 1;
  whState.countries = [];
  whState.countriesForAdv = null;
  whState.selectedCountry = null;
  whState.spark = "";
  document.getElementById("whCountryInput").value = "";
  document.getElementById("whCountryOk").textContent = "";
  document.getElementById("whSparkInput").value = "";
  document.getElementById("whAdvSearch").value = "";
}

// Read the spark textarea into state before hiding the modal — everything
// else on steps 1-2 already lives in whState as the user interacts with it.
function whSnapshotDom() {
  whState.spark = document.getElementById("whSparkInput").value;
}

function whRestoreDom() {
  const sel = document.getElementById("whBcSelect");
  if (tiktokState.connections.length) {
    sel.innerHTML = tiktokState.connections
      .map((c) => `<option value="${c.id}">${escapeHtml(connBcOptionLabel(c))}</option>`)
      .join("");
    if (whState.connectionId) sel.value = whState.connectionId;
  }
  renderWhAdvertisers();
  document.getElementById("whCountryInput").value = whState.selectedCountry?.name || "";
  document.getElementById("whSparkInput").value = whState.spark;
  whGoToStepShow(whState.step || 1);
}

// Same panel-visibility/title work whGoToStep does, but WITHOUT its
// side-effecting bits (clearing the picked country, re-fetching the country
// list) — used only to redraw the currently-resumed step, never to advance.
function whGoToStepShow(n) {
  document.getElementById("whStep1").hidden = n !== 1;
  document.getElementById("whStep2").hidden = n !== 2;
  document.getElementById("whStep3").hidden = n !== 3;
  document.getElementById("whWarmupTitle").textContent =
    n === 1 ? "WH Warmup — accounts" : n === 2 ? "WH Warmup — settings" : "WH Warmup — results";
  if (n === 2) {
    const count = whState.selected.size;
    document.getElementById("whSelCount").innerHTML = `Creating for <strong>${count}</strong> Approved account${count === 1 ? "" : "s"}.`;
  }
}

function whGoToStep(n) {
  whState.step = n;
  if (n === 1) {
    // Only invalidate the picked country if the accounts selection actually
    // changed the advertiser the country list is scoped to (loadWhCountries
    // is per-advertiser) — otherwise Back then Next would forget a perfectly
    // valid pick and force reselecting it for no reason.
    const repAdv = whRepresentativeAdvId();
    if (repAdv !== whState.countriesForAdv) {
      whState.selectedCountry = null;
      document.getElementById("whCountryOk").textContent = "";
    }
  }
  whGoToStepShow(n);
  if (n === 2) {
    document.getElementById("whStep2Error").textContent = "";
    document.getElementById("whCreateProgress").textContent = "";
    document.getElementById("whCreateProgress").className = "eng-placeholder";
    const btn = document.getElementById("whCreateBtn");
    btn.disabled = false;
    btn.textContent = "Create WH Warmup";
    // Country list comes from ONE selected advertiser's own valid TikTok
    // regions — the same one used to decide whether to keep the pick above.
    loadWhCountries(whRepresentativeAdvId());
  }
}

function renderWhAdvertisers() {
  const advs = whAdvsForConnection();
  const approved = advs.filter((a) => advIsApproved(a)).length;
  document.getElementById("whSummary").innerHTML = `
    <span class="tk-sum-item"><strong>${advs.length}</strong> account${advs.length === 1 ? "" : "s"}</span>
    <span class="tk-sum-item ok"><strong>${approved}</strong> Approved</span>
    <span class="tk-sum-item warn"><strong>${advs.length - approved}</strong> Suspended</span>`;

  // Search box lives outside this container (static markup) so re-rendering
  // the rows never steals its focus/cursor.
  const query = document.getElementById("whAdvSearch")?.value || "";
  const shown = filterAdvsByQuery(advs, query);

  const wrap = document.getElementById("whAdvList");
  wrap.innerHTML = shown.length
    ? shown.map((a) => whAdvRow(a)).join("")
    : `<p class="tk-empty">${advs.length ? "No accounts match your search." : "No advertiser accounts under this Business Center."}</p>`;

  syncWhSelectAll();
  updateWhNextButton();
}

function whAdvRow(a) {
  const ok = advIsApproved(a);
  const id = String(a.advertiser_id);
  const meta = [id, a.currency || null, a.display_timezone || a.timezone || null].filter(Boolean).join(" · ");
  return `
    <label class="tk-adv${ok ? "" : " disabled"}" title="${ok ? "" : "Suspended accounts can't be used — campaign creation would fail."}">
      <input type="checkbox" data-wh-adv="${escapeHtml(id)}" ${whState.selected.has(id) ? "checked" : ""} ${ok ? "" : "disabled"} />
      <span class="tk-adv-main">
        <span class="tk-adv-name">${escapeHtml(a.advertiser_name || id)}</span>
        <span class="tk-adv-meta">${escapeHtml(meta)}</span>
      </span>
      <span class="tk-adv-status ${ok ? "ok" : "warn"}">${ok ? "Approved" : "Suspended"}</span>
    </label>`;
}

function syncWhSelectAll() {
  const approved = whAdvsForConnection().filter((a) => advIsApproved(a));
  const all = approved.length > 0 && approved.every((a) => whState.selected.has(String(a.advertiser_id)));
  const cb = document.getElementById("whSelectAll");
  cb.checked = all;
  cb.disabled = approved.length === 0;
}

function updateWhNextButton() {
  document.getElementById("whNextBtn").disabled = whState.selected.size === 0;
}

// One request creates warmup campaigns sequentially server-side (campaign ->
// ad group -> Spark ad, PLUS the $5 account safety cap first — slightly more
// MCP calls per account than Campaign Creator's own create) and the
// serverless function has a hard wall-clock limit, so — exactly like
// Campaign Creator (see CC_CREATE_CHUNK_SIZE) — a batch bigger than this is
// split into consecutive requests of this size instead of one unbounded
// request. The total batch size has no cap; a bigger batch just takes
// proportionally longer (more requests).
const WH_CREATE_CHUNK_SIZE = 6;

async function submitWhWarmup() {
  const typed = document.getElementById("whCountryInput").value.trim();
  const spark = document.getElementById("whSparkInput").value.trim();
  const errEl = document.getElementById("whStep2Error");
  const progressEl = document.getElementById("whCreateProgress");
  const btn = document.getElementById("whCreateBtn");
  errEl.textContent = "";

  const picked = whState.selectedCountry;
  if (!picked || picked.name.toLowerCase() !== typed.toLowerCase()) {
    return (errEl.textContent = "Pick a target country from the suggestions.");
  }
  if (!spark) return (errEl.textContent = "Enter a Spark code.");
  // Ordered per the ad-accounts list (not Set insertion/click order) so the
  // backend's wh1, wh2, … naming always matches what's shown on screen.
  const ids = whAdvsForConnection()
    .filter((a) => whState.selected.has(String(a.advertiser_id)))
    .map((a) => String(a.advertiser_id));
  if (!ids.length) return whGoToStep(1);
  // Computed once, up front, over the FULL list — so numbering stays
  // continuous (wh1, wh2, …) across chunk boundaries instead of each chunk
  // restarting at wh1 and colliding with an earlier one's names.
  const namesAll = ids.map((_, i) => `wh${i + 1}`);
  const total = ids.length;
  const chunkCount = Math.ceil(total / WH_CREATE_CHUNK_SIZE);

  btn.disabled = true;
  btn.textContent = "Creating…";
  progressEl.className = "eng-placeholder busy";

  const allResults = [];
  let warning = null;
  try {
    for (let c = 0; c < chunkCount; c++) {
      const start = c * WH_CREATE_CHUNK_SIZE;
      const end = Math.min(start + WH_CREATE_CHUNK_SIZE, total);
      progressEl.textContent = chunkCount > 1
        ? `Creating ${total} warmup campaigns… batch ${c + 1}/${chunkCount} (${allResults.filter((x) => x.status === "Created").length} done so far).`
        : `Creating ${total} warmup campaign${total === 1 ? "" : "s"}… this can take a minute.`;
      try {
        const res = await createWhWarmup(
          whState.connectionId,
          ids.slice(start, end),
          picked.name,
          spark,
          picked.location_id,
          namesAll.slice(start, end)
        );
        allResults.push(...(res.results || []));
        if (res.warning && !warning) warning = res.warning;
      } catch (chunkErr) {
        // One batch failing outright (network error, etc.) never stops the
        // rest — the remaining batches still run, this one's accounts are
        // just recorded as failed.
        ids.slice(start, end).forEach((advId, i) => {
          const a = whAdvsForConnection().find((x) => String(x.advertiser_id) === advId);
          allResults.push({
            advertiser_id: advId,
            advertiser_name: a?.advertiser_name || advId,
            status: "Failed",
            error: chunkErr.message,
          });
        });
      }
    }
    renderWhResults(allResults, warning);
    whGoToStep(3);
    // Kick a cleanup pass so newly-Active ones start deleting promptly.
    runWhWarmupCleanup();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Create WH Warmup";
    progressEl.textContent = "";
    progressEl.className = "eng-placeholder";
  }
}

function renderWhResults(results, warning) {
  const el = document.getElementById("whResults");
  const tone = (s) => (s === "Created" ? "ok" : s === "Skipped" ? "warn" : "bad");
  el.innerHTML =
    (warning ? `<div class="wh-result-row bad"><span class="wh-r-detail">${escapeHtml(warning)}</span></div>` : "") +
    (results.length
      ? results
          .map(
            (r) => `
      <div class="wh-result-row ${tone(r.status)}">
        <span class="wh-r-name">${escapeHtml(r.advertiser_name || r.advertiser_id)}</span>
        <span class="wh-r-status">${escapeHtml(r.status)}${r.error ? ` <span class="wh-r-detail">— ${escapeHtml(r.error)}</span>` : ""}</span>
      </div>`
          )
          .join("")
      : `<p class="tk-empty">No accounts processed.</p>`);
}

// ---- "WHs Warming Up" — every WH campaign, ad account included, with
// on/off, status, source and budget, matching Detailed Metrics' own fields
// (wh-warmup.js's "list" action joins in campaign_operation_status/
// effective_status from tiktok_campaigns for exactly this). Select-all or
// per-row, then delete — reuses the same setCampaignStatus/deleteTiktokCampaign
// writes Detailed Metrics uses, just against this panel's own local cache
// instead of state.sources.

const whWarmingState = { campaigns: [], selected: new Set() };

function wireWhWarmingUpEvents() {
  document.getElementById("whWarmingUpBox").addEventListener("click", openWhWarmingUpModal);
  document.getElementById("closeWhWarmingUpModal").addEventListener("click", closeWhWarmingUpModal);
  document.getElementById("whWarmingUpModal").addEventListener("click", (e) => {
    if (e.target.id === "whWarmingUpModal") closeWhWarmingUpModal();
  });
  document.getElementById("whWarmingSelectAll").addEventListener("change", (e) => {
    if (e.target.checked) whWarmingState.campaigns.forEach((c) => whWarmingState.selected.add(String(c.campaign_id)));
    else whWarmingState.selected.clear();
    renderWhWarmingList();
  });
  document.getElementById("whWarmingDeleteBtn").addEventListener("click", deleteSelectedWhWarming);

  document.getElementById("whWarmingList").addEventListener("click", (e) => {
    const toggleBtn = e.target.closest("[data-wh-toggle]");
    if (toggleBtn) {
      e.stopPropagation();
      handleWhWarmingToggle(toggleBtn);
      return;
    }
    // Shares the ⋮ menu plumbing with Detailed Metrics (data-row-menu /
    // openRowMenuFor / closeRowMenu — see the document-level outside-click
    // guard) so it opens, positions, and closes the same way everywhere.
    const menuBtn = e.target.closest("[data-row-menu]");
    if (menuBtn) {
      e.stopPropagation();
      toggleWhWarmingMenu(menuBtn);
    }
  });
  document.getElementById("whWarmingList").addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-wh-select]");
    if (!cb) return;
    const id = String(cb.dataset.whSelect);
    if (cb.checked) whWarmingState.selected.add(id);
    else whWarmingState.selected.delete(id);
    syncWhWarmingToolbar();
  });
}

async function openWhWarmingUpModal() {
  document.getElementById("whWarmingUpModal").classList.add("open");
  document.getElementById("whWarmingError").textContent = "";
  whWarmingState.selected.clear();
  await loadWhWarmingList();
}

function closeWhWarmingUpModal() {
  document.getElementById("whWarmingUpModal").classList.remove("open");
}

// Scoped to whState.connectionId — the box/modal live right under the BC
// selector in the WH Warmup creator, so they only ever show/count that same
// BC's warming campaigns, never every connected BC mixed together.
async function loadWhWarmingList() {
  const el = document.getElementById("whWarmingList");
  el.innerHTML = `<p class="tk-loading">Loading WH campaigns…</p>`;
  try {
    const res = await listWhWarmup(whState.connectionId);
    whWarmingState.campaigns = res.campaigns || [];
    renderWhWarmingList();
    updateWhWarmingCount();
  } catch (err) {
    el.innerHTML = `<p class="tk-error">Couldn't load WH campaigns: ${escapeHtml(err.message)}</p>`;
  }
}

// Best-effort badge on the entry box — fired when the WH Warmup modal opens,
// never blocks it.
async function refreshWhWarmingCount() {
  try {
    const res = await listWhWarmup(whState.connectionId);
    whWarmingState.campaigns = res.campaigns || [];
    updateWhWarmingCount();
  } catch (_) {
    /* box just shows no count yet */
  }
}

function updateWhWarmingCount() {
  const el = document.getElementById("whWarmingUpCount");
  if (!el) return;
  const n = whWarmingState.campaigns.length;
  el.textContent = n ? `${n} warming up` : "";
}

function renderWhWarmingList() {
  const list = whWarmingState.campaigns;
  const el = document.getElementById("whWarmingList");
  if (!list.length) {
    el.innerHTML = `<p class="tk-empty">No WH Warmup campaigns yet.</p>`;
    syncWhWarmingToolbar();
    return;
  }
  el.innerHTML = `
    <table class="wh-warming-table">
      <thead><tr><th></th><th>On/Off</th><th>Status</th><th>Source</th><th></th></tr></thead>
      <tbody>${list.map(whWarmingRowHtml).join("")}</tbody>
    </table>`;
  syncWhWarmingToolbar();
}

function whWarmingRowHtml(c) {
  const id = String(c.campaign_id);
  const isStray = c.origin === "stray";
  const on = String(c.campaign_operation_status || "").toUpperCase() === "ENABLE";
  const pending = state.pendingActions.has(`wh:${id}`);
  const status = c.effective_status
    ? { label: c.effective_status, tone: c.effective_tone, detail: c.status_detail }
    : {
        label: isStray ? "Checking…" : c.cleanup_status === "WAITING_FOR_ACTIVE" ? "In Review" : c.cleanup_status || "—",
        tone: "neutral",
        detail: null,
      };
  const checked = whWarmingState.selected.has(id);
  return `
    <tr data-wh-row="${escapeHtml(id)}" class="${isStray ? "wh-warming-row-stray" : ""}">
      <td><input type="checkbox" data-wh-select="${escapeHtml(id)}" ${checked ? "checked" : ""} /></td>
      <td>${switchHtml({
        on,
        pending,
        attrs: `data-wh-toggle="${on ? "DISABLE" : "ENABLE"}" data-campaign-id="${escapeHtml(id)}"`,
        title: on ? "Campaign running — click to pause" : "Campaign paused — click to unpause",
      })}</td>
      <td>${statusBadge(status)}</td>
      <td><div class="wh-warming-source">
        <strong>${escapeHtml(c.campaign_name || id)}</strong>${isStray ? `<span class="wh-stray-badge" title="Found by a sync — not created through Campaign Creator or WH Warmup. Check it: pause or delete it if it shouldn't be running.">Stray</span>` : ""}
        <span>${escapeHtml(c.advertiser_name || c.advertiser_id)}</span>
      </div></td>
      <td><button type="button" class="rowmenu-btn" data-row-menu="wh:${escapeHtml(id)}" aria-label="Campaign actions" title="Campaign actions">⋮</button></td>
    </tr>`;
}

function syncWhWarmingToolbar() {
  const all = whWarmingState.campaigns;
  const selCb = document.getElementById("whWarmingSelectAll");
  selCb.checked = all.length > 0 && all.every((c) => whWarmingState.selected.has(String(c.campaign_id)));
  selCb.disabled = all.length === 0;
  const delBtn = document.getElementById("whWarmingDeleteBtn");
  delBtn.disabled = whWarmingState.selected.size === 0;
  delBtn.textContent = whWarmingState.selected.size ? `Delete selected (${whWarmingState.selected.size})` : "Delete selected";
}

async function handleWhWarmingToggle(btn) {
  const id = btn.dataset.campaignId;
  const targetOp = btn.dataset.whToggle;
  const key = `wh:${id}`;
  if (state.pendingActions.has(key)) return;
  state.pendingActions.add(key);
  renderWhWarmingList();
  try {
    const result = await setCampaignStatus(id, targetOp);
    const row = whWarmingState.campaigns.find((c) => String(c.campaign_id) === id);
    if (row) {
      if (result.campaign_operation_status !== undefined) row.campaign_operation_status = result.campaign_operation_status;
      if (result.effective_status) row.effective_status = result.effective_status;
      if (result.effective_tone) row.effective_tone = result.effective_tone;
      if (result.status_detail !== undefined) row.status_detail = result.status_detail;
    }
  } catch (err) {
    document.getElementById("whWarmingError").textContent = `Update failed: ${err.message}`;
  } finally {
    state.pendingActions.delete(key);
    renderWhWarmingList();
  }
}

// Same floating-menu component as Detailed Metrics' ⋮ (openRowMenuFor /
// rowMenuEl / closeRowMenu) — keyed "wh:<id>" so it can never collide with a
// real campaign_id there.
function toggleWhWarmingMenu(btn) {
  const key = String(btn.dataset.rowMenu || "");
  const id = key.replace(/^wh:/, "");
  if (openRowMenuFor === key) {
    closeRowMenu();
    return;
  }
  closeRowMenu();
  openRowMenuFor = key;
  btn.classList.add("active");

  const menu = document.createElement("div");
  menu.className = "rowmenu";
  menu.innerHTML = `<button type="button" class="rowmenu-item danger" data-wh-menu-action="delete">Delete campaign</button>`;
  document.body.appendChild(menu);
  rowMenuEl = menu;

  const r = btn.getBoundingClientRect();
  let left = r.right + window.scrollX - menu.offsetWidth;
  if (left < 8) left = 8;
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.left = `${left}px`;

  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-wh-menu-action]");
    if (!item) return;
    closeRowMenu();
    if (item.dataset.whMenuAction === "delete") deleteOneWhWarming(id);
  });
}

async function deleteOneWhWarming(id) {
  if (!confirm("Delete this WH Warmup campaign from TikTok?")) return;
  document.getElementById("whWarmingError").textContent = "";
  try {
    await deleteTiktokCampaign(id);
    whWarmingState.campaigns = whWarmingState.campaigns.filter((c) => String(c.campaign_id) !== id);
    whWarmingState.selected.delete(id);
    renderWhWarmingList();
    updateWhWarmingCount();
  } catch (err) {
    document.getElementById("whWarmingError").textContent = `Delete failed: ${err.message}`;
  }
}

async function deleteSelectedWhWarming() {
  const ids = [...whWarmingState.selected];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} WH Warmup campaign${ids.length === 1 ? "" : "s"} from TikTok?`)) return;
  const btn = document.getElementById("whWarmingDeleteBtn");
  const errEl = document.getElementById("whWarmingError");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Deleting…";
  const failed = [];
  for (const id of ids) {
    try {
      await deleteTiktokCampaign(id);
      whWarmingState.campaigns = whWarmingState.campaigns.filter((c) => String(c.campaign_id) !== id);
      whWarmingState.selected.delete(id);
    } catch (err) {
      failed.push(`${id}: ${err.message}`);
    }
  }
  if (failed.length) errEl.textContent = `Some deletes failed — ${failed.join("; ")}`;
  renderWhWarmingList();
  updateWhWarmingCount();
}

// ============================== CAMPAIGN CREATOR ==============================
// Template-based launches. Templates hold reusable settings only; per-launch
// values are collected in the runtime wizard. Creation + registration is 100%
// server-side (campaign-creator-run.js). Reuses the WH account selector, the
// country autocomplete, and the existing duplication/appeal monitoring.

const CC_AGE_OPTS = [
  { v: "AGE_18_24", l: "18–24" },
  { v: "AGE_25_34", l: "25–34" },
  { v: "AGE_35_44", l: "35–44" },
  { v: "AGE_45_54", l: "45–54" },
  { v: "AGE_55_100", l: "55+" },
];
const CC_CTA_OPTS = [
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "DOWNLOAD_NOW", "INSTALL_NOW", "PLAY_GAME",
  "ORDER_NOW", "CONTACT_US", "BOOK_NOW", "APPLY_NOW", "GET_QUOTE", "READ_MORE", "VIEW_NOW", "SUBSCRIBE",
];
const ccCtaLabel = (v) => v.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
let ccFormIdTimer = null;

const ccState = {
  view: "home", // home | tpl | run
  templates: [],
  loaded: false,
  tpl: {
    id: null,
    step: 1,
    name: "",
    type: "LEAD_GENERATION",
    cbo: true,
    budget: "",
    locations: [], // [{ id, name }]
    ages: new Set(CC_AGE_OPTS.map((o) => o.v)),
    gender: "GENDER_UNLIMITED",
    deviceOs: "ALL",
    ctas: new Set(["LEARN_MORE"]), // 1+ — Dynamic CTA when more than one is picked
    text: "",
    cardEnabled: false,
    cardUrl: "",
    countries: [],
    countriesLoading: false,
    suggestActive: -1,
  },
  run: {
    template: null,
    connectionId: null,
    selected: new Set(),
    step: 1,
    base: "",
    // one entry per advertiser timezone: { "<IANA tz>": { date:"YYYY-MM-DD", hour, minute } }
    schedules: {},
    spark: "",
    links: "",
    resources: null,
    resLoading: false,
    formId: "", // Instant Form page_id (dropdown or manual)
    formLabel: "", // display name for review
    formValidated: false, // page_field_get confirmed it works for the accounts
  },
  minimized: false, // true = modal hidden but the draft is kept for resume
};

function wireCampaignCreatorEvents() {
  document.getElementById("toolsCampaignCreatorBtn").addEventListener("click", openCampaignCreatorModal);
  // X and backdrop MINIMIZE (keep the draft) — Cancel is the explicit discard.
  document.getElementById("closeCampaignCreatorModal").addEventListener("click", minimizeCampaignCreator);
  const minBtn = document.getElementById("ccMinimizeModal");
  if (minBtn) minBtn.addEventListener("click", minimizeCampaignCreator);
  document.getElementById("campaignCreatorModal").addEventListener("click", (e) => {
    if (e.target.id === "campaignCreatorModal") minimizeCampaignCreator();
  });

  // Home
  document.getElementById("ccNewTemplateBtn").addEventListener("click", () => openTplWizard(null));
  document.getElementById("ccTemplateList").addEventListener("click", onCcTemplateListClick);

  // Template wizard nav — Cancel discards the template draft.
  const closeToHome = () => { ccResetTplDraft(); ccShowView("home"); };
  document.getElementById("ccTplCancel1").addEventListener("click", closeToHome);
  document.getElementById("ccTplCancel2").addEventListener("click", closeToHome);
  document.getElementById("ccTplCancel3").addEventListener("click", closeToHome);
  document.getElementById("ccTplNext1").addEventListener("click", () => tplGoStep(2));
  document.getElementById("ccTplNext2").addEventListener("click", () => tplGoStep(3));
  document.getElementById("ccTplBack2").addEventListener("click", () => tplGoStep(1));
  document.getElementById("ccTplBack3").addEventListener("click", () => tplGoStep(2));
  document.getElementById("ccTplSave").addEventListener("click", saveTplWizard);

  document.getElementById("ccTplType").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b) return;
    ccState.tpl.type = b.dataset.type;
    syncTplTypeToggle();
  });
  document.getElementById("ccTplCard").addEventListener("change", (e) => {
    ccState.tpl.cardEnabled = e.target.checked;
    document.getElementById("ccTplCardWrap").hidden = !e.target.checked;
  });
  document.getElementById("ccTplAge").addEventListener("click", (e) => {
    const chip = e.target.closest(".cc-chip[data-age]");
    if (!chip) return;
    const v = chip.dataset.age;
    if (ccState.tpl.ages.has(v)) ccState.tpl.ages.delete(v);
    else ccState.tpl.ages.add(v);
    renderTplAgeChips();
  });
  document.getElementById("ccTplLocChips").addEventListener("click", (e) => {
    const x = e.target.closest("[data-loc-remove]");
    if (!x) return;
    ccState.tpl.locations = ccState.tpl.locations.filter((l) => l.id !== x.dataset.locRemove);
    renderTplLocChips();
  });

  // Template location autocomplete (reuses the WH country list endpoint)
  const li = document.getElementById("ccTplLocInput");
  li.addEventListener("input", () => renderTplLocSuggest(li.value));
  li.addEventListener("focus", () => renderTplLocSuggest(li.value));
  li.addEventListener("blur", () => setTimeout(() => (document.getElementById("ccTplLocSuggest").hidden = true), 150));
  document.getElementById("ccTplLocSuggest").addEventListener("mousedown", (e) => {
    const b = e.target.closest("button[data-loc-id]");
    if (!b) return;
    e.preventDefault();
    if (!ccState.tpl.locations.some((l) => l.id === b.dataset.locId)) {
      ccState.tpl.locations.push({ id: b.dataset.locId, name: b.dataset.name });
    }
    li.value = "";
    document.getElementById("ccTplLocSuggest").hidden = true;
    renderTplLocChips();
  });

  // Runtime wizard nav — Cancel discards the run draft.
  const runCancel = () => { ccResetRunDraft(); ccShowView("home"); };
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const c = document.getElementById(`ccRunCancel${n}`);
    if (c) c.addEventListener("click", runCancel);
    const b = document.getElementById(`ccRunBack${n}`);
    if (b) b.addEventListener("click", () => runGoStep(n - 1));
  }
  document.getElementById("ccRunNext1").addEventListener("click", () => runGoStep(2));
  document.getElementById("ccRunNext2").addEventListener("click", () => runGoStep(3));
  document.getElementById("ccRunNext3").addEventListener("click", () => runGoStep(4));
  document.getElementById("ccRunNext4").addEventListener("click", () => runGoStep(5));
  document.getElementById("ccRunNext5").addEventListener("click", () => runGoStep(6));
  document.getElementById("ccRunCreate").addEventListener("click", submitCampaignCreator);
  document.getElementById("ccRunDone").addEventListener("click", () => { ccResetRunDraft(); closeCampaignCreatorModal(); });

  document.getElementById("ccRunBcSelect").addEventListener("change", (e) => {
    ccState.run.connectionId = e.target.value;
    ccState.run.selected.clear();
    renderCcRunAdvertisers();
  });
  document.getElementById("ccRunSelectAll").addEventListener("change", (e) => {
    const approved = ccRunAdvs().filter((a) => advIsApproved(a));
    if (e.target.checked) approved.forEach((a) => ccState.run.selected.add(String(a.advertiser_id)));
    else approved.forEach((a) => ccState.run.selected.delete(String(a.advertiser_id)));
    renderCcRunAdvertisers();
  });
  // Static — lives outside ccRunAdvList, so re-rendering the list below it
  // never touches (or steals focus from) this input.
  document.getElementById("ccRunAdvSearch").addEventListener("input", renderCcRunAdvertisers);
  document.getElementById("ccRunAdvList").addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-cc-adv]');
    if (!cb) return;
    const id = String(cb.dataset.ccAdv);
    if (cb.checked) ccState.run.selected.add(id);
    else ccState.run.selected.delete(id);
    document.getElementById("ccRunNext1").disabled = ccState.run.selected.size === 0;
    syncCcRunSelectAll();
  });
  document.getElementById("ccRunBase").addEventListener("input", (e) => {
    ccState.run.base = e.target.value;
    renderCcNamePreview();
  });
  document.getElementById("ccRunSpark").addEventListener("input", (e) => { ccState.run.spark = e.target.value; renderCcSparkCounts(); });
  document.getElementById("ccRunLinks").addEventListener("input", (e) => { ccState.run.links = e.target.value; renderCcSparkCounts(); });
  // per-timezone schedule blocks (delegated)
  document.getElementById("ccRunTzBlocks").addEventListener("change", (e) => {
    const field = e.target.dataset.sched;
    const block = e.target.closest("[data-tz]");
    if (!field || !block) return;
    const tz = block.dataset.tz;
    ccState.run.schedules[tz] = ccState.run.schedules[tz] || {};
    ccState.run.schedules[tz][field] = field === "date" ? e.target.value : +e.target.value;
  });
  document.getElementById("ccRunForm").addEventListener("change", (e) => {
    if (document.getElementById("ccRunFormId").value.trim()) return; // manual id wins
    ccState.run.formId = e.target.value;
    ccState.run.formLabel = e.target.selectedOptions[0]?.textContent || e.target.value;
    ccState.run.formValidated = !!e.target.value; // dropdown items are already validated
    syncCcRunNext5();
  });
  document.getElementById("ccRunFormId").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    const st = document.getElementById("ccRunFormIdStatus");
    clearTimeout(ccFormIdTimer);
    if (!v) {
      st.textContent = "";
      st.className = "cc-formid-status";
      const fs = document.getElementById("ccRunForm");
      ccState.run.formId = fs.value || "";
      ccState.run.formLabel = fs.selectedOptions[0]?.textContent || fs.value || "";
      ccState.run.formValidated = false;
      syncCcRunNext5();
      return;
    }
    // provisionally accept; confirm in the background
    ccState.run.formId = v;
    ccState.run.formLabel = `Form ID ${v}`;
    ccState.run.formValidated = false;
    syncCcRunNext5();
    if (!/^\d{6,25}$/.test(v)) {
      st.textContent = "A Form ID is a long number.";
      st.className = "cc-formid-status bad";
      return;
    }
    st.textContent = "Checking…";
    st.className = "cc-formid-status busy";
    ccFormIdTimer = setTimeout(() => validateCcFormId(v), 600);
  });

  // CTA multi-select dropdown
  document.getElementById("ccTplCtaBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCtaPanel();
  });
  document.getElementById("ccTplCtaPanel").addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-cta]");
    if (!cb) return;
    const v = cb.dataset.cta;
    const set = ccState.tpl.ctas;
    if (cb.checked) set.add(v);
    else if (set.size > 1) set.delete(v);
    else cb.checked = true; // at least one CTA is always required
    renderTplCtaOptions();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#ccTplCtaWrap")) toggleCtaPanel(false);
  });
}

// CTA dropdown — a compact button showing the current pick(s); opens a
// checkbox panel so more than one CTA can be selected at once. Selecting more
// than one turns on TikTok's Dynamic CTA at creation time (see
// campaign-creator-build.js buildAdCreative / ensureCtaPortfolio) — TikTok
// shows whichever of the picked CTAs a given viewer is likeliest to tap,
// instead of every ad using one fixed CTA.
function renderTplCtaOptions() {
  const d = ccState.tpl;
  const btn = document.getElementById("ccTplCtaBtn");
  const panel = document.getElementById("ccTplCtaPanel");
  const names = CC_CTA_OPTS.filter((v) => d.ctas.has(v)).map(ccCtaLabel);
  btn.textContent = names.length ? names.join(", ") : "Select…";
  panel.innerHTML = CC_CTA_OPTS.map(
    (v) => `<label><input type="checkbox" data-cta="${v}" ${d.ctas.has(v) ? "checked" : ""} /> ${ccCtaLabel(v)}</label>`
  ).join("");
}

function toggleCtaPanel(open) {
  const panel = document.getElementById("ccTplCtaPanel");
  if (!panel) return;
  panel.hidden = open === undefined ? !panel.hidden : !open;
}

// ---- modal / view plumbing ----

// Reopen: if the user minimized mid-flow, resume exactly where they were.
async function openCampaignCreatorModal() {
  closeToolsDrawer();
  document.getElementById("campaignCreatorModal").classList.add("open");

  if (ccState.minimized) {
    ccState.minimized = false;
    ccRestoreDom();
    return;
  }

  ccShowView("home");
  document.getElementById("ccTemplateList").innerHTML = `<p class="cc-empty">Loading templates…</p>`;
  try {
    const [tpls, conns] = await Promise.all([
      listCampaignTemplates(),
      fetchTiktokConnections(),
    ]);
    ccState.templates = tpls.templates || [];
    tiktokState.connections = conns.connections || [];
    tiktokState.advertisers = conns.advertisers || [];
    ccState.loaded = true;
  } catch (err) {
    document.getElementById("ccTemplateList").innerHTML = `<p class="tk-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderCcTemplateList();
}

function closeCampaignCreatorModal() {
  document.getElementById("campaignCreatorModal").classList.remove("open");
}

// Minimize — hide the modal but keep the full draft (step, template, accounts,
// name, schedule, spark codes, post links, identity, form, template inputs).
// Session only; reopening from Tools resumes it.
function minimizeCampaignCreator() {
  if (ccState.view !== "home") {
    ccSnapshotDom();
    ccState.minimized = true;
  }
  document.getElementById("campaignCreatorModal").classList.remove("open");
}

function ccResetRunDraft() {
  ccState.minimized = false;
  ccState.run = {
    template: null, connectionId: null, selected: new Set(), step: 1, base: "",
    hour: 8, minute: 0, spark: "", links: "", resources: null, resLoading: false,
    schedules: {}, formId: "", formLabel: "", formValidated: false, submitting: false,
  };
}

// Syncs the Review step's Create button + progress line to the ONE source of
// truth for "is a create request actually in flight": ccState.run.submitting.
// This replaced an earlier fix that just cleared the progress *text* — that
// missed the button's own disabled/textContent, which is static DOM (the
// button element is never recreated, only its parent step is hidden/shown),
// so a completed run's "Creating…" / disabled=true silently carried into the
// NEXT run and made its Review step look permanently stuck (and made
// submitCampaignCreator's `if (btn.disabled) return` guard block the real
// click). Call this any time Review is about to be shown — it never assumes
// "idle", it reflects r.submitting exactly, so a genuinely in-flight request
// (e.g. surviving a minimize/resume) still shows correctly as busy.
function ccSyncCreateUi() {
  const r = ccState.run;
  const btn = document.getElementById("ccRunCreate");
  const prog = document.getElementById("ccRunProgress");
  const err = document.getElementById("ccRunErr6");
  const busy = !!r.submitting;
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "Creating…" : "Create Campaigns";
  }
  if (!busy) {
    if (prog) { prog.textContent = ""; prog.className = "eng-placeholder"; }
    if (err) err.textContent = "";
  }
}
function ccResetTplDraft() {
  ccState.minimized = false;
  ccState.tpl.id = null;
}

// Read every live input into ccState so the draft survives a minimize.
function ccSnapshotDom() {
  const g = (id) => document.getElementById(id);
  if (ccState.view === "tpl") {
    const d = ccState.tpl;
    d.name = g("ccTplName").value.trim();
    d.cbo = g("ccTplCbo").checked;
    d.budget = g("ccTplBudget").value;
    d.gender = g("ccTplGender").value;
    d.deviceOs = g("ccTplDeviceOs").value;
    // d.ctas is kept live by the checkbox panel's own change handler — nothing to read here.
    d.text = g("ccTplText").value;
    d.cardEnabled = g("ccTplCard").checked;
    d.cardUrl = g("ccTplCardUrl").value.trim();
    d.step = ccState.tpl.step;
  } else if (ccState.view === "run") {
    const r = ccState.run;
    r.base = g("ccRunBase").value;
    r.spark = g("ccRunSpark").value;
    r.links = g("ccRunLinks").value;
    // schedule blocks -> ccState.run.schedules
    document.querySelectorAll("#ccRunTzBlocks [data-tz]").forEach((b) => {
      const tz = b.dataset.tz;
      r.schedules[tz] = {
        date: b.querySelector('[data-sched="date"]')?.value || ccLocalDate(tz),
        hour: +(b.querySelector('[data-sched="hour"]')?.value || 8),
        minute: +(b.querySelector('[data-sched="minute"]')?.value || 0),
      };
    });
    const manualId = g("ccRunFormId").value.trim();
    if (manualId) {
      if (r.formId !== manualId) r.formLabel = `Form ID ${manualId}`;
      r.formId = manualId;
    } else if (g("ccRunForm").value) {
      r.formId = g("ccRunForm").value;
      r.formLabel = g("ccRunForm").selectedOptions[0]?.textContent || r.formId;
    }
  }
}

// Rebuild the DOM from ccState after a resume.
function ccRestoreDom() {
  if (ccState.view === "tpl") {
    const d = ccState.tpl;
    const g = (id) => document.getElementById(id);
    g("ccTplName").value = d.name;
    g("ccTplCbo").checked = d.cbo;
    g("ccTplBudget").value = d.budget;
    g("ccTplGender").value = d.gender;
    g("ccTplDeviceOs").value = d.deviceOs;
    renderTplCtaOptions();
    g("ccTplText").value = d.text;
    g("ccTplCard").checked = d.cardEnabled;
    g("ccTplCardWrap").hidden = !d.cardEnabled;
    g("ccTplCardUrl").value = d.cardUrl;
    syncTplTypeToggle();
    renderTplAgeChips();
    renderTplLocChips();
    ccShowView("tpl");
    tplGoBack(d.step || 1);
  } else if (ccState.view === "run") {
    const r = ccState.run;
    ccShowView("run");
    if (r.template) {
      document.getElementById("ccRunTplLabel").innerHTML =
        `Template: <strong>${escapeHtml(r.template.name)}</strong> · ${r.template.campaign_type === "SALES" ? "Sales" : "Lead Generation"}`;
    }
    const sel = document.getElementById("ccRunBcSelect");
    sel.innerHTML = tiktokState.connections.map((c) => `<option value="${c.id}">${escapeHtml(connBcOptionLabel(c))}</option>`).join("");
    if (r.connectionId) sel.value = r.connectionId;
    renderCcRunAdvertisers();
    document.getElementById("ccRunBase").value = r.base;
    document.getElementById("ccRunSpark").value = r.spark;
    document.getElementById("ccRunLinks").value = r.links;
    renderCcTzBlocks(); // rebuilds from r.schedules
    // Restore the picked Form ID before the resources step re-renders. If it's
    // not one of the dropdown options, put it back in the manual field.
    const inList = (r.resources?.forms || []).some((f) => String(f.id) === String(r.formId));
    document.getElementById("ccRunFormId").value = r.formId && !inList ? r.formId : "";
    const st = document.getElementById("ccRunFormIdStatus");
    if (st) {
      st.textContent = r.formId && !inList && r.formValidated ? `✓ ${r.formLabel || r.formId}` : "";
      st.className = "cc-formid-status" + (r.formId && !inList && r.formValidated ? " ok" : "");
    }
    const step = r.step || 1;
    if (step >= 5 && r.resources) renderCcResourcesFromState();
    runGoStepShow(step);
    if (step === 2) renderCcNamePreview();
    if (step === 4) renderCcSparkCounts();
    if (step === 6) renderCcReview();
  } else {
    ccShowView("home");
    renderCcTemplateList();
  }
}

function ccShowView(v) {
  ccState.view = v;
  document.getElementById("ccHome").hidden = v !== "home";
  document.getElementById("ccTplWizard").hidden = v !== "tpl";
  document.getElementById("ccRun").hidden = v !== "run";
  document.getElementById("ccTitle").textContent =
    v === "tpl" ? (ccState.tpl.id ? "Edit Template" : "New Template") : v === "run" ? "Run Template" : "Campaign Creator";
}

function ccSteps(containerId, current, total) {
  const spans = document.querySelectorAll(`#${containerId} span[data-step]`);
  spans.forEach((s) => {
    const n = +s.dataset.step;
    s.classList.toggle("active", n === current);
    s.classList.toggle("done", n < current);
  });
  void total;
}

// ---- home: template list ----

function renderCcTemplateList() {
  const el = document.getElementById("ccTemplateList");
  if (!ccState.templates.length) {
    el.innerHTML = `<p class="cc-empty">No templates yet. Create one to get started.</p>`;
    return;
  }
  el.innerHTML = ccState.templates
    .map((t) => {
      const c = t.config || {};
      const sub = `${t.campaign_type === "SALES" ? "Sales" : "Lead Gen"} · $${Number(c.daily_budget || 0)}/day · ${(c.location_labels || []).join(", ") || (c.location_ids || []).length + " location(s)"}`;
      return `<div class="cc-tpl-card" data-tpl-id="${t.id}">
        <div><div class="cc-tpl-name">${escapeHtml(t.name)}</div><div class="cc-tpl-sub">${escapeHtml(sub)}</div></div>
        <div class="cc-tpl-actions">
          <button class="icon-btn primary" data-tpl-use="${t.id}">Use</button>
          <button class="icon-btn" data-tpl-edit="${t.id}">Edit</button>
          <button class="icon-btn danger" data-tpl-del="${t.id}">Delete</button>
        </div></div>`;
    })
    .join("");
}

async function onCcTemplateListClick(e) {
  const use = e.target.closest("[data-tpl-use]");
  const edit = e.target.closest("[data-tpl-edit]");
  const del = e.target.closest("[data-tpl-del]");
  if (use) return openRunWizard(ccState.templates.find((t) => t.id === use.dataset.tplUse));
  if (edit) return openTplWizard(ccState.templates.find((t) => t.id === edit.dataset.tplEdit));
  if (del) {
    const t = ccState.templates.find((x) => x.id === del.dataset.tplDel);
    if (!t || !confirm(`Delete template “${t.name}”? Campaigns already created from it are unaffected.`)) return;
    try {
      await deleteCampaignTemplate(t.id);
      ccState.templates = ccState.templates.filter((x) => x.id !== t.id);
      renderCcTemplateList();
    } catch (err) {
      alert(err.message);
    }
  }
}

// ---- template wizard ----

function openTplWizard(tpl) {
  const d = ccState.tpl;
  d.id = tpl ? tpl.id : null;
  const c = (tpl && tpl.config) || {};
  d.name = tpl ? tpl.name : "";
  d.type = tpl ? tpl.campaign_type : "LEAD_GENERATION";
  d.cbo = c.cbo === undefined ? true : !!c.cbo;
  d.budget = c.daily_budget != null ? String(c.daily_budget) : "";
  d.locations = (c.location_ids || []).map((id, i) => ({ id: String(id), name: (c.location_labels || [])[i] || String(id) }));
  d.ages = new Set((c.age_groups && c.age_groups.length ? c.age_groups : CC_AGE_OPTS.map((o) => o.v)));
  d.gender = c.gender || "GENDER_UNLIMITED";
  d.deviceOs = c.device_os || "ALL";
  // ctas (new) wins; cta (single, legacy templates) is the fallback.
  d.ctas = new Set(Array.isArray(c.ctas) && c.ctas.length ? c.ctas : [c.cta || "LEARN_MORE"]);
  d.text = c.ad_text || "";
  d.cardEnabled = !!(c.interactive_card && c.interactive_card.enabled);
  d.cardUrl = (c.interactive_card && c.interactive_card.image_url) || "";
  d.countries = [];
  d.step = 1;

  ccShowView("tpl");
  document.getElementById("ccTplName").value = d.name;
  document.getElementById("ccTplCbo").checked = d.cbo;
  document.getElementById("ccTplBudget").value = d.budget;
  document.getElementById("ccTplGender").value = d.gender;
  document.getElementById("ccTplDeviceOs").value = d.deviceOs;
  renderTplCtaOptions();
  document.getElementById("ccTplText").value = d.text;
  document.getElementById("ccTplCard").checked = d.cardEnabled;
  document.getElementById("ccTplCardWrap").hidden = !d.cardEnabled;
  document.getElementById("ccTplCardUrl").value = d.cardUrl;
  document.getElementById("ccTplLocInput").value = "";
  syncTplTypeToggle();
  renderTplAgeChips();
  renderTplLocChips();
  tplGoStep(1);
  loadTplCountries();
}

function syncTplTypeToggle() {
  document.querySelectorAll("#ccTplType button").forEach((b) => b.classList.toggle("active", b.dataset.type === ccState.tpl.type));
}
function renderTplAgeChips() {
  document.getElementById("ccTplAge").innerHTML = CC_AGE_OPTS.map(
    (o) => `<span class="cc-chip${ccState.tpl.ages.has(o.v) ? " on" : ""}" data-age="${o.v}">${o.l}</span>`
  ).join("");
}
function renderTplLocChips() {
  const el = document.getElementById("ccTplLocChips");
  el.innerHTML = ccState.tpl.locations
    .map((l) => `<span class="cc-chip on">${escapeHtml(l.name)} <span class="x" data-loc-remove="${escapeHtml(l.id)}">✕</span></span>`)
    .join("");
}

async function loadTplCountries() {
  const d = ccState.tpl;
  const hint = document.getElementById("ccTplLocHint");
  if (!tiktokState.connections.length) {
    hint.textContent = "Connect a TikTok Business Center to load the location list.";
    return;
  }
  // Templates aren't tied to one ad account — the account is picked later, at
  // launch. So this pulls the union of every country any Approved account can
  // target (across every connected BC), not just what one account allows.
  hint.textContent = "Loading TikTok location list…";
  d.countriesLoading = true;
  try {
    const data = await fetchTemplateCountries();
    d.countries = data.countries || [];
    hint.textContent = d.countries.length ? "" : "TikTok returned no locations for any connected account.";
  } catch (err) {
    hint.textContent = `Couldn't load locations: ${err.message}`;
  } finally {
    d.countriesLoading = false;
  }
}

function renderTplLocSuggest(query) {
  const box = document.getElementById("ccTplLocSuggest");
  const q = String(query || "").trim().toLowerCase();
  if (!q || !ccState.tpl.countries.length) {
    box.hidden = true;
    return;
  }
  const hits = ccState.tpl.countries
    .filter((c) => c.name.toLowerCase().includes(q) || String(c.code || "").toLowerCase() === q)
    .slice(0, 8);
  box.hidden = !hits.length;
  box.innerHTML = hits
    .map((c) => `<button type="button" data-loc-id="${escapeHtml(c.location_id)}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`)
    .join("");
}

function tplGoStep(n) {
  ccState.tpl.step = n;
  document.getElementById("ccTplStep1").hidden = n !== 1;
  document.getElementById("ccTplStep2").hidden = n !== 2;
  document.getElementById("ccTplStep3").hidden = n !== 3;
  ccSteps("ccTplSteps", n);
  ["ccTplErr1", "ccTplErr2", "ccTplErr3"].forEach((id) => (document.getElementById(id).textContent = ""));

  if (n === 2) {
    // pull step-1 values into the draft
    ccState.tpl.name = document.getElementById("ccTplName").value.trim();
    ccState.tpl.cbo = document.getElementById("ccTplCbo").checked;
    ccState.tpl.budget = document.getElementById("ccTplBudget").value;
    const err = document.getElementById("ccTplErr1");
    if (!ccState.tpl.name) return (tplGoBack(1), (err.textContent = "Enter a template name."));
    if (!(Number(ccState.tpl.budget) > 0)) return (tplGoBack(1), (err.textContent = "Enter a daily budget greater than 0."));
  }
  if (n === 3) {
    ccState.tpl.gender = document.getElementById("ccTplGender").value;
    ccState.tpl.deviceOs = document.getElementById("ccTplDeviceOs").value;
    if (!ccState.tpl.locations.length) return (tplGoBack(2), (document.getElementById("ccTplErr2").textContent = "Add at least one location."));
    if (!ccState.tpl.ages.size) return (tplGoBack(2), (document.getElementById("ccTplErr2").textContent = "Select at least one age range."));
  }
}
function tplGoBack(n) {
  ccState.tpl.step = n;
  document.getElementById("ccTplStep1").hidden = n !== 1;
  document.getElementById("ccTplStep2").hidden = n !== 2;
  document.getElementById("ccTplStep3").hidden = n !== 3;
  ccSteps("ccTplSteps", n);
}

async function saveTplWizard() {
  const d = ccState.tpl;
  d.text = document.getElementById("ccTplText").value.trim();
  d.cardEnabled = document.getElementById("ccTplCard").checked;
  d.cardUrl = document.getElementById("ccTplCardUrl").value.trim();
  const err = document.getElementById("ccTplErr3");
  err.textContent = "";
  if (d.cardEnabled && !d.cardUrl) return (err.textContent = "Add the card image link or turn Interactive Card off.");

  const config = {
    cbo: d.cbo,
    daily_budget: Number(d.budget),
    location_ids: d.locations.map((l) => l.id),
    location_labels: d.locations.map((l) => l.name),
    age_groups: CC_AGE_OPTS.map((o) => o.v).filter((v) => d.ages.has(v)),
    gender: d.gender,
    device_os: d.deviceOs,
    ctas: CC_CTA_OPTS.filter((v) => d.ctas.has(v)),
    ad_text: d.text,
    interactive_card: { enabled: d.cardEnabled, image_url: d.cardUrl },
  };
  const btn = document.getElementById("ccTplSave");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const payload = { action: d.id ? "update" : "create", name: d.name, campaign_type: d.type, config };
    if (d.id) payload.id = d.id;
    const res = await saveCampaignTemplate(payload);
    const saved = res.template;
    const i = ccState.templates.findIndex((t) => t.id === saved.id);
    if (i >= 0) ccState.templates[i] = saved;
    else ccState.templates.push(saved);
    ccState.templates.sort((a, b) => a.name.localeCompare(b.name));
    ccShowView("home");
    renderCcTemplateList();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Template";
  }
}

// ---- runtime wizard ----

function ccRunAdvs() {
  return advsForConnection(ccState.run.connectionId);
}
function ccSelectedAdvs() {
  return ccRunAdvs().filter((a) => ccState.run.selected.has(String(a.advertiser_id)));
}

function openRunWizard(tpl) {
  if (!tpl) return;
  ccResetRunDraft();
  const r = ccState.run;
  r.template = tpl;
  ccShowView("run");
  document.getElementById("ccRunTplLabel").innerHTML =
    `Template: <strong>${escapeHtml(tpl.name)}</strong> · ${tpl.campaign_type === "SALES" ? "Sales" : "Lead Generation"} · $${Number((tpl.config || {}).daily_budget || 0)}/day`;
  document.getElementById("ccRunBase").value = "";
  document.getElementById("ccRunSpark").value = "";
  document.getElementById("ccRunLinks").value = "";
  document.getElementById("ccRunFormId").value = "";
  document.getElementById("ccRunFormIdStatus").textContent = "";
  document.getElementById("ccRunTzBlocks").innerHTML = "";
  document.getElementById("ccRunAdvSearch").value = "";
  // r.submitting is false here (ccResetRunDraft(), called just above, resets
  // it) — sync the Create button/progress line to that now, so a fresh run
  // never inherits a completed prior run's "Creating…"/disabled button.
  ccSyncCreateUi();

  const sel = document.getElementById("ccRunBcSelect");
  if (!tiktokState.connections.length) {
    sel.innerHTML = "";
    document.getElementById("ccRunAdvList").innerHTML = `<p class="tk-empty">No TikTok Business Centers connected. Add one under Tools → TikTok Ads first.</p>`;
    document.getElementById("ccRunSummary").innerHTML = "";
  } else {
    sel.innerHTML = tiktokState.connections.map((c) => `<option value="${c.id}">${escapeHtml(connBcOptionLabel(c))}</option>`).join("");
    r.connectionId = tiktokState.connections[0].id;
    sel.value = r.connectionId;
    renderCcRunAdvertisers();
  }
  runGoStep(1);
}

function renderCcRunAdvertisers() {
  const advs = ccRunAdvs();
  const approved = advs.filter((a) => advIsApproved(a)).length;
  document.getElementById("ccRunSummary").innerHTML = `
    <span class="tk-sum-item"><strong>${advs.length}</strong> account${advs.length === 1 ? "" : "s"}</span>
    <span class="tk-sum-item ok"><strong>${approved}</strong> Approved</span>
    <span class="tk-sum-item warn"><strong>${advs.length - approved}</strong> Suspended</span>`;
  // Search box lives outside this container (static markup) so re-rendering
  // the rows never steals its focus/cursor.
  const query = document.getElementById("ccRunAdvSearch")?.value || "";
  const shown = filterAdvsByQuery(advs, query);
  const wrap = document.getElementById("ccRunAdvList");
  const campMap = campaignNameByAdvertiser();
  wrap.innerHTML = shown.length
    ? shown.map((a) => {
        const ok = advIsApproved(a);
        const id = String(a.advertiser_id);
        const meta = [id, a.currency || null, a.display_timezone || a.timezone || null].filter(Boolean).join(" · ");
        const campaignName = campMap.get(id);
        return `<label class="tk-adv${ok ? "" : " disabled"}">
          <input type="checkbox" data-cc-adv="${escapeHtml(id)}" ${ccState.run.selected.has(id) ? "checked" : ""} ${ok ? "" : "disabled"} />
          <span class="tk-adv-main"><span class="tk-adv-name">${escapeHtml(a.advertiser_name || id)}</span><span class="tk-adv-meta">${escapeHtml(meta)}${campaignName ? ` <span class="tk-adv-campaign">| ${escapeHtml(campaignName)}</span>` : ""}</span></span>
          <span class="tk-adv-status ${ok ? "ok" : "warn"}">${ok ? "Approved" : "Suspended"}</span>
        </label>`;
      }).join("")
    : `<p class="tk-empty">${advs.length ? "No accounts match your search." : "No advertiser accounts under this Business Center."}</p>`;
  syncCcRunSelectAll();
  document.getElementById("ccRunNext1").disabled = ccState.run.selected.size === 0;
}
function syncCcRunSelectAll() {
  const approved = ccRunAdvs().filter((a) => advIsApproved(a));
  const cb = document.getElementById("ccRunSelectAll");
  cb.checked = approved.length > 0 && approved.every((a) => ccState.run.selected.has(String(a.advertiser_id)));
  cb.disabled = approved.length === 0;
}

// Campaign names from a base that already carries its own starting number
// (e.g. "ad1" -> ad1, ad2, ad3…; "ad136" -> ad136, ad137, ad138…) so a batch
// can pick up exactly where a previous one left off. A base with no trailing
// digits (e.g. "ad") falls back to the original base+1, base+2… behavior.
// Mirrors campaignNamesFromBase in netlify/functions/campaign-creator-run.js —
// this copy drives the live preview/review UI; the exact list it computes is
// also what gets sent as `names` at submit time, so preview == reality.
function ccCampaignNames(base, count) {
  const b = String(base || "").trim();
  const m = /^(.*?)(\d+)$/.exec(b);
  if (m) {
    const prefix = m[1];
    const start = parseInt(m[2], 10);
    return Array.from({ length: count }, (_, i) => `${prefix}${start + i}`);
  }
  return Array.from({ length: count }, (_, i) => `${b}${i + 1}`);
}

function renderCcNamePreview() {
  const advs = ccSelectedAdvs();
  const base = ccState.run.base.trim();
  const names = base ? ccCampaignNames(base, advs.length) : [];
  document.getElementById("ccRunNamePreview").innerHTML = advs
    .map((a, i) => `<div class="row"><span>${escapeHtml(a.advertiser_name || a.advertiser_id)}</span><strong>${names[i] ? escapeHtml(names[i]) : "—"}</strong></div>`)
    .join("");
}

const ccAdvTz = (a) => a.timezone || a.display_timezone || "America/New_York";
function ccLocalTime(tz) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date());
  } catch (_) {
    return "—";
  }
}
// Today's calendar date IN that timezone as "YYYY-MM-DD" (never the browser's).
function ccLocalDate(tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}
// Selected advertisers grouped by their configured timezone.
function ccTzGroups() {
  const groups = new Map();
  for (const a of ccSelectedAdvs()) {
    const tz = ccAdvTz(a);
    if (!groups.has(tz)) groups.set(tz, []);
    groups.get(tz).push(a);
  }
  return groups;
}

// Default schedule for a timezone: that advertiser's current local time minus
// 3 hours. Computed by shifting the actual UTC instant (never by subtracting on
// the wall-clock string), then re-reading date/hour/minute AS SEEN in `tz` — so
// a local time within 3h of midnight correctly rolls the date back a day too
// (e.g. 02:30 Sep 5 local -> 23:30 Sep 4 local), with no separate rollover logic
// needed. Still well inside TikTok's accepted "up to ~12h in the past" window.
function ccMinus3hDefault(tz) {
  const shifted = new Date(Date.now() - 3 * 60 * 60 * 1000);
  try {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(shifted);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "8", 10) % 24;
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    return { date, hour, minute };
  } catch (_) {
    return { date: ccLocalDate(tz), hour: 8, minute: 0 };
  }
}

// One schedule block per advertiser timezone. Each block: tz name, current local
// time, account count, and a DATE + HOUR + MINUTE picker. The date/time default
// to that timezone's current local time minus 3 hours (see ccMinus3hDefault).
// Existing picks in ccState.run.schedules are preserved.
function renderCcTzBlocks() {
  const groups = ccTzGroups();
  const sched = ccState.run.schedules;
  // drop stale timezones no longer selected
  for (const tz of Object.keys(sched)) if (!groups.has(tz)) delete sched[tz];

  const hourOpts = (sel) =>
    Array.from({ length: 24 }, (_, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${String(i).padStart(2, "0")}</option>`).join("");
  const minOpts = (sel) =>
    Array.from({ length: 60 }, (_, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${String(i).padStart(2, "0")}</option>`).join("");

  const html = [...groups.entries()]
    .map(([tz, advs]) => {
      if (!sched[tz]) sched[tz] = ccMinus3hDefault(tz);
      const s = sched[tz];
      if (!s.date) s.date = ccLocalDate(tz);
      const today = ccLocalDate(tz);
      // min stays "today" normally; relaxed to the (earlier) default date so the
      // minus-3h default is never marked invalid by its own min attribute.
      const minDate = s.date < today ? s.date : today;
      return `<div class="cc-tzblock" data-tz="${escapeHtml(tz)}">
        <div class="cc-tzblock-head"><strong>${escapeHtml(tz)}</strong>
          <span>${advs.length} account${advs.length === 1 ? "" : "s"} · now ${escapeHtml(ccLocalTime(tz))}</span></div>
        <div class="cc-tzblock-fields">
          <label>Date <input type="date" data-sched="date" value="${escapeHtml(s.date)}" min="${escapeHtml(minDate)}" /></label>
          <label>Time <select data-sched="hour">${hourOpts(s.hour)}</select> : <select data-sched="minute">${minOpts(s.minute)}</select></label>
        </div>
      </div>`;
    })
    .join("");
  document.getElementById("ccRunTzBlocks").innerHTML = html || `<p class="eng-hint">Select accounts first.</p>`;
}

function renderCcSparkCounts() {
  const n = ccSelectedAdvs().length;
  const sc = ccState.run.spark.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  const lc = ccState.run.links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  const mark = (c) => (c === n ? "✓" : "✗");
  document.getElementById("ccRunSparkCount").textContent = `${sc} spark code${sc === 1 ? "" : "s"} ${mark(sc)}  (need ${n})`;
  document.getElementById("ccRunLinksCount").textContent = `${lc} post link${lc === 1 ? "" : "s"} ${mark(lc)}  (need ${n})`;
}

async function runGoStep(n) {
  if (n < 1) return ccShowView("home");
  const r = ccState.run;
  r.step = n;
  for (const s of [1, 2, 3, 4, 5, 6, 7]) document.getElementById(`ccRunStep${s}`).hidden = s !== n;
  ccSteps("ccRunSteps", Math.min(n, 6));
  for (const id of ["ccRunErr1", "ccRunErr2", "ccRunErr3", "ccRunErr4", "ccRunErr5", "ccRunErr6"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  }

  if (n === 2) {
    if (!ccState.run.selected.size) return runGoStep(1);
    renderCcNamePreview();
  }
  if (n === 3) {
    r.base = document.getElementById("ccRunBase").value.trim();
    if (!r.base) { document.getElementById("ccRunErr2").textContent = "Enter a campaign name base."; return runGoStepShow(2); }
    renderCcTzBlocks();
  }
  if (n === 4) {
    // snapshot the schedule blocks before leaving step 3
    document.querySelectorAll("#ccRunTzBlocks [data-tz]").forEach((b) => {
      const tz = b.dataset.tz;
      r.schedules[tz] = {
        date: b.querySelector('[data-sched="date"]')?.value || ccLocalDate(tz),
        hour: +(b.querySelector('[data-sched="hour"]')?.value || 8),
        minute: +(b.querySelector('[data-sched="minute"]')?.value || 0),
      };
    });
    renderCcSparkCounts();
  }
  if (n === 5) {
    const need = ccSelectedAdvs().length;
    const sc = r.spark.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const lc = r.links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (sc.length !== need || lc.length !== need) {
      document.getElementById("ccRunErr4").textContent = `Need exactly ${need} spark codes and ${need} post links (one per line).`;
      return runGoStepShow(4);
    }
    await loadCcResources();
  }
  if (n === 6) {
    console.log("[cc] resources next -> review");
    renderCcReview();
  }
}
function runGoStepShow(n) {
  ccState.run.step = n;
  for (const s of [1, 2, 3, 4, 5, 6, 7]) document.getElementById(`ccRunStep${s}`).hidden = s !== n;
  ccSteps("ccRunSteps", Math.min(n, 6));
}

async function loadCcResources() {
  const r = ccState.run;
  const type = r.template.campaign_type;
  document.getElementById("ccRunResLoading").hidden = false;
  document.getElementById("ccRunResBody").hidden = true;
  document.getElementById("ccRunNext5").disabled = true;
  const rememberedIds = type === "LEAD_GENERATION" ? loadRememberedForms().map((f) => f.id) : [];
  try {
    r.resources = await campaignCreatorResources(
      r.connectionId,
      type,
      ccSelectedAdvs().map((a) => String(a.advertiser_id)),
      rememberedIds
    );
  } catch (err) {
    document.getElementById("ccRunResLoading").hidden = true;
    document.getElementById("ccRunErr5").textContent = err.message;
    return;
  }
  // A fresh preflight resets the form pick so stale values can't carry.
  r.formId = "";
  r.formLabel = "";
  r.formValidated = false;
  document.getElementById("ccRunFormId").value = "";
  document.getElementById("ccRunFormIdStatus").textContent = "";
  renderCcResourcesFromState();
}

// Confirm a manually-typed Form ID works for the selected accounts.
async function validateCcFormId(pageId) {
  const r = ccState.run;
  const st = document.getElementById("ccRunFormIdStatus");
  if (document.getElementById("ccRunFormId").value.trim() !== pageId) return; // stale
  let res;
  try {
    res = await validateCampaignForm(r.connectionId, ccSelectedAdvs().map((a) => String(a.advertiser_id)), pageId);
  } catch (err) {
    st.textContent = `✗ ${err.message}`;
    st.className = "cc-formid-status bad";
    return;
  }
  if (document.getElementById("ccRunFormId").value.trim() !== pageId) return;
  if (res.ok) {
    const nm = res.name || `Form ${pageId}`;
    r.formId = pageId;
    r.formLabel = nm;
    r.formValidated = true;
    rememberForm(pageId, nm);
    const bad = (res.checks || []).filter((c) => !c.ok).length;
    st.textContent = `✓ ${nm}${bad ? ` — not linked to ${bad} of ${res.checks.length} checked account(s)` : ""}`;
    st.className = bad ? "cc-formid-status busy" : "cc-formid-status ok";
    // add/refresh the dropdown option so Review + resume show the name
    const fs = document.getElementById("ccRunForm");
    if (![...fs.options].some((o) => o.value === pageId)) {
      const opt = document.createElement("option");
      opt.value = pageId;
      opt.textContent = nm;
      fs.appendChild(opt);
    }
  } else {
    const err = (res.checks || []).find((c) => !c.ok)?.error || res.error || "not usable by the selected accounts";
    st.textContent = `✗ ${err}`;
    st.className = "cc-formid-status bad";
    r.formValidated = false;
  }
  syncCcRunNext5();
}

// Render step-5 controls purely from ccState.run.resources (also used on resume).
function renderCcResourcesFromState() {
  const r = ccState.run;
  const res = r.resources || {};
  const type = r.template.campaign_type;
  const isLead = type === "LEAD_GENERATION";

  document.getElementById("ccRunResLoading").hidden = true;
  document.getElementById("ccRunResBody").hidden = false;

  document.getElementById("ccRunFormWrap").hidden = !isLead;
  document.getElementById("ccRunSalesNote").hidden = isLead;

  if (isLead) {
    const fs = document.getElementById("ccRunForm");
    const forms = res.forms || [];
    fs.innerHTML = forms.length
      ? [`<option value="">— select a form —</option>`]
          .concat(forms.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name || f.id)}</option>`))
          .join("")
      : `<option value="">— paste your Form ID below —</option>`;
    const manual = document.getElementById("ccRunFormId");
    if (manual.value.trim()) {
      r.formId = manual.value.trim();
    } else if (r.formId && [...fs.options].some((o) => o.value === r.formId)) {
      fs.value = r.formId;
      r.formValidated = true;
    } else if (forms.length === 1) {
      fs.value = forms[0].id;
      r.formId = forms[0].id;
      r.formLabel = forms[0].name || forms[0].id;
      r.formValidated = true;
    } else {
      r.formId = "";
      r.formLabel = "";
      r.formValidated = false;
      fs.value = "";
    }
  }
  // Sales has nothing to pick here — optimization goal/event are fixed and
  // resolved automatically per advertiser at creation time.

  const notes = [];
  for (const b of res.blockers || []) notes.push(`<div class="note bad">✖ ${escapeHtml(b)}</div>`);
  for (const n of res.form_notes || []) notes.push(`<div class="note">⚠ ${escapeHtml(n)}</div>`);
  for (const a of res.advertisers || []) {
    for (const nt of a.notes || []) notes.push(`<div class="note">⚠ ${escapeHtml(a.advertiser_name)}: ${escapeHtml(nt)}</div>`);
  }
  document.getElementById("ccRunResNotes").innerHTML = notes.join("");
  syncCcRunNext5();
}

function syncCcRunNext5() {
  const r = ccState.run;
  const res = r.resources || {};
  const isLead = r.template.campaign_type === "LEAD_GENERATION";
  const hardBlock = (res.blockers || []).length > 0;
  // Identity is never a blocker (Auto always works). Lead Gen needs a form pick;
  // Sales needs nothing here (optimization is fixed / automatic).
  const ok = !hardBlock && (!isLead || !!r.formId);
  document.getElementById("ccRunNext5").disabled = !ok;
}

function renderCcReview() {
  console.log("[cc] render review");
  // Rendering Review is display-only — it NEVER sets/changes creating state.
  // It only syncs the button/progress to whatever ccState.run.submitting
  // already is, so a re-render (Back/Next, resume, revisiting this step)
  // always shows the true state instead of a stale one.
  ccSyncCreateUi();
  const r = ccState.run;
  const advs = ccSelectedAdvs();
  const base = r.base.trim();
  const names = ccCampaignNames(base, advs.length);
  const sc = r.spark.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const lc = r.links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const isLead = r.template.campaign_type === "LEAD_GENERATION";
  const pageByAdv = new Map((r.resources?.advertisers || []).map((a) => [String(a.advertiser_id), a.instant_page]));
  const pad = (n) => String(n).padStart(2, "0");
  const schedText = (tz) => {
    const s = r.schedules[tz] || {};
    return `${s.date || ccLocalDate(tz)} · ${pad(s.hour ?? 8)}:${pad(s.minute ?? 0)}`;
  };

  document.getElementById("ccRunReview").innerHTML =
    `<div class="row"><span>Identity</span><strong>Auto — each Spark code's own identity</strong></div>` +
    (isLead
      ? `<div class="row"><span>Instant Form</span><strong>${escapeHtml(r.formLabel || r.formId || "—")}</strong></div>`
      : `<div class="row"><span>Optimization</span><strong>Conversion — Highest Volume (Instant Page, no pixel)</strong></div>`) +
    advs
      .map((a, i) => {
        const id = String(a.advertiser_id);
        const tz = ccAdvTz(a);
        const page = !isLead ? `<div class="row"><span>Instant Page</span><strong>${escapeHtml(pageByAdv.get(id) || "newest (auto)")}</strong></div>` : "";
        return `<div class="rev-acct">${escapeHtml(a.advertiser_name || id)}</div>
          <div class="row"><span>Campaign</span><strong>${escapeHtml(names[i])}</strong></div>
          <div class="row"><span>Start</span><strong>${escapeHtml(schedText(tz))} <em>(${escapeHtml(tz)})</em></strong></div>
          <div class="row"><span>Spark code</span><strong>#${i + 1} · ${escapeHtml((sc[i] || "").slice(0, 10))}…</strong></div>
          <div class="row"><span>Post link</span><strong>${escapeHtml((lc[i] || "").replace(/^https:\/\/(www\.)?/, "").slice(0, 44))}</strong></div>
          ${page}`;
      })
      .join("");
}

// The ONLY place that calls the create API — wired ONCE (wireCampaignCreatorEvents
// runs a single time at init) solely to the Review step's explicit "Create
// Campaigns" button click. The re-entry guard trusts ONLY ccState.run.submitting
// — an in-memory flag that ccResetRunDraft() reliably resets to false at the
// start of every run — never the button's own `disabled` DOM property, which is
// static/persistent state that previously went stale across runs and caused
// this exact handler to silently no-op on a real click (see ccSyncCreateUi).
// One create request creates campaigns sequentially server-side (~9s each —
// TikTok campaign -> ad group -> Spark ad, in series) and the serverless
// function has a hard ~60s wall-clock limit, so a single request safely fits
// about 6 accounts. A batch bigger than that is split into consecutive
// requests of this size — this is the ONLY thing that caps how many accounts
// fit per request; the total batch size has no cap, it just takes
// proportionally longer (more requests) for larger batches.
const CC_CREATE_CHUNK_SIZE = 6;

async function submitCampaignCreator() {
  const r = ccState.run;
  console.log("[cc] create clicked", { submitting: r.submitting });
  if (r.submitting) {
    console.log("[cc] create clicked while already submitting — ignored");
    return;
  }
  r.submitting = true;
  ccSyncCreateUi(); // -> button disabled + "Creating…"
  const prog = document.getElementById("ccRunProgress");
  const advs = ccSelectedAdvs();
  const total = advs.length;
  const sparkAll = r.spark.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const linksAll = r.links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const namesAll = ccCampaignNames(r.base.trim(), total);
  const chunkCount = Math.ceil(total / CC_CREATE_CHUNK_SIZE);
  const allResults = [];

  try {
    for (let c = 0; c < chunkCount; c++) {
      const start = c * CC_CREATE_CHUNK_SIZE;
      const end = Math.min(start + CC_CREATE_CHUNK_SIZE, total);
      const chunkAdvs = advs.slice(start, end);

      prog.className = "eng-placeholder busy";
      prog.textContent = chunkCount > 1
        ? `Creating ${total} campaigns… batch ${c + 1}/${chunkCount} (${allResults.filter((x) => x.status === "Created").length} done so far).`
        : `Creating ${total} campaign${total === 1 ? "" : "s"}… this can take a minute.`;

      console.log(`[cc] create request started (batch ${c + 1}/${chunkCount}, ${chunkAdvs.length} accounts)`);
      try {
        const res = await runCampaignCreator({
          template_id: r.template.id,
          campaign_type: r.template.campaign_type,
          connection_id: r.connectionId,
          advertiser_ids: chunkAdvs.map((a) => String(a.advertiser_id)),
          base_name: r.base.trim(),
          names: namesAll.slice(start, end),
          schedules: r.schedules,
          spark_codes: sparkAll.slice(start, end),
          post_links: linksAll.slice(start, end),
          form_id: r.formId || undefined,
        });
        allResults.push(...(res.results || []));
      } catch (chunkErr) {
        // One batch failing outright (network error, etc.) never stops the
        // rest — the remaining batches still run, this one's accounts are
        // just recorded as failed.
        console.log(`[cc] batch ${c + 1}/${chunkCount} request failed:`, chunkErr.message);
        chunkAdvs.forEach((a, i) => {
          allResults.push({
            advertiser_id: String(a.advertiser_id),
            advertiser_name: a.advertiser_name || String(a.advertiser_id),
            campaign_name: namesAll[start + i],
            status: "Failed",
            error: chunkErr.message,
          });
        });
      }
    }
    console.log("[cc] create request finished");
    renderCcResults(allResults);
    runGoStepShow(7);
    ccSteps("ccRunSteps", 6);
    ccState.run.step = 7;
    loadTiktokCampaigns();
    runCampaignCreatorDuplication();
  } catch (e2) {
    console.log("[cc] create request failed:", e2.message);
    document.getElementById("ccRunErr6").textContent = e2.message;
  } finally {
    // Single point that flips submitting back off AND re-syncs the DOM to it —
    // covers both success (button just goes idle behind the now-hidden Review
    // step) and failure (button/progress become usable again, error already
    // shown above) so the UI can never stay stuck on "Creating…".
    r.submitting = false;
    ccSyncCreateUi();
  }
}

function renderCcResults(results) {
  const el = document.getElementById("ccRunResults");
  const tone = (s) => (s === "Created" ? "ok" : s === "Skipped" ? "warn" : "bad");
  const created = results.filter((r) => r.status === "Created").length;
  const failed = results.filter((r) => r.status === "Failed").length;
  const skipped = results.filter((r) => r.status === "Skipped").length;
  el.innerHTML =
    `<div class="wh-result-row"><span class="wh-r-detail"><strong>${created}</strong> Created · <strong>${failed}</strong> Failed${skipped ? ` · <strong>${skipped}</strong> Skipped` : ""}</span></div>` +
    results
      .map((r) => {
        const warn = (r.warnings || []).map((w) => `<div class="wh-r-detail">⚠ ${escapeHtml(w)}</div>`).join("");
        return `<div class="wh-result-row ${tone(r.status)}">
          <span class="wh-r-name">${escapeHtml(r.advertiser_name || r.advertiser_id)} — ${escapeHtml(r.campaign_name || "")}</span>
          <span class="wh-r-status">${escapeHtml(r.status)}${r.error ? ` <span class="wh-r-detail">— ${escapeHtml(r.error)}</span>` : ""}${warn}</span>
        </div>`;
      })
      .join("");
}

// ============================== MANUAL DUPE (Detailed Metrics) ==============================
// Duplication no longer starts automatically once a Campaign Creator
// campaign goes Active (see _shared/campaign-creator.js — it now stops at
// dupe_status READY) — this "Dupe" button + modal is the only thing that
// starts it, via the manual_dupe action. Lists every currently-Active
// campaign from Detailed Metrics, merges in its duplication progress (if
// registered), and lets the user pick which to duplicate and how many copies.

const dupeState = { campaigns: [], selected: new Set() };

function wireDupeEvents() {
  document.getElementById("openDupeModalBtn").addEventListener("click", openDupeModal);
  document.getElementById("closeDupeModal").addEventListener("click", closeDupeModal);
  document.getElementById("cancelDupeBtn").addEventListener("click", closeDupeModal);
  document.getElementById("dupeModal").addEventListener("click", (e) => {
    if (e.target.id === "dupeModal") closeDupeModal();
  });
  document.getElementById("dupeList").addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-dupe-campaign]');
    if (!cb) return;
    const id = cb.dataset.dupeCampaign;
    if (cb.checked) dupeState.selected.add(id);
    else dupeState.selected.delete(id);
    syncDupeConfirmButton();
  });
  document.getElementById("confirmDupeBtn").addEventListener("click", submitManualDupe);
}

function closeDupeModal() {
  document.getElementById("dupeModal").classList.remove("open");
}

async function openDupeModal() {
  document.getElementById("dupeModal").classList.add("open");
  dupeState.selected.clear();
  document.getElementById("dupeCount").value = "20";
  document.getElementById("dupeError").textContent = "";
  document.getElementById("dupeProgress").textContent = "";
  document.getElementById("dupeProgress").className = "eng-placeholder";
  await loadDupeCampaigns();
}

// Active campaigns come straight from Detailed Metrics' own data (already
// loaded) — WH Warmup campaigns are excluded, they're never duplicated.
// Duplication progress (if any) is merged in from the Campaign Creator
// registry so the list shows exactly what's eligible and what's already done.
async function loadDupeCampaigns() {
  const list = document.getElementById("dupeList");
  list.innerHTML = `<p class="tk-loading">Loading active campaigns…</p>`;
  const active = state.tiktokCampaigns.filter((c) => c.effective_status === "Active" && !c.is_wh_warmup);
  if (!active.length) {
    dupeState.campaigns = [];
    list.innerHTML = `<p class="tk-empty">No Active campaigns right now.</p>`;
    syncDupeConfirmButton();
    return;
  }
  let progressById = new Map();
  try {
    const res = await listCampaignCreatorCampaigns();
    progressById = new Map((res.campaigns || []).map((r) => [String(r.campaign_id), r]));
  } catch (_) {
    /* progress is a nice-to-have — the list still renders without it */
  }
  dupeState.campaigns = active.map((c) => {
    const p = progressById.get(String(c.campaign_id));
    return {
      campaign_id: String(c.campaign_id),
      campaign_name: c.campaign_name || c.campaign_id,
      advertiser_name: c.advertiser_name || c.advertiser_id,
      registered: !!p,
      dupe_status: p ? p.dupe_status : null,
      dupe_created: p ? Number(p.dupe_created) || 0 : 0,
      dupe_target: p ? Number(p.dupe_target) || 20 : 20,
      waiting: !!p && p.dupe_status === "WAITING_FOR_ACTIVE",
    };
  });
  renderDupeList();
}

function dupeProgressNote(c) {
  if (!c.registered) return "Not a Campaign Creator campaign";
  if (c.waiting) return "Ad group not yet confirmed Active";
  if (c.dupe_status === "COMPLETE") return `Done — ${c.dupe_created}/${c.dupe_target}`;
  if (c.dupe_status === "DUPLICATING") return `In progress — ${c.dupe_created}/${c.dupe_target}`;
  if (c.dupe_status === "FAILED") return `Failed at ${c.dupe_created}/${c.dupe_target} — pick again to retry`;
  return "Ready to duplicate";
}

function renderDupeList() {
  const list = document.getElementById("dupeList");
  const rows = dupeState.campaigns
    .map((c) => {
      const disabled = !c.registered || c.waiting;
      return `<label class="tk-adv${disabled ? " disabled" : ""}">
        <input type="checkbox" data-dupe-campaign="${escapeHtml(c.campaign_id)}" ${disabled ? "disabled" : ""} ${dupeState.selected.has(c.campaign_id) ? "checked" : ""} />
        <span class="tk-adv-main">
          <span class="tk-adv-name">${escapeHtml(c.campaign_name)}</span>
          <span class="tk-adv-meta">${escapeHtml(c.advertiser_name)} · ${escapeHtml(dupeProgressNote(c))}</span>
        </span>
      </label>`;
    })
    .join("");
  list.innerHTML = `<div class="tk-adv-list">${rows}</div>`;
  syncDupeConfirmButton();
}

function syncDupeConfirmButton() {
  document.getElementById("confirmDupeBtn").disabled = dupeState.selected.size === 0;
}

async function submitManualDupe() {
  const err = document.getElementById("dupeError");
  const prog = document.getElementById("dupeProgress");
  const btn = document.getElementById("confirmDupeBtn");
  err.textContent = "";
  const count = Number(document.getElementById("dupeCount").value);
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    err.textContent = "Enter a number of dupes between 1 and 100.";
    return;
  }
  const ids = [...dupeState.selected];
  if (!ids.length || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "Duplicating…";
  prog.className = "eng-placeholder busy";
  prog.textContent = `Duplicating ${ids.length} campaign${ids.length === 1 ? "" : "s"}… this can take a minute.`;
  try {
    const res = await runManualDupe(ids, count);
    const results = res.results || [];
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    prog.className = "eng-placeholder";
    prog.textContent = `${ok} campaign${ok === 1 ? "" : "s"} started/updated${failed ? `, ${failed} failed` : ""}.`;
    const failMsgs = results.filter((r) => !r.ok).map((r) => `${r.campaign_id}: ${r.error}`);
    if (failMsgs.length) err.textContent = failMsgs.join(" · ");
    dupeState.selected.clear();
    await loadDupeCampaigns();
    loadTiktokCampaigns();
    runCampaignCreatorDuplication();
  } catch (e2) {
    err.textContent = e2.message;
    prog.textContent = "";
    prog.className = "eng-placeholder";
  } finally {
    btn.disabled = false;
    btn.textContent = "Dupe";
    syncDupeConfirmButton();
  }
}

// ---- Business Center view filter (Detailed Metrics header) ----

// Every connected Business Center (from tiktokState.advertisers, loaded once
// at startup by loadTiktokConnectionsForBcFilter — see DOMContentLoaded),
// not just ones with campaigns currently in Detailed Metrics. A BC with zero
// campaigns still shows in the dropdown; selecting it just shows an empty
// table, same as any other filter with no matches.
function trackedBcOptions() {
  const map = new Map();
  for (const a of tiktokState.advertisers) {
    if (a && a.bc_id) map.set(String(a.bc_id), a.bc_name || `BC ${a.bc_id}`);
  }
  return [...map.entries()].map(([bc_id, bc_name]) => ({ bc_id, bc_name }));
}

function renderDetailBcSelector() {
  const wrap = document.getElementById("detailBcWrap");
  const select = document.getElementById("detailBcSelect");
  const opts = trackedBcOptions();

  // Show whenever at least one BC has campaigns — "All Business Centers" plus
  // each one, so the filter is always available rather than only once a 2nd
  // BC shows up. Only truly nothing to show when there are zero BCs at all.
  if (!opts.length) {
    wrap.hidden = true;
    state.detailBcFilter = "all";
    updateBcBalanceBanner();
    return;
  }

  if (!["all", ...opts.map((o) => o.bc_id)].includes(state.detailBcFilter)) {
    state.detailBcFilter = "all";
  }
  select.innerHTML =
    `<option value="all">All Business Centers</option>` +
    opts
      .map((o) => `<option value="${escapeHtml(o.bc_id)}" ${o.bc_id === state.detailBcFilter ? "selected" : ""}>${escapeHtml(o.bc_name)}</option>`)
      .join("");
  wrap.hidden = false;
  updateBcBalanceBanner();
}

function updateBcBalanceBanner() {
  const el = document.getElementById("detailBcBalance");
  const bcId = state.detailBcFilter;
  const bal = bcId !== "all" ? state.bcBalances[bcId] : null;
  if (!bal || bal.error || bal.balance == null) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const v = Number(bal.balance) || 0;
  // > $10 healthy · $5–$10 warning · < $5 danger
  const tone = v > 10 ? "ok" : v >= 5 ? "warn" : "bad";
  el.hidden = false;
  el.innerHTML = `<span class="bcbal-label">Available Balance</span><span class="bcbal-value tabular ${tone}">${money(v)}</span>`;
}

function toggleRowExpand(source) {
  const tr = document.querySelector(`tr.source-row[data-source="${cssEscapeAttr(source)}"]`);
  if (!tr) return;
  const isOpen = tr.classList.toggle("expanded");
  const s = state.sources.find((x) => x.source === source);
  if (isOpen) {
    state.expandedSources.add(source);
    if (s) renderAdGroupsPanel(s);
  } else {
    state.expandedSources.delete(source);
  }
}

// ---- expanded ad-group panel (lazy-loaded from TikTok MCP) ----

function panelEl(campaignId) {
  return document.querySelector(`.adgroups-panel[data-adgroups-for="${cssEscapeAttr(campaignId || "")}"]`);
}

// The gutter to the left of the (centered) ad-group table — shows which ad
// account this campaign runs under, so it doesn't have to be found by
// checking each account one by one. Empty when there's nothing to show yet
// (e.g. no tracked TikTok campaign at all).
function adAccountLabelHtml(s) {
  const name = s?.advertiserName || s?.advertiserId;
  if (!name) return "";
  return `<div class="adgroups-account"><div class="adgroups-account-label">Ad account</div><div class="adgroups-account-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div></div>`;
}

async function renderAdGroupsPanel(s, { force } = {}) {
  const panel = panelEl(s.campaignId);
  if (!panel) return;

  if (!s.hasTiktok || !s.campaignId) {
    panel.innerHTML = `<div class="adgroups-empty">No tracked TikTok campaign for this source — ad groups come from TikTok only.</div>`;
    return;
  }

  const acct = adAccountLabelHtml(s);
  const cached = state.adGroupsByCampaign[s.campaignId];
  const fresh = cached && Date.now() - cached.loadedAt < 60000 && !force;
  if (fresh && cached.rows) {
    paintAdGroups(panel, s, cached.rows);
    return;
  }
  if (cached && cached.error && !force) {
    panel.innerHTML = `<div class="adgroups-wrap">${acct}<div class="adgroups-error">Couldn't load ad groups: ${escapeHtml(cached.error)}</div></div>`;
    return;
  }

  panel.innerHTML = `<div class="adgroups-wrap">${acct}<div class="adgroups-loading">Loading ad groups…</div></div>`;
  try {
    const res = await fetchCampaignAdGroups(s.campaignId);
    state.adGroupsByCampaign[s.campaignId] = {
      loadedAt: Date.now(),
      rows: res.adgroups || [],
      appealState: res.appeal_state || "NONE",
      appealReasons: res.appeal_reasons || null,
      appealUnknownReasons: res.appeal_unknown_reasons || null,
      appealRawReasons: res.appeal_raw_reasons || null,
      appealAdgroupId: res.appeal_adgroup_id || null,
    };
    applyCampaignStatusResult(res); // keep the row status in sync with the live read
    const s2 = state.sources.find((x) => x.campaignId === s.campaignId) || s;
    const panel2 = panelEl(s.campaignId);
    if (panel2) paintAdGroups(panel2, s2, res.adgroups || []);
  } catch (err) {
    state.adGroupsByCampaign[s.campaignId] = { loadedAt: Date.now(), error: err.message };
    const p = panelEl(s.campaignId);
    if (p) p.innerHTML = `<div class="adgroups-wrap">${acct}<div class="adgroups-error">Couldn't load ad groups: ${escapeHtml(err.message)}</div></div>`;
  }
}

// Appeal states for which a rejection actually happened and a reason exists
// worth showing — button disappears once the appeal is approved (or there was
// never an appeal at all).
const REJECTION_REASON_VISIBLE_STATES = new Set([
  "REJECTED",
  "APPEAL_SUBMITTING",
  "APPEAL_UNDER_REVIEW",
  "APPEAL_REJECTED",
  "UNSUPPORTED",
]);

function paintAdGroups(panel, s, rows) {
  const acct = adAccountLabelHtml(s);
  if (!rows.length) {
    panel.innerHTML = `<div class="adgroups-wrap">${acct}<div class="adgroups-empty">This campaign has no ad groups.</div></div>`;
    return;
  }
  const cached = state.adGroupsByCampaign[s.campaignId] || {};
  panel.innerHTML = `
    <div class="adgroups-wrap">
      ${acct}
      <table class="adgroups-table">
        <colgroup>
          <col style="width:40px" /><col style="width:118px" /><col style="width:210px" /><col style="width:96px" /><col style="width:96px" /><col style="width:170px" />
        </colgroup>
        <thead>
          <tr><th>On/Off</th><th>Status</th><th>Ad group</th><th class="num">Spend</th><th class="num">CPA</th><th></th></tr>
        </thead>
        <tbody>
          ${rows.map((g) => adGroupRowHtml(s.campaignId, g, cached)).join("")}
        </tbody>
      </table>
    </div>`;
}

function adGroupRowHtml(campaignId, g, appealInfo) {
  const on = String(g.operation_status || "").toUpperCase() === "ENABLE";
  const pending = state.pendingActions.has(`g:${g.adgroup_id}`);
  const tone = ["good", "warn", "bad", "neutral"].includes(g.status_tone) ? g.status_tone : "neutral";
  const ai = appealInfo || {};
  const showReasonBtn =
    REJECTION_REASON_VISIBLE_STATES.has(ai.appealState) &&
    (!ai.appealAdgroupId || String(ai.appealAdgroupId) === String(g.adgroup_id));
  let reasonCell = "";
  if (showReasonBtn) {
    const payload = { groups: ai.appealReasons || [], unknown: ai.appealUnknownReasons || [] };
    reasonCell = `<button type="button" class="rejection-reason-btn" data-rejection-reason='${escapeHtml(
      JSON.stringify(payload)
    )}'>Rejection reason</button>`;
  }
  return `
    <tr data-adgroup-row="${escapeHtml(g.adgroup_id)}">
      <td class="toggle-cell">${switchHtml({
        on,
        pending,
        attrs: `data-adgroup-action="${on ? "DISABLE" : "ENABLE"}" data-campaign-id="${escapeHtml(campaignId)}" data-adgroup-id="${escapeHtml(g.adgroup_id)}"`,
        title: on ? "Ad group running — click to pause" : "Ad group paused — click to unpause",
      })}</td>
      <td><span class="status-badge ${tone}">${escapeHtml(g.status_label || "—")}</span></td>
      <td class="ag-name-cell"><span class="ag-name">${escapeHtml(g.adgroup_name || g.adgroup_id)}</span></td>
      <td class="num">${money(g.spend)}</td>
      <td class="num">${money(g.cpa)}</td>
      <td class="ag-reason-cell">${reasonCell}</td>
    </tr>`;
}

function openRejectionReasonModal(payloadJson) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (_) {
    payload = { groups: [], unknown: [] };
  }
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const unknown = Array.isArray(payload.unknown) ? payload.unknown : [];
  let html = "";
  for (const g of groups) {
    const texts = Array.isArray(g.texts) ? g.texts : [];
    html += `
      <div class="rr-group">
        <div class="rr-title-chip">${escapeHtml(g.title || g.id || "Reason")}</div>
        <ul class="rr-raw-list">${texts.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
      </div>`;
  }
  if (unknown.length) {
    html += `
      <div class="rr-group">
        <div class="rr-title-chip rr-title-chip--unknown">Uncategorized</div>
        <ul class="rr-raw-list">${unknown.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
      </div>`;
  }
  if (!groups.length && !unknown.length) {
    html = `<div class="rr-group"><p>No exact rejection text was returned by TikTok yet.</p></div>`;
  }
  document.getElementById("rrBody").innerHTML = html;
  document.getElementById("rejectionReasonModal").classList.add("open");
}

function closeRejectionReasonModal() {
  document.getElementById("rejectionReasonModal").classList.remove("open");
}

// Merge a { campaign_id, campaign_operation_status, effective_status, ... }
// result from the backend into the stored campaign + re-render its row/panel.
function applyCampaignStatusResult(res) {
  if (!res || !res.campaign_id) return;
  const tk = state.tiktokCampaigns.find((c) => String(c.campaign_id) === String(res.campaign_id));
  if (tk) {
    if (res.campaign_operation_status !== undefined) tk.campaign_operation_status = res.campaign_operation_status;
    if (res.effective_status) tk.effective_status = res.effective_status;
    if (res.effective_tone) tk.effective_tone = res.effective_tone;
    if (res.status_detail !== undefined) tk.status_detail = res.status_detail;
  }
  if (Array.isArray(res.adgroups)) {
    state.adGroupsByCampaign[String(res.campaign_id)] = {
      loadedAt: Date.now(),
      rows: res.adgroups,
      appealState: res.appeal_state || "NONE",
      appealReasons: res.appeal_reasons || null,
      appealUnknownReasons: res.appeal_unknown_reasons || null,
      appealRawReasons: res.appeal_raw_reasons || null,
      appealAdgroupId: res.appeal_adgroup_id || null,
    };
  }
  rebuildSources();
  // rebuildSources -> renderTable rebuilds rows; re-open panels that were expanded.
  for (const s of state.sources) {
    if (state.expandedSources.has(s.source)) {
      const cached = state.adGroupsByCampaign[s.campaignId];
      const panel = panelEl(s.campaignId);
      if (panel && cached && cached.rows) paintAdGroups(panel, s, cached.rows);
    }
  }
}

// ---- campaign / ad group pause-unpause writes ----

async function handleCampaignAction(btn) {
  const campaignId = btn.dataset.campaignId;
  const targetOp = btn.dataset.campaignAction; // ENABLE | DISABLE
  const key = `c:${campaignId}`;
  if (state.pendingActions.has(key)) return; // double-click guard
  state.pendingActions.add(key);
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const result = await setCampaignStatus(campaignId, targetOp);
    state.pendingActions.delete(key);
    applyCampaignStatusResult(result);
    setStatus(`Campaign ${targetOp === "DISABLE" ? "paused" : "enabled"} — now “${result.effective_status}”.`);
  } catch (err) {
    state.pendingActions.delete(key);
    setStatus(`Campaign update failed: ${err.message}`, true);
    rebuildSources();
  }
}

async function handleAdgroupAction(btn) {
  const campaignId = btn.dataset.campaignId;
  const adgroupId = btn.dataset.adgroupId;
  const targetOp = btn.dataset.adgroupAction;
  const key = `g:${adgroupId}`;
  if (state.pendingActions.has(key)) return; // double-click guard
  state.pendingActions.add(key);
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const result = await setAdgroupStatus(campaignId, adgroupId, targetOp);
    state.pendingActions.delete(key);
    applyCampaignStatusResult(result); // repaints the panel + row from the live result
    setStatus(`Ad group ${targetOp === "DISABLE" ? "paused" : "unpaused"}.`);
  } catch (err) {
    state.pendingActions.delete(key);
    setStatus(`Ad group update failed: ${err.message}`, true);
    const s = state.sources.find((x) => x.campaignId === campaignId);
    if (s) renderAdGroupsPanel(s, { force: true });
  }
}

// ---- advertiser account spend-cap edit (one account, or the same cap applied
// to every account behind the current campaign selection) ----

let budgetModalAdvIds = [];
const BUDGET_MODE_LABEL = {
  UNLIMITED: "Uncapped",
  MONTHLY_BUDGET: "Monthly",
  DAILY_BUDGET: "Daily",
  CUSTOM_BUDGET: "Custom",
};

function openBudgetModal(advertiserIds) {
  budgetModalAdvIds = [...new Set((Array.isArray(advertiserIds) ? advertiserIds : [advertiserIds]).map(String).filter(Boolean))];
  if (!budgetModalAdvIds.length) return;

  const cur = document.getElementById("budgetModalCurrent");
  if (budgetModalAdvIds.length === 1) {
    const advId = budgetModalAdvIds[0];
    const b = state.budgets[advId];
    const s = state.sources.find((x) => x.advertiserId === advId);
    document.getElementById("budgetModalAcct").textContent = (s && s.advertiserName ? `${s.advertiserName} · ` : "") + `Ad account ${advId}`;
    if (b && b.capped) {
      cur.innerHTML = `
        <div><span>Current cap</span><strong>${money(b.cap)}</strong> <em>(${BUDGET_MODE_LABEL[b.budget_mode] || b.budget_mode})</em></div>
        <div><span>Spent</span><strong>${money(b.spent)}</strong></div>
        <div><span>Remaining</span><strong>${money(b.remaining)}</strong></div>`;
    } else {
      cur.innerHTML = `<div><span>Current</span><strong>Uncapped</strong></div>
        <div><span>Shared BC balance</span><strong>${b ? money(b.account_balance) : "—"}</strong></div>`;
    }
    document.getElementById("budgetModeSelect").value = b && b.capped ? b.budget_mode : "DAILY_BUDGET";
    document.getElementById("budgetAmountInput").value = b && b.capped ? String(b.cap) : "";
  } else {
    document.getElementById("budgetModalAcct").textContent = `${budgetModalAdvIds.length} ad accounts`;
    cur.innerHTML = `<div><span>Accounts</span><strong>${budgetModalAdvIds.length} selected</strong></div>
      <div class="eng-hint">The cap you set applies to every one of them.</div>`;
    document.getElementById("budgetModeSelect").value = "DAILY_BUDGET";
    document.getElementById("budgetAmountInput").value = "";
  }

  document.getElementById("budgetModalError").textContent = "";
  syncBudgetAmountVisibility();
  document.getElementById("budgetModal").classList.add("open");
}

function closeBudgetModal() {
  document.getElementById("budgetModal").classList.remove("open");
  budgetModalAdvIds = [];
}

function syncBudgetAmountVisibility() {
  const mode = document.getElementById("budgetModeSelect").value;
  document.getElementById("budgetAmountWrap").hidden = mode === "UNLIMITED";
}

async function submitBudgetEdit() {
  if (!budgetModalAdvIds.length) return;
  const ids = budgetModalAdvIds;
  const mode = document.getElementById("budgetModeSelect").value;
  const amount = Number(document.getElementById("budgetAmountInput").value);
  const errEl = document.getElementById("budgetModalError");
  errEl.textContent = "";

  if (mode !== "UNLIMITED" && !(amount > 0)) {
    errEl.textContent = "Enter a cap amount greater than 0.";
    return;
  }

  const btn = document.getElementById("confirmBudgetBtn");
  btn.disabled = true;
  btn.textContent = ids.length > 1 ? `Updating ${ids.length}…` : "Updating…";
  ids.forEach((id) => state.pendingActions.add(`b:${id}`));
  rebuildSources();

  const failed = [];
  for (const advId of ids) {
    try {
      const res = await setAdvertiserBudget(advId, mode, mode === "UNLIMITED" ? 0 : amount);
      if (res.budget) state.budgets[advId] = { ...state.budgets[advId], ...res.budget };
    } catch (err) {
      failed.push(`${advId}: ${err.message}`);
    } finally {
      state.pendingActions.delete(`b:${advId}`);
    }
  }
  btn.disabled = false;
  btn.textContent = "Update";
  rebuildSources();

  if (failed.length) {
    errEl.textContent = `${failed.length} account${failed.length === 1 ? "" : "s"} failed — ${failed.join("; ")}`;
    return;
  }
  closeBudgetModal();
  setStatus(
    `${ids.length > 1 ? `${ids.length} ad account caps` : "Ad account cap"} updated — ${mode === "UNLIMITED" ? "uncapped" : money(amount) + " " + (BUDGET_MODE_LABEL[mode] || "")}.`
  );
}

// "Set minimum budget" — sets each selected account's cap to whatever
// minimum TikTok itself allows above its current spend. Bypasses the Cap
// type / amount fields entirely: TikTok computes and applies the exact
// number server-side (advertiser_update's ONE_CLICK_SET), since the actual
// minimum varies account to account (TikTok's own ~105%-of-spend rule,
// rounded however TikTok rounds it) and is never guessed here. Fired in
// parallel across accounts — each is its own independent request to the
// backend, not N MCP calls sharing one function's time budget, so there's no
// reason to wait on them one at a time.
async function submitBudgetMinimum() {
  if (!budgetModalAdvIds.length) return;
  const ids = budgetModalAdvIds;
  const errEl = document.getElementById("budgetModalError");
  errEl.textContent = "";

  const btn = document.getElementById("setMinBudgetBtn");
  const updateBtn = document.getElementById("confirmBudgetBtn");
  btn.disabled = true;
  updateBtn.disabled = true;
  btn.textContent = ids.length > 1 ? `Setting ${ids.length}…` : "Setting…";
  ids.forEach((id) => state.pendingActions.add(`b:${id}`));
  rebuildSources();

  const failures = await Promise.all(
    ids.map(async (advId) => {
      try {
        const res = await setAdvertiserBudget(advId, "ONE_CLICK_MINIMUM", 0);
        if (res.budget) state.budgets[advId] = { ...state.budgets[advId], ...res.budget };
        return null;
      } catch (err) {
        return `${advId}: ${err.message}`;
      } finally {
        state.pendingActions.delete(`b:${advId}`);
      }
    })
  );
  const failed = failures.filter(Boolean);

  btn.disabled = false;
  updateBtn.disabled = false;
  btn.textContent = "Set minimum budget";
  rebuildSources();

  if (failed.length) {
    errEl.textContent = `${failed.length} account${failed.length === 1 ? "" : "s"} failed — ${failed.join("; ")}`;
    return;
  }
  closeBudgetModal();
  setStatus(
    `${ids.length > 1 ? `${ids.length} ad account caps` : "Ad account cap"} set to TikTok's minimum above current spend.`
  );
}

// Effective operating status for a SOURCE/campaign row. `status` is
// { label, tone, detail } from the TikTok campaign, or null when the source
// only exists on the Glitchy side (no matching tracked TikTok campaign).
function statusBadge(status) {
  if (!status || !status.label) {
    return `<span class="status-badge none" title="No matching tracked TikTok campaign">—</span>`;
  }
  const tone = ["good", "warn", "bad", "neutral"].includes(status.tone) ? status.tone : "neutral";
  const tip = status.detail ? `${status.label} — ${status.detail}` : status.label;
  return `<span class="status-badge ${tone}" title="${escapeHtml(tip)}">${escapeHtml(status.label)}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cssSafeId(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, "_");
}
function cssEscapeAttr(str) {
  return String(str).replace(/"/g, '\\"');
}

// ============================== MAIN CHART ==============================

// Hourly series for the Live Performance graph, derived from a cumulative-
// so-far snapshot object { date, currentHour, cumulative, byHour } — shared
// by both Spend (TikTok) and Earnings (combined Glitchy+Mabac), which are
// snapshotted the exact same way (see tiktok-campaigns.js's spendToday /
// _shared/glitchy-daily.js's earningsSnapshotToday).
//
// A cumulative total only ever goes up, so an hour with no recorded snapshot
// safely means "still whatever it last was" — never a real unknown. Forward-
// filling the cumulative total across every hour (starting from 0 at
// midnight) turns that into a smooth, always-connected line running from
// 00:00 through the current hour, instead of a broken gap wherever a snapshot
// happened not to land (e.g. before the first poll of the day, or across any
// stretch the dashboard was closed). Each hour's bar is then just the delta
// between its filled-in cumulative total and the previous hour's — still
// clamped at 0 so a counter reset never shows as a negative dip. The CURRENT
// hour always uses the live cumulative value straight from this poll (not
// whatever was last snapshotted), so the point for the hour in progress rises
// immediately as new data comes in rather than waiting for the hour to end.
// Future hours stay null.
function hourlySeriesFromCumulative(st) {
  if (!st || st.date !== todayStr()) return Array(24).fill(null);

  const byHour = st.byHour || {};
  const curH = Number.isFinite(st.currentHour) ? st.currentHour : currentEstHour();
  const liveCum = toNum(st.cumulative);
  const at = (h) => (byHour[String(h)] != null ? toNum(byHour[String(h)]) : null);

  const cumByHour = Array(24).fill(0);
  let running = 0;
  for (let h = 0; h <= curH && h < 24; h++) {
    const known = h === curH ? liveCum : at(h);
    if (known != null) running = known;
    cumByHour[h] = running;
  }

  const out = Array(24).fill(null);
  let prev = 0;
  for (let h = 0; h <= curH && h < 24; h++) {
    const delta = cumByHour[h] - prev;
    out[h] = delta > 0 ? Math.round(delta * 100) / 100 : 0; // clamp: no negative bars at a reset
    prev = cumByHour[h];
  }
  return out;
}
function hourlySpendSeries() {
  return hourlySeriesFromCumulative(state.spendToday);
}
function hourlyEarningsSeries() {
  return hourlySeriesFromCumulative(state.earningsToday);
}

// `forceRecreate` is only for an actual theme swap (chart colors are read
// from CSS vars at creation time). Every routine data refresh instead
// updates the existing chart in place — destroying and recreating it every
// ~60s replayed Chart.js's whole entrance animation, a visible flash right
// near the top of the page on every single auto-refresh.
function renderChart(forceRecreate) {
  if (!mainChartCanvas || !window.Chart) return;

  // Fixed 00:00–23:00 EST axis, always — never the viewer's local timezone.
  // Only hours up to (and including) the current EST hour get plotted;
  // everything after stays a gap (null) until that hour actually happens.
  const hourLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const limit = currentEstHour() + 1;

  const spendFull = hourlySpendSeries();
  const earningsFull = hourlyEarningsSeries();

  const spendBuckets = spendFull.map((v, h) => (h < limit ? v : null));
  const earningsBuckets = earningsFull.map((v, h) => (h < limit ? v : null));

  if (forceRecreate || !updateMainChart(hourLabels, earningsBuckets, spendBuckets)) {
    createMainChart(mainChartCanvas, hourLabels, earningsBuckets, spendBuckets);
  }
}

// ============================== TOOLS DRAWER ==============================

function openToolsDrawer() {
  document.getElementById("toolsDrawer").classList.add("open");
  document.getElementById("drawerBackdrop").classList.add("open");
}
function closeToolsDrawer() {
  document.getElementById("toolsDrawer").classList.remove("open");
  document.getElementById("drawerBackdrop").classList.remove("open");
}

// ============================== TIKTOK ACCOUNTS MODAL ==============================
// Informational / connection-management only: BC selector, advertiser list
// (Approved/Suspended), affiliate network, Refresh Data, Disconnect, Connect
// New BC. All token handling lives in the tiktok-* Netlify functions.
//
// There is no per-account "tracked" selection here anymore — Detailed Metrics
// scopes itself automatically off Campaign Creator campaigns (see
// tiktok-campaigns.js scopedAdvertisers). The `tracked` column/backend action
// still exist for compatibility but nothing in this modal writes to them.

// connections: [{id,label,tiktok_email,tiktok_display_name,bc_id,bc_name,bc_count,...}]
// advertisers: [{connection_id,advertiser_id,...,tracked}]
// selectedConnectionId: which connection the management view shows (multi-BC only)
const tiktokState = { connections: [], advertisers: [], selectedConnectionId: null, savingNetwork: null };
let tiktokPwHandler = null;

function openAccountsModal() {
  document.getElementById("tiktokAdvSearch").value = "";
  document.getElementById("accountsModal").classList.add("open");
}
function closeAccountsModal() {
  document.getElementById("accountsModal").classList.remove("open");
}

function wireTiktokEvents() {
  document.getElementById("tiktokConnectBtn").addEventListener("click", connectTiktok);
  document.getElementById("tiktokRefreshBtn").addEventListener("click", () => refreshTiktokData());
  document.getElementById("tiktokBcSelect").addEventListener("change", (e) => {
    tiktokState.selectedConnectionId = e.target.value;
    renderSelectedConnection();
  });
  // Static — lives outside tiktokConnectionsWrap, so re-rendering the list
  // below it never touches (or steals focus from) this input.
  document.getElementById("tiktokAdvSearch").addEventListener("input", renderSelectedConnection);

  // Connection-management only: network toggle + disconnect. Account tracking
  // selection was removed (Detailed Metrics now scopes itself off Campaign
  // Creator campaigns — see tiktok-campaigns.js scopedAdvertisers).
  const wrap = document.getElementById("tiktokConnectionsWrap");
  wrap.addEventListener("click", (e) => {
    const netBtn = e.target.closest("[data-tk-net]");
    if (netBtn && !netBtn.classList.contains("active")) {
      setBcNetwork(netBtn.dataset.tkConn, netBtn.dataset.tkNet);
      return;
    }
    const disconnectBtn = e.target.closest("[data-tk-disconnect]");
    if (disconnectBtn) disconnectConnection(disconnectBtn.dataset.tkDisconnect);
  });

  document.getElementById("tiktokPwCancel").addEventListener("click", closeTiktokPwModal);
  document.getElementById("tiktokPwConfirm").addEventListener("click", submitTiktokPw);
  document.getElementById("tiktokPwInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitTiktokPw();
  });
  document.getElementById("tiktokPwModal").addEventListener("click", (e) => {
    if (e.target.id === "tiktokPwModal") closeTiktokPwModal();
  });
}

// TikTok advertiser `status` is kept raw in storage; only the label shown to
// the user is mapped. STATUS_ENABLE -> "Approved", anything else -> "Suspended".
function advIsApproved(a) {
  return String(a.status || "").toUpperCase() === "STATUS_ENABLE";
}
function advApprovedRank(a) {
  return advIsApproved(a) ? 0 : 1;
}
function advStatusLabel(a) {
  return advIsApproved(a) ? "Approved" : "Suspended";
}

// Dynamic name search shared by the 3 ad-account lists (TikTok Ads, WH
// Warmup, Campaign Creator). Never touches which accounts "select all"
// selects — it only narrows which rows are shown.
function filterAdvsByQuery(advs, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return advs;
  return advs.filter((a) => String(a.advertiser_name || a.advertiser_id || "").toLowerCase().includes(q));
}

// advertiser_id -> the campaign name currently sitting in that account, from
// ANY source (Campaign Creator, WH Warmup, or a stray campaign a sync
// found) — one CBO campaign per account at a time, so this is what lets the
// 3 account-picker lists warn "this account is already occupied" before you
// launch a new one on top of it. Recomputed fresh each render — state.
// tiktokCampaigns is small enough (tens of rows) that this costs nothing.
function campaignNameByAdvertiser() {
  const map = new Map();
  for (const c of state.tiktokCampaigns) {
    if (!c || !c.advertiser_id || !c.campaign_name) continue;
    const id = String(c.advertiser_id);
    if (!map.has(id)) map.set(id, c.campaign_name);
  }
  return map;
}

// A connection's Business Center identity for display. Real BC name from
// bc/get when known; never invented from advertiser names.
function connBcName(c) {
  return c.bc_name || c.tiktok_display_name || c.tiktok_email || "TikTok connection";
}
function connBcOptionLabel(c) {
  const primary = c.bc_name || (c.bc_count > 1 ? `${c.bc_count} Business Centers` : c.tiktok_display_name) || "Connection";
  return c.tiktok_email ? `${primary} — ${c.tiktok_email}` : primary;
}

// Approved first, Suspended after — but WITHIN each group, keeps whatever
// order tiktokState.advertisers already arrived in (the backend orders by
// list_order, i.e. the Business Center's own order), never alphabetical.
// Array.prototype.sort is stable, so sorting on rank alone preserves that.
// Shared by the TikTok Ad Accounts modal and Campaign Creator (ccRunAdvs).
function advsForConnection(connId) {
  return tiktokState.advertisers
    .filter((a) => a.connection_id === connId)
    .slice()
    .sort((a, b) => advApprovedRank(a) - advApprovedRank(b));
}

async function renderTiktokAccounts() {
  const wrap = document.getElementById("tiktokConnectionsWrap");
  wrap.innerHTML = `<p class="tk-loading">Loading connections…</p>`;

  let data;
  try {
    data = await fetchTiktokConnections();
  } catch (err) {
    wrap.innerHTML = `<p class="tk-error">Couldn't load connections: ${escapeHtml(err.message)}</p>`;
    return;
  }

  tiktokState.connections = data.connections || [];
  tiktokState.advertisers = data.advertisers || [];

  const ids = tiktokState.connections.map((c) => c.id);
  if (!ids.includes(tiktokState.selectedConnectionId)) {
    tiktokState.selectedConnectionId = ids[0] || null;
  }

  // BC / connection dropdown at the top of the modal.
  const bcWrap = document.getElementById("tiktokBcSelectWrap");
  const bcSelect = document.getElementById("tiktokBcSelect");
  if (tiktokState.connections.length) {
    bcSelect.innerHTML = tiktokState.connections
      .map((c) => `<option value="${c.id}" ${c.id === tiktokState.selectedConnectionId ? "selected" : ""}>${escapeHtml(connBcOptionLabel(c))}</option>`)
      .join("");
    bcWrap.hidden = false;
  } else {
    bcWrap.hidden = true;
  }

  renderSelectedConnection();
}

function renderSelectedConnection() {
  const wrap = document.getElementById("tiktokConnectionsWrap");
  const summaryEl = document.getElementById("tiktokSummary");

  if (!tiktokState.connections.length) {
    summaryEl.innerHTML = "";
    wrap.innerHTML = `<p class="tk-empty">No TikTok accounts connected yet. Click “Connect TikTok Ads” and authorize in this browser profile.</p>`;
    return;
  }

  const c =
    tiktokState.connections.find((x) => x.id === tiktokState.selectedConnectionId) || tiktokState.connections[0];
  const advs = advsForConnection(c.id);
  const approved = advs.filter((a) => advIsApproved(a)).length;

  summaryEl.innerHTML = `
    <span class="tk-sum-item"><strong>${advs.length}</strong> account${advs.length === 1 ? "" : "s"}</span>
    <span class="tk-sum-item ok"><strong>${approved}</strong> Approved</span>
    <span class="tk-sum-item warn"><strong>${advs.length - approved}</strong> Suspended</span>`;

  // Search box lives outside this container (static markup) so re-rendering
  // never steals its focus/cursor.
  const query = document.getElementById("tiktokAdvSearch")?.value || "";
  const shownAdvs = filterAdvsByQuery(advs, query);
  const campMap = campaignNameByAdvertiser();
  const rows = shownAdvs.length
    ? shownAdvs.map((a) => tiktokAdvRow(a, campMap)).join("")
    : `<p class="tk-empty">${advs.length ? "No accounts match your search." : "No advertiser accounts found for this connection."}</p>`;

  const net = String(c.affiliate_network || "GLITCHY").toUpperCase();
  const saving = tiktokState.savingNetwork === c.id;

  wrap.innerHTML = `
    <div class="tk-conn">
      <div class="tk-conn-head">
        <div class="tk-conn-id">
          <div class="tk-conn-label">${escapeHtml(connBcName(c))}</div>
          <div class="tk-conn-sub">${escapeHtml(c.tiktok_email || c.tiktok_display_name || "")}</div>
        </div>
        <div class="tk-conn-right">
          <div class="tk-net-toggle${saving ? " saving" : ""}" title="Affiliate network for this Business Center's campaigns">
            <button class="${net === "GLITCHY" ? "active" : ""}" data-tk-net="GLITCHY" data-tk-conn="${c.id}" ${saving ? "disabled" : ""}>Glitchy</button>
            <button class="${net === "MABAC" ? "active" : ""}" data-tk-net="MABAC" data-tk-conn="${c.id}" ${saving ? "disabled" : ""}>Mabac</button>
          </div>
          <button class="tk-disconnect" data-tk-disconnect="${c.id}" title="Disconnect this Business Center">
            <span class="tk-disconnect-icon">⚠</span> Disconnect
          </button>
        </div>
      </div>
      <div class="tk-adv-list">${rows}</div>
    </div>`;
}

// Informational row only — no selection control. Detailed Metrics scopes
// itself automatically (tracked OR has a Campaign Creator campaign; see
// scopedAdvertisers in tiktok-campaigns.js), so there's nothing to pick here.
function tiktokAdvRow(a, campMap) {
  const meta = [a.advertiser_id, a.currency || null, a.display_timezone || a.timezone || null]
    .filter(Boolean)
    .join(" · ");
  const approved = advIsApproved(a);
  const campaignName = campMap ? campMap.get(String(a.advertiser_id)) : null;
  return `
    <div class="tk-adv">
      <span class="tk-adv-main">
        <span class="tk-adv-name">${escapeHtml(a.advertiser_name || a.advertiser_id)}</span>
        <span class="tk-adv-meta">${escapeHtml(meta)}${campaignName ? ` <span class="tk-adv-campaign">| ${escapeHtml(campaignName)}</span>` : ""}</span>
      </span>
      <span class="tk-adv-status ${approved ? "ok" : "warn"}">${advStatusLabel(a)}</span>
    </div>`;
}

// ---- admin password (only for connect + disconnect) ----

function askTiktokPassword({ title, hint }) {
  return new Promise((resolve) => {
    tiktokPwHandler = resolve;
    document.getElementById("tiktokPwTitle").textContent = title || "Dashboard password";
    document.getElementById("tiktokPwHint").textContent = hint || "Enter the dashboard password to continue.";
    document.getElementById("tiktokPwInput").value = "";
    document.getElementById("tiktokPwError").textContent = "";
    document.getElementById("tiktokPwModal").classList.add("open");
    document.getElementById("tiktokPwInput").focus();
  });
}
function closeTiktokPwModal() {
  document.getElementById("tiktokPwModal").classList.remove("open");
  if (tiktokPwHandler) {
    tiktokPwHandler(null);
    tiktokPwHandler = null;
  }
}
function submitTiktokPw() {
  const val = document.getElementById("tiktokPwInput").value;
  if (!val) {
    document.getElementById("tiktokPwError").textContent = "Password required.";
    return;
  }
  document.getElementById("tiktokPwModal").classList.remove("open");
  if (tiktokPwHandler) {
    tiktokPwHandler(val);
    tiktokPwHandler = null;
  }
}

// ---- actions ----

async function connectTiktok() {
  const password = await askTiktokPassword({
    title: "Connect New BC",
    hint: "Enter the dashboard password. You'll then be sent to TikTok to authorize the Business Center logged in to this browser profile.",
  });
  if (!password) return;
  try {
    const { authorizeUrl } = await startTiktokAuth(password, "");
    if (!authorizeUrl) {
      setStatus("TikTok did not return an authorization URL.", true);
      return;
    }
    // Full-page redirect — survives AdsPower profiles / popup blockers.
    window.location.assign(authorizeUrl);
  } catch (err) {
    setStatus(`Couldn't start TikTok authentication: ${err.message}`, true);
  }
}

// "Refresh Data" — re-scan advertiser accounts (Approved/Suspended, new
// accounts), re-discover campaigns + ad/adgroup statuses, refresh budgets/
// balances, for every scoped advertiser (tracked, or has a Campaign Creator
// campaign — see tiktok-campaigns.js scopedAdvertisers). Scoped to the
// currently selected BC unless allBcs. No password.
async function refreshTiktokData({ silent, allBcs } = {}) {
  const btn = document.getElementById("tiktokRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  if (!silent) setStatus("Refreshing TikTok data…");
  try {
    const connId = allBcs ? null : tiktokState.selectedConnectionId;
    const r = await syncTiktokCampaigns(connId);
    await loadTiktokCampaigns();
    loadTiktokBudgets();
    loadMabac();
    loadTiktokMetrics();
    if (document.getElementById("accountsModal").classList.contains("open")) {
      await renderTiktokAccounts();
    }
    if (r.note) setStatus(r.note);
    else setStatus(`Refreshed — ${r.campaignCount ?? 0} campaign(s) across ${r.connections ?? 0} Business Center(s).`);
  } catch (err) {
    setStatus(`Refresh failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh Data";
  }
}

// Glitchy/Mabac toggle for one BC. Persists immediately, no password, subtle
// saving state. Stamps the BC's campaigns with the new network and re-merges.
async function setBcNetwork(connectionId, network) {
  if (tiktokState.savingNetwork) return;
  tiktokState.savingNetwork = connectionId;
  renderSelectedConnection();
  try {
    await setConnectionNetwork(connectionId, network);
    const conn = tiktokState.connections.find((c) => c.id === connectionId);
    if (conn) conn.affiliate_network = network;
    for (const c of state.tiktokCampaigns) {
      if (String(c.connection_id) === String(connectionId)) c.affiliate_network = network;
    }
    rebuildSources();
    loadMabac(); // ensure Mabac data is loaded if we just switched to it
    setStatus(`${connBcName(conn || {})} now uses ${network === "MABAC" ? "Mabac" : "Glitchy"} for affiliate data.`);
  } catch (err) {
    setStatus(`Couldn't change network: ${err.message}`, true);
  } finally {
    tiktokState.savingNetwork = null;
    renderSelectedConnection();
  }
}

// Disconnect ONE connection — PASSWORD required.
async function disconnectConnection(connectionId) {
  const conn = tiktokState.connections.find((c) => c.id === connectionId);
  const password = await askTiktokPassword({
    title: "Disconnect TikTok connection",
    hint: `Enter the dashboard password to remove “${conn ? connBcName(conn) : "this connection"}” and its advertiser accounts.`,
  });
  if (!password) return;
  try {
    await postTiktokAction({ password, action: "disconnect", connection_id: connectionId });
    if (tiktokState.selectedConnectionId === connectionId) tiktokState.selectedConnectionId = null;
    setStatus("TikTok connection removed.");
    await renderTiktokAccounts();
    await loadTiktokCampaigns();
  } catch (err) {
    setStatus(`Couldn't disconnect: ${err.message}`, true);
  }
}

// Called from init when returning from the OAuth redirect.
function handleTiktokReturn() {
  const qp = new URLSearchParams(window.location.search);
  const kind = qp.get("tiktok");
  if (!kind) return;

  if (kind === "connected") {
    const n = qp.get("accounts");
    const warn = qp.get("warn");
    setStatus(
      `TikTok account connected${n != null ? ` — ${n} ad account(s) discovered` : ""}.` +
        (warn ? ` Note: ${warn}` : "")
    );
  } else if (kind === "error") {
    setStatus(`TikTok connection failed: ${qp.get("reason") || "unknown error"}`, true);
  }

  const newConnId = qp.get("connection");
  history.replaceState({}, "", window.location.pathname);

  if (kind === "connected") {
    if (newConnId) tiktokState.selectedConnectionId = newConnId; // focus the just-added BC
    openAccountsModal();
    renderTiktokAccounts();
  }
}

// ============================== PROFIT CALENDAR (modal, on demand) ==============================
// Automatic history — no "New Day". Reads the stored daily_totals rows; the
// current day's row is kept fresh by the normal glitchy-stats poll.

let calendarMonth = null; // "YYYY-MM" currently displayed

function monthGridDays(daily) {
  const month = daily.month || todayStr().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const firstWeekday = new Date(year, mon - 1, 1).getDay();
  const todayIso = todayStr();
  const rowsByDate = new Map((daily.days || []).map((d) => [d.date, d]));

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    days.push({
      dateStr,
      day: d,
      isFuture: dateStr > todayIso,
      isToday: dateStr === todayIso,
      entry: rowsByDate.get(dateStr) || null,
    });
  }
  return { year, mon, firstWeekday, days };
}

function dayProfit(entry) {
  if (!entry) return 0;
  if (entry.net_profit != null) return entry.net_profit;
  return (entry.total_earnings || 0) - (entry.total_spend || 0);
}

async function openCalendarModal() {
  document.getElementById("calendarModal").classList.add("open");
  calendarMonth = todayStr().slice(0, 7);
  await loadCalendar();
}

function closeCalendarModal() {
  document.getElementById("calendarModal").classList.remove("open");
}

function shiftCalendarMonth(delta) {
  if (!calendarMonth) calendarMonth = todayStr().slice(0, 7);
  const [y, m] = calendarMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  calendarMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  loadCalendar();
}

async function loadCalendar() {
  const grid = document.getElementById("calendarGridDetailed");
  grid.innerHTML = `<div class="cal-loading">Loading…</div>`;
  try {
    const daily = await fetchDailyTotals(calendarMonth);
    renderDetailedCalendar(daily);
  } catch (_) {
    renderDetailedCalendar({ month: calendarMonth, days: [] });
  }
}

// Heatmap intensity for one day's profit, normalised against the visible month
// so a single unusually large day doesn't wash out the rest. The reference is
// the ~80th percentile of the month's absolute profits (falls back to the max);
// sqrt scaling lifts the mid-range. Near-zero days stay very subtle.
function makeIntensity(magnitudes) {
  const sorted = magnitudes.filter((v) => v > 0).sort((a, b) => a - b);
  const ref = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))] || sorted[sorted.length - 1]
    : 1;
  return (profit) => {
    const r = Math.min(1, Math.sqrt(Math.abs(profit) / (ref || 1)));
    return Math.round(6 + r * 46); // 6% (subtle) .. 52%
  };
}

function renderDetailedCalendar(daily) {
  const { year, mon, firstWeekday, days } = monthGridDays(daily);

  document.getElementById("calendarModalMonthLabel").textContent = new Date(year, mon - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  const populated = days.filter((d) => d.entry && !d.isFuture);
  const totalSpend = populated.reduce((a, d) => a + (d.entry.total_spend || 0), 0);
  const totalEarnings = populated.reduce((a, d) => a + (d.entry.total_earnings || 0), 0);
  const totalProfit = totalEarnings - totalSpend;
  const overallRoas = totalSpend > 0 ? totalEarnings / totalSpend : 0;

  document.getElementById("summarySpend").textContent = money(totalSpend);
  document.getElementById("summaryEarnings").textContent = money(totalEarnings);
  const profitEl = document.getElementById("summaryProfit");
  profitEl.textContent = signedMoney(totalProfit);
  profitEl.classList.toggle("positive", totalProfit >= 0);
  profitEl.classList.toggle("negative", totalProfit < 0);
  document.getElementById("summaryRoas").textContent = `${overallRoas.toFixed(2)}x`;

  const intensity = makeIntensity(populated.map((d) => Math.abs(dayProfit(d.entry))));

  const grid = document.getElementById("calendarGridDetailed");
  grid.innerHTML = "";

  for (let i = 0; i < firstWeekday; i++) {
    const filler = document.createElement("div");
    filler.className = "cal-cell-detailed empty";
    grid.appendChild(filler);
  }

  days.forEach(({ dateStr, day, isFuture, isToday, entry }, idx) => {
    const cell = document.createElement("div");
    cell.className = "cal-cell-detailed" + (isFuture ? " future" : "") + (isToday ? " today" : "");
    cell.style.animationDelay = `${idx * 5}ms`;

    if (entry && !isFuture) {
      const profit = dayProfit(entry);
      const sentiment = profit >= 0 ? "positive" : "negative";
      const pct = intensity(profit);
      cell.style.background =
        profit >= 0
          ? `color-mix(in srgb, var(--profit) ${pct}%, var(--bg-2))`
          : `color-mix(in srgb, var(--loss) ${pct}%, var(--bg-2))`;
      cell.innerHTML = `
        <span class="cal-d-daynum">${day}</span>
        <span class="cal-d-amount ${sentiment}">${signedMoney(profit)}</span>`;
      cell.title = `${dateStr} — net profit ${signedMoney(profit)}`;
    } else {
      cell.innerHTML = `<span class="cal-d-daynum">${day}</span>`;
      cell.title = dateStr;
    }

    grid.appendChild(cell);
  });
}

// ============================== TRACKER (Tests + Winners) ==============================
// Tests rows are auto-populated server-side by the daily tracker-run.js cron —
// this module only ever renders them + saves the user-entered fields (offer /
// hook / notes). Winners rows are 100% manual (added, edited, deleted here).
// Password-gated on open, same admin password as TikTok connect/disconnect.

const TRACKER_RESULT_LABEL = { DEAD: "Dead", BREAK_EVEN: "Break Even", WINNER: "Winner" };
const TRACKER_RESULT_ROW_CLASS = { DEAD: "tracker-row-dead", BREAK_EVEN: "tracker-row-breakeven", WINNER: "tracker-row-winner" };
const TRACKER_RESULT_BADGE_TONE = { DEAD: "neutral", BREAK_EVEN: "warn", WINNER: "good" };

let trackerDeleteTarget = null; // { kind: "test" | "winner", id }

// Ensures a cached, verified password before every Tracker call. Any 401
// (wrong / stale password) clears the cache so the very next call re-prompts.
async function trackerAuthedCall(apiFn, ...args) {
  if (!state.tracker.password) {
    const pw = await askTiktokPassword({ title: "Tracker", hint: "Enter the dashboard password to open the Tracker." });
    if (!pw) {
      const err = new Error("Password required.");
      throw err;
    }
    state.tracker.password = pw;
  }
  try {
    return await apiFn(state.tracker.password, ...args);
  } catch (err) {
    if (err.status === 401) {
      state.tracker.password = null;
      state.tracker.unlocked = false;
    }
    throw err;
  }
}

function applyTrackerTabUI(tab) {
  document.querySelectorAll("#trackerTabs .tracker-tab").forEach((b) => b.classList.toggle("active", b.dataset.trackerTab === tab));
  document.getElementById("trackerTestsWrap").hidden = tab !== "tests";
  document.getElementById("trackerWinnersWrap").hidden = tab !== "winners";
  document.getElementById("trackerAddWinnerBtn").hidden = tab !== "winners";
}

function setTrackerTab(tab) {
  state.tracker.tab = tab;
  applyTrackerTabUI(tab);
  renderTrackerActive();
}

function setTrackerOfferFilter(v) {
  state.tracker.offerFilter = v;
  document.querySelectorAll("#trackerOfferFilter .tracker-filter-btn").forEach((b) => b.classList.toggle("active", b.dataset.trackerOffer === v));
  renderTrackerActive();
}

function renderTrackerActive() {
  if (state.tracker.tab === "tests") renderTrackerTests();
  else renderTrackerWinners();
}

async function openTrackerModal() {
  document.getElementById("trackerModal").classList.add("open");
  document.getElementById("trackerError").textContent = "";
  applyTrackerTabUI(state.tracker.tab);
  await loadTrackerData();
}

function closeTrackerModal() {
  document.getElementById("trackerModal").classList.remove("open");
}

async function loadTrackerData() {
  const errEl = document.getElementById("trackerError");
  errEl.textContent = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await trackerAuthedCall(trackerList);
      state.tracker.tests = data.tests || [];
      state.tracker.winners = data.winners || [];
      state.tracker.unlocked = true;
      renderTrackerActive();
      return;
    } catch (err) {
      if (err.status === 401 && attempt === 0) continue; // password was cleared — loop re-prompts once
      errEl.textContent = err.message || "Couldn't load the Tracker.";
      if (!state.tracker.password) closeTrackerModal();
      return;
    }
  }
}

// Hide zero-spend placeholder rows (a campaign that never actually spent that
// day). `spend` may be absent on rows recorded before supabase/tracker.sql's
// spend column existed — for those, fall back to "every auto metric is 0",
// the same signature a true $0 day has, so real historical winners with a
// nonzero cpa/cpnc/epc/roas are never hidden just because `spend` is missing.
function trackerTestHasSpend(r) {
  if (r.spend != null) return Number(r.spend) > 0;
  return toNum(r.cpa) > 0 || toNum(r.cpnc) > 0 || toNum(r.epc) > 0 || toNum(r.roas) > 0;
}

function trackerFilteredTests() {
  const f = state.tracker.offerFilter;
  const base = state.tracker.tests.filter(trackerTestHasSpend);
  if (f === "all") return base;
  return base.filter((r) => String(r.offer || "").toUpperCase() === f);
}

function trackerFilteredWinners() {
  const f = state.tracker.offerFilter;
  if (f === "all") return state.tracker.winners;
  return state.tracker.winners.filter((r) => String(r.offer || "").toUpperCase() === f);
}

function renderTrackerTests() {
  const wrap = document.getElementById("trackerTestsWrap");
  const rows = trackerFilteredTests();
  if (!rows.length) {
    wrap.innerHTML = `<p class="tracker-empty">No tested ads yet. Ads launched through Campaign Creator show up here automatically once their test day ends.</p>`;
    return;
  }
  wrap.innerHTML = `
    <table class="tracker-table">
      <thead>
        <tr>
          <th>SN</th><th>Offer</th><th>Type</th><th>Hook</th>
          <th class="num">CPA</th><th class="num">CPNC</th><th class="num">EPC</th><th class="num">ROAS</th>
          <th>Result</th><th>Notes</th><th></th>
        </tr>
      </thead>
      <tbody>${rows.map(trackerTestRowHtml).join("")}</tbody>
    </table>`;
}

function trackerTestRowHtml(r) {
  const rowClass = TRACKER_RESULT_ROW_CLASS[r.result] || "";
  const typeClass = r.type === "VIDEOS" ? "tracker-type-videos" : "tracker-type-slides";
  const tone = TRACKER_RESULT_BADGE_TONE[r.result] || "neutral";
  return `
    <tr class="tracker-row ${rowClass}" data-tracker-test-id="${escapeHtml(r.id)}">
      <td class="tracker-sn" title="${escapeHtml(r.sn)}">${escapeHtml(r.sn)}</td>
      <td>
        <select class="tracker-input" data-tracker-field="offer">
          <option value="" ${!r.offer ? "selected" : ""}>—</option>
          <option value="CPI" ${r.offer === "CPI" ? "selected" : ""}>CPI</option>
          <option value="SWEEPS" ${r.offer === "SWEEPS" ? "selected" : ""}>Sweeps</option>
        </select>
      </td>
      <td class="${typeClass}">${r.type === "VIDEOS" ? "Videos" : "Slides"}</td>
      <td><input type="text" class="tracker-input" data-tracker-field="hook" value="${escapeHtml(r.hook || "")}" placeholder="Hook…" /></td>
      <td class="num">${money(r.cpa)}</td>
      <td class="num">${money(r.cpnc)}</td>
      <td class="num">${money(r.epc)}</td>
      <td class="num roas-cell" style="color:${roasColor(r.roas)}">${(Number(r.roas) || 0).toFixed(2)}x</td>
      <td><span class="status-badge ${tone}">${TRACKER_RESULT_LABEL[r.result] || r.result}</span></td>
      <td><input type="text" class="tracker-input" data-tracker-field="notes" value="${escapeHtml(r.notes || "")}" placeholder="Notes…" /></td>
      <td><button type="button" class="tracker-del-btn" data-tracker-del="test">Delete</button></td>
    </tr>`;
}

function renderTrackerWinners() {
  const wrap = document.getElementById("trackerWinnersWrap");
  const rows = trackerFilteredWinners();
  if (!rows.length) {
    wrap.innerHTML = `<p class="tracker-empty">No winners saved yet. Use “+ Add Row” to log one.</p>`;
    return;
  }
  wrap.innerHTML = `
    <table class="tracker-table">
      <thead>
        <tr>
          <th>SN</th><th>Offer</th><th>Type</th><th>Hook</th>
          <th class="num">Total Spend</th><th class="num">Total Revenue</th><th class="num">ROAS</th><th>Notes</th><th></th>
        </tr>
      </thead>
      <tbody>${rows.map((r, i) => trackerWinnerRowHtml(r, i + 1)).join("")}</tbody>
    </table>`;
}

function trackerWinnerRowHtml(r, sn) {
  const spend = Number(r.total_spend) || 0;
  const revenue = Number(r.total_revenue) || 0;
  const roas = ratio(revenue, spend);
  const typeClass = r.type === "VIDEOS" ? "tracker-type-videos" : r.type === "SLIDES" ? "tracker-type-slides" : "";
  return `
    <tr data-tracker-winner-id="${escapeHtml(r.id)}">
      <td>${sn}</td>
      <td>
        <select class="tracker-input" data-tracker-field="offer">
          <option value="" ${!r.offer ? "selected" : ""}>—</option>
          <option value="CPI" ${r.offer === "CPI" ? "selected" : ""}>CPI</option>
          <option value="SWEEPS" ${r.offer === "SWEEPS" ? "selected" : ""}>Sweeps</option>
        </select>
      </td>
      <td>
        <select class="tracker-input tracker-type-select ${typeClass}" data-tracker-field="type">
          <option value="" ${!r.type ? "selected" : ""}>—</option>
          <option value="SLIDES" ${r.type === "SLIDES" ? "selected" : ""}>Slides</option>
          <option value="VIDEOS" ${r.type === "VIDEOS" ? "selected" : ""}>Videos</option>
        </select>
      </td>
      <td><input type="text" class="tracker-input" data-tracker-field="hook" value="${escapeHtml(r.hook || "")}" placeholder="Hook…" /></td>
      <td class="num"><input type="number" min="0" step="0.01" class="tracker-input tracker-num" data-tracker-field="total_spend" value="${spend}" /></td>
      <td class="num"><input type="number" min="0" step="0.01" class="tracker-input tracker-num" data-tracker-field="total_revenue" value="${revenue}" /></td>
      <td class="num roas-cell" style="color:${roasColor(roas)}">${roas.toFixed(2)}x</td>
      <td><input type="text" class="tracker-input" data-tracker-field="notes" value="${escapeHtml(r.notes || "")}" placeholder="Notes…" /></td>
      <td><button type="button" class="tracker-del-btn" data-tracker-del="winner">Delete</button></td>
    </tr>`;
}

async function saveTrackerTestField(id, field, rawValue) {
  const patch = { [field]: rawValue === "" ? null : rawValue };
  try {
    const { test } = await trackerAuthedCall(trackerUpdateTest, id, patch);
    const idx = state.tracker.tests.findIndex((r) => r.id === id);
    if (idx !== -1) state.tracker.tests[idx] = test;
    renderTrackerActive();
  } catch (err) {
    document.getElementById("trackerError").textContent = err.message || "Couldn't save.";
    renderTrackerActive(); // revert the field to the last-known-good value
  }
}

async function saveTrackerWinnerField(id, field, rawValue) {
  const isNum = field === "total_spend" || field === "total_revenue";
  const value = isNum ? Number(rawValue) || 0 : rawValue === "" ? null : rawValue;
  try {
    const { winner } = await trackerAuthedCall(trackerUpdateWinner, id, { [field]: value });
    const idx = state.tracker.winners.findIndex((r) => r.id === id);
    if (idx !== -1) state.tracker.winners[idx] = winner;
    renderTrackerActive();
  } catch (err) {
    document.getElementById("trackerError").textContent = err.message || "Couldn't save.";
    renderTrackerActive();
  }
}

function trackerFieldChangeHandler(e) {
  const el = e.target.closest("[data-tracker-field]");
  if (!el) return;
  const field = el.dataset.trackerField;
  const testRow = el.closest("[data-tracker-test-id]");
  const winnerRow = el.closest("[data-tracker-winner-id]");
  if (testRow) saveTrackerTestField(testRow.dataset.trackerTestId, field, el.value);
  else if (winnerRow) saveTrackerWinnerField(winnerRow.dataset.trackerWinnerId, field, el.value);
}

async function addTrackerWinnerRow() {
  try {
    const { winner } = await trackerAuthedCall(trackerCreateWinner);
    state.tracker.winners.push(winner);
    renderTrackerActive();
  } catch (err) {
    document.getElementById("trackerError").textContent = err.message || "Couldn't add the row.";
  }
}

function trackerDeleteClickHandler(e) {
  const btn = e.target.closest("[data-tracker-del]");
  if (!btn) return;
  const row = btn.closest("[data-tracker-test-id],[data-tracker-winner-id]");
  const id = row && (row.dataset.trackerTestId || row.dataset.trackerWinnerId);
  if (!id) return;
  trackerDeleteTarget = { kind: btn.dataset.trackerDel, id };
  document.getElementById("trackerDeleteModal").classList.add("open");
}

function closeTrackerDeleteModal() {
  document.getElementById("trackerDeleteModal").classList.remove("open");
  trackerDeleteTarget = null;
}

async function confirmTrackerDelete() {
  if (!trackerDeleteTarget) return closeTrackerDeleteModal();
  const { kind, id } = trackerDeleteTarget;
  try {
    if (kind === "test") {
      await trackerAuthedCall(trackerDeleteTest, id);
      state.tracker.tests = state.tracker.tests.filter((r) => r.id !== id);
    } else {
      await trackerAuthedCall(trackerDeleteWinner, id);
      state.tracker.winners = state.tracker.winners.filter((r) => r.id !== id);
    }
    closeTrackerDeleteModal();
    renderTrackerActive();
  } catch (err) {
    trackerDeleteTarget = null;
    document.getElementById("trackerDeleteModal").classList.remove("open");
    document.getElementById("trackerError").textContent = err.message || "Couldn't delete.";
  }
}

function wireTrackerEvents() {
  document.getElementById("closeTrackerModal").addEventListener("click", closeTrackerModal);
  document.getElementById("trackerModal").addEventListener("click", (e) => {
    if (e.target.id === "trackerModal") closeTrackerModal();
  });

  document.getElementById("trackerTabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tracker-tab]");
    if (btn) setTrackerTab(btn.dataset.trackerTab);
  });
  document.getElementById("trackerOfferFilter").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tracker-offer]");
    if (btn) setTrackerOfferFilter(btn.dataset.trackerOffer);
  });
  document.getElementById("trackerAddWinnerBtn").addEventListener("click", addTrackerWinnerRow);

  document.getElementById("trackerTestsWrap").addEventListener("change", trackerFieldChangeHandler);
  document.getElementById("trackerTestsWrap").addEventListener("click", trackerDeleteClickHandler);
  document.getElementById("trackerWinnersWrap").addEventListener("change", trackerFieldChangeHandler);
  document.getElementById("trackerWinnersWrap").addEventListener("click", trackerDeleteClickHandler);

  document.getElementById("closeTrackerDeleteModal").addEventListener("click", closeTrackerDeleteModal);
  document.getElementById("cancelTrackerDeleteBtn").addEventListener("click", closeTrackerDeleteModal);
  document.getElementById("trackerDeleteModal").addEventListener("click", (e) => {
    if (e.target.id === "trackerDeleteModal") closeTrackerDeleteModal();
  });
  document.getElementById("confirmTrackerDeleteBtn").addEventListener("click", confirmTrackerDelete);
}

// Tracker auto-populate. Runs once a day (see tracker-run.js, the cron) after
// America/New_York midnight, so it always targets a NY date that is already
// fully over — not "whatever the dashboard last saw". It asks TikTok and
// Glitchy/Mabac for THAT specific date's own historical numbers directly, the
// same way netlify/functions/tiktok-campaigns.js's backfillStaleDailyTotals
// already does for daily_totals — so it works correctly even if the dashboard
// was never open that day.
//
// Scope: only campaigns registered in campaign_creator_campaigns (the only
// place a "used an Interactive Card" flag exists, via ad_payload.card_id —
// see _shared/campaign-creator-build.js). Campaigns created outside Campaign
// Creator are not trackable this way and are skipped.
//
// Idempotent / freeze rule: a tracker_tests row's auto columns (sn, type, cpa,
// cpnc, epc, roas, result, test_date) are only ever written while the row's
// stored test_date is NOT older than the date being populated — i.e. once a
// day closes out, that row is frozen forever, even if this job re-runs or a
// campaign with the same campaign_id somehow still has activity later.
// offer / hook / notes are NEVER written here — those are user-entered only.

const {
  getSupabase,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  dashboardToday,
  loadCampaignMetricsForAdvertiser,
} = require("./tiktok-mcp");
const { fetchGlitchy, sumEntriesBySourceForDate } = require("./glitchy-daily");
const { fetchMabacSubIdReport } = require("./mabac");

// Calendar-date subtraction on a YYYY-MM-DD string — pure date math (UTC noon
// anchor), never touches the wall clock, so it's DST-safe.
function dayBefore(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function resultFor(roas) {
  const r = Number(roas) || 0;
  if (r < 0.8) return "DEAD";
  if (r < 1.5) return "BREAK_EVEN";
  return "WINNER";
}

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
const ratio = (a, b) => (b > 0 ? a / b : 0);

// Populates tracker_tests for `targetDate` (defaults to yesterday's NY date).
// Returns a small summary object; never throws — every failure is best-effort
// and recorded in `errors` so a partial outage (one dead connection) doesn't
// block every other advertiser.
async function populateTrackerTests(supabase, targetDate) {
  const nyToday = dashboardToday();
  const date = targetDate || dayBefore(nyToday);
  const out = { date, upserted: 0, skipped: 0, errors: {} };

  const { data: ccRows, error: ccErr } = await supabase
    .from("campaign_creator_campaigns")
    .select("campaign_id, campaign_name, connection_id, advertiser_id, ad_payload");
  if (ccErr) {
    if (/does not exist|schema cache|could not find/i.test(ccErr.message || "")) return out;
    out.errors.campaign_creator_campaigns = ccErr.message;
    return out;
  }
  if (!ccRows || !ccRows.length) return out;

  const ids = ccRows.map((r) => String(r.campaign_id));

  // Affiliate network ownership per campaign (GLITCHY default, same rule the
  // frontend's rebuildSources uses).
  let netById = new Map();
  try {
    const { data: tkRows } = await supabase
      .from("tiktok_campaigns")
      .select("campaign_id, affiliate_network")
      .in("campaign_id", ids);
    netById = new Map((tkRows || []).map((r) => [String(r.campaign_id), String(r.affiliate_network || "GLITCHY").toUpperCase()]));
  } catch (_) {
    /* default GLITCHY for everything */
  }

  // Existing tracker rows — to enforce the freeze rule before overwriting.
  let existingById = new Map();
  try {
    const { data: exRows } = await supabase.from("tracker_tests").select("campaign_id, test_date").in("campaign_id", ids);
    existingById = new Map((exRows || []).map((r) => [String(r.campaign_id), String(r.test_date)]));
  } catch (_) {
    /* no existing rows / table not migrated — treated as none below */
  }

  // ---- Glitchy + Mabac for `date`, by source name (campaign_name) ----
  let glitchyBySource = {};
  const token = process.env.GLITCHY_TOKEN;
  if (token) {
    try {
      const { entries } = await fetchGlitchy(token, date, date);
      glitchyBySource = sumEntriesBySourceForDate(entries, date);
    } catch (err) {
      out.errors.glitchy = err.message;
    }
  }
  let mabacBySub1 = {};
  try {
    const mb = await fetchMabacSubIdReport({ startDate: date, endDate: date });
    for (const s of mb.sources || []) if (s && s.sub1) mabacBySub1[s.sub1] = s;
  } catch (err) {
    out.errors.mabac = err.message; // optional network — never fatal
  }

  // ---- TikTok spend/cpa for `date`, per campaign_id — grouped by connection
  //      so each Business Center only needs one MCP client / one report call
  //      per advertiser account (mirrors backfillStaleDailyTotals). ----
  const byConnection = new Map();
  for (const r of ccRows) {
    if (!byConnection.has(r.connection_id)) byConnection.set(r.connection_id, new Map());
    const byAdv = byConnection.get(r.connection_id);
    if (!byAdv.has(r.advertiser_id)) byAdv.set(r.advertiser_id, []);
    byAdv.get(r.advertiser_id).push(r);
  }

  const { serverUrl, redirectUrl } = resolveConfig();
  const tkMetricsById = new Map();

  for (const [connectionId, byAdv] of byConnection.entries()) {
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      out.errors[`conn:${connectionId}`] = "connection not found";
      continue;
    }
    const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection: conn });
    let client;
    try {
      ({ client } = await connectMcp({ provider, serverUrl }));
    } catch (err) {
      out.errors[`conn:${connectionId}`] = err.message;
      continue;
    }
    try {
      for (const advertiserId of byAdv.keys()) {
        try {
          const byId = await loadCampaignMetricsForAdvertiser(client, advertiserId, { date });
          for (const [cid, m] of Object.entries(byId)) tkMetricsById.set(cid, m);
        } catch (err) {
          out.errors[`adv:${advertiserId}`] = err.message;
        }
      }
    } finally {
      await client.close().catch(() => {});
    }
  }

  // ---- Compute + upsert ----
  const upserts = [];
  for (const cc of ccRows) {
    const cid = String(cc.campaign_id);
    const frozenAt = existingById.get(cid);
    if (frozenAt && frozenAt !== date) {
      out.skipped++; // already closed out on a different (earlier) day — never touch again
      continue;
    }

    const tk = tkMetricsById.get(cid);
    if (!tk) {
      out.skipped++; // no TikTok report row for this date (never ran that day) — nothing to record
      continue;
    }

    const spend = Number(tk.spend) || 0;
    if (spend <= 0) {
      out.skipped++; // campaign existed that day but never actually spent — not a real test, don't clutter Tracker
      continue;
    }

    const network = netById.get(cid) || "GLITCHY";
    const aff = network === "MABAC" ? mabacBySub1[cc.campaign_name] : glitchyBySource[cc.campaign_name];
    const clicks = aff ? Number(aff.clicks) || 0 : 0;
    const payout = aff ? Number(network === "MABAC" ? aff.revenue : aff.payout) || 0 : 0;

    const roas = round4(ratio(payout, spend));
    const cardId = cc.ad_payload && typeof cc.ad_payload === "object" ? cc.ad_payload.card_id : null;

    upserts.push({
      campaign_id: cid,
      sn: cc.campaign_name || cid,
      type: cardId ? "VIDEOS" : "SLIDES",
      spend: round2(spend),
      cpa: round2(tk.cpa),
      cpnc: round2(ratio(spend, clicks)),
      epc: round2(ratio(payout, clicks)),
      roas,
      result: resultFor(roas),
      test_date: date,
      updated_at: new Date().toISOString(),
    });
  }

  if (upserts.length) {
    let { error } = await supabase.from("tracker_tests").upsert(upserts, { onConflict: "campaign_id" });
    if (error && /spend/.test(error.message || "") && /column .* does not exist|schema cache/i.test(error.message || "")) {
      // Not migrated yet (supabase/tracker.sql) — retry without it so the rest
      // of the row still gets recorded; spend-based filtering just falls back
      // to "show everything" until the migration runs.
      const bare = upserts.map(({ spend, ...r }) => r);
      ({ error } = await supabase.from("tracker_tests").upsert(bare, { onConflict: "campaign_id" }));
    }
    if (error) out.errors.upsert = error.message;
    else out.upserted = upserts.length;
  }

  return out;
}

module.exports = { populateTrackerTests, dayBefore, resultFor };

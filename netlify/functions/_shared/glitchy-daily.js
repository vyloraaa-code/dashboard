// Shared by glitchy-stats.js and daily-totals.js.
//
// The dashboard day is simply the EST calendar date. There is no manual
// "New Day" / session concept any more: Glitchy is queried for today, summed
// by source, and today's row in `daily_totals` is kept current on every poll.
// When EST midnight passes, Glitchy returns the new date's data and a fresh
// `daily_totals` row is written automatically.
//
// (The old `reset_baselines` table and its session logic are gone. The table
// is left in place as historical storage but is never read or written.)

const { createClient } = require("@supabase/supabase-js");

let WebSocketImpl;
try {
  WebSocketImpl = require("ws");
} catch (_) {
  WebSocketImpl = undefined; // fall back to a global WebSocket if present
}

// EST calendar date (YYYY-MM-DD). Glitchy's `hour` field is EST-anchored, so
// everything the dashboard shows is keyed to this same clock.
function todayEst() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Glitchy's Stat.date is normalised to a bare YYYY-MM-DD (EST) so per-day
// filtering is safe regardless of the exact string Glitchy returns.
function normalizeDateKey(raw, fallback) {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(raw);
  if (isNaN(d)) return fallback;
  const est = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${est.getFullYear()}-${String(est.getMonth() + 1).padStart(2, "0")}-${String(est.getDate()).padStart(2, "0")}`;
}

// Supabase client with an explicit WebSocket for the Realtime constructor that
// @supabase/supabase-js builds inside createClient() (Netlify's Lambda Node
// runtime does not reliably expose a global WebSocket). Realtime is unused.
function supabaseClient() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_KEY || "").trim();
  if (!url || !key) return null;
  const opts = { auth: { persistSession: false } };
  if (WebSocketImpl) opts.realtime = { transport: WebSocketImpl };
  return createClient(url, key, opts);
}

// Fetch Glitchy for [startDate, endDate] and return the raw entries plus a
// plain per-source sum (no baseline correction).
async function fetchGlitchy(token, startDate, endDate) {
  const url = `https://api.glitchy.com/v3/stats?rangeTypeValue=Today&startDate=${startDate}&endDate=${endDate}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/plain, */*" },
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Glitchy responded with status ${response.status}`);
    err.status = response.status;
    err.details = text.slice(0, 500);
    throw err;
  }

  const data = await response.json();
  const entries = Array.isArray(data) ? data : data.data || data.results || [data];
  return { entries, bySource: summarizeBySource(entries) };
}

// Sum raw Glitchy entries by source.
function summarizeBySource(entries) {
  const result = {};
  const offerName = {};
  for (const entry of entries) {
    const stat = entry.Stat || entry.stat || entry;
    if (!stat || !stat.source) continue;
    const src = stat.source;
    result[src] = result[src] || { clicks: 0, conversions: 0, payout: 0, entries_count: 0 };
    result[src].clicks += Number(stat.clicks || 0);
    result[src].conversions += Number(stat.conversions || 0);
    result[src].payout += Number(stat.payout || 0);
    result[src].entries_count += 1;
    offerName[src] = entry.Offer?.name || entry.offer?.name || offerName[src] || null;
  }
  for (const src of Object.keys(result)) {
    result[src].payout = Math.round(result[src].payout * 100) / 100;
    result[src].offer_name = offerName[src];
  }
  return result;
}

// Sum only the entries dated `dateStr` (EST) — used for today's totals even
// when the fetch covered a wider range.
function sumEntriesForDate(entries, dateStr) {
  const b = sumEntriesBySourceForDate(entries, dateStr);
  let payout = 0;
  let clicks = 0;
  let conversions = 0;
  for (const s of Object.values(b)) {
    payout += s.payout;
    clicks += s.clicks;
    conversions += s.conversions;
  }
  return { payout: Math.round(payout * 100) / 100, clicks, conversions };
}

// Per-source Glitchy totals for one EST date.
function sumEntriesBySourceForDate(entries, dateStr) {
  const bySource = {};
  for (const entry of entries) {
    const stat = entry.Stat || entry.stat || entry;
    if (!stat || !stat.source) continue;
    const dk = stat.date ? normalizeDateKey(stat.date, dateStr) : dateStr;
    if (dk !== dateStr) continue;
    const s = (bySource[stat.source] = bySource[stat.source] || { payout: 0, clicks: 0, conversions: 0 });
    s.payout += Number(stat.payout || 0);
    s.clicks += Number(stat.clicks || 0);
    s.conversions += Number(stat.conversions || 0);
  }
  return bySource;
}

// Combined affiliate earnings for a day, mirroring the frontend rebuildSources
// network-ownership rule so daily_totals matches the dashboard KPIs:
//   - a name declared MABAC (a tracked campaign in a Mabac BC) uses Mabac data
//   - a name only present in Mabac (and not declared) uses Mabac data
//   - everything else uses Glitchy data
// Glitchy + Mabac are never summed for the same name.
function combinedEarnings({ glitchyBySource = {}, mabacBySub1 = {}, networkByName = {} }) {
  const names = new Set([
    ...Object.keys(glitchyBySource),
    ...Object.keys(mabacBySub1),
    ...Object.keys(networkByName),
  ]);
  let earnings = 0;
  let clicks = 0;
  let conversions = 0;
  for (const name of names) {
    const g = glitchyBySource[name];
    const m = mabacBySub1[name];
    const declared = String(networkByName[name] || "").toUpperCase();
    let net;
    if (declared === "MABAC" || declared === "GLITCHY") net = declared;
    else if (m && !g) net = "MABAC";
    else net = "GLITCHY";
    const src = net === "MABAC" ? m : g;
    if (!src) continue;
    earnings += net === "MABAC" ? Number(src.revenue || 0) : Number(src.payout || 0);
    clicks += Number(src.clicks || 0);
    conversions += Number(src.conversions || 0);
  }
  return { earnings: Math.round(earnings * 100) / 100, clicks, conversions };
}

// Sum of today's TikTok campaign spend, read straight from the per-campaign
// `today_spend` columns that tiktok-campaigns.js's "metrics" action keeps
// current. Decoupled on purpose: this path (the Glitchy poll) never needs an
// MCP client, and a TikTok outage just means daily_totals carries the last
// value the dashboard managed to persist. Returns 0 if the columns aren't
// migrated yet or on any error.
async function tiktokSpendForToday(supabase, today) {
  try {
    const { data, error } = await supabase
      .from("tiktok_campaigns")
      .select("campaign_id, today_spend, today_date");
    if (error) {
      // Was silent before — a real error here (as opposed to a genuinely
      // empty table) previously meant the Live Performance Spend line sat at
      // a permanent, indistinguishable-from-"no data" $0 with no trace of
      // why anywhere. "does not exist"/"schema cache" means
      // supabase/tiktok_campaign_metrics.sql hasn't been run yet; anything
      // else is worth investigating.
      console.error(`[tiktokSpendForToday] query failed: ${error.message}`);
      return 0;
    }
    if (!Array.isArray(data)) return 0;

    // WH Warmup campaigns show in Detailed Metrics while they exist but their
    // throwaway warmup spend must never land in the permanent daily_totals
    // calendar. Drop them here (best-effort; table may not be migrated).
    let whIds = new Set();
    try {
      const { data: wh } = await supabase.from("wh_warmup_campaigns").select("campaign_id");
      whIds = new Set((wh || []).map((r) => String(r.campaign_id)));
    } catch (_) {
      /* no WH table — nothing to exclude */
    }

    let spend = 0;
    for (const r of data) {
      if (String(r.today_date) !== String(today)) continue; // stale / another day
      if (whIds.has(String(r.campaign_id))) continue; // WH Warmup — not calendar spend
      spend += Number(r.today_spend) || 0;
    }
    return Math.round(spend * 100) / 100;
  } catch (err) {
    console.error(`[tiktokSpendForToday] failed: ${err.message}`);
    return 0;
  }
}

// Upsert today's row in `daily_totals` (date, total_spend, total_earnings,
// updated_at). `total_spend` is today's real TikTok campaign spend, summed from
// the persisted per-campaign `today_spend` columns (see tiktokSpendForToday);
// it is 0 only when TikTok genuinely has no spend today OR the metrics columns
// haven't been migrated / no metrics refresh has run yet. `opts.mabacSources` +
// `opts.networkByName` fold in Mabac earnings by network ownership (no
// double-count with Glitchy).
async function upsertTodayTotals(supabase, entries, opts = {}) {
  const today = todayEst();
  const glitchyBySource = sumEntriesBySourceForDate(entries, today);
  const mabacBySub1 = {};
  for (const s of opts.mabacSources || []) if (s && s.sub1) mabacBySub1[s.sub1] = s;

  const { earnings } = combinedEarnings({
    glitchyBySource,
    mabacBySub1,
    networkByName: opts.networkByName || {},
  });

  const totalSpend = await tiktokSpendForToday(supabase, today);

  const { error } = await supabase.from("daily_totals").upsert(
    {
      date: today,
      total_spend: totalSpend,
      total_earnings: earnings,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "date" }
  );
  if (error) throw new Error(`daily_totals upsert failed: ${error.message}`);
  return { date: today, total_spend: totalSpend, total_earnings: earnings };
}

// Current hour (0-23) in America/New_York — same clock as todayEst().
function nyHourNow() {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date());
  return parseInt(s, 10) % 24; // guards the historical "24" at midnight
}

// Snapshot mirrors tiktok_spend_snapshots.sql exactly, but for combined
// Glitchy+Mabac earnings — see supabase/earnings_snapshots.sql. Never throws:
// a write/read hiccup here must never blank out the Live Performance graph's
// Earnings line, so each step is isolated in its own try/catch.
async function recordEarningsSnapshot(supabase, date, hour, cumulative) {
  const value = Math.round((Number(cumulative) || 0) * 100) / 100;
  try {
    const { error } = await supabase.from("earnings_snapshots").upsert(
      { date, hour, cumulative_earnings: value, updated_at: new Date().toISOString() },
      { onConflict: "date,hour" }
    );
    if (error) {
      if (/earnings_snapshots|does not exist|schema cache/i.test(error.message || "")) return;
      throw error;
    }
    // Opportunistic cleanup — tiny table, keep ~14 days.
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    await supabase.from("earnings_snapshots").delete().lt("date", cutoff);
  } catch (err) {
    console.error(`[earnings-snapshot] write failed: ${err.message}`);
  }
}

// { "<hour>": cumulative_earnings } for one NY date. Empty on any error / no rows.
async function readEarningsSnapshots(supabase, date) {
  try {
    const { data, error } = await supabase.from("earnings_snapshots").select("hour, cumulative_earnings").eq("date", date);
    if (error || !Array.isArray(data)) return {};
    const byHour = {};
    for (const r of data) byHour[String(r.hour)] = Number(r.cumulative_earnings) || 0;
    return byHour;
  } catch (_) {
    return {};
  }
}

// Records this poll's combined-earnings-so-far into the current NY hour and
// hands back every hour's cumulative for the frontend to derive hourly
// earnings from (delta between consecutive snapshots) — the Earnings-series
// analog of tiktok-campaigns.js's spendToday. Always returns a real object;
// never null (a snapshot hiccup just means byHour is incomplete this cycle).
async function earningsSnapshotToday(supabase, date, earnings) {
  const hour = nyHourNow();
  await recordEarningsSnapshot(supabase, date, hour, earnings);
  const byHour = await readEarningsSnapshots(supabase, date);
  return { date, currentHour: hour, cumulative: earnings, byHour };
}

// campaign_name -> affiliate_network, from tiktok_campaigns. Empty on any error
// (e.g. before the migration) so callers just get Glitchy-only behaviour.
async function networkByCampaignName(supabase) {
  try {
    const { data, error } = await supabase.from("tiktok_campaigns").select("campaign_name, affiliate_network");
    if (error) return {};
    const map = {};
    for (const r of data || []) if (r.campaign_name) map[r.campaign_name] = r.affiliate_network || "GLITCHY";
    return map;
  } catch (_) {
    return {};
  }
}

module.exports = {
  todayEst,
  normalizeDateKey,
  supabaseClient,
  fetchGlitchy,
  summarizeBySource,
  sumEntriesForDate,
  sumEntriesBySourceForDate,
  combinedEarnings,
  networkByCampaignName,
  tiktokSpendForToday,
  upsertTodayTotals,
  earningsSnapshotToday,
};

// This runs on Netlify's server, not in the browser.
// Your Glitchy token stays here — never sent to the frontend.
//
// Fetches Glitchy for the EST calendar day (default today), sums by source,
// and keeps today's `daily_totals` history row current on every call. There is
// no session / "New Day" concept — the day rolls over automatically at EST
// midnight.

const {
  todayEst,
  supabaseClient,
  fetchGlitchy,
  upsertTodayTotals,
  networkByCampaignName,
  earningsSnapshotToday,
} = require("./_shared/glitchy-daily");
const { fetchMabacSubIdReport } = require("./_shared/mabac");

exports.handler = async function (event) {
  try {
    const token = process.env.GLITCHY_TOKEN;

    if (!token) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "GLITCHY_TOKEN is missing. Add it in Netlify → Site settings → Environment variables.",
        }),
      };
    }

    // ?startDate=2026-07-04&endDate=2026-07-05 — both default to today (EST).
    const params = event.queryStringParameters || {};
    const today = todayEst();
    const startDate = params.startDate || today;
    const endDate = params.endDate || today;

    const { entries, bySource } = await fetchGlitchy(token, startDate, endDate);
    const sources = Object.keys(bySource).map((src) => ({ source: src, ...bySource[src] }));

    // Diagnostic only — helps confirm whether Glitchy's Stat.date carries a
    // real time-of-day (needed for true per-hour Earnings attribution on the
    // Live Performance graph, not yet implemented) or is just a bare date.
    // Safe to remove once that's settled; never affects the response.
    if (entries.length) {
      const sample = (entries[0].Stat || entries[0].stat || entries[0] || {}).date;
      console.log(`[glitchy-stats] sample Stat.date: ${JSON.stringify(sample)}`);
    }

    // Automatic daily history: refresh today's row whenever the requested range
    // reaches today (the normal dashboard poll). Combined Glitchy + Mabac
    // earnings by network ownership. Every part here is best-effort — a Mabac
    // or Supabase hiccup never blocks the Glitchy response.
    let earningsToday = null;
    if (endDate >= today) {
      const supabase = supabaseClient();
      if (supabase) {
        let mabacSources = [];
        try {
          const mb = await fetchMabacSubIdReport({ startDate: today, endDate: today });
          mabacSources = mb.sources || [];
        } catch (_) {
          /* Mabac optional */
        }
        try {
          const networkByName = await networkByCampaignName(supabase);
          const totals = await upsertTodayTotals(supabase, entries, { mabacSources, networkByName });
          // Live Performance graph ONLY: snapshot the combined total-so-far into
          // the current NY hour so the Earnings line reflects Mabac too (raw
          // Glitchy entries alone, used below for backward-compat, never do).
          earningsToday = await earningsSnapshotToday(supabase, today, totals.total_earnings);
        } catch (err) {
          console.error(`[glitchy-stats] daily history / earnings snapshot failed: ${err.message}`);
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        startDate,
        endDate,
        raw_entry_count: entries.length,
        sources,
        // The Live Performance hourly chart uses `earningsToday` (combined
        // Glitchy+Mabac, snapshotted per NY hour — see above), not raw
        // per-entry data, so the raw entries themselves aren't sent here.
        earningsToday,
      }),
    };
  } catch (err) {
    if (err.status) {
      return {
        statusCode: err.status,
        body: JSON.stringify({ error: err.message, details: err.details }),
      };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Function crashed", message: err.message, stack: err.stack }),
    };
  }
};

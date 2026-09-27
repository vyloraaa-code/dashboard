// Testing/Scale decision engine — Phase 1, SHADOW MODE ONLY.
//
// Runs inside the same "metrics" cycle as applyAutoBudgetBumps
// (tiktok-campaigns.js), reusing the same already-fetched TikTok spend — no
// extra TikTok API call. Unlike auto-budget-bump, this needs no MCP client:
// it only reads spend the caller already has, plus one account-wide
// Glitchy/Mabac fetch per cycle (see fetchEarningsToday), never once per
// advertiser.
//
// Phase 1 NEVER calls setCampaignStatus/setAdgroupStatus/campaign_update.
// Every verdict is logged only (tiktok_campaigns.lifecycle_* + an insert
// into testing_scale_events) for a human to read. Live pause/scale actions
// are an explicit later phase.

const { fetchGlitchy } = require("./glitchy-daily");
const { fetchMabacSubIdReport } = require("./mabac");

// ---- Placeholder thresholds — starter defaults, TUNE ONCE REAL DATA EXISTS ----
const MIN_SPEND_FOR_VERDICT = 20; // $ cumulative in-state spend before ANY ROAS verdict — below this, ROAS is too noisy (1-2 clicks) to trust
const FAST_KILL_SPEND = 15; // $ cumulative spend with 0 conversions -> kill immediately, don't even wait for MIN_SPEND_FOR_VERDICT
const GRADUATION_ROAS = 1.3; // cumulative payout/spend >= this (once MIN_SPEND_FOR_VERDICT met) -> scaling
const KILL_ROAS_FLOOR = 0.3; // cumulative payout/spend <= this (once MIN_SPEND_FOR_VERDICT met) -> killed
const TIMEOUT_SPEND = 50; // cumulative spend cap -> killed even if ROAS is still ambiguous (between KILL_ROAS_FLOOR and GRADUATION_ROAS)

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const toNum = (v) => Number(v) || 0;
const ratio = (a, b) => (b > 0 ? a / b : 0);

// Called ONCE per "metrics" cycle (not per advertiser) — same shape as the
// existing account-wide Glitchy/Mabac fetches in glitchy-stats.js /
// daily-totals.js. Returns bySource/bySub1 maps keyed by campaign_name,
// exactly like rebuildSources() joins client-side today.
async function fetchEarningsToday(date) {
  const out = { glitchyBySource: {}, mabacBySub1: {}, errors: {} };
  const token = process.env.GLITCHY_TOKEN;
  if (token) {
    try {
      const { bySource } = await fetchGlitchy(token, date, date);
      out.glitchyBySource = bySource || {};
    } catch (err) {
      out.errors.glitchy = err.message;
    }
  }
  try {
    const mb = await fetchMabacSubIdReport({ startDate: date, endDate: date });
    for (const s of mb.sources || []) if (s && s.sub1) out.mabacBySub1[s.sub1] = s;
  } catch (err) {
    out.errors.mabac = err.message; // optional network — never fatal
  }
  return out;
}

// Folds ONE metric's marginal delta into its cumulative accumulator.
// `todayNow` is this poll's day-running total (resets to 0 daily);
// `lastSeenToday` is what we observed it at on the previous poll.
function foldDelta(accum, lastSeenToday, todayNow) {
  const delta = Math.max(0, toNum(todayNow) - toNum(lastSeenToday));
  return { accum: round2(toNum(accum) + delta), lastSeenToday: round2(toNum(todayNow)) };
}

// 'scaling' and 'killed' are terminal for Phase 1 — no re-verdicts once
// decided (there's no action wired to a verdict yet, so continuously
// re-deciding would only spam testing_scale_events).
function decide(state, spend, payout, conversions) {
  if (state === "scaling" || state === "killed") return null;
  const roas = ratio(payout, spend);
  if (spend >= FAST_KILL_SPEND && conversions <= 0) {
    return { to: "killed", reason: `fast_kill: $${round2(spend)} spent, 0 conversions` };
  }
  if (spend >= MIN_SPEND_FOR_VERDICT) {
    if (roas >= GRADUATION_ROAS) return { to: "scaling", reason: `graduated: ${roas.toFixed(2)}x roas at $${round2(spend)} spend` };
    if (roas <= KILL_ROAS_FLOOR) return { to: "killed", reason: `low_roas: ${roas.toFixed(2)}x roas at $${round2(spend)} spend` };
  }
  if (spend >= TIMEOUT_SPEND) {
    return { to: "killed", reason: `timeout: $${round2(spend)} spent, still ambiguous (${roas.toFixed(2)}x roas)` };
  }
  return null;
}

// spendByCampaignId: { campaign_id: spend } — THIS advertiser's slice of the
// SAME report tiktok-campaigns.js just fetched (identical input shape to
// applyAutoBudgetBumps).
// knownById: Map campaign_id -> tiktok_campaigns row. Must include
// campaign_name, connection_id, advertiser_id, affiliate_network, and every
// lifecycle_* column added by testing_scale_lifecycle.sql.
// whIds / strayIds: Sets of campaign_ids to always skip (throwaway / unwatched).
// earnings: { glitchyBySource, mabacBySub1 } from fetchEarningsToday — fetched
// ONCE per cycle by the caller and passed to every advertiser's call, so the
// account-wide Glitchy/Mabac fetch never repeats per advertiser.
// nowIso: one Date().toISOString() shared for the whole cycle.
//
// Returns { rows, events }:
//   rows   -> fold into the SAME tiktok_campaigns upsert the caller already
//             builds (one row per campaign touched this poll, state-changed
//             or not — the accumulators update every poll regardless).
//   events -> insert into testing_scale_events (only campaigns whose state
//             actually changed this poll).
function applyLifecycleDecisions({ spendByCampaignId, knownById, whIds, strayIds, earnings, nowIso }) {
  const rows = [];
  const events = [];

  for (const cid of Object.keys(spendByCampaignId)) {
    if (whIds.has(cid) || (strayIds && strayIds.has(cid))) continue;
    const k = knownById.get(cid);
    if (!k) continue;

    const network = String(k.affiliate_network || "GLITCHY").toUpperCase();
    const aff = network === "MABAC" ? earnings.mabacBySub1[k.campaign_name] : earnings.glitchyBySource[k.campaign_name];
    const todaySpend = toNum(spendByCampaignId[cid]);
    const todayPayout = network === "MABAC" ? toNum(aff?.revenue) : toNum(aff?.payout);
    const todayConversions = toNum(aff?.conversions);

    const spendFold = foldDelta(k.lifecycle_spend_accum, k.lifecycle_last_seen_today_spend, todaySpend);
    const payoutFold = foldDelta(k.lifecycle_payout_accum, k.lifecycle_last_seen_today_payout, todayPayout);
    const convFold = foldDelta(k.lifecycle_conversions_accum, k.lifecycle_last_seen_today_conversions, todayConversions);

    const currentState = k.lifecycle_state || "testing";
    const verdict = decide(currentState, spendFold.accum, payoutFold.accum, convFold.accum);

    rows.push({
      campaign_id: cid,
      lifecycle_state: verdict ? verdict.to : currentState,
      lifecycle_state_since: verdict ? nowIso : k.lifecycle_state_since || nowIso,
      lifecycle_spend_accum: verdict ? 0 : spendFold.accum,
      lifecycle_payout_accum: verdict ? 0 : payoutFold.accum,
      lifecycle_conversions_accum: verdict ? 0 : convFold.accum,
      lifecycle_last_seen_today_spend: spendFold.lastSeenToday,
      lifecycle_last_seen_today_payout: payoutFold.lastSeenToday,
      lifecycle_last_seen_today_conversions: convFold.lastSeenToday,
    });

    if (verdict) {
      events.push({
        campaign_id: cid,
        campaign_name: k.campaign_name,
        connection_id: k.connection_id,
        advertiser_id: k.advertiser_id,
        ts: nowIso,
        from_state: currentState,
        to_state: verdict.to,
        reason: verdict.reason,
        spend_at_decision: spendFold.accum,
        payout_at_decision: payoutFold.accum,
        conversions_at_decision: convFold.accum,
        roas_at_decision: round2(ratio(payoutFold.accum, spendFold.accum)),
      });
    }
  }
  return { rows, events };
}

// Called from BOTH tiktok-campaigns.js's inline stale-today reset AND
// cleanup.js's identical daily-cron reset, IMMEDIATELY BEFORE each runs its
// existing blind `update({today_spend:0,...}).neq('today_date', nyToday)`.
// Folds each stale campaign's final pre-rollover today_spend into
// lifecycle_spend_accum before it gets zeroed, and zeroes ALL THREE
// lifecycle_last_seen_today_* counters so tomorrow's first poll computes a
// correct delta from 0 (a stale lastSeenToday would otherwise clamp
// tomorrow's early spend/payout/conversions to a 0 delta until it exceeds
// yesterday's leftover number). lifecycle_payout_accum / conversions_accum
// are carried forward UNCHANGED here — their marginal delta for the final
// pre-rollover moment was already folded in by the last live "metrics" poll
// before rollover (via applyLifecycleDecisions); this step only needs to
// stop counting from a stale baseline, not re-fetch Glitchy/Mabac.
async function foldStaleLifecycleAccumBeforeReset(supabase, nyToday) {
  const { data: stale, error } = await supabase
    .from("tiktok_campaigns")
    .select(
      "campaign_id, today_spend, lifecycle_spend_accum, lifecycle_last_seen_today_spend, " +
        "lifecycle_payout_accum, lifecycle_conversions_accum"
    )
    .not("today_date", "is", null)
    .neq("today_date", nyToday);
  if (error || !stale || !stale.length) return; // best-effort; missing columns = migration not run yet
  const rows = stale.map((r) => {
    const spendFold = foldDelta(r.lifecycle_spend_accum, r.lifecycle_last_seen_today_spend, r.today_spend);
    return {
      campaign_id: r.campaign_id,
      lifecycle_spend_accum: spendFold.accum,
      lifecycle_last_seen_today_spend: 0,
      lifecycle_payout_accum: r.lifecycle_payout_accum,
      lifecycle_last_seen_today_payout: 0,
      lifecycle_conversions_accum: r.lifecycle_conversions_accum,
      lifecycle_last_seen_today_conversions: 0,
    };
  });
  await supabase.from("tiktok_campaigns").upsert(rows, { onConflict: "campaign_id" });
}

module.exports = {
  fetchEarningsToday,
  applyLifecycleDecisions,
  foldStaleLifecycleAccumBeforeReset,
  foldDelta,
  MIN_SPEND_FOR_VERDICT,
  FAST_KILL_SPEND,
  GRADUATION_ROAS,
  KILL_ROAS_FLOOR,
  TIMEOUT_SPEND,
};

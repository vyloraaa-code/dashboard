// POST /.netlify/functions/tracker   { action, password, ... }
//   "list"                                    -> { tests: [...], winners: [...] }
//   "update_test"    { id, patch }             -> { test }   (patch: offer/hook/notes only)
//   "delete_test"    { id }                    -> { ok: true }
//   "create_winner"  {}                        -> { winner }
//   "update_winner"  { id, patch }             -> { winner } (patch: offer/type/hook/total_spend/total_revenue/notes)
//   "delete_winner"  { id }                    -> { ok: true }
//
// Every action requires the dashboard admin password (same one used for TikTok
// connect/disconnect — see checkPassword) since the user asked the Tracker
// itself to be gated on open, not just on write.
//
// The auto-managed columns on tracker_tests (sn/type/cpa/cpnc/epc/roas/result/
// test_date) are NEVER writable here — only tracker-run.js's daily cron sets
// them. This endpoint only ever touches the user-entered columns.

const { getSupabase, sbErr, checkPassword, json } = require("./_shared/tiktok-mcp");

const TEST_COLS = "id, campaign_id, sn, offer, type, hook, spend, cpa, cpnc, epc, roas, result, notes, test_date, created_at, updated_at";
const TEST_COLS_NO_SPEND = "id, campaign_id, sn, offer, type, hook, cpa, cpnc, epc, roas, result, notes, test_date, created_at, updated_at";
const WINNER_COLS = "id, offer, type, hook, total_spend, total_revenue, notes, created_at, updated_at";

const OFFERS = new Set(["CPI", "SWEEPS"]);
const TYPES = new Set(["SLIDES", "VIDEOS"]);

function cleanTestPatch(patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  const out = { updated_at: new Date().toISOString() };
  if ("offer" in p) out.offer = p.offer && OFFERS.has(String(p.offer).toUpperCase()) ? String(p.offer).toUpperCase() : null;
  if ("hook" in p) out.hook = p.hook == null ? null : String(p.hook).slice(0, 2000);
  if ("notes" in p) out.notes = p.notes == null ? null : String(p.notes).slice(0, 4000);
  return out;
}

function cleanWinnerPatch(patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  const out = { updated_at: new Date().toISOString() };
  if ("offer" in p) out.offer = p.offer && OFFERS.has(String(p.offer).toUpperCase()) ? String(p.offer).toUpperCase() : null;
  if ("type" in p) out.type = p.type && TYPES.has(String(p.type).toUpperCase()) ? String(p.type).toUpperCase() : null;
  if ("hook" in p) out.hook = p.hook == null ? null : String(p.hook).slice(0, 2000);
  if ("notes" in p) out.notes = p.notes == null ? null : String(p.notes).slice(0, 4000);
  if ("total_spend" in p) out.total_spend = Math.max(0, Number(p.total_spend) || 0);
  if ("total_revenue" in p) out.total_revenue = Math.max(0, Number(p.total_revenue) || 0);
  return out;
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
    const supabase = getSupabase();

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    const pw = checkPassword(body.password);
    if (!pw.ok) return json(pw.code, { error: pw.error });

    if (body.action === "list") {
      let [{ data: tests, error: tErr }, { data: winners, error: wErr }] = await Promise.all([
        supabase.from("tracker_tests").select(TEST_COLS).order("test_date", { ascending: false }).order("created_at", { ascending: false }),
        supabase.from("tracker_winners").select(WINNER_COLS).order("created_at", { ascending: true }),
      ]);
      if (tErr && /spend/.test(tErr.message || "") && /does not exist|schema cache|could not find/i.test(tErr.message || "")) {
        // `spend` not migrated yet (supabase/tracker.sql) — retry without it so
        // the Tests list still loads; the frontend just can't filter $0 rows.
        ({ data: tests, error: tErr } = await supabase
          .from("tracker_tests")
          .select(TEST_COLS_NO_SPEND)
          .order("test_date", { ascending: false })
          .order("created_at", { ascending: false }));
      }
      if (tErr && !/does not exist|schema cache|could not find/i.test(tErr.message || "")) {
        return json(500, { error: "Supabase read failed", details: sbErr(tErr) });
      }
      if (wErr && !/does not exist|schema cache|could not find/i.test(wErr.message || "")) {
        return json(500, { error: "Supabase read failed", details: sbErr(wErr) });
      }
      return json(200, { tests: tests || [], winners: winners || [] });
    }

    if (body.action === "update_test") {
      if (!body.id) return json(400, { error: "id is required" });
      const { data, error } = await supabase
        .from("tracker_tests")
        .update(cleanTestPatch(body.patch))
        .eq("id", String(body.id))
        .select(TEST_COLS)
        .maybeSingle();
      if (error) return json(500, { error: "Could not update the row", details: sbErr(error) });
      if (!data) return json(404, { error: "Row not found." });
      return json(200, { test: data });
    }

    if (body.action === "delete_test") {
      if (!body.id) return json(400, { error: "id is required" });
      const { error } = await supabase.from("tracker_tests").delete().eq("id", String(body.id));
      if (error) return json(500, { error: "Could not delete the row", details: sbErr(error) });
      return json(200, { ok: true });
    }

    if (body.action === "create_winner") {
      const { data, error } = await supabase.from("tracker_winners").insert({}).select(WINNER_COLS).maybeSingle();
      if (error) {
        if (/does not exist|schema cache|could not find/i.test(error.message || "")) {
          return json(500, { error: "The tracker_winners table isn't migrated yet. Run supabase/tracker.sql, then retry." });
        }
        return json(500, { error: "Could not add the row", details: sbErr(error) });
      }
      return json(200, { winner: data });
    }

    if (body.action === "update_winner") {
      if (!body.id) return json(400, { error: "id is required" });
      const { data, error } = await supabase
        .from("tracker_winners")
        .update(cleanWinnerPatch(body.patch))
        .eq("id", String(body.id))
        .select(WINNER_COLS)
        .maybeSingle();
      if (error) return json(500, { error: "Could not update the row", details: sbErr(error) });
      if (!data) return json(404, { error: "Row not found." });
      return json(200, { winner: data });
    }

    if (body.action === "delete_winner") {
      if (!body.id) return json(400, { error: "id is required" });
      const { error } = await supabase.from("tracker_winners").delete().eq("id", String(body.id));
      if (error) return json(500, { error: "Could not delete the row", details: sbErr(error) });
      return json(200, { ok: true });
    }

    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

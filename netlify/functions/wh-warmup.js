// POST /.netlify/functions/wh-warmup   { action, ... }
//
//   "create"  { connection_id, advertiser_ids: [...], target_country, spark_code }
//        -> for EACH advertiser independently: FIRST sets a $5/day account-
//           level safety cap (whAccountSafetyCap — skips creating the
//           campaign for that account if this fails), THEN creates the
//           Traffic-CBO warmup campaign + ad group + Spark ad. One account
//           failing never stops the batch. Returns per-account results.
//
//   "cleanup"  (no body)
//        -> poll every WH campaign still in WAITING_FOR_ACTIVE / PAUSE_PENDING /
//           DELETE_PENDING. Once genuinely Active: PAUSE first (retried every
//           cycle, uncapped — the money-safety guarantee), then delete.
//           Idempotent.
//
//   "list"     (no body)   -> WH campaigns still WAITING_FOR_ACTIVE /
//        PAUSE_PENDING / DELETE_PENDING (the "WHs Warming Up" panel) —
//        DELETED/FAILED rows drop off the list the moment "cleanup" retires
//        them, even though the row itself is kept in the table.
//
//   "countries" { connection_id, advertiser_id }
//        -> valid country-level TikTok target locations for that advertiser
//           ({ countries: [{ location_id, name, code }] }); drives the autocomplete
//
//   "template_countries"  (no body)
//        -> union of country-level TikTok locations across every approved
//           advertiser on every connection. Campaign Creator templates aren't
//           tied to one ad account, so this is deliberately NOT limited to
//           what any single account can currently target (see
//           _shared/wh-warmup.js#listAllCountryRegions). Cached in-memory.
//
// No admin password (same posture as the other tiktok-* write actions — every
// write is scoped server-side to advertiser accounts under the given connection).
// All MCP calls run here; no tokens are ever returned to the browser.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  setAdvertiserBudget,
  json,
} = require("./_shared/tiktok-mcp");
const {
  createWarmupForAdvertiser,
  cleanupOneWarmup,
  listCountryRegions,
  listAllCountryRegions,
  whAccountSafetyCap,
} = require("./_shared/wh-warmup");

async function withClient(supabase, connection, fn) {
  const { serverUrl, redirectUrl } = resolveConfig();
  const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection });
  const { client } = await connectMcp({ provider, serverUrl });
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const advApproved = (a) => String(a?.status || "").toUpperCase() === "STATUS_ENABLE";

exports.handler = async function (event) {
  try {
    const supabase = getSupabase();

    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    if (body.action === "create") return createBatch(supabase, body);
    if (body.action === "cleanup") return cleanupBatch(supabase);
    if (body.action === "list") return listWarmups(supabase, body.connection_id || null);
    if (body.action === "countries") return countriesFor(supabase, body);
    if (body.action === "template_countries") return templateCountries(supabase);

    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

// Valid country-level TikTok target locations for one advertiser (drives the
// WH settings-screen autocomplete). { countries: [{ location_id, name, code }] }
async function countriesFor(supabase, body) {
  const connectionId = body.connection_id;
  const advertiserId = String(body.advertiser_id || "");
  if (!connectionId || !advertiserId) return json(400, { error: "connection_id and advertiser_id are required" });

  const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!conn) return json(404, { error: "Connection not found." });

  try {
    const countries = await withClient(supabase, conn, (client) => listCountryRegions(client, advertiserId));
    return json(200, { ok: true, countries });
  } catch (err) {
    return json(502, { error: "Couldn't load TikTok countries", details: err.message });
  }
}

// In-process cache — sweeping every connection's advertisers is slow (one
// tool_region_get per account, sequential to respect TikTok's rate limiter).
// Eligibility barely changes day to day, so a warm Lambda/Vercel instance
// should not re-sweep on every "New Template" click. 15 min TTL.
let _templateCountriesCache = null; // { at, countries }
const TEMPLATE_COUNTRIES_TTL_MS = 15 * 60 * 1000;

async function templateCountries(supabase) {
  if (_templateCountriesCache && Date.now() - _templateCountriesCache.at < TEMPLATE_COUNTRIES_TTL_MS) {
    return json(200, { ok: true, countries: _templateCountriesCache.countries, cached: true });
  }

  const { data: connections, error: connErr } = await supabase.from("tiktok_connections").select("*");
  if (connErr) return json(500, { error: "Supabase read failed", details: sbErr(connErr) });
  if (!connections || !connections.length) return json(200, { ok: true, countries: [] });

  const deadline = Date.now() + 8000; // stay well under Netlify's/Vercel's sync function timeout
  const byId = new Map();
  for (const conn of connections) {
    if (Date.now() > deadline) break;
    const { data: advRows } = await supabase
      .from("tiktok_advertisers")
      .select("advertiser_id, status")
      .eq("connection_id", conn.id);
    const advIds = (advRows || []).filter(advApproved).map((a) => String(a.advertiser_id));
    if (!advIds.length) continue;

    try {
      await withClient(supabase, conn, async (client) => {
        const list = await listAllCountryRegions(client, advIds, { deadlineMs: deadline });
        for (const c of list) if (!byId.has(c.location_id)) byId.set(c.location_id, c);
      });
    } catch (err) {
      console.error(`[wh-warmup] template_countries connection ${conn.id} failed: ${err.message}`);
    }
  }

  const countries = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  _templateCountriesCache = { at: Date.now(), countries };
  return json(200, { ok: true, countries });
}

async function createBatch(supabase, body) {
  const connectionId = body.connection_id;
  const advertiserIds = [...new Set((body.advertiser_ids || []).map(String).filter(Boolean))];
  // Optional, same length/order as advertiserIds — see js/api.js createWhWarmup.
  // A large batch arrives as several chunked requests (js/app.js
  // submitWhWarmup, mirroring Campaign Creator's own chunking), each covering
  // a slice of the full account list; without an explicit name per account,
  // deriving "wh${i+1}" from THIS request's own array position would restart
  // at wh1 on every chunk and collide with an earlier one's names. Falls back
  // to that same derivation when omitted (e.g. a single-chunk batch).
  const campaignNames = Array.isArray(body.campaign_names) ? body.campaign_names.map(String) : null;
  const targetCountry = String(body.target_country || "").trim();
  const locationId = String(body.location_id || "").trim() || null;
  const rawSpark = String(body.spark_code || "");
  const sparkCode = rawSpark.trim(); // ONLY strip surrounding whitespace/newlines — # + = are kept

  if (!connectionId) return json(400, { error: "connection_id is required" });
  if (!advertiserIds.length) return json(400, { error: "Select at least one advertiser account." });
  if (!targetCountry) return json(400, { error: "Enter a target country." });
  if (!sparkCode) return json(400, { error: "Enter a Spark code." });

  // Safe fingerprint (never the code) so the exact characters can be verified in
  // the function logs across the input path.
  console.log(
    `[wh-warmup] spark in: rawLen=${rawSpark.length} trimmedLen=${sparkCode.length} ` +
      `hash=${sparkCode.startsWith("#")} plus=${sparkCode.includes("+")} pct2b=${/%2[bB]/.test(sparkCode)} ` +
      `eq=${sparkCode.endsWith("=")} space=${sparkCode.includes(" ")}`
  );

  const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!conn) return json(404, { error: "Connection not found." });

  const { data: advRows } = await supabase
    .from("tiktok_advertisers")
    .select("advertiser_id, advertiser_name, status, currency, timezone, display_timezone, bc_id")
    .eq("connection_id", connectionId)
    .in("advertiser_id", advertiserIds);
  const advById = new Map((advRows || []).map((a) => [String(a.advertiser_id), a]));

  const results = [];
  let storeWarning = null;

  // Second layer of defense on top of the frontend's own chunking (see
  // js/app.js submitWhWarmup, mirroring Campaign Creator's create action /
  // its matching frontend chunk size) — if a chunk still runs long (a slow
  // TikTok API day), the remaining accounts in THIS request come back
  // Skipped with a clear retry message instead of the whole request hard
  // timing out with no response at all.
  const deadline = Date.now() + 52000;

  await withClient(supabase, conn, async (client) => {
    for (let i = 0; i < advertiserIds.length; i++) {
      const advId = advertiserIds[i];
      if (Date.now() > deadline) {
        const name = advById.get(advId)?.advertiser_name || advId;
        results.push({
          advertiser_id: advId,
          advertiser_name: name,
          status: "Skipped",
          error: "This request ran out of time — the dashboard should have sent it in a smaller batch; retry to create the rest.",
        });
        continue;
      }
      // wh1, wh2, … by POSITION in advertiserIds — the dashboard sends this
      // list already ordered to match the ad-accounts list (see
      // js/app.js submitWhWarmup), so this numbering always lines up with
      // what's shown on screen, independent of which accounts get skipped.
      // campaignNames[i], when the caller sent it, overrides this with the
      // GLOBAL position across a multi-chunk batch (see the comment above).
      const campaignName = campaignNames?.[i] || `wh${i + 1}`;
      const adv = advById.get(advId);
      const name = adv?.advertiser_name || advId;
      if (!adv) {
        results.push({ advertiser_id: advId, advertiser_name: name, status: "Failed", error: "Account not under this connection." });
        continue;
      }
      if (!advApproved(adv)) {
        results.push({ advertiser_id: advId, advertiser_name: name, status: "Skipped", error: "Account is Suspended." });
        continue;
      }

      // Safety cap FIRST, before anything is created: a $5/day account-level
      // cap means even a warmup campaign someone forgets to pause can burn at
      // most that much. If this fails, the WH campaign is deliberately NOT
      // created for this account — an uncapped warmup campaign defeats the
      // whole point.
      const safetyCap = whAccountSafetyCap();
      try {
        await setAdvertiserBudget({
          client,
          bcId: adv.bc_id || conn.bc_id || null,
          advertiserId: advId,
          budgetMode: "DAILY_BUDGET",
          budget: safetyCap,
        });
      } catch (err) {
        results.push({
          advertiser_id: advId,
          advertiser_name: name,
          status: "Failed",
          error: `Couldn't set the $${safetyCap}/day safety cap — WH campaign NOT created (${err.message}).`,
        });
        continue;
      }

      try {
        const r = await createWarmupForAdvertiser({
          client,
          advertiserId: advId,
          currency: adv.currency,
          targetCountry,
          locationId,
          sparkCode,
          campaignName,
        });
        // Record IMMEDIATELY so a mid-batch failure never leaves an untracked
        // (undeletable-by-us) campaign live on TikTok.
        const { error: insErr } = await supabase.from("wh_warmup_campaigns").upsert(
          {
            campaign_id: r.campaign_id,
            advertiser_id: advId,
            advertiser_name: adv.advertiser_name || null,
            connection_id: connectionId,
            bc_id: adv.bc_id || conn.bc_id || null,
            campaign_name: r.campaign_name,
            adgroup_id: r.adgroup_id,
            ad_id: r.ad_id,
            destination_url: r.destination_url,
            target_country: r.target_country,
            location_id: r.location_id,
            spark_item_id: r.spark_item_id,
            daily_budget: r.daily_budget,
            currency: r.currency,
            cleanup_status: "WAITING_FOR_ACTIVE",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "campaign_id" }
        );
        if (insErr && !storeWarning) {
          storeWarning = `Some campaigns were created but could not be stored for auto-cleanup (${insErr.message}). Run supabase/wh_warmup.sql.`;
          console.error(`[wh-warmup] store failed campaign=${r.campaign_id}: ${insErr.message}`);
        }
        results.push({
          advertiser_id: advId,
          advertiser_name: name,
          status: "Created",
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
        });
      } catch (err) {
        console.error(`[wh-warmup] create failed adv=${advId}: ${err.message}`);
        results.push({ advertiser_id: advId, advertiser_name: name, status: "Failed", error: err.message });
      }
    }
  }).catch((err) => {
    for (const advId of advertiserIds) {
      if (!results.some((x) => x.advertiser_id === advId)) {
        results.push({
          advertiser_id: advId,
          advertiser_name: advById.get(advId)?.advertiser_name || advId,
          status: "Failed",
          error: err.message,
        });
      }
    }
  });

  return json(200, { ok: true, results, ...(storeWarning ? { warning: storeWarning } : {}) });
}

// ---------------------------------------------------------------------------
// cleanup — the "Active -> delete" state machine, driven by the 60s refresh
// ---------------------------------------------------------------------------

async function cleanupBatch(supabase) {
  const { data: rows, error } = await supabase
    .from("wh_warmup_campaigns")
    .select("*")
    .in("cleanup_status", ["WAITING_FOR_ACTIVE", "PAUSE_PENDING", "DELETE_PENDING"]);
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, checked: 0, deleted: 0, failed: 0, pending: 0, unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }
  if (!rows || !rows.length) return json(200, { ok: true, checked: 0, deleted: 0, failed: 0, pending: 0 });

  const byConnection = {};
  for (const r of rows) (byConnection[r.connection_id] = byConnection[r.connection_id] || []).push(r);

  const tally = { checked: 0, deleted: 0, failed: 0, pending: 0 };
  const deadline = Date.now() + 9000;

  for (const [connectionId, list] of Object.entries(byConnection)) {
    if (Date.now() > deadline) break;
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      // connection gone -> abandon its WH rows
      for (const r of list) {
        await patchRow(supabase, r.campaign_id, { cleanup_status: "FAILED", cleanup_error: "Connection removed.", updated_at: new Date().toISOString() });
        tally.failed += 1;
      }
      continue;
    }

    // advertiser status/timezone for status derivation
    const advIds = [...new Set(list.map((r) => String(r.advertiser_id)))];
    const { data: advRows } = await supabase
      .from("tiktok_advertisers")
      .select("advertiser_id, status, timezone, display_timezone")
      .eq("connection_id", connectionId)
      .in("advertiser_id", advIds);
    const advById = new Map((advRows || []).map((a) => [String(a.advertiser_id), a]));

    try {
      await withClient(supabase, conn, async (client) => {
        for (const r of list) {
          if (Date.now() > deadline) break;
          tally.checked += 1;
          const adv = advById.get(String(r.advertiser_id)) || {};
          const out = await cleanupOneWarmup({
            client,
            row: r,
            advertiserStatus: adv.status,
            timezone: adv.timezone || adv.display_timezone || null,
          });
          await patchRow(supabase, r.campaign_id, out.patch);
          if (out.status === "DELETED") {
            tally.deleted += 1;
            // The WH campaign is gone from TikTok — pull its Detailed Metrics row
            // now instead of waiting for the next discovery sync to prune it.
            try {
              await supabase.from("tiktok_campaigns").delete().eq("campaign_id", String(r.campaign_id));
            } catch (e) {
              console.error(`[wh-warmup] tiktok_campaigns cleanup ${r.campaign_id} failed: ${e.message}`);
            }
          } else if (out.status === "FAILED") tally.failed += 1;
          else tally.pending += 1;
        }
      });
    } catch (err) {
      console.error(`[wh-warmup] cleanup connection ${connectionId} failed: ${err.message}`);
      // leave rows as-is; next cycle retries
    }
  }

  return json(200, { ok: true, ...tally });
}

async function patchRow(supabase, campaignId, patch) {
  try {
    await supabase.from("wh_warmup_campaigns").update(patch).eq("campaign_id", String(campaignId));
  } catch (err) {
    console.error(`[wh-warmup] patch ${campaignId} failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

// Only rows still actively being warmed/cleaned up — the "WHs Warming Up"
// panel is a live worklist, not a history. A row leaves it the moment
// cleanupOneWarmup marks it DELETED (genuinely deleted once Active) or
// FAILED (e.g. the ad account got suspended and it can never be deleted) —
// both cases mean "nothing left to watch here" from the panel's point of
// view, even though the row itself stays in the table for the audit trail.
// Also joins in each campaign's live on/off + status from tiktok_campaigns
// (the same columns Detailed Metrics reads) so the panel can show on/off and
// status without a second round trip.
// `connectionId` (optional): scopes the list to one Business Center — the
// "WHs Warming Up" box lives right under the BC selector in the WH Warmup
// creator (js/app.js openWhWarmingUpModal passes whState.connectionId), so
// it should only ever count/show that same BC's campaigns, not every
// connected BC's mixed together. Omit it for the unscoped view.
async function listWarmups(supabase, connectionId) {
  let warmupQ = supabase
    .from("wh_warmup_campaigns")
    .select(
      "campaign_id, advertiser_id, advertiser_name, campaign_name, target_country, daily_budget, currency, cleanup_status, cleanup_attempts, cleanup_error, became_active_at, deleted_at, created_at, connection_id"
    )
    .in("cleanup_status", ["WAITING_FOR_ACTIVE", "PAUSE_PENDING", "DELETE_PENDING"])
    .order("created_at", { ascending: false })
    .limit(200);
  if (connectionId) warmupQ = warmupQ.eq("connection_id", connectionId);
  const { data, error } = await warmupQ;
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, campaigns: [], unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }

  const rows = (data || []).map((r) => ({ ...r, origin: "warmup" }));

  // Stray campaigns (found by a full sync — see _shared/stray-campaigns.js):
  // real campaigns nothing was tracking, shown here for visibility, NEVER
  // auto-deleted. No WH-specific fields (target_country/daily_budget/
  // cleanup_status) — those stay null so the frontend can tell them apart.
  try {
    let strayQ = supabase
      .from("stray_campaigns")
      .select("campaign_id, advertiser_id, campaign_name, discovered_at, connection_id")
      .order("discovered_at", { ascending: false })
      .limit(200);
    if (connectionId) strayQ = strayQ.eq("connection_id", connectionId);
    const { data: strays } = await strayQ;
    for (const s of strays || []) {
      rows.push({
        campaign_id: s.campaign_id,
        advertiser_id: s.advertiser_id,
        advertiser_name: null,
        campaign_name: s.campaign_name,
        target_country: null,
        daily_budget: null,
        currency: null,
        cleanup_status: null,
        cleanup_attempts: 0,
        cleanup_error: null,
        became_active_at: null,
        deleted_at: null,
        created_at: s.discovered_at,
        origin: "stray",
      });
    }
  } catch (_) {
    /* table optional — not migrated yet */
  }

  // A campaign_id can legitimately appear in both wh_warmup_campaigns and
  // stray_campaigns (e.g. a sync ran in the narrow window before its warmup
  // row was persisted, or before a cleanup-terminal warmup row's exclusion
  // check saw it) — de-dup so the panel never shows the same campaign twice.
  // "warmup" origin wins: it carries the real cleanup lifecycle/fields.
  {
    const byId = new Map();
    for (const r of rows) {
      const existing = byId.get(String(r.campaign_id));
      if (!existing || (existing.origin === "stray" && r.origin === "warmup")) byId.set(String(r.campaign_id), r);
    }
    rows.length = 0;
    rows.push(...byId.values());
  }

  if (rows.length) {
    const ids = rows.map((r) => String(r.campaign_id));
    const { data: live } = await supabase
      .from("tiktok_campaigns")
      .select("campaign_id, campaign_operation_status, effective_status, effective_tone, status_detail")
      .in("campaign_id", ids);
    const liveById = new Map((live || []).map((c) => [String(c.campaign_id), c]));
    for (const r of rows) {
      const c = liveById.get(String(r.campaign_id));
      r.campaign_operation_status = c?.campaign_operation_status || null;
      r.effective_status = c?.effective_status || null;
      r.effective_tone = c?.effective_tone || null;
      r.status_detail = c?.status_detail || null;
    }
  }

  return json(200, { ok: true, campaigns: rows });
}

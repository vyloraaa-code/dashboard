// GET  /.netlify/functions/tiktok-campaigns
//        -> { campaigns: [...] }   (every row currently stored in tiktok_campaigns)
//
// POST /.netlify/functions/tiktok-campaigns   { action, ... }
//        "sync"                : { connection_id? } — re-scan advertisers + re-discover
//                                campaigns. Scoped to one Business Center when
//                                connection_id is given ("Refresh Data"), else all.
//        "budgets"            : advertiser-account caps + BC balances (all scoped accounts)
//        "metrics"            : today's live TikTok campaign spend/CPM/CPA for every
//                                scoped advertiser (NY date; one report per advertiser).
//                                Also snapshots cumulative spend per NY hour and
//                                returns `spendToday` for the Live Performance graph.
//        "set_advertiser_budget": { advertiser_id, budget_mode, budget } — write
//        "adgroups"            : { campaign_id } — lazy-load one campaign's ad groups +
//                                today's spend/CPA + status
//        "set_campaign_status" : { campaign_id, operation_status } — write
//        "set_adgroup_status"  : { campaign_id, adgroup_id, operation_status } — write
//        "set_post_url"       : { campaign_id, tiktok_post_url } — set/clear a campaign's
//                                TikTok post URL (validated https tiktok.com link; no external calls)
//        "queue_engagement_comments": { campaign_id, service_id, comments } — store a comment
//                                batch (against the campaign's tiktok_post_url) as an
//                                engagement_orders row. NEVER contacts an SMM service.
//
// None of these need the admin password. Discovery/sync/metrics/budgets and
// every per-campaign write are restricted server-side to "scoped" advertiser
// accounts (see scopedAdvertisers): the legacy manually-`tracked` set, UNION
// any advertiser with a Campaign Creator campaign registered
// (campaign_creator_campaigns) — so Campaign Creator campaigns need no manual
// tracking step at all. All MCP calls run here; no tokens are ever returned to
// the browser.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  mcpCall,
  dashboardToday,
  discoverAndStoreAdvertisers,
  discoverAndStoreCampaigns,
  loadCampaignDetail,
  loadCampaignMetricsForAdvertiser,
  setCampaignStatus,
  setAdGroupStatus,
  deleteCampaign,
  getBcBalance,
  getAdvertiserBudgets,
  setAdvertiserBudget,
  markEngagementReadyIfActive,
  withoutTemporaryCampaigns,
  applyAppealOverlay,
  applyAppealOverlayByCampaignId,
  json,
} = require("./_shared/tiktok-mcp");
const { tiktokSpendForToday } = require("./_shared/glitchy-daily");
const { submitEngagementOrder, parseComments } = require("./_shared/engagement-provider");
const { groupReasonsByCategory } = require("./_shared/appeals.js");
const { applyAutoBudgetBumps } = require("./_shared/auto-budget-bump");
const { discoverStrayCampaigns } = require("./_shared/stray-campaigns");

const CAMPAIGN_COLUMNS_BASE =
  "campaign_id, connection_id, advertiser_id, advertiser_name, campaign_name, objective_type, budget, budget_mode, campaign_operation_status, campaign_secondary_status, effective_status, effective_tone, status_detail, ad_count, active_ad_count, create_time, updated_at";
const CAMPAIGN_COLUMNS = `${CAMPAIGN_COLUMNS_BASE}, bc_id, bc_name, affiliate_network`;

async function readCampaigns(supabase) {
  let res = await supabase
    .from("tiktok_campaigns")
    .select(`${CAMPAIGN_COLUMNS}, hidden`)
    .order("campaign_name", { ascending: true });
  if (res.error && /hidden/.test(res.error.message || "")) {
    // hidden column not migrated yet (supabase/tiktok_campaign_hidden.sql)
    res = await supabase.from("tiktok_campaigns").select(CAMPAIGN_COLUMNS).order("campaign_name", { ascending: true });
  }
  if (res.error && /bc_(id|name)|affiliate_network/.test(res.error.message || "")) {
    res = await supabase.from("tiktok_campaigns").select(CAMPAIGN_COLUMNS_BASE).order("campaign_name", { ascending: true });
    if (!res.error)
      res.data = (res.data || []).map((c) => ({ ...c, bc_id: null, bc_name: null, affiliate_network: "GLITCHY" }));
  }
  // Campaigns hidden locally (TikTok refused deletion — suspended account) never
  // reach the dashboard.
  if (!res.error) res.data = (res.data || []).filter((c) => !c.hidden);

  // Engagement-foundation columns, merged from a SEPARATE query so the migration
  // (supabase/tiktok_engagement.sql) is fully optional — without it every row
  // just reads tiktok_post_url:null / engagement_status:"PENDING".
  if (!res.error) {
    const eng = await supabase
      .from("tiktok_campaigns")
      .select("campaign_id, tiktok_post_url, engagement_status, engagement_added_at");
    const byId = new Map();
    if (!eng.error) for (const e of eng.data || []) byId.set(String(e.campaign_id), e);
    res.data = (res.data || []).map((c) => {
      const e = byId.get(String(c.campaign_id)) || {};
      return {
        ...c,
        tiktok_post_url: e.tiktok_post_url ?? null,
        engagement_status: e.engagement_status ?? "PENDING",
        engagement_added_at: e.engagement_added_at ?? null,
      };
    });
  }

  // Flag WH Warmup campaigns so the UI can show them in Detailed Metrics but keep
  // them out of engagement (Add comments). They're excluded server-side too.
  if (!res.error) {
    try {
      const { data: wh } = await supabase.from("wh_warmup_campaigns").select("campaign_id");
      const whIds = new Set((wh || []).map((r) => String(r.campaign_id)));
      res.data = (res.data || []).map((c) => ({ ...c, is_wh_warmup: whIds.has(String(c.campaign_id)) }));
    } catch (_) {
      res.data = (res.data || []).map((c) => ({ ...c, is_wh_warmup: false }));
    }
  }

  // Flag stray campaigns (discovered by a full sync, not Campaign Creator or
  // WH Warmup) the same way — kept out of Detailed Metrics, shown in the
  // "WHs Warming Up" panel instead so they're never silently unwatched.
  if (!res.error) {
    try {
      const { data: stray } = await supabase.from("stray_campaigns").select("campaign_id");
      const strayIds = new Set((stray || []).map((r) => String(r.campaign_id)));
      res.data = (res.data || []).map((c) => ({ ...c, is_stray: strayIds.has(String(c.campaign_id)) }));
    } catch (_) {
      res.data = (res.data || []).map((c) => ({ ...c, is_stray: false }));
    }
  }

  // AUTO REJECTION APPEAL — read-time status overlay. Campaign Creator campaigns
  // with a live automatic appeal show a clearer label/tone. Never masks a
  // campaign that is genuinely Active/serving right now (current state wins over
  // historical rejection). Fully optional — no-op until
  // supabase/campaign_creator_appeals.sql is run.
  if (!res.error) {
    try {
      const { data: ap } = await supabase
        .from("campaign_creator_campaigns")
        .select("campaign_id, appeal_state")
        .neq("appeal_state", "NONE");
      const stByCampaign = new Map((ap || []).map((r) => [String(r.campaign_id), r.appeal_state]));
      res.data = (res.data || []).map((c) => applyAppealOverlay(c, stByCampaign.get(String(c.campaign_id))));
    } catch (_) {
      /* appeal columns not migrated — leave statuses untouched */
    }
  }
  return res;
}

// Loads a stored campaign row and its advertiser metadata (status/timezone/bc)
// so the caller can act on it.
//
// This deliberately does NOT require the advertiser's `tracked` flag: GET
// /tiktok-campaigns (readCampaigns, which is what populates Detailed Metrics)
// never filters by `tracked` either, so any campaign row a user can see and
// click "Delete"/toggle on has already been vouched for by the fact that it's
// sitting in tiktok_campaigns at all — it was put there by our own discovery
// (discoverAndStoreCampaigns), Campaign Creator, or WH Warmup, all of which
// look up campaign_id server-side against rows the dashboard itself wrote.
// Requiring `tracked` on top of that only ever produced a confusing "not
// tracked" dead end for campaigns the user was staring right at — Campaign
// Creator and WH Warmup campaigns never set `tracked`, and even a
// legitimately-tracked advertiser can be unchecked later while its old
// campaign rows linger in the table (no sync path retroactively removes
// them). If the advertiser row itself is missing entirely, there's no
// status/timezone to act with, so that case is still refused.
async function resolveTrackedCampaign(supabase, campaignId) {
  const { data: campaign } = await supabase
    .from("tiktok_campaigns")
    .select("*")
    .eq("campaign_id", String(campaignId))
    .maybeSingle();
  if (!campaign) return { error: json(404, { error: "Campaign not found. Run a campaign sync first." }) };

  const { data: adv } = await supabase
    .from("tiktok_advertisers")
    .select("tracked, status, timezone, display_timezone, bc_id, bc_name")
    .eq("connection_id", campaign.connection_id)
    .eq("advertiser_id", campaign.advertiser_id)
    .maybeSingle();
  if (!adv) {
    return { error: json(403, { error: "That advertiser account is no longer known to this dashboard — run a sync first." }) };
  }

  const { data: conn } = await supabase
    .from("tiktok_connections")
    .select("*")
    .eq("id", campaign.connection_id)
    .maybeSingle();
  if (!conn) return { error: json(404, { error: "Connection not found." }) };

  return { campaign, advertiser: adv, connection: conn };
}

// Connects one MCP client for a connection, runs fn(client), always closes.
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

exports.handler = async function (event) {
  try {
    const supabase = getSupabase();

    if (event.httpMethod === "GET") {
      const { data, error } = await readCampaigns(supabase);
      if (error) return json(500, { error: "Supabase read failed", details: sbErr(error) });
      return json(200, { campaigns: data || [] });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Use GET or POST" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    const action = body.action;

    // ---- read-only: advertiser account budgets + BC balance ----
    if (action === "budgets") return budgetsForScopedAdvertisers(supabase);

    // ---- read-only: today's live TikTok campaign metrics (spend/CPM/CPA) ----
    if (action === "metrics") return campaignMetricsForScopedAdvertisers(supabase);

    // ---- write: recompute daily_totals.total_spend for one past date from
    // TikTok's own historical report, across every scoped advertiser. Manual
    // recovery path for a date the automatic rollover backfill (see
    // backfillStaleDailyTotals) missed — e.g. one that already rolled over
    // before that fix existed. Never touches total_earnings. { date:"YYYY-MM-DD" } ----
    if (action === "backfill_daily_total") return backfillDailyTotalForDate(supabase, body.date);

    // ---- read-only: engagement orders for one campaign (likes / saves / comments) ----
    if (action === "engagement_orders") {
      if (!body.campaign_id) return json(400, { error: "campaign_id is required" });
      const { data, error } = await supabase
        .from("engagement_orders")
        .select("kind, provider, service_id, quantity, status, provider_ref, note, updated_at")
        .eq("campaign_id", String(body.campaign_id))
        .order("updated_at", { ascending: false });
      if (error && /does not exist|schema cache|could not find the table/i.test(error.message || "")) {
        return json(200, { ok: true, orders: [], unmigrated: true });
      }
      if (error) return json(500, { error: "Could not read engagement orders", details: sbErr(error) });
      return json(200, { ok: true, orders: data || [] });
    }

    // ---- read-only: lazy ad-group load for one campaign ----
    if (action === "adgroups") {
      if (!body.campaign_id) return json(400, { error: "campaign_id is required" });
      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;
      const tz = r.advertiser.timezone || r.advertiser.display_timezone || null;
      const detail = await withClient(supabase, r.connection, (client) =>
        loadCampaignDetail({
          client,
          advertiserId: r.campaign.advertiser_id,
          advertiserStatus: r.advertiser.status,
          campaignId: r.campaign.campaign_id,
          timezone: tz,
        })
      );
      const overlaid = await applyAppealOverlayByCampaignId(supabase, r.campaign.campaign_id, detail);
      await persistCampaignStatus(supabase, r.campaign.campaign_id, overlaid);
      const appealInfo = await fetchAppealInfo(supabase, r.campaign.campaign_id);
      return json(200, {
        ok: true,
        campaign_id: String(r.campaign.campaign_id),
        campaign_operation_status: overlaid.campaign_operation_status,
        effective_status: overlaid.effective_status,
        effective_tone: overlaid.effective_tone,
        status_detail: overlaid.status_detail,
        adgroups: overlaid.adGroups,
        ...appealInfo,
      });
    }

    // Writes below are NOT password-gated (per product decision): the dashboard
    // is already behind whatever protects the site, and every write is still
    // restricted server-side to a SCOPED advertiser account — tracked, or a
    // Campaign Creator campaign (resolveTrackedCampaign). Only connecting /
    // disconnecting a TikTok account still asks for the admin password.

    if (action === "delete_campaign") {
      if (!body.campaign_id) return json(400, { error: "campaign_id is required" });
      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;

      const campaignId = String(r.campaign.campaign_id);
      const campaignName = r.campaign.campaign_name || campaignId;
      const advHealthy = ["", "STATUS_ENABLE"].includes(String(r.advertiser.status || "").toUpperCase());

      try {
        await withClient(supabase, r.connection, (client) =>
          deleteCampaign({ client, advertiserId: r.campaign.advertiser_id, campaignId })
        );
      } catch (err) {
        // The delete write failed — but that can also mean the campaign is
        // ALREADY gone from TikTok (deleted directly in Ads Manager, outside
        // Chigla Ads, so campaign_status_update has nothing left to act on).
        // Never guess this from the error text — ask TikTok itself via
        // campaign_get, the same check used to confirm this live. If it
        // genuinely returns nothing, there's nothing left to protect: clean up
        // every local row tied to this campaign_id, same as a real deletion.
        let goneFromTiktok = false;
        try {
          const check = await withClient(supabase, r.connection, (client) =>
            mcpCall(client, "campaign_get", {
              advertiser_id: r.campaign.advertiser_id,
              filtering: { campaign_ids: [campaignId] },
              fields: ["campaign_id"],
            })
          );
          goneFromTiktok = !((check && check.list) || []).length;
        } catch (_) {
          /* couldn't confirm either way — fall through to the normal handling below */
        }

        if (goneFromTiktok) {
          await supabase.from("tiktok_campaigns").delete().eq("campaign_id", campaignId);
          try {
            await supabase.from("campaign_creator_campaigns").delete().eq("campaign_id", campaignId);
          } catch (_) {
            /* table optional */
          }
          try {
            await supabase.from("stray_campaigns").delete().eq("campaign_id", campaignId);
          } catch (_) {
            /* table optional */
          }
          try {
            await supabase.from("engagement_orders").delete().eq("campaign_id", campaignId);
          } catch (_) {
            /* best-effort */
          }
          return json(200, {
            ok: true,
            campaign_id: campaignId,
            outcome: "already_gone",
            message: `Campaign “${campaignName}” was already deleted directly on TikTok — removed it from Chigla Ads too.`,
          });
        }

        // TikTok refused the delete for some other reason. If the advertiser
        // account is suspended/limited we can't ever complete this write —
        // hide the campaign locally instead so it stops cluttering the
        // dashboard and a re-sync won't resurrect it. Do NOT present this as a
        // real deletion.
        if (!advHealthy) {
          const upd = await supabase
            .from("tiktok_campaigns")
            .update({ hidden: true, hidden_at: new Date().toISOString() })
            .eq("campaign_id", campaignId);
          if (upd.error && /hidden/.test(upd.error.message || "")) {
            return json(500, {
              error:
                "Campaign could not be deleted from TikTok and the local-hide column is missing. Run supabase/tiktok_campaign_hidden.sql, then retry.",
              details: err.message,
            });
          }
          // The campaign is gone from the user's view — clear its temporary
          // engagement rows too (the real-delete path gets these via FK cascade;
          // the hidden tombstone stays so a re-sync can't resurrect it).
          try {
            await supabase.from("engagement_orders").delete().eq("campaign_id", campaignId);
          } catch (_) {
            /* best-effort */
          }
          return json(200, {
            ok: true,
            campaign_id: campaignId,
            outcome: "hidden",
            message: `Campaign could not be deleted from TikTok because this advertiser account is suspended. It has been hidden from Chigla Ads instead.`,
          });
        }
        return json(502, {
          error: "TikTok rejected the campaign deletion",
          details: err.message,
        });
      }

      // Real deletion succeeded — drop the row. A re-sync won't bring it back
      // (campaign_get no longer returns deleted campaigns).
      await supabase.from("tiktok_campaigns").delete().eq("campaign_id", campaignId);
      try {
        await supabase.from("stray_campaigns").delete().eq("campaign_id", campaignId);
      } catch (_) {
        /* table optional */
      }
      return json(200, {
        ok: true,
        campaign_id: campaignId,
        outcome: "deleted",
        message: `Campaign “${campaignName}” was deleted from TikTok.`,
      });
    }

    if (action === "set_campaign_status") {
      const op = normalizeOp(body.operation_status);
      if (!op) return json(400, { error: "operation_status must be ENABLE or DISABLE" });
      if (!body.campaign_id) return json(400, { error: "campaign_id is required" });

      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;
      const tz = r.advertiser.timezone || r.advertiser.display_timezone || null;

      const detail = await withClient(supabase, r.connection, async (client) => {
        await setCampaignStatus({
          client,
          advertiserId: r.campaign.advertiser_id,
          campaignId: r.campaign.campaign_id,
          operationStatus: op,
        });
        return loadCampaignDetail({
          client,
          advertiserId: r.campaign.advertiser_id,
          advertiserStatus: r.advertiser.status,
          campaignId: r.campaign.campaign_id,
          timezone: tz,
        });
      });
      const overlaid = await applyAppealOverlayByCampaignId(supabase, r.campaign.campaign_id, detail);
      await persistCampaignStatus(supabase, r.campaign.campaign_id, overlaid);
      const appealInfo = await fetchAppealInfo(supabase, r.campaign.campaign_id);
      return json(200, {
        ok: true,
        campaign_id: String(r.campaign.campaign_id),
        campaign_operation_status: overlaid.campaign_operation_status,
        effective_status: overlaid.effective_status,
        effective_tone: overlaid.effective_tone,
        status_detail: overlaid.status_detail,
        adgroups: overlaid.adGroups,
        ...appealInfo,
      });
    }

    if (action === "set_adgroup_status") {
      const op = normalizeOp(body.operation_status);
      if (!op) return json(400, { error: "operation_status must be ENABLE or DISABLE" });
      if (!body.campaign_id || !body.adgroup_id) return json(400, { error: "campaign_id and adgroup_id are required" });

      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;
      const tz = r.advertiser.timezone || r.advertiser.display_timezone || null;

      const out = await withClient(supabase, r.connection, async (client) => {
        const updated = await setAdGroupStatus({
          client,
          advertiserId: r.campaign.advertiser_id,
          adGroupId: body.adgroup_id,
          operationStatus: op,
        });
        // Confirm the ad group actually belongs to this campaign.
        if (updated && String(updated.campaign_id) !== String(r.campaign.campaign_id)) {
          throw new Error("Ad group does not belong to that campaign.");
        }
        const detail = await loadCampaignDetail({
          client,
          advertiserId: r.campaign.advertiser_id,
          advertiserStatus: r.advertiser.status,
          campaignId: r.campaign.campaign_id,
          timezone: tz,
        });
        return { detail };
      });
      const overlaid = await applyAppealOverlayByCampaignId(supabase, r.campaign.campaign_id, out.detail);
      await persistCampaignStatus(supabase, r.campaign.campaign_id, overlaid);
      const appealInfo = await fetchAppealInfo(supabase, r.campaign.campaign_id);
      return json(200, {
        ok: true,
        campaign_id: String(r.campaign.campaign_id),
        adgroup_id: String(body.adgroup_id),
        campaign_operation_status: overlaid.campaign_operation_status,
        effective_status: overlaid.effective_status,
        effective_tone: overlaid.effective_tone,
        status_detail: overlaid.status_detail,
        adgroups: overlaid.adGroups,
        ...appealInfo,
      });
    }

    if (action === "set_advertiser_budget") {
      if (!body.advertiser_id) return json(400, { error: "advertiser_id is required" });
      const mode = String(body.budget_mode || "").toUpperCase();
      const allowed = ["UNLIMITED", "MONTHLY_BUDGET", "DAILY_BUDGET", "CUSTOM_BUDGET"];
      if (!allowed.includes(mode)) return json(400, { error: `budget_mode must be one of ${allowed.join(", ")}` });
      const amount = Number(body.budget);
      if (mode !== "UNLIMITED" && !(amount > 0)) return json(400, { error: "budget must be a positive number" });

      const r = await resolveTrackedAdvertiser(supabase, body.advertiser_id);
      if (r.error) return r.error;
      if (!r.bcId) {
        return json(400, {
          error: "This advertiser account isn't under a Business Center this connection can manage its budget for.",
        });
      }

      try {
        const updated = await withClient(supabase, r.connection, (client) =>
          setAdvertiserBudget({
            client,
            bcId: r.bcId,
            advertiserId: String(body.advertiser_id),
            budgetMode: mode,
            budget: amount,
          })
        );
        return json(200, { ok: true, advertiser_id: String(body.advertiser_id), budget: updated });
      } catch (err) {
        return json(502, { error: "TikTok rejected the budget change", details: err.message });
      }
    }

    // ---- engagement FOUNDATION (no external calls anywhere) ----
    //
    // `tiktok_post_url` is the authoritative per-campaign mapping. Campaign
    // Creation Automation will write it directly on each campaign it creates
    // (from the ordered Spark-code / post-link pairs). The Add-comments modal
    // also lets it be set/edited manually via set_post_url.

    if (action === "set_post_url") {
      if (!body.campaign_id) return json(400, { error: "campaign_id is required" });
      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;
      if (!(await withoutTemporaryCampaigns(supabase, [String(body.campaign_id)])).length) {
        return json(400, { error: "WH Warmup campaigns can't be used for engagement." });
      }

      const raw = typeof body.tiktok_post_url === "string" ? body.tiktok_post_url.trim() : "";
      let url = null;
      if (raw) {
        let parsed;
        try {
          parsed = new URL(raw);
        } catch (_) {
          return json(400, { error: "Enter a valid URL (https://www.tiktok.com/…)." });
        }
        if (parsed.protocol !== "https:" || !/(^|\.)tiktok\.com$/i.test(parsed.hostname)) {
          return json(400, { error: "That doesn't look like a TikTok post URL (must be an https tiktok.com link)." });
        }
        url = parsed.toString();
      }

      const patch = {
        tiktok_post_url: url,
        engagement_added_at: url ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      const upd = await supabase.from("tiktok_campaigns").update(patch).eq("campaign_id", String(r.campaign.campaign_id));
      if (upd.error && /tiktok_post_url|engagement_added_at/.test(upd.error.message || "")) {
        return json(500, {
          error: "Engagement columns aren't migrated yet. Run supabase/tiktok_engagement.sql, then retry.",
          details: upd.error.message,
        });
      }
      if (upd.error) return json(500, { error: "Update failed", details: sbErr(upd.error) });
      return json(200, { ok: true, campaign_id: String(r.campaign.campaign_id), tiktok_post_url: url });
    }

    if (action === "queue_engagement_comments") {
      if (!body.campaign_id) return json(400, { error: "campaign_id is required" });
      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;
      if (!(await withoutTemporaryCampaigns(supabase, [String(body.campaign_id)])).length) {
        return json(400, { error: "WH Warmup campaigns can't be used for engagement." });
      }

      const link = (r.campaign.tiktok_post_url || "").trim();
      if (!link) {
        return json(400, {
          error: "This campaign has no TikTok post URL yet. It is set automatically when the campaign is created.",
        });
      }

      const comments = parseComments(body.comments);
      if (!comments.length) {
        return json(400, { error: "Enter at least one comment (one per line)." });
      }
      const serviceId = typeof body.service_id === "string" ? body.service_id.trim() : "";
      if (!serviceId) {
        return json(400, { error: "Service ID is required." });
      }

      // Store the batch first (so a provider failure still leaves a record).
      const orderRow = {
        campaign_id: String(r.campaign.campaign_id),
        kind: "COMMENTS",
        provider: null,
        service_id: serviceId,
        link,
        quantity: comments.length,
        comments,
        status: "READY",
        note: null,
        updated_at: new Date().toISOString(),
      };
      const ins = await supabase.from("engagement_orders").insert(orderRow).select().maybeSingle();
      if (ins.error && /does not exist|schema cache|could not find the table/i.test(ins.error.message || "")) {
        return json(500, {
          error: "The engagement_orders table isn't migrated yet. Run supabase/tiktok_engagement.sql, then retry.",
          details: ins.error.message,
        });
      }
      if (ins.error) return json(500, { error: "Could not store the comment batch", details: ins.error.message });

      // Dispatch to the COMMENTS provider (DripFeedPanel) using the modal's
      // Service ID. With no ENGAGEMENT_COMMENTS_API_KEY this is stored-only.
      const result = await submitEngagementOrder({
        kind: "COMMENTS",
        campaignId: String(r.campaign.campaign_id),
        serviceId,
        link,
        quantity: comments.length,
        comments,
      });

      if (ins.data) {
        await supabase
          .from("engagement_orders")
          .update({
            status: result.status || "READY",
            provider: result.provider || null,
            provider_ref: result.providerRef || null,
            note: result.message || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", ins.data.id);
      }

      return json(200, {
        ok: true,
        order_id: ins.data ? ins.data.id : null,
        count: comments.length,
        submitted: !!result.submitted,
        status: result.status || "READY",
        provider_ref: result.providerRef || null,
        message: result.message || "Stored locally — ready for an approved provider integration.",
      });
    }

    if (action === "sync") return syncAll(supabase, body.connection_id || null);

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

// Confirms an advertiser account is ours to manage (tracked, OR it has at
// least one Campaign Creator campaign registered) and returns its connection
// + bc_id.
async function resolveTrackedAdvertiser(supabase, advertiserId) {
  const { data: advs } = await supabase
    .from("tiktok_advertisers")
    .select("connection_id, advertiser_id, tracked, bc_id, bc_name")
    .eq("advertiser_id", String(advertiserId));
  let adv = (advs || []).find((a) => a.tracked);
  if (!adv) {
    try {
      const { data: cc } = await supabase
        .from("campaign_creator_campaigns")
        .select("connection_id")
        .eq("advertiser_id", String(advertiserId))
        .limit(1);
      const ccConnId = (cc || [])[0]?.connection_id;
      if (ccConnId) adv = (advs || []).find((a) => String(a.connection_id) === String(ccConnId));
    } catch (_) {
      /* campaign_creator_campaigns not migrated — nothing to fall back to */
    }
  }
  if (!adv) return { error: json(403, { error: "That advertiser account is not tracked." }) };

  const { data: conn } = await supabase
    .from("tiktok_connections")
    .select("*")
    .eq("id", adv.connection_id)
    .maybeSingle();
  if (!conn) return { error: json(404, { error: "Connection not found." }) };

  return { advertiser: adv, connection: conn, bcId: adv.bc_id || conn.bc_id || null };
}

// Advertisers whose campaigns are discovered/synced/metered for Detailed
// Metrics: the legacy explicitly-`tracked` set (kept working for back-compat)
// UNION any advertiser that has at least one Campaign Creator campaign
// registered (campaign_creator_campaigns) — so campaigns created through
// Campaign Creator show up automatically with no manual "tracked" step, without
// pulling in every advertiser under every connected Business Center. Optional
// `onlyConnectionId` scopes to one connection (mirrors the old tracked-only
// queries' `onlyConnectionId` filtering in syncAll).
async function scopedAdvertisers(supabase, onlyConnectionId) {
  let advQ = supabase
    .from("tiktok_advertisers")
    .select("connection_id, advertiser_id, advertiser_name, status, timezone, display_timezone, bc_id, bc_name, tracked");
  if (onlyConnectionId) advQ = advQ.eq("connection_id", onlyConnectionId);
  const { data: allAdvs, error: advErr } = await advQ;
  if (advErr) throw new Error(advErr.message);

  const advByKey = new Map((allAdvs || []).map((a) => [`${a.connection_id}::${a.advertiser_id}`, a]));
  const byKey = new Map();
  for (const a of allAdvs || []) if (a.tracked) byKey.set(`${a.connection_id}::${a.advertiser_id}`, a);

  try {
    let ccQ = supabase.from("campaign_creator_campaigns").select("connection_id, advertiser_id");
    if (onlyConnectionId) ccQ = ccQ.eq("connection_id", onlyConnectionId);
    const { data: ccRows } = await ccQ;
    for (const r of ccRows || []) {
      const key = `${r.connection_id}::${r.advertiser_id}`;
      if (!byKey.has(key)) {
        const a = advByKey.get(key);
        if (a) byKey.set(key, a); // only if the advertiser has actually been discovered
      }
    }
  } catch (_) {
    /* campaign_creator_campaigns not migrated yet — tracked-only is still safe */
  }

  return [...byKey.values()];
}

// Per-advertiser budget/cap + per-BC shared balance for every scoped account.
async function budgetsForScopedAdvertisers(supabase) {
  let scoped;
  try {
    scoped = await scopedAdvertisers(supabase, null);
  } catch (err) {
    return json(500, { error: "Supabase read failed", details: err.message });
  }
  if (!scoped.length) return json(200, { advertisers: {}, bc: {} });

  // Group by connection so we authenticate once per connection.
  const byConnection = {};
  for (const t of scoped) (byConnection[t.connection_id] = byConnection[t.connection_id] || []).push(t);

  const { serverUrl, redirectUrl } = resolveConfig();
  const advertisers = {};
  const bc = {}; // bc_id -> { balance, currency, connection_id, bc_name }

  for (const [connectionId, list] of Object.entries(byConnection)) {
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) continue;
    const bcIds = [...new Set(list.map((t) => t.bc_id || conn.bc_id).filter(Boolean))];
    if (!bcIds.length) continue;

    const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection: conn });
    let client;
    try {
      ({ client } = await connectMcp({ provider, serverUrl }));
      for (const bcId of bcIds) {
        const [bal, budgets] = await Promise.all([
          getBcBalance({ client, bcId }),
          getAdvertiserBudgets({ client, bcId }),
        ]);
        bc[bcId] = { bc_id: bcId, bc_name: conn.bc_name || null, connection_id: connectionId, ...bal };
        for (const [advId, b] of Object.entries(budgets.byId || {})) advertisers[advId] = { ...b, bc_id: bcId };
      }
    } catch (err) {
      bc[`err:${connectionId}`] = { error: err.message };
    } finally {
      if (client) await client.close().catch(() => {});
    }
  }

  return json(200, { advertisers, bc });
}

// Today's live TikTok campaign performance for every SCOPED advertiser account
// (see scopedAdvertisers), across every connection / Business Center. One
// report request per advertiser (all its campaigns at once), one MCP client
// per connection.
//
// Reporting boundary: the America/New_York calendar date (dashboardToday()) —
// the same clock as Glitchy / Mabac / daily_totals / the calendar. NOTE:
// report_integrated_get reads start_date/end_date in each AD ACCOUNT's own
// timezone, so an account not set to Eastern has a small near-midnight skew;
// we log a server warning when that's detected. A precise fix needs an hourly
// report and is out of scope for this endpoint.
//
// Partial failure is fine: an advertiser/connection that errors is recorded in
// `errors` and its campaigns are simply absent from `metrics` (the frontend
// keeps its last-known values for those). Never throws for a partial failure.
//
// Response: { ok, date, metrics: { <campaign_id>: { advertiser_id, spend, cpm,
//   cpa, impressions, clicks, conversions } }, okAdvertiserIds: [...], errors,
//   spendToday: { date, currentHour, cumulative, byHour: { <hour>: cumulative } } }
//   — spendToday is for the Live Performance graph only.
// A campaign whose today_date is stale (belongs to a past NY date) is about
// to have its running total_spend counter reset to 0 by the rollover reset
// below — but that counter may have stopped updating BEFORE the stale day
// actually ended (dashboard closed), so it was never the real final total for
// that day. Correct daily_totals for every such stale date first, using
// loadCampaignMetricsForAdvertiser's own historical report query (it already
// takes an arbitrary `date` — TikTok returns a campaign's true spend for any
// past date regardless of when it's asked, unaffected by our own poll gaps).
// Aggregates ACROSS every connection/advertiser for that date (matching
// glitchy-daily.js's tiktokSpendForToday, which sums the same way) and writes
// ONLY total_spend — total_earnings (Glitchy/Mabac) is a separate, already-
// correct concern untouched here. Runs only when something is actually stale
// (rare — at most once per NY-day rollover), so the extra connections are
// negligible; a connect/report failure just leaves that date's row as-is
// rather than risk zeroing out real spend.
async function backfillStaleDailyTotals(supabase, currentDate) {
  let staleRows;
  try {
    const { data, error } = await supabase
      .from("tiktok_campaigns")
      .select("campaign_id, connection_id, advertiser_id, today_date")
      .not("today_date", "is", null)
      .neq("today_date", currentDate);
    if (error) return; // column not migrated yet — nothing to backfill
    staleRows = data || [];
  } catch (_) {
    return;
  }
  if (!staleRows.length) return;

  // stale date -> connection_id -> Set(advertiser_id)
  const byDate = new Map();
  for (const r of staleRows) {
    const d = String(r.today_date);
    if (!byDate.has(d)) byDate.set(d, new Map());
    const byConn = byDate.get(d);
    if (!byConn.has(r.connection_id)) byConn.set(r.connection_id, new Set());
    byConn.get(r.connection_id).add(String(r.advertiser_id));
  }

  let whIds = new Set();
  try {
    const { data: wh } = await supabase.from("wh_warmup_campaigns").select("campaign_id");
    whIds = new Set((wh || []).map((r) => String(r.campaign_id)));
  } catch (_) {
    /* no WH table — nothing to exclude */
  }

  const { serverUrl, redirectUrl } = resolveConfig();

  for (const [staleDate, byConn] of byDate.entries()) {
    let total = 0;
    let sawFailure = false;
    for (const [connectionId, advIds] of byConn.entries()) {
      const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
      if (!conn) {
        sawFailure = true;
        continue;
      }
      const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection: conn });
      let client;
      try {
        ({ client } = await connectMcp({ provider, serverUrl }));
      } catch (err) {
        console.error(`[tiktok-metrics] backfill connect failed conn=${connectionId} date=${staleDate}: ${err.message}`);
        sawFailure = true;
        continue;
      }
      try {
        for (const advId of advIds) {
          try {
            const byId = await loadCampaignMetricsForAdvertiser(client, advId, { date: staleDate });
            for (const [cid, m] of Object.entries(byId)) {
              if (whIds.has(cid)) continue;
              total += Number(m.spend) || 0;
            }
          } catch (err) {
            console.error(`[tiktok-metrics] backfill report failed adv=${advId} date=${staleDate}: ${err.message}`);
            sawFailure = true;
          }
        }
      } finally {
        await client.close().catch(() => {});
      }
    }
    if (sawFailure && total === 0) continue; // couldn't get a real number — leave the existing row alone

    total = Math.round(total * 100) / 100;
    try {
      const { error } = await supabase
        .from("daily_totals")
        .update({ total_spend: total, updated_at: new Date().toISOString() })
        .eq("date", staleDate);
      if (error) console.error(`[tiktok-metrics] daily_totals backfill write failed date=${staleDate}: ${error.message}`);
      else console.log(`[tiktok-metrics] backfilled daily_totals ${staleDate} total_spend=${total}`);
    } catch (err) {
      console.error(`[tiktok-metrics] daily_totals backfill crashed date=${staleDate}: ${err.message}`);
    }
  }
}

// Manual counterpart to backfillStaleDailyTotals, for a date whose
// tiktok_campaigns.today_date has ALREADY been reset (so the automatic
// stale-row detection has nothing left to find) — e.g. a day that rolled over
// before that fix existed. Recomputes total_spend for `date` from TikTok's
// own historical report across EVERY currently scoped advertiser (not just
// ones with a stale row), same WH-exclusion rule as tiktokSpendForToday, and
// writes only total_spend (never total_earnings). Safe to run for any past
// date at any time — read-mostly, one targeted correction at the end.
async function backfillDailyTotalForDate(supabase, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return json(400, { error: "date must be YYYY-MM-DD" });

  let scoped;
  try {
    scoped = await scopedAdvertisers(supabase, null);
  } catch (err) {
    return json(500, { error: "Supabase read failed", details: err.message });
  }
  if (!scoped.length) return json(200, { ok: true, date, total_spend: 0, note: "No scoped advertisers." });

  let whIds = new Set();
  try {
    const { data: wh } = await supabase.from("wh_warmup_campaigns").select("campaign_id");
    whIds = new Set((wh || []).map((r) => String(r.campaign_id)));
  } catch (_) {
    /* no WH table — nothing to exclude */
  }

  const byConnection = {};
  for (const a of scoped) (byConnection[a.connection_id] = byConnection[a.connection_id] || []).push(a);
  const { serverUrl, redirectUrl } = resolveConfig();

  let total = 0;
  const errors = {};
  for (const [connectionId, advs] of Object.entries(byConnection)) {
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      errors[`conn:${connectionId}`] = "connection not found";
      continue;
    }
    const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection: conn });
    let client;
    try {
      ({ client } = await connectMcp({ provider, serverUrl }));
    } catch (err) {
      errors[`conn:${connectionId}`] = err.message;
      continue;
    }
    try {
      for (const a of advs) {
        try {
          const byId = await loadCampaignMetricsForAdvertiser(client, String(a.advertiser_id), { date });
          for (const [cid, m] of Object.entries(byId)) {
            if (whIds.has(cid)) continue;
            total += Number(m.spend) || 0;
          }
        } catch (err) {
          errors[`adv:${a.advertiser_id}`] = err.message;
        }
      }
    } finally {
      await client.close().catch(() => {});
    }
  }
  total = Math.round(total * 100) / 100;

  const upd = await supabase
    .from("daily_totals")
    .update({ total_spend: total, updated_at: new Date().toISOString() })
    .eq("date", date);
  if (upd.error) return json(500, { error: "daily_totals write failed", details: sbErr(upd.error) });

  return json(200, { ok: true, date, total_spend: total, errors });
}

async function campaignMetricsForScopedAdvertisers(supabase) {
  const date = dashboardToday();

  // A day that rolled over while the dashboard was CLOSED can lose that day's
  // spend from the calendar forever: our own today_spend tracking only ever
  // reflects the LAST poll before the dashboard closed, so the reset below
  // would commit whatever partial number that was — never the real final
  // total for that day. Fix it first, using TikTok's own historical report
  // for the stale date (it doesn't care that the date has passed).
  await backfillStaleDailyTotals(supabase, date);

  // NY-day rollover: any campaign whose today_* still belongs to a past date is
  // reset to $0 / 0 (and re-dated) BEFORE we pull fresh numbers, so it never
  // shows yesterday's metrics today. Best-effort; the daily cron does this too
  // for when the dashboard is closed. today_date/today_spend errors just mean
  // the metrics migration hasn't run yet.
  // auto_budget_bumps/auto_budget_baseline reset the same way: a campaign
  // still running the next day starts that day's $10/$50 ladder over, on top
  // of whatever budget it already earned (never rolled back) — see
  // _shared/auto-budget-bump.js.
  try {
    const { error: resetErr } = await supabase
      .from("tiktok_campaigns")
      .update({
        today_date: date,
        today_spend: 0,
        today_impressions: 0,
        today_clicks: 0,
        today_conversions: 0,
        today_cpm: 0,
        today_cpa: 0,
        auto_budget_bumps: 0,
        auto_budget_baseline: null,
      })
      .not("today_date", "is", null)
      .neq("today_date", date);
    if (resetErr && !/today_(date|spend|impressions|clicks|conversions|cpm|cpa)|auto_budget_(bumps|baseline)|does not exist/.test(resetErr.message || "")) {
      console.error(`[tiktok-metrics] stale today_* reset failed: ${resetErr.message}`);
    }
  } catch (_) {
    /* best-effort */
  }

  let tracked;
  try {
    tracked = await scopedAdvertisers(supabase, null);
  } catch (err) {
    return json(500, { error: "Supabase read failed", details: err.message });
  }
  if (!tracked.length) {
    return json(200, { ok: true, date, metrics: {}, okAdvertiserIds: [], errors: {} });
  }

  // campaign_id -> { connection_id, advertiser_id, campaign_name, ... } — used
  // to ignore report rows for campaigns we don't track, to satisfy the NOT
  // NULL columns when persisting, and (auto_budget_baseline/auto_budget_bumps)
  // as the running state for the auto budget-bump feature below.
  const { data: known } = await supabase
    .from("tiktok_campaigns")
    .select("campaign_id, connection_id, advertiser_id, campaign_name, effective_status, auto_budget_baseline, auto_budget_bumps");
  const knownById = new Map((known || []).map((c) => [String(c.campaign_id), c]));

  // WH Warmup campaigns are throwaway (auto-delete once Active) — never
  // worth scaling their budget.
  let whIds = new Set();
  try {
    const { data: wh } = await supabase.from("wh_warmup_campaigns").select("campaign_id");
    whIds = new Set((wh || []).map((r) => String(r.campaign_id)));
  } catch (_) {
    /* no WH table — nothing to exclude */
  }

  // Engagement FOUNDATION: on this ~60s tick, flip any campaign currently stored
  // as "Active" that has a post URL to READY. Idempotent, no external calls.
  await markEngagementReadyIfActive(
    supabase,
    (known || []).filter((c) => c.effective_status === "Active").map((c) => c.campaign_id)
  );

  const byConnection = {};
  for (const t of tracked) (byConnection[t.connection_id] = byConnection[t.connection_id] || []).push(t);

  const { serverUrl, redirectUrl } = resolveConfig();
  const metrics = {};
  const errors = {};
  const okAdvertiserIds = [];
  const budgetBumps = {}; // campaign_id -> { budget, auto_budget_baseline, auto_budget_bumps }

  // Stay comfortably inside the function time limit even with many advertisers.
  const DEADLINE_MS = 9000;
  const startedAt = Date.now();
  let timedOut = false;

  for (const [connectionId, list] of Object.entries(byConnection)) {
    if (timedOut) break;
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      errors[`conn:${connectionId}`] = "connection not found";
      continue;
    }

    const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection: conn });
    let client;
    try {
      ({ client } = await connectMcp({ provider, serverUrl }));
    } catch (err) {
      errors[`conn:${connectionId}`] = err.message;
      console.error(`[tiktok-metrics] connect failed conn=${connectionId}: ${err.message}`);
      continue;
    }

    try {
      for (const adv of list) {
        const advId = String(adv.advertiser_id);
        if (Date.now() - startedAt > DEADLINE_MS) {
          timedOut = true;
          errors.timeout = "Stopped early to stay within the function time limit — some advertiser accounts were not refreshed this cycle.";
          break;
        }
        const tz = adv.timezone || adv.display_timezone || "";
        if (tz && !/new[_ ]?york|eastern/i.test(tz)) {
          console.warn(`[tiktok-metrics] advertiser ${advId} tz="${tz}" — daily boundary uses the NY date, near-midnight skew possible`);
        }
        try {
          const byId = await loadCampaignMetricsForAdvertiser(client, advId, { date });
          for (const [cid, m] of Object.entries(byId)) metrics[cid] = m;
          okAdvertiserIds.push(advId);

          // Auto budget-bump: +$50 to a CBO campaign's budget for every $10 it
          // spends today. Reuses this SAME connected client + the spend this
          // call just fetched — no extra report/connection. Best-effort: a
          // failure here never blocks metrics for the rest of this advertiser.
          try {
            const spendByCampaignId = {};
            for (const [cid, m] of Object.entries(byId)) spendByCampaignId[cid] = m.spend;
            const bumps = await applyAutoBudgetBumps({ client, advertiserId: advId, spendByCampaignId, knownById, whIds });
            for (const b of bumps) budgetBumps[b.campaign_id] = b;
          } catch (err) {
            console.error(`[auto-budget] adv=${advId} failed: ${err.message}`);
          }
        } catch (err) {
          errors[`adv:${advId}`] = err.message;
          console.error(`[tiktok-metrics] report failed adv=${advId}: ${err.message}`);
        }
      }
    } finally {
      await client.close().catch(() => {});
    }
  }

  // Persist today's metrics onto the known campaign rows (one upsert). This is
  // what daily_totals.total_spend is derived from, so it must be best-effort and
  // must never fail the response. Any auto budget-bump applied this cycle
  // (budgetBumps) rides along in the SAME upsert.
  const now = new Date().toISOString();
  const rows = [];
  for (const [cid, m] of Object.entries(metrics)) {
    const k = knownById.get(cid);
    if (!k) continue;
    const bump = budgetBumps[cid];
    rows.push({
      campaign_id: cid,
      connection_id: k.connection_id,
      advertiser_id: k.advertiser_id,
      campaign_name: k.campaign_name,
      today_date: date,
      today_spend: m.spend,
      today_impressions: m.impressions,
      today_clicks: m.clicks,
      ...(bump ? { budget: bump.budget, auto_budget_baseline: bump.auto_budget_baseline, auto_budget_bumps: bump.auto_budget_bumps } : {}),
      today_conversions: m.conversions,
      today_cpm: m.cpm,
      today_cpa: m.cpa,
      metrics_updated_at: now,
    });
  }
  if (rows.length) {
    const { error: upErr } = await supabase.from("tiktok_campaigns").upsert(rows, { onConflict: "campaign_id" });
    if (upErr && !/today_(date|spend|impressions|clicks|conversions|cpm|cpa)|metrics_updated_at|auto_budget_(bumps|baseline)/.test(upErr.message || "")) {
      // A real write error (not "column missing" — that just means the migration
      // hasn't been run yet, which only affects daily_totals, not the live table).
      errors.persist = upErr.message;
      console.error(`[tiktok-metrics] persist failed: ${upErr.message}`);
    }
  }

  // ---- Live Performance graph ONLY: snapshot today's cumulative spend into the
  // current NY hour, then hand back every hour's cumulative so the frontend can
  // derive hourly spend (delta between consecutive snapshots). Zero extra MCP
  // calls — this is all Supabase. Never fails the response.
  let spendToday = null;
  try {
    const cumulative = await tiktokSpendForToday(supabase, date); // Σ persisted today_spend
    const hour = nyHourNow();
    await recordSpendSnapshot(supabase, date, hour, cumulative);
    spendToday = { date, currentHour: hour, cumulative, byHour: await readSpendSnapshots(supabase, date) };
  } catch (err) {
    console.error(`[tiktok-metrics] spend snapshot failed: ${err.message}`);
  }

  return json(200, { ok: true, date, metrics, okAdvertiserIds, errors, spendToday, budgetBumps });
}

// Current hour (0-23) in America/New_York — the graph's fixed axis / boundary.
function nyHourNow() {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date());
  return parseInt(s, 10) % 24; // guards the historical "24" at midnight
}

// Upsert the running cumulative into (date, hour). Overwrites the current hour on
// every refresh; the last write before the hour rolls becomes its frozen value.
// Silently no-ops if the migration (supabase/tiktok_spend_snapshots.sql) is unrun.
async function recordSpendSnapshot(supabase, date, hour, cumulative) {
  const value = Math.round((Number(cumulative) || 0) * 100) / 100;
  const { error } = await supabase.from("tiktok_spend_snapshots").upsert(
    { date, hour, cumulative_spend: value, updated_at: new Date().toISOString() },
    { onConflict: "date,hour" }
  );
  if (error) {
    if (/tiktok_spend_snapshots|does not exist|schema cache/i.test(error.message || "")) return;
    throw error;
  }
  // Opportunistic cleanup — tiny table, keep ~14 days.
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  await supabase.from("tiktok_spend_snapshots").delete().lt("date", cutoff);
}

// { "<hour>": cumulative_spend } for one NY date. Empty on any error / no rows.
async function readSpendSnapshots(supabase, date) {
  const { data, error } = await supabase
    .from("tiktok_spend_snapshots")
    .select("hour, cumulative_spend")
    .eq("date", date);
  if (error || !Array.isArray(data)) return {};
  const byHour = {};
  for (const r of data) byHour[String(r.hour)] = Number(r.cumulative_spend) || 0;
  return byHour;
}

function normalizeOp(v) {
  const s = String(v || "").toUpperCase();
  return s === "ENABLE" || s === "DISABLE" ? s : null;
}

async function persistCampaignStatus(supabase, campaignId, detail) {
  await supabase
    .from("tiktok_campaigns")
    .update({
      campaign_operation_status: detail.campaign_operation_status,
      campaign_secondary_status: detail.campaign_secondary_status,
      effective_status: detail.effective_status,
      effective_tone: detail.effective_tone,
      status_detail: detail.status_detail,
      ad_count: detail.ad_count,
      active_ad_count: detail.active_ad_count,
      updated_at: new Date().toISOString(),
    })
    .eq("campaign_id", String(campaignId));
}

// "Rejection reason" button: the exact reasons the automatic-appeal pipeline
// recorded for this campaign's initial ad — no-op (returns nulls) for
// campaigns never processed by it. appeal_reasons is ALWAYS regrouped fresh
// from appeal_raw_reasons here (never trusts whatever shape is sitting in the
// column) so rows appealed before groupReasonsByCategory existed still
// render correctly with no backfill needed.
async function fetchAppealInfo(supabase, campaignId) {
  const { data } = await supabase
    .from("campaign_creator_campaigns")
    .select("appeal_state, appeal_raw_reasons, appeal_adgroup_id")
    .eq("campaign_id", String(campaignId))
    .maybeSingle();
  const raw = data?.appeal_raw_reasons || null;
  const { groups, unknownTexts } = groupReasonsByCategory(raw || []);
  return {
    appeal_state: data?.appeal_state || "NONE",
    appeal_reasons: groups,
    appeal_unknown_reasons: unknownTexts,
    appeal_raw_reasons: raw,
    appeal_adgroup_id: data?.appeal_adgroup_id || null,
  };
}

// Re-discovery for scoped advertisers (see scopedAdvertisers — tracked, or has
// a Campaign Creator campaign). `onlyConnectionId` scopes the whole operation
// to a single Business Center/connection ("Refresh Data" button); omit it for
// a full sync across every connection.
async function syncAll(supabase, onlyConnectionId) {
  let allScoped;
  try {
    allScoped = await scopedAdvertisers(supabase, null); // global, for the prune decision below
  } catch (err) {
    return json(500, { error: "Supabase read failed", details: err.message });
  }

  const globalScopedAdvIds = allScoped.map((t) => String(t.advertiser_id));

  // Prune campaigns whose advertiser is no longer scoped anywhere (only on a
  // full sync — a scoped refresh must not touch other BCs).
  if (!onlyConnectionId) {
    if (globalScopedAdvIds.length) {
      await supabase.from("tiktok_campaigns").delete().not("advertiser_id", "in", `(${globalScopedAdvIds.join(",")})`);
    } else {
      await supabase.from("tiktok_campaigns").delete().neq("campaign_id", "");
      return json(200, { ok: true, campaignCount: 0, connections: 0, note: "No advertiser accounts are tracked or have Campaign Creator campaigns." });
    }
  }

  const tracked = onlyConnectionId
    ? allScoped.filter((t) => String(t.connection_id) === String(onlyConnectionId))
    : allScoped;

  if (!tracked.length) {
    // Scoped refresh for a BC with nothing scoped -> drop its campaign rows.
    if (onlyConnectionId) {
      await supabase.from("tiktok_campaigns").delete().eq("connection_id", onlyConnectionId);
    }
    return json(200, { ok: true, campaignCount: 0, connections: 0, note: "No advertiser accounts are tracked or have Campaign Creator campaigns for this Business Center." });
  }

  const byConnection = {};
  for (const t of tracked) {
    (byConnection[t.connection_id] = byConnection[t.connection_id] || []).push(t);
  }

  const { serverUrl, redirectUrl } = resolveConfig();
  const summary = { ok: true, campaignCount: 0, connections: 0, perConnection: {} };

  for (const [connectionId, advertisers] of Object.entries(byConnection)) {
    const { data: conn, error: connErr } = await supabase
      .from("tiktok_connections")
      .select("*")
      .eq("id", connectionId)
      .maybeSingle();
    if (connErr || !conn) {
      summary.perConnection[connectionId] = "connection not found";
      continue;
    }

    const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection: conn });
    let client;
    try {
      ({ client } = await connectMcp({ provider, serverUrl }));
      // Refresh the account list / statuses / BC identity for this connection too.
      try {
        await discoverAndStoreAdvertisers({ supabase, client, connectionId });
      } catch (_) {
        /* campaign discovery is the priority — don't fail the whole sync on this */
      }
      const res = await discoverAndStoreCampaigns({
        supabase,
        client,
        connectionId,
        trackedAdvertisers: advertisers,
        affiliateNetwork: conn.affiliate_network,
      });
      summary.campaignCount += res.campaignCount;
      summary.connections += 1;
      summary.perConnection[connectionId] = res.perAdvertiser;

      // Full-account scan: every Approved advertiser under this connection,
      // not just the ones already scoped above — catches campaigns nothing
      // in this dashboard was tracking yet ("stray" campaigns). Best-effort;
      // never fails the sync.
      try {
        const strayRes = await discoverStrayCampaigns({ supabase, client, connectionId });
        if (strayRes.strayCount) summary.strayCampaignsFound = (summary.strayCampaignsFound || 0) + strayRes.strayCount;
      } catch (err) {
        console.error(`[sync] stray discovery failed conn=${connectionId}: ${err.message}`);
      }
      await supabase
        .from("tiktok_connections")
        .update({ last_verified_at: new Date().toISOString(), status: "active" })
        .eq("id", connectionId);
    } catch (err) {
      summary.perConnection[connectionId] = `error: ${err.message}`;
    } finally {
      if (client) await client.close().catch(() => {});
    }
  }

  return json(200, summary);
}

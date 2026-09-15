// Full-account campaign discovery: finds every non-deleted campaign sitting
// in EVERY Approved advertiser under one connection — not just advertisers
// already tracked or running a Campaign Creator campaign. Only ever runs
// from the "sync" action (Refresh Data), never the 60s metrics tick — this
// is a live TikTok scan across possibly many accounts, priced like the rest
// of a full sync, not like a per-poll cost.
//
// A campaign already known to campaign_creator_campaigns or
// wh_warmup_campaigns needs nothing done — it already flows through its own
// existing path. Anything else is a "stray": a real, currently-existing ad
// TikTok is charging for that nothing in this dashboard was watching. For
// each stray campaign this:
//   1. marks its advertiser tracked=true — the existing pause/delete actions
//      (resolveTrackedCampaign / scopedAdvertisers) check this flag, so a
//      stray campaign becomes actionable from the dashboard the moment it's
//      found, same as everything else.
//   2. upserts a minimal tiktok_campaigns row for it (status/toggle/delete
//      machinery needs a row to act on).
//   3. records it in stray_campaigns — see that table's own comment for why
//      this carries NO automation (never auto-deleted, only by explicit
//      user action).

const { mcpCall } = require("./tiktok-mcp");

function approved(status) {
  const s = String(status || "").toUpperCase();
  return s === "" || s === "STATUS_ENABLE";
}

const CAMPAIGN_FIELDS = ["campaign_id", "campaign_name", "operation_status", "secondary_status", "create_time"];

async function campaignsForAdvertiser(client, advertiserId) {
  const all = [];
  let page = 1;
  for (;;) {
    const res = await mcpCall(client, "campaign_get", {
      advertiser_id: advertiserId,
      fields: CAMPAIGN_FIELDS,
      page,
      page_size: 1000,
    });
    all.push(...(res?.list || []));
    const info = res?.page_info || {};
    if (!info.total_page || page >= info.total_page) break;
    page += 1;
    if (page > 20) break; // safety
  }
  return all;
}

// Returns { strayCount, scannedAdvertiserCount, errors }.
async function discoverStrayCampaigns({ supabase, client, connectionId }) {
  const out = { strayCount: 0, scannedAdvertiserCount: 0, errors: {} };

  const { data: advs, error: advErr } = await supabase
    .from("tiktok_advertisers")
    .select("advertiser_id, status")
    .eq("connection_id", connectionId);
  if (advErr) {
    out.errors.advertisers = advErr.message;
    return out;
  }
  const approvedIds = (advs || []).filter((a) => approved(a.status)).map((a) => String(a.advertiser_id));
  if (!approvedIds.length) return out;

  const [{ data: ccRows }, { data: whRows }] = await Promise.all([
    supabase.from("campaign_creator_campaigns").select("campaign_id"),
    supabase.from("wh_warmup_campaigns").select("campaign_id"),
  ]);
  const knownIds = new Set([...(ccRows || []), ...(whRows || [])].map((r) => String(r.campaign_id)));

  const strayRows = [];
  const campaignRows = [];
  const advertiserIdsToTrack = new Set();

  for (const advertiserId of approvedIds) {
    try {
      const campaigns = await campaignsForAdvertiser(client, advertiserId);
      out.scannedAdvertiserCount++;
      for (const c of campaigns) {
        const cid = String(c.campaign_id);
        if (knownIds.has(cid)) continue; // Campaign Creator / WH Warmup — already handled elsewhere
        advertiserIdsToTrack.add(advertiserId);
        strayRows.push({ campaign_id: cid, connection_id: connectionId, advertiser_id: advertiserId, campaign_name: c.campaign_name || cid });
        campaignRows.push({
          campaign_id: cid,
          connection_id: connectionId,
          advertiser_id: advertiserId,
          campaign_name: c.campaign_name || cid,
          objective_type: null,
          campaign_operation_status: c.operation_status || null,
          campaign_secondary_status: c.secondary_status || null,
          create_time: c.create_time || null,
        });
      }
    } catch (err) {
      out.errors[`adv:${advertiserId}`] = err.message;
    }
  }

  if (advertiserIdsToTrack.size) {
    await supabase
      .from("tiktok_advertisers")
      .update({ tracked: true })
      .eq("connection_id", connectionId)
      .in("advertiser_id", [...advertiserIdsToTrack]);
  }

  // Write the stray_campaigns MARKER first, and only then the tiktok_campaigns
  // row for whichever of these campaign_ids the marker write actually covers.
  // A campaign_id must never land in tiktok_campaigns via this path without
  // also being flagged in stray_campaigns — readCampaigns' is_stray check
  // (tiktok-campaigns.js) is what keeps a stray out of Detailed Metrics, so
  // writing tiktok_campaigns unconditionally (the old order) meant ANY
  // failure of the stray_campaigns upsert — table not yet migrated, a
  // transient error, anything — silently leaked that campaign into Detailed
  // Metrics forever, unflagged, with a blank "Unknown" status. (Same failure
  // shape as the WH Warmup Traffic-campaign leak fixed in cleanup.js.)
  let markedIds = new Set();
  if (strayRows.length) {
    const { error } = await supabase.from("stray_campaigns").upsert(strayRows, { onConflict: "campaign_id" });
    if (error) {
      if (!/does not exist|schema cache|could not find/i.test(error.message || "")) out.errors.stray_campaigns = error.message;
      // Table not migrated yet (or a real failure) — don't write ANY of these
      // to tiktok_campaigns either; better invisible than unflagged.
    } else {
      out.strayCount = strayRows.length;
      markedIds = new Set(strayRows.map((r) => r.campaign_id));
    }
  }

  const coveredCampaignRows = campaignRows.filter((r) => markedIds.has(r.campaign_id));
  if (coveredCampaignRows.length) {
    // Only the columns listed in campaignRows are ever written — today_spend,
    // effective_status, etc. are left completely alone (Postgres upsert only
    // sets columns you actually provide), so this never clobbers whatever the
    // regular metrics tick / discoverAndStoreCampaigns has already built up
    // for a campaign once its advertiser becomes scoped. effective_status
    // itself is computed by discoverAndStoreCampaigns, not here — a
    // brand-new stray reads with a blank status until the NEXT full sync,
    // which now includes it (its advertiser is tracked as of this run).
    const { error } = await supabase.from("tiktok_campaigns").upsert(coveredCampaignRows, { onConflict: "campaign_id" });
    if (error) out.errors.tiktok_campaigns = error.message;
  }

  return out;
}

module.exports = { discoverStrayCampaigns };

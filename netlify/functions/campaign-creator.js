// POST /.netlify/functions/campaign-creator   { action, ... }   (Vercel: /api/campaign-creator)
//
//   "register"  { campaign_id, advertiser_id, connection_id, bc_id?, campaign_name?,
//                 initial_adgroup_id, initial_ad_id?, adgroup_payload, ad_payload?, dupe_target?:20 }
//        -> record a Campaign-Creator campaign so its initial ad group is
//           auto-duplicated once Active. No-op if campaign_id already registered.
//           (Called by the future Campaign Creator tool — nothing else writes here.)
//
//   "process_duplication"  (no body)
//        -> for EVERY registered campaign: WAITING_FOR_ACTIVE (checks whether
//           the initial ad group is genuinely Active yet — auto appeal also
//           runs here) and DUPLICATING (a manual_dupe run still in progress —
//           creates up to DUPES_PER_CYCLE more copies) get the full
//           appeal/duplication treatment; READY/FAILED/COMPLETE rows get a
//           cheap READ-ONLY status refresh only (no appeal or ad-group-
//           creation calls) so Detailed Metrics keeps matching TikTok's real
//           current state for the campaign's whole life, not just its initial
//           review. Idempotent. Driven ONLY by the existing ~60s dashboard
//           refresh (js/app.js runCampaignCreatorDuplication()) — there is NO
//           scheduler/cron for this. See the NOTE below for why.
//
//   DUPLICATION IS MANUAL (2026-09-05): reaching Active no longer auto-starts
//   creating 20 copies. A WAITING_FOR_ACTIVE row that goes Active advances to
//   READY and just sits there — the dashboard's "Dupe" button
//   (manual_dupe below) is the only thing that starts the creation loop.
//
//   "manual_dupe"  { campaign_ids: [...], count }
//        -> for each campaign_id already registered (skips + reports any that
//           aren't, or whose initial ad group isn't Active yet): sets
//           dupe_target = count, clears dupe_attempts/dupe_error, sets
//           dupe_status DUPLICATING, then immediately runs one duplication
//           pass for it (reusing the exact same engine as process_duplication)
//           so the dashboard shows progress right away. dupe_created (progress
//           already made) is never reset — this doubles as "retry a FAILED
//           row" and "raise/lower the target on an in-progress or COMPLETE
//           row" — a count below what's already been created is just a no-op.
//           Any remainder beyond one pass continues on the next
//           process_duplication tick, capped at DUPES_PER_CYCLE per tick, and
//           can never exceed dupe_target.
//
//   "list"  -> registered campaigns + duplication state (monitoring; the
//              dashboard's Dupe modal uses this to show current progress)
//
// No admin password (same posture as the other tiktok-* write actions). All MCP
// calls run here; no tokens are ever returned to the browser.
//
// NOTE: there is deliberately NO cron/scheduler for this function (removed
// 2026-09-05). A vercel.json cron finer than once/day (it was */5 * * * *)
// makes Vercel's Hobby plan reject the ENTIRE deployment — every commit from
// the moment that cron was added until it was removed silently failed to
// deploy at all, not just this feature. Duplication is manual by design now
// anyway (the "Dupe" button), and progress on an in-progress job continues via
// the ~60s in-browser poll while the dashboard is open — no closed-dashboard
// background trigger is needed or wanted. Do not re-add a sub-daily cron here.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  loadCampaignDetail,
  applyAppealOverlay,
  markEngagementReadyIfActive,
  json,
} = require("./_shared/tiktok-mcp");
const { duplicateForRow, registerForDuplication, DUPES_PER_CYCLE } = require("./_shared/campaign-creator.js");
const { handleAutoAppeal, isStaleSubmitting } = require("./_shared/appeals.js");

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

// manual_dupe's own immediate pass and the ~60s process_duplication tick
// (js/app.js runCampaignCreatorDuplication) can both fire for the same
// DUPLICATING row — manual_dupe's request can still be running when the next
// poll starts process_duplication, which also processes DUPLICATING rows.
// With no mutual exclusion both invocations create their own overlapping
// batch of ad groups off the same stale dupe_created, colliding names (two
// real "adg4"s) and blowing past dupe_target. Claim the row atomically before
// letting duplicateForRow create anything; a claim older than the staleness
// window is treated as an abandoned/crashed invocation and can be reclaimed.
// See supabase/campaign_creator_dupe_lock.sql.
const DUPE_CLAIM_STALE_MS = 90 * 1000; // comfortably longer than either caller's own 45s deadline
async function claimDuplicationRow(supabase, campaignId) {
  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - DUPE_CLAIM_STALE_MS).toISOString();
  const claim = await supabase
    .from("campaign_creator_campaigns")
    .update({ dupe_claimed_at: nowIso })
    .eq("campaign_id", campaignId)
    .eq("dupe_status", "DUPLICATING")
    .or(`dupe_claimed_at.is.null,dupe_claimed_at.lt.${staleBefore}`)
    .select("campaign_id");
  if (claim.error) {
    // Migration not run yet (supabase/campaign_creator_dupe_lock.sql) —
    // degrade to no locking rather than block duplication entirely.
    if (/dupe_claimed_at/.test(claim.error.message || "")) return true;
    return false;
  }
  return !!(claim.data && claim.data.length);
}

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

    if (body.action === "register") return register(supabase, body);
    if (body.action === "manual_dupe") return manualDupe(supabase, body);
    if (body.action === "list") return listRows(supabase);
    // Driven only by the dashboard's ~60s poll — no scheduler calls this.
    if (body.action === "process_duplication") return processDuplication(supabase);

    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

// ---------------------------------------------------------------------------

async function register(supabase, body) {
  const r = await registerForDuplication(supabase, body);
  if (r.error) return json(r.code || 500, { error: r.error });
  return json(200, { ok: true, ...(r.already ? { already: true } : {}) });
}

// The Dupe button's action. Sets dupe_target + flips selected rows to
// DUPLICATING, then runs ONE duplication pass immediately (same engine as
// process_duplication) so progress shows right away. Reuses withClient,
// patchRow, and duplicateForRow exactly as process_duplication does — no
// second duplication system.
async function manualDupe(supabase, body) {
  const campaignIds = Array.isArray(body.campaign_ids) ? [...new Set(body.campaign_ids.map(String).filter(Boolean))] : [];
  if (!campaignIds.length) return json(400, { error: "campaign_ids (a non-empty array) is required" });
  const count = Number(body.count);
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    return json(400, { error: "count must be a number between 1 and 100" });
  }

  const { data: rows, error } = await supabase.from("campaign_creator_campaigns").select("*").in("campaign_id", campaignIds);
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, {
        ok: true,
        results: campaignIds.map((id) => ({ campaign_id: id, ok: false, error: "Campaign Creator isn't migrated yet." })),
      });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }

  const byId = new Map((rows || []).map((r) => [String(r.campaign_id), r]));
  const results = [];
  const toProcess = [];
  const now = new Date().toISOString();

  for (const id of campaignIds) {
    const row = byId.get(id);
    if (!row) {
      results.push({ campaign_id: id, ok: false, error: "Not a Campaign Creator campaign — nothing to duplicate." });
      continue;
    }
    if (row.dupe_status === "WAITING_FOR_ACTIVE") {
      results.push({ campaign_id: id, ok: false, error: "The initial ad group isn't Active yet." });
      continue;
    }
    const patch = { dupe_target: count, dupe_status: "DUPLICATING", dupe_attempts: 0, dupe_error: null, updated_at: now };
    const upd = await supabase.from("campaign_creator_campaigns").update(patch).eq("campaign_id", id);
    if (upd.error) {
      results.push({ campaign_id: id, ok: false, error: upd.error.message });
      continue;
    }
    toProcess.push({ ...row, ...patch });
  }

  if (!toProcess.length) return json(200, { ok: true, results });

  const byConnection = {};
  for (const r of toProcess) (byConnection[r.connection_id] = byConnection[r.connection_id] || []).push(r);
  const deadlineMs = Date.now() + 45000; // this endpoint gets maxDuration 60 on Vercel

  for (const [connectionId, list] of Object.entries(byConnection)) {
    if (Date.now() > deadlineMs) {
      for (const r of list) results.push({ campaign_id: r.campaign_id, ok: true, dupe_status: "DUPLICATING", note: "queued for the next automatic cycle" });
      continue;
    }
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      for (const r of list) results.push({ campaign_id: r.campaign_id, ok: false, error: "Connection removed." });
      continue;
    }
    const advIds = [...new Set(list.map((r) => String(r.advertiser_id)))];
    const { data: advRows } = await supabase
      .from("tiktok_advertisers")
      .select("advertiser_id, status")
      .eq("connection_id", connectionId)
      .in("advertiser_id", advIds);
    const advStatus = new Map((advRows || []).map((a) => [String(a.advertiser_id), a.status]));

    try {
      await withClient(supabase, conn, async (client) => {
        for (const r of list) {
          if (Date.now() > deadlineMs) {
            results.push({ campaign_id: r.campaign_id, ok: true, dupe_status: "DUPLICATING", note: "queued for the next automatic cycle" });
            continue;
          }
          const claimed = await claimDuplicationRow(supabase, r.campaign_id);
          if (!claimed) {
            // process_duplication's ~60s tick already owns this row right now.
            results.push({
              campaign_id: r.campaign_id,
              ok: true,
              dupe_status: "DUPLICATING",
              dupe_created: r.dupe_created,
              dupe_target: count,
              note: "Already being processed — progress continues on its own.",
            });
            continue;
          }
          r.__persist = (patch) => patchRow(supabase, r.campaign_id, patch);
          let out;
          try {
            out = await duplicateForRow({ client, row: r, advertiserStatus: advStatus.get(String(r.advertiser_id)), deadlineMs });
          } catch (err) {
            await patchRow(supabase, r.campaign_id, { dupe_claimed_at: null });
            results.push({ campaign_id: r.campaign_id, ok: false, error: err.message });
            continue;
          }
          await patchRow(supabase, r.campaign_id, { ...out.patch, dupe_claimed_at: null });
          console.log(`[campaign-creator] ${r.campaign_id} — manual_dupe -> ${out.patch.dupe_status || out.status} (${out.patch.dupe_created ?? r.dupe_created}/${count})`);
          results.push({
            campaign_id: r.campaign_id,
            ok: out.status !== "FAILED",
            dupe_status: out.patch.dupe_status || out.status,
            dupe_created: out.patch.dupe_created ?? r.dupe_created,
            dupe_target: count,
            error: out.patch.dupe_error || null,
          });
        }
      });
    } catch (err) {
      for (const r of list) results.push({ campaign_id: r.campaign_id, ok: false, error: err.message });
    }
  }

  return json(200, { ok: true, results });
}

// ---------------------------------------------------------------------------

async function processDuplication(supabase) {
  // Every registered row, not just WAITING_FOR_ACTIVE/DUPLICATING: a row that
  // has moved on to READY/FAILED/COMPLETE still gets a cheap read-only status
  // refresh below (see "STATUS-ONLY REFRESH") so Detailed Metrics keeps
  // matching TikTok's real current state for the campaign's whole life, not
  // just during its initial review — it just never re-enters appeal/
  // duplication handling once it's past that stage.
  //
  // This table is never purged (it's the permanent duplication/appeal audit
  // trail), so it only grows — with this account's volume (1 CBO per ad, 20
  // ad-group dupes) it can hold a lot of history. The 45s deadline below can't
  // always reach every row in one tick, so newest-first ordering matters: a
  // freshly launched campaign's status is still actively changing (review ->
  // active, appeal outcome, etc.) and needs to surface fast, while an old
  // COMPLETE/FAILED row's status rarely changes again. Without this order, an
  // unordered `select("*")` on a large table can leave the very rows a user
  // just launched waiting behind years of settled history that didn't need
  // rechecking this cycle at all.
  const { data: fetched, error } = await supabase
    .from("campaign_creator_campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, checked: 0, created: 0, completed: 0, failed: 0, unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }
  if (!fetched || !fetched.length) return json(200, { ok: true, checked: 0, created: 0, completed: 0, failed: 0 });

  // DUPLICATING rows routinely need several ticks each (DUPES_PER_CYCLE=5 vs.
  // a dupe_target that can be 20+), and the 45s deadline below can cut a tick
  // off partway through the list. Left in the newest-first order above, the
  // SAME campaigns — whichever landed earliest in the list — would claim the
  // budget on every single tick, while campaigns sorted later never got a
  // turn at all: exactly the "some got all 10 dupes, some got 0" bug this
  // fixes. Pulling DUPLICATING rows out and sorting them oldest-updated-first
  // makes it self-correcting: a row touched this tick sorts to the back next
  // time, so whichever rows were skipped naturally rise to the front instead
  // of the same ones winning every tick. WAITING_FOR_ACTIVE/READY/FAILED/
  // COMPLETE keep the original newest-first order untouched (see the comment
  // above) — this only reorders the rows actually competing for the
  // duplication budget.
  const duplicating = fetched
    .filter((r) => r.dupe_status === "DUPLICATING")
    .sort((a, b) => new Date(a.updated_at || 0) - new Date(b.updated_at || 0));
  const rest = fetched.filter((r) => r.dupe_status !== "DUPLICATING");
  const rows = [...duplicating, ...rest];

  const byConnection = {};
  for (const r of rows) (byConnection[r.connection_id] = byConnection[r.connection_id] || []).push(r);

  const tally = { checked: 0, created: 0, completed: 0, failed: 0, pending: 0 };
  const deadlineMs = Date.now() + 45000; // this endpoint gets maxDuration 60 on Vercel

  for (const [connectionId, list] of Object.entries(byConnection)) {
    if (Date.now() > deadlineMs) break;
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      for (const r of list) {
        await patchRow(supabase, r.campaign_id, { dupe_status: "FAILED", dupe_error: "Connection removed.", updated_at: new Date().toISOString() });
        tally.failed += 1;
      }
      continue;
    }

    const advIds = [...new Set(list.map((r) => String(r.advertiser_id)))];
    const { data: advRows } = await supabase
      .from("tiktok_advertisers")
      .select("advertiser_id, status")
      .eq("connection_id", connectionId)
      .in("advertiser_id", advIds);
    const advStatus = new Map((advRows || []).map((a) => [String(a.advertiser_id), a.status]));

    // Recover any row wedged in APPEAL_SUBMITTING by a crash between claim and
    // result — reset to REJECTED so the appeal can be retried. Never clears
    // appeal_attempted, so a successful appeal is still never repeated.
    for (const r of list) {
      if (isStaleSubmitting(r)) {
        await patchRow(supabase, r.campaign_id, {
          appeal_state: "REJECTED",
          appeal_updated_at: new Date().toISOString(),
        });
        r.appeal_state = "REJECTED";
        console.log(`[appeals] ${r.campaign_id} — stale APPEAL_SUBMITTING reset to REJECTED`);
      }
    }

    try {
      await withClient(supabase, conn, async (client) => {
        for (const r of list) {
          if (Date.now() > deadlineMs) break;
          tally.checked += 1;

          // ---- STATUS-ONLY REFRESH (READY / FAILED / COMPLETE) ----
          // These rows are done with appeal/duplication handling for good —
          // but the campaign itself keeps running (or not) on TikTok for its
          // whole real life, and nothing else refreshes Detailed Metrics'
          // effective_status for a Campaign Creator campaign once it leaves
          // WAITING_FOR_ACTIVE/DUPLICATING. One cheap read-only detail pull,
          // no appeal or ad-group-creation calls at all.
          if (r.dupe_status !== "WAITING_FOR_ACTIVE" && r.dupe_status !== "DUPLICATING") {
            try {
              const detail = await loadCampaignDetail({
                client,
                advertiserId: r.advertiser_id,
                advertiserStatus: advStatus.get(String(r.advertiser_id)),
                campaignId: r.campaign_id,
                timezone: null,
              });
              const overlaid = applyAppealOverlay(detail, r.appeal_state);
              await persistTiktokCampaignStatus(supabase, r.campaign_id, overlaid);
            } catch (err) {
              console.error(`[campaign-creator] ${r.campaign_id} — status refresh failed: ${err.message}`);
            }
            continue;
          }

          const before = Number(r.dupe_created) || 0;
          r.__persist = (patch) => patchRow(supabase, r.campaign_id, patch);

          // ---- AUTO REJECTION APPEAL (initial review lifecycle only) ----
          // Runs before duplication so a rejected / appealing campaign is never
          // duplicated. Reuses its loadCampaignDetail result for the Active gate.
          let preloadedDetail = null;
          if (r.dupe_status === "WAITING_FOR_ACTIVE") {
            let appeal;
            try {
              appeal = await handleAutoAppeal({
                supabase,
                client,
                row: r,
                advertiserStatus: advStatus.get(String(r.advertiser_id)),
              });
            } catch (err) {
              console.error(`[appeals] ${r.campaign_id} — orchestrator failed: ${err.message}`);
              appeal = { blockDuplication: true, detail: null, appealState: r.appeal_state || "NONE" };
            }
            preloadedDetail = appeal.detail || null;
            // Keep the Detailed Metrics status current for creator campaigns
            // (the 60s "metrics" tick doesn't re-derive status). Overlay with
            // appeal.appealState (the state as of the END of this call, which
            // handleAutoAppeal may have just changed) — never r.appeal_state,
            // which is stale the instant this tick writes a new value.
            if (preloadedDetail) {
              const overlaid = applyAppealOverlay(preloadedDetail, appeal.appealState);
              await persistTiktokCampaignStatus(supabase, r.campaign_id, overlaid);
            }
            if (appeal.blockDuplication) {
              await patchRow(supabase, r.campaign_id, { updated_at: new Date().toISOString() });
              tally.pending += 1;
              continue;
            }
          }

          const beforeStatus = r.dupe_status;
          // Only DUPLICATING actually creates ad groups (WAITING_FOR_ACTIVE
          // here is just the Active-ness check above) — that's the only case
          // that can collide with a concurrent manual_dupe pass on this row.
          let claimed = true;
          if (beforeStatus === "DUPLICATING") {
            claimed = await claimDuplicationRow(supabase, r.campaign_id);
          }
          if (!claimed) {
            tally.pending += 1;
            continue; // a manual_dupe request already owns this row right now
          }
          let out;
          try {
            out = await duplicateForRow({
              client,
              row: r,
              advertiserStatus: advStatus.get(String(r.advertiser_id)),
              deadlineMs,
              preloadedDetail,
            });
          } catch (err) {
            console.error(`[campaign-creator] ${r.campaign_id} failed: ${err.message}`);
            if (beforeStatus === "DUPLICATING") await patchRow(supabase, r.campaign_id, { dupe_claimed_at: null });
            continue;
          }
          await patchRow(supabase, r.campaign_id, beforeStatus === "DUPLICATING" ? { ...out.patch, dupe_claimed_at: null } : out.patch);
          const createdNow = Math.max(0, (Number(out.patch.dupe_created) || before) - before);
          tally.created += createdNow;
          const afterStatus = out.patch.dupe_status || out.status;
          if (afterStatus !== beforeStatus) {
            console.log(`[campaign-creator] ${r.campaign_id} — ${beforeStatus} -> ${afterStatus}`);
          }
          if (out.status === "COMPLETE") {
            tally.completed += 1;
            console.log(`[campaign-creator] ${r.campaign_id} — COMPLETE (${out.patch.dupe_created || Number(r.dupe_target) || 20}/${Number(r.dupe_target) || 20} ad groups)`);
          } else if (out.status === "FAILED") {
            tally.failed += 1;
            console.log(`[campaign-creator] ${r.campaign_id} — FAILED: ${out.patch.dupe_error || "unknown"}`);
          } else {
            tally.pending += 1;
            if (createdNow > 0) {
              console.log(`[campaign-creator] ${r.campaign_id} — DUPLICATING (${out.patch.dupe_created}/${Number(r.dupe_target) || 20})`);
            }
          }
        }
      });
    } catch (err) {
      console.error(`[campaign-creator] connection ${connectionId} failed: ${err.message}`);
    }
  }

  return json(200, { ok: true, ...tally, dupes_per_cycle: DUPES_PER_CYCLE });
}

async function patchRow(supabase, campaignId, patch) {
  try {
    await supabase.from("campaign_creator_campaigns").update(patch).eq("campaign_id", String(campaignId));
  } catch (err) {
    console.error(`[campaign-creator] patch ${campaignId} failed: ${err.message}`);
  }
}

// Refresh a campaign's derived status on its tiktok_campaigns row from a
// loadCampaignDetail result. Best-effort — the "metrics" 60s tick doesn't
// re-derive status, so this keeps a creator campaign's Detailed Metrics badge
// current while it moves through review / appeal / Active.
//
// This is also the ONLY place that observes a Campaign Creator campaign
// reaching "Active" on the automatic ~60s cycle — the full discovery `sync`
// that normally flips engagement_status to READY (see
// markEngagementReadyIfActive in _shared/tiktok-mcp.js) only runs on a manual
// "Refresh Data" click, there is no server-side cron for it. So the auto
// LIKES/SAVES trigger is wired in right here: the instant this tick sees a
// campaign go Active, it's marked READY too — same idempotent flag the
// pending-engagement worker below already treats as "add once, never again."
async function persistTiktokCampaignStatus(supabase, campaignId, detail) {
  if (!detail || !detail.effective_status) return;
  try {
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
    if (detail.effective_status === "Active") {
      await markEngagementReadyIfActive(supabase, [campaignId]);
    }
  } catch (err) {
    console.error(`[campaign-creator] status persist ${campaignId} failed: ${err.message}`);
  }
}

async function listRows(supabase) {
  const BASE =
    "campaign_id, advertiser_id, campaign_name, initial_adgroup_id, dupe_target, dupe_created, dupe_status, dupe_attempts, dupe_error, became_active_at, completed_at, created_at";
  const APPEAL =
    ", appeal_state, appeal_attempted, appeal_attempts, appeal_raw_reasons, appeal_reasons, appeal_text, appeal_ad_id, appeal_adgroup_id, appeal_submitted_at, appeal_error, appeal_updated_at";

  let { data, error } = await supabase
    .from("campaign_creator_campaigns")
    .select(BASE + APPEAL)
    .order("created_at", { ascending: false })
    .limit(200);

  // Appeal columns not migrated yet — fall back to the base columns.
  if (error && /appeal_|column .* does not exist/i.test(error.message || "")) {
    ({ data, error } = await supabase
      .from("campaign_creator_campaigns")
      .select(BASE)
      .order("created_at", { ascending: false })
      .limit(200));
  }
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, campaigns: [], unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }
  return json(200, { ok: true, campaigns: data || [] });
}

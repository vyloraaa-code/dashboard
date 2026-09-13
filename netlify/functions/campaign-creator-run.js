// POST /.netlify/functions/campaign-creator-run   { action, ... }   (Vercel: /api/campaign-creator-run)
//
//   "resources"  { connection_id, campaign_type, advertiser_ids:[...], form_ids?:[...] }
//        -> per-advertiser preflight for the runtime wizard:
//           { identities:[{Auto}], forms:[{id,name}] (Lead Gen),
//             advertisers:[{advertiser_id,advertiser_name,timezone,local_time,instant_page,notes[]}],
//             form_notes:[string], blockers:[string] }
//        Sales has no conversion-event selection — optimization_goal CONVERT +
//        optimization_event BUTTON (no pixel) are fixed and resolved automatically.
//
//   "validate_form"  { connection_id, advertiser_ids:[...], page_id }
//        -> { ok, page_id, name, checks:[{advertiser_id,advertiser_name,ok,error?}] }
//
//   "create"  { template_id?, campaign_type, config?, connection_id, advertiser_ids:[...],
//               base_name, names?:[...], spark_codes:[...], post_links:[...], form_id?,
//               schedules:{ "<IANA tz>": { date:"YYYY-MM-DD", hour, minute } }   (per tz group;
//                 legacy: schedule:{hour,minute}) }
//        -> identity is always Auto (each Spark code's own authorized identity).
//        -> campaign names: `names` (one per advertiser_id) wins when given —
//           the dashboard sends this so a batch split into several requests
//           (see js/app.js submitCampaignCreator; one request per ~6 accounts
//           to stay under the serverless function time limit) still numbers
//           continuously. Otherwise derived from base_name's own trailing
//           number, e.g. "ad136" -> ad136, ad137, ad138…
//        -> creates ONE campaign per advertiser, registers each successful one for
//           the existing duplication + auto-appeal lifecycle, stores its post URL.
//           Partial failure tolerant. -> { results:[{advertiser_id,advertiser_name,
//           campaign_name,status:'Created'|'Failed'|'Skipped',campaign_id?,error?,warnings?}] }
//
// No admin password (same posture as wh-warmup / the other tiktok-* write
// actions). All MCP calls run here; no tokens are ever returned to the browser.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  normalizeNetwork,
  json,
} = require("./_shared/tiktok-mcp");
const { registerForDuplication } = require("./_shared/campaign-creator.js");
const {
  TEMPLATE_TYPES,
  normalizeTemplateConfig,
  fmtLocal,
  resolveCardImageUrl,
  listBcForms,
  formLibraryMap,
  validateFormForAdvertisers,
  listInstantPages,
  newestInstantPage,
  createOneCampaign,
} = require("./_shared/campaign-creator-build");

const AUTO_IDENTITY = { identity_id: "__AUTO__", identity_type: "AUTO", name: "Auto — each Spark code's own identity" };

const advApproved = (a) => String(a?.status || "").toUpperCase() === "STATUS_ENABLE";
const uniq = (a) => [...new Set(a)];

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
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }
    if (body.action === "resources") return resources(supabase, body);
    if (body.action === "validate_form") return validateFormAction(supabase, body);
    if (body.action === "create") return createBatch(supabase, body);
    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

// ---------------------------------------------------------------------------

async function loadConnAndAdvertisers(supabase, connectionId, advertiserIds) {
  const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!conn) return { error: json(404, { error: "Connection not found." }) };
  const { data: advRows } = await supabase
    .from("tiktok_advertisers")
    .select("advertiser_id, advertiser_name, status, currency, timezone, display_timezone, bc_id, bc_name")
    .eq("connection_id", connectionId)
    .in("advertiser_id", advertiserIds.map(String));
  const byId = new Map((advRows || []).map((a) => [String(a.advertiser_id), a]));
  return { conn, byId };
}

// ---------------------------------------------------------------------------
// validate_form — confirm a pasted / remembered Instant Form ID is usable by the
// selected Approved accounts (page_field_get works cross-account for a form that
// is assigned to the ad accounts, even when page_get can't list it).
// ---------------------------------------------------------------------------

async function validateFormAction(supabase, body) {
  const connectionId = body.connection_id;
  const pageId = String(body.page_id || "").trim();
  const advertiserIds = uniq((body.advertiser_ids || []).map(String).filter(Boolean));
  if (!connectionId || !pageId) return json(400, { error: "connection_id and page_id are required" });
  if (!/^\d{6,25}$/.test(pageId)) return json(400, { error: "A Form ID is a long number (from the form's URL)." });
  if (!advertiserIds.length) return json(400, { error: "Select at least one account first." });

  const loaded = await loadConnAndAdvertisers(supabase, connectionId, advertiserIds);
  if (loaded.error) return loaded.error;
  const { conn, byId } = loaded;
  const approved = advertiserIds.map((id) => byId.get(id)).filter((a) => a && advApproved(a));
  if (!approved.length) return json(400, { error: "None of the selected accounts is Approved." });

  try {
    const r = await withClient(supabase, conn, (client) => validateFormForAdvertisers(client, pageId, approved));
    return json(200, r);
  } catch (err) {
    return json(200, { page_id: pageId, ok: false, name: null, checks: [], error: err.message });
  }
}

// ---------------------------------------------------------------------------
// resources — preflight
// ---------------------------------------------------------------------------

async function resources(supabase, body) {
  const connectionId = body.connection_id;
  const type = String(body.campaign_type || "").toUpperCase();
  const advertiserIds = uniq((body.advertiser_ids || []).map(String).filter(Boolean));
  // Form IDs the operator has used before (remembered client-side) — validated
  // live so they show real names and only if still usable.
  const knownFormIds = uniq((body.form_ids || []).map((s) => String(s).trim()).filter((s) => /^\d{6,25}$/.test(s))).slice(0, 12);
  if (!connectionId) return json(400, { error: "connection_id is required" });
  if (!TEMPLATE_TYPES.includes(type)) return json(400, { error: `campaign_type must be one of ${TEMPLATE_TYPES.join(", ")}` });
  if (!advertiserIds.length) return json(400, { error: "Select at least one advertiser account." });

  const loaded = await loadConnAndAdvertisers(supabase, connectionId, advertiserIds);
  if (loaded.error) return loaded.error;
  const { conn, byId } = loaded;

  const out = {
    ok: true,
    identities: [],
    forms: [],
    advertisers: [],
    blockers: [],
  };

  const deadline = Date.now() + 45000;
  let approvedSeen = 0;
  const formById = new Map(); // page_id -> { id, name, source: 'bc' | 'saved' }
  let bcFormDiag = null;

  await withClient(supabase, conn, async (client) => {
    // BC-wide Instant Forms — the "BC -> Assets -> Forms" list. Forms linked to
    // ad accounts are NOT visible via page_get(advertiser_id); they live in a
    // form library and are only listable by sweeping page_get(library_id).
    if (type === "LEAD_GENERATION") {
      // 1. Validate remembered Form IDs first — this is the reliable path
      //    (page_field_get resolves a form assigned to the accounts even when
      //    page_get can't list it).
      if (knownFormIds.length) {
        const approvedAdvs = advertiserIds
          .map((id) => byId.get(id))
          .filter((a) => a && String(a.status || "").toUpperCase() === "STATUS_ENABLE");
        for (const fid of knownFormIds) {
          if (Date.now() > deadline - 12000) break;
          try {
            const v = await validateFormForAdvertisers(client, fid, approvedAdvs, { max: 1 });
            if (v.ok && !formById.has(fid)) {
              formById.set(fid, { id: fid, name: v.name || fid, source: "saved" });
            }
          } catch (_) {
            /* skip a bad remembered id */
          }
        }
      }

      // 2. Best-effort BC-wide library sweep (works for connections whose token
      //    owns the forms; often empty otherwise — non-fatal, logged server-side).
      try {
        const { forms, diag } = await listBcForms(client, { deadlineMs: deadline - 8000, cacheKey: String(connectionId) });
        for (const f of forms) if (!formById.has(f.id)) formById.set(f.id, { id: f.id, name: f.name, source: "bc" });
        bcFormDiag = diag;
        if (diag && diag.errors && diag.errors.length) {
          console.warn(`[campaign-creator] form library scan: ${diag.libraries} libs, ${diag.withForms} with forms, ${diag.errors.length} error(s): ${diag.errors.slice(0, 3).join(" | ")}`);
        }
      } catch (err) {
        console.warn(`[campaign-creator] form library sweep failed: ${err.message}`);
      }
    }

    for (const advId of advertiserIds) {
      if (Date.now() > deadline) {
        out.blockers.push("Preflight stopped early (too many accounts) — reduce the batch or try again.");
        break;
      }
      const adv = byId.get(advId);
      const row = {
        advertiser_id: advId,
        advertiser_name: adv?.advertiser_name || advId,
        timezone: adv?.timezone || adv?.display_timezone || "America/New_York",
        local_time: null,
        instant_page: null,
        notes: [],
      };
      row.local_time = fmtLocal(new Date(), row.timezone);

      if (!adv) {
        row.notes.push("not under this Business Center");
        out.advertisers.push(row);
        continue;
      }
      if (!advApproved(adv)) {
        // Suspended accounts are shown for context but NEVER queried and NEVER
        // affect the form / identity lists.
        row.notes.push("Suspended — will be skipped");
        out.advertisers.push(row);
        continue;
      }
      approvedSeen += 1;

      // Identity is always "Auto" (each Spark code's own authorized identity) —
      // no discovery, no UI. See createBatch (identityArgConst = { auto: true }).

      if (type === "LEAD_GENERATION") {
        // Nothing per-account: forms come from the validated Form IDs + the
        // best-effort BC library sweep, both done once above.
      } else {
        // Sales: only the newest Instant Page is shown here for a sanity check —
        // optimization goal/event are fixed (CONVERT / BUTTON, no pixel) and
        // resolved automatically at creation time, never selected in the UI.
        try {
          const pages = await listInstantPages(client, advId);
          const newest = newestInstantPage(pages);
          if (newest.error) row.notes.push(`Instant Page: ${newest.error}`);
          else row.instant_page = newest.name || newest.page_id;
        } catch (err) {
          row.notes.push(`Instant Pages unavailable (${err.message})`);
        }
      }

      out.advertisers.push(row);
    }
  }).catch((err) => {
    out.blockers.push(`Preflight failed: ${err.message}`);
  });

  // Identity is always Auto — no selection.
  out.identities = [{ ...AUTO_IDENTITY }];

  if (type === "LEAD_GENERATION") {
    // Every published Lead Gen Instant Form visible to this BC (Business Center
    // forms + any account-owned ones), by page_id. The operator picks one; that
    // exact page_id is used for every campaign (the form is linked to the
    // accounts). NOT an intersection; suspended accounts never affect it.
    // NEVER a hard blocker — the operator can always paste a Form ID.
    out.forms = [...formById.values()].map((f) => ({ id: f.id, name: f.name || f.id, source: f.source }));
    out.forms.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    out.form_notes = [];
    if (approvedSeen && !out.forms.length) {
      const permissionError = (bcFormDiag?.errors || []).find((e) => /permission/i.test(e));
      if (permissionError) {
        out.form_notes.push(
          `TikTok denied access to your Business Center's form library (${permissionError.replace(/^.*?:\s*/, "")}). Paste your Instant Form ID below — it can still be validated per-account even when the library can't be listed.`
        );
      } else {
        out.form_notes.push(
          "No forms found automatically — paste your Instant Form ID below (the number in the form's URL). It's checked and remembered."
        );
      }
    }
  }

  return json(200, out);
}

// ---------------------------------------------------------------------------
// create — one campaign per advertiser
// ---------------------------------------------------------------------------

function splitLines(v) {
  return String(v || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Campaign names from a base that already carries its own starting number
// (e.g. "ad1" -> ad1, ad2, ad3…; "ad136" -> ad136, ad137, ad138…) so a batch
// can pick up exactly where a previous one left off. A base with no trailing
// digits (e.g. "ad") falls back to the original base+1, base+2… behavior.
function campaignNamesFromBase(base, count) {
  const m = /^(.*?)(\d+)$/.exec(base);
  if (m) {
    const prefix = m[1];
    const start = parseInt(m[2], 10);
    return Array.from({ length: count }, (_, i) => `${prefix}${start + i}`);
  }
  return Array.from({ length: count }, (_, i) => `${base}${i + 1}`);
}

async function createBatch(supabase, body) {
  const connectionId = body.connection_id;
  const type = String(body.campaign_type || "").toUpperCase();
  const advertiserIds = uniq((body.advertiser_ids || []).map(String).filter(Boolean));
  const base = String(body.base_name || "").trim();
  // Per-timezone schedule: { "<IANA tz>": { date:"YYYY-MM-DD", hour, minute } }.
  // Falls back to a single { hour, minute } for older callers.
  const schedules = body.schedules && typeof body.schedules === "object" ? body.schedules : null;
  const legacyHour = Number(body.schedule?.hour);
  const legacyMinute = Number(body.schedule?.minute);
  const sparkCodes = Array.isArray(body.spark_codes) ? body.spark_codes.map((s) => String(s)) : splitLines(body.spark_codes);
  const postLinks = Array.isArray(body.post_links) ? body.post_links.map((s) => String(s).trim()) : splitLines(body.post_links);
  // Identity is always Auto (each Spark code's own authorized identity). The
  // identity selection UI was removed; the payload is ignored beyond this.
  const identityArgConst = { auto: true };
  const formId = body.form_id ? String(body.form_id).trim() : "";      // BC / account form page_id (primary)
  const formName = body.form_name ? String(body.form_name).trim() : ""; // name fallback (account-owned forms)
  // Explicit per-account names (the dashboard sends these when a batch is
  // split into multiple requests, so numbering stays continuous across
  // chunks — see js/app.js submitCampaignCreator). Falls back to deriving
  // names from base_name for any other/older caller.
  const explicitNames = Array.isArray(body.names) ? body.names.map((s) => String(s).trim()) : null;
  // Sales: no conversion-event selection — optimization_goal CONVERT +
  // optimization_event BUTTON are resolved automatically (see instantPageConversion).

  // ---- static validation ----
  if (!connectionId) return json(400, { error: "connection_id is required" });
  if (!TEMPLATE_TYPES.includes(type)) return json(400, { error: `campaign_type must be one of ${TEMPLATE_TYPES.join(", ")}` });
  if (!advertiserIds.length) return json(400, { error: "Select at least one advertiser account." });
  if (!base) return json(400, { error: "Enter a campaign name base." });

  // Normalize schedules -> { tz: { date, hour, minute } }
  const schedByTz = {};
  const validClock = (h, m) => Number.isInteger(h) && h >= 0 && h <= 23 && Number.isInteger(m) && m >= 0 && m <= 59;
  if (schedules) {
    for (const [tz, s] of Object.entries(schedules)) {
      const h = Number(s?.hour);
      const m = Number(s?.minute);
      const date = String(s?.date || "").trim();
      if (!validClock(h, m)) return json(400, { error: `Pick a valid time for ${tz}.` });
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: `Pick a valid date for ${tz}.` });
      schedByTz[tz] = { date: date || null, hour: h, minute: m };
    }
  }
  if (!Object.keys(schedByTz).length) {
    if (!validClock(legacyHour, legacyMinute)) return json(400, { error: "Pick a valid schedule time." });
    schedByTz.__default__ = { date: null, hour: legacyHour, minute: legacyMinute };
  }

  if (explicitNames && explicitNames.length !== advertiserIds.length) {
    return json(400, { error: `names (${explicitNames.length}) must match selected accounts (${advertiserIds.length}).` });
  }
  if (sparkCodes.length !== advertiserIds.length) {
    return json(400, { error: `Spark codes (${sparkCodes.length}) must match selected accounts (${advertiserIds.length}).` });
  }
  if (postLinks.length !== advertiserIds.length) {
    return json(400, { error: `Post links (${postLinks.length}) must match selected accounts (${advertiserIds.length}).` });
  }
  for (const l of postLinks) {
    let u;
    try {
      u = new URL(l);
    } catch (_) {
      return json(400, { error: `Not a valid TikTok post URL: "${l.slice(0, 60)}"` });
    }
    if (u.protocol !== "https:" || !/(^|\.)tiktok\.com$/i.test(u.hostname)) {
      return json(400, { error: `Post links must be https tiktok.com URLs: "${l.slice(0, 60)}"` });
    }
  }
  if (type === "LEAD_GENERATION" && !formId && !formName) return json(400, { error: "Select an Instant Form (or paste a Form ID)." });

  // ---- template config ----
  let config, campaignType;
  if (body.template_id) {
    const { data: tpl, error } = await supabase
      .from("campaign_creator_templates")
      .select("campaign_type, config")
      .eq("id", String(body.template_id))
      .maybeSingle();
    if (error || !tpl) return json(404, { error: "Template not found." });
    campaignType = String(tpl.campaign_type).toUpperCase();
    ({ config } = normalizeTemplateConfig(tpl.config || {}));
  } else {
    campaignType = type;
    const n = normalizeTemplateConfig(body.config || {});
    if (n.errors.length) return json(400, { error: n.errors[0] });
    config = n.config;
  }
  if (campaignType !== type) return json(400, { error: "Template type does not match the selected campaign type." });

  const loaded = await loadConnAndAdvertisers(supabase, connectionId, advertiserIds);
  if (loaded.error) return loaded.error;
  const { conn, byId } = loaded;
  const network = normalizeNetwork(conn.affiliate_network);

  // Campaign names — explicit list when provided (chunked batches), otherwise
  // derived from base_name's own trailing number (see campaignNamesFromBase).
  const names = explicitNames || campaignNamesFromBase(base, advertiserIds.length);
  for (const nm of names) {
    if (nm.length > 512) return json(400, { error: `Campaign name too long: "${nm}"` });
  }

  // Interactive card image -> one clean public URL for the whole batch.
  let cardImageUrl = null;
  if (config.interactive_card?.enabled && config.interactive_card.image_url) {
    try {
      const r = await resolveCardImageUrl(config.interactive_card.image_url, { supabase });
      cardImageUrl = r.url;
    } catch (err) {
      return json(400, { error: `Interactive Card image: ${err.message}` });
    }
  }

  const results = [];
  const deadline = Date.now() + 52000;

  // Pick the schedule for an advertiser from its own timezone group.
  const schedFor = (adv) => {
    const tz = adv?.timezone || adv?.display_timezone || "America/New_York";
    return schedByTz[tz] || schedByTz.__default__ || Object.values(schedByTz)[0];
  };

  await withClient(supabase, conn, async (client) => {
    // The BC form-library map is only needed when the form was picked by NAME
    // (no page_id) — a rare fallback. An explicit form_id is used verbatim.
    const needLibMap = type === "LEAD_GENERATION" && !formId && !!formName;
    const libMap = needLibMap ? await formLibraryMap(client) : new Map();

    for (let i = 0; i < advertiserIds.length; i++) {
      const advId = advertiserIds[i];
      const adv = byId.get(advId);
      const name = names[i];
      const advName = adv?.advertiser_name || advId;

      if (Date.now() > deadline) {
        results.push({ advertiser_id: advId, advertiser_name: advName, campaign_name: name, status: "Skipped", error: "This request ran out of time — the dashboard should have sent it in a smaller batch; retry to create the rest." });
        continue;
      }
      if (!adv) {
        results.push({ advertiser_id: advId, advertiser_name: advName, campaign_name: name, status: "Failed", error: "Account is not under this Business Center." });
        continue;
      }
      if (!advApproved(adv)) {
        results.push({ advertiser_id: advId, advertiser_name: advName, campaign_name: name, status: "Skipped", error: "Account is Suspended." });
        continue;
      }

      const bcId = adv.bc_id || conn.bc_id || null;
      const sched = schedFor(adv);
      try {
        const created = await createOneCampaign({
          client,
          supabase,
          advertiser: adv,
          connectionId,
          bcId,
          type,
          config,
          campaignName: name,
          scheduleHour: sched.hour,
          scheduleMinute: sched.minute,
          scheduleDate: sched.date || null,
          sparkCode: sparkCodes[i],
          postUrl: postLinks[i],
          identity: identityArgConst,
          form: type === "LEAD_GENERATION" ? { id: formId || null, name: formName || null } : null,
          libraryId: libMap.get(advId) || null,
          cardImageUrl,
        });

        // Store a minimal Detailed-Metrics row NOW carrying the post URL, so the
        // existing engagement / Add-comments flow can use it before the next
        // discovery sync. A re-sync preserves tiktok_post_url (engagement cols
        // are never overwritten by discoverAndStoreCampaigns).
        await upsertCampaignRow(supabase, {
          campaign_id: created.campaign_id,
          connection_id: connectionId,
          advertiser_id: advId,
          advertiser_name: advName,
          bc_id: bcId,
          bc_name: adv.bc_name || conn.bc_name || null,
          affiliate_network: network,
          campaign_name: name,
          objective_type: type === "SALES" ? "WEB_CONVERSIONS" : "LEAD_GENERATION",
          budget: config.daily_budget,
          budget_mode: "BUDGET_MODE_DAY",
          tiktok_post_url: created.post_url,
        });

        // Enroll into the existing duplication + auto-appeal lifecycle.
        const reg = await registerForDuplication(supabase, {
          campaign_id: created.campaign_id,
          advertiser_id: advId,
          connection_id: connectionId,
          bc_id: bcId,
          campaign_name: name,
          initial_adgroup_id: created.adgroup_id,
          initial_ad_id: created.ad_id,
          adgroup_payload: created.adgroup_payload,
          ad_payload: created.ad_payload,
          dupe_target: 20,
        });

        const warnings = [...(created.warnings || [])];
        if (reg.error) warnings.push(`Created, but NOT enrolled for auto-duplication: ${reg.error}`);

        results.push({
          advertiser_id: advId,
          advertiser_name: advName,
          campaign_name: name,
          status: "Created",
          campaign_id: created.campaign_id,
          instant_page_name: created.instant_page_name || null,
          instant_form_id: created.instant_form_id || null,
          identity_used: created.identity_used || null,
          schedule_local: created.schedule_local,
          schedule_tz: created.schedule_tz,
          warnings: warnings.length ? warnings : undefined,
        });
      } catch (err) {
        console.error(`[campaign-creator-run] ${advId} failed: ${err.message}`);
        results.push({
          advertiser_id: advId,
          advertiser_name: advName,
          campaign_name: name,
          status: "Failed",
          error: err.message,
        });
      }
    }
  }).catch((err) => {
    for (let i = 0; i < advertiserIds.length; i++) {
      if (!results.some((r) => r.advertiser_id === advertiserIds[i])) {
        results.push({
          advertiser_id: advertiserIds[i],
          advertiser_name: byId.get(advertiserIds[i])?.advertiser_name || advertiserIds[i],
          campaign_name: names[i],
          status: "Failed",
          error: err.message,
        });
      }
    }
  });

  const createdCount = results.filter((r) => r.status === "Created").length;
  return json(200, { ok: true, created: createdCount, total: advertiserIds.length, results });
}

// Upsert a tiktok_campaigns row, degrading gracefully when optional columns
// (bc_*, affiliate_network, tiktok_post_url, engagement_added_at) aren't migrated.
async function upsertCampaignRow(supabase, r) {
  const now = new Date().toISOString();
  const full = {
    campaign_id: String(r.campaign_id),
    connection_id: r.connection_id,
    advertiser_id: String(r.advertiser_id),
    advertiser_name: r.advertiser_name || null,
    campaign_name: r.campaign_name,
    objective_type: r.objective_type || null,
    budget: r.budget != null ? Number(r.budget) : null,
    budget_mode: r.budget_mode || null,
    campaign_operation_status: "ENABLE",
    campaign_secondary_status: null,
    effective_status: "In Review",
    effective_tone: "warn",
    status_detail: "Campaign just created — awaiting TikTok review",
    ad_count: 1,
    active_ad_count: 0,
    create_time: now,
    updated_at: now,
    bc_id: r.bc_id || null,
    bc_name: r.bc_name || null,
    affiliate_network: r.affiliate_network || "GLITCHY",
    tiktok_post_url: r.tiktok_post_url || null,
    engagement_added_at: r.tiktok_post_url ? now : null,
  };
  let { error } = await supabase.from("tiktok_campaigns").upsert(full, { onConflict: "campaign_id" });
  if (error && /bc_(id|name)|affiliate_network|tiktok_post_url|engagement_added_at/.test(error.message || "")) {
    const { bc_id, bc_name, affiliate_network, tiktok_post_url, engagement_added_at, ...bare } = full;
    ({ error } = await supabase.from("tiktok_campaigns").upsert(bare, { onConflict: "campaign_id" }));
  }
  if (error) console.error(`[campaign-creator-run] tiktok_campaigns upsert failed for ${r.campaign_id}: ${error.message}`);
}

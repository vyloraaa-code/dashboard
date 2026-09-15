// Automatic TikTok ad-rejection appeals.
//
// Scope: Campaign Creator campaigns ONLY (rows in campaign_creator_campaigns),
// during their initial review lifecycle (dupe_status WAITING_FOR_ACTIVE). Driven
// by the existing ~60s campaign-creator.js "process_duplication" cycle — no new
// polling system. WH Warmup campaigns are a separate table and are never
// registered here, so they can never be auto-appealed.
//
// Lifecycle (appeal_state on the row):
//   NONE -> REJECTED -> APPEAL_SUBMITTING -> APPEAL_UNDER_REVIEW -> APPEAL_APPROVED
//                                                               \-> APPEAL_REJECTED
//   REJECTED -> UNSUPPORTED   (rejected for a reason we have no template for)
//
// CRITICAL: a rejection is auto-appealed AT MOST ONCE. `appeal_attempted` is a
// one-way latch set only after adgroup_appeal succeeds; once true no second
// automatic appeal is ever sent. A technical MCP/HTTP failure keeps the row in
// REJECTED (retried up to APPEAL_TECH_RETRY_CAP) and never marks it
// APPEAL_REJECTED — only TikTok's own decision does that.

const { mcpCall, loadCampaignDetail } = require("./tiktok-mcp");

const APPEAL_TECH_RETRY_CAP = 4; // consecutive technical failures of adgroup_appeal before giving up
const GIVE_UP_AFTER_MS = 3 * 24 * 3600 * 1000; // never appeal a row older than the duplication give-up

// ---------------------------------------------------------------------------
// Appeal-text construction
// ---------------------------------------------------------------------------

const COMMON_INTRO =
  "Hi my ad was wrongly disapproved, I follow all guidelines and TOS and make sure all content is compliant with TikTok and safe for the platform, please fix this.";
const COMMON_ENDING = "This ad follows all the TOS.";

// canonical reason id -> its unique middle section (null => intro + ending only)
const REASON_MIDDLE = {
  sensitive_personal_information: "My ad doesn't request any sensitive personal information.",
  adult_content_services:
    "My ads don't promote any adult content or services. The images, hooks, and audio used in this ad follows all TikTok TOS.",
  financial_misrepresentation:
    "My ads dont make any financial misrepresentation. The method implied is clearly explained in the website. The images, hooks, and audio used in this ad follows all TikTok TOS. It is just written in a tiktok-style slang so users resonate to it. Nothing wrong or deceptive has been promoted.",
  misleading_opportunities:
    "My ad doesnt make any misleading opportunity. The method implied is clearly explained in the website. The images, hooks, and audio used in this ad follows all TikTok TOS. It is just written in a tiktok-style slang so users resonate to it. Nothing wrong or deceptive has been promoted.",
  gambling_and_games: null,
};

// Deterministic ordering — the canonical numbered list from the spec.
const REASON_ORDER = [
  "sensitive_personal_information",
  "adult_content_services",
  "financial_misrepresentation",
  "misleading_opportunities",
  "gambling_and_games",
];

// Build ONE clean appeal string: common intro once, each matched reason's unique
// middle at most once in canonical order, common ending once. No double spaces.
function buildAppealText(categories) {
  const set = new Set(categories || []);
  const parts = [COMMON_INTRO];
  for (const id of REASON_ORDER) {
    if (set.has(id) && REASON_MIDDLE[id]) parts.push(REASON_MIDDLE[id]);
  }
  parts.push(COMMON_ENDING);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Reason normalization — conservative. A wrong match sends the wrong appeal, so
// we require the distinctive phrase and tolerate only casing / punctuation /
// singular-plural. Anything else is "unknown" and blocks the auto appeal.
// ---------------------------------------------------------------------------

function matchReason(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;

  // NOTE: TikTok's ad_review_info_get / adgroup_review_info_get reject_info
  // does NOT include the short category headline shown in Ads Manager (e.g.
  // "Misleading Opportunities") — only a longer boilerplate policy
  // explanation. Verified live 2026-09-07 (ad2, 3 reject_info entries):
  //   "...may violate TikTok's Advertising Policies by featuring or
  //     promoting adult products or services. This could include products or
  //     services such as pornographic material or media, pornographic or
  //     sexual services, sexual products such as sex toys, sex accessories
  //     or sexual performance products..."          -> adult_content_services
  //   "...may violate TikTok's advertising policies by promoting misleading
  //     employment or money-making opportunities. This could include
  //     unclear descriptions of the job or opportunity being promoted,
  //     misleading language on qualification requirements, or instructions
  //     for users to communicate off-platform."      -> misleading_opportunities
  //   "...may violate TikTok's advertising policies by promoting prohibited
  //     products or services in the targeted locations. For more policy
  //     details, please refer to 'TikTok Advertising Policies - Industry
  //     Entry'..."                                   -> gambling_and_games
  //     (TikTok's generic "Industry Entry" wrapper text for a
  //     location-restricted industry; matched to gambling_and_games because
  //     that's the one category whose appeal text (REASON_MIDDLE) has no
  //     specific claim to rebut — so even if this generic wrapper is
  //     occasionally used for a different restricted industry, the appeal
  //     text sent never asserts anything false.)
  // Each pattern below is keyword-based (not one exact contiguous phrase)
  // specifically so minor wording variants from TikTok don't silently fall
  // back to UNSUPPORTED the way one earlier attempt already did.

  if (/sensitive personal information/.test(s)) return "sensitive_personal_information";
  if (/personal information/.test(s) && /(photo|post|image|sensitive|collect|request)/.test(s))
    return "sensitive_personal_information";

  if (/adult (products?|content) (or|and) services/.test(s)) return "adult_content_services";
  if (/adult content/.test(s) || /adult services?/.test(s)) return "adult_content_services";
  if (/pornographic|sex toys?|sex accessories|sexual (product|service|performance|material)/.test(s))
    return "adult_content_services";
  if (/dating (app|application|platform)/.test(s) && /(promot|service)/.test(s)) return "adult_content_services";

  if (/financial misrepresentation/.test(s)) return "financial_misrepresentation";
  if (/misrepresent/.test(s) && /(financ|invest|earn|income)/.test(s)) return "financial_misrepresentation";

  if (/misleading opportunit(y|ies)/.test(s)) return "misleading_opportunities";
  if (/misleading employment/.test(s) || /money making opportunit(y|ies)/.test(s)) return "misleading_opportunities";
  if (/(unclear|misleading).{0,40}(opportunit|job|employment|earnings?|qualification)/.test(s))
    return "misleading_opportunities";

  if (/gambling and games/.test(s) || /\bgambling\b/.test(s)) return "gambling_and_games";
  if (/pay to play games?/.test(s) && /(prize|reward|real world value)/.test(s)) return "gambling_and_games";
  if (/prohibited products or services in the targeted locations/.test(s) && /industry entry/.test(s))
    return "gambling_and_games";

  return null;
}

// raw reason strings -> { categories: [canonical ids], unknown: [raw strings] }
// deduped; categories in canonical order.
function classifyReasons(rawReasons) {
  const seen = new Set();
  const categories = [];
  const unknown = [];
  const unknownSeen = new Set();
  for (const raw of rawReasons || []) {
    const id = matchReason(raw);
    if (id) {
      if (!seen.has(id)) {
        seen.add(id);
        categories.push(id);
      }
    } else {
      const key = String(raw || "").trim().toLowerCase();
      if (key && !unknownSeen.has(key)) {
        unknownSeen.add(key);
        unknown.push(String(raw).trim());
      }
    }
  }
  categories.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
  return { categories, unknown };
}

// Display titles matching TikTok Ads Manager's own "Rejected content" panel
// headers exactly where confirmed live (misleading_opportunities,
// gambling_and_games, adult_content_services — checked against a real
// rejected ad's Ads Manager view 2026-09-08); the other two are our best
// match to TikTok's naming convention, unconfirmed against a live example.
const REASON_TITLES = {
  sensitive_personal_information: "Sensitive Personal Information",
  adult_content_services: "Promotion of Adult Products/Services",
  financial_misrepresentation: "Financial Misrepresentation",
  misleading_opportunities: "Misleading Opportunities",
  gambling_and_games: "Gambling and games",
};

// Group raw reason strings by category for DISPLAY (not appeal decisions —
// classifyReasons above is still what gates whether an auto-appeal is sent).
// TikTok's ad_review_info_get / adgroup_review_info_get only ever return a
// generic, category-level boilerplate paragraph in reject_info — never the
// more specific, ad-tailored wording TikTok's Ads Manager UI shows in its
// "Rejection details" panel (confirmed live 2026-09-08: an ad's Ads Manager
// panel showed ad-specific detail like an exact dollar figure and a
// description of the ad's own claims, while ad_review_info_get for that same
// ad returned only the generic per-category paragraph documented above in
// matchReason). That richer per-ad text is generated by TikTok's internal
// review tooling and is not exposed by the public Business API — this
// grouping surfaces the best (and only) text available via the API, paired
// with the same category title TikTok's own UI uses.
function groupReasonsByCategory(rawReasons) {
  const byId = new Map();
  const unknownTexts = [];
  const unknownSeen = new Set();
  for (const raw of rawReasons || []) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const id = matchReason(text);
    if (id) {
      if (!byId.has(id)) byId.set(id, { id, title: REASON_TITLES[id] || id, texts: [] });
      const bucket = byId.get(id);
      if (!bucket.texts.includes(text)) bucket.texts.push(text);
    } else {
      const key = text.toLowerCase();
      if (!unknownSeen.has(key)) {
        unknownSeen.add(key);
        unknownTexts.push(text);
      }
    }
  }
  const groups = REASON_ORDER.filter((id) => byId.has(id)).map((id) => byId.get(id));
  return { groups, unknownTexts };
}

// ---------------------------------------------------------------------------
// MCP reads — ad-level rejection info is the source of truth
// ---------------------------------------------------------------------------

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

// Extract human rejection strings from one ad/review_info list item. `reject_info`
// is an object[] in v1.3 (was a single object in v1.2); shapes vary, so probe
// the common text keys and any nested reason lists.
function rejectStringsFromAdItem(item) {
  const out = [];
  for (const r of asArray(item && item.reject_info)) {
    if (typeof r === "string") {
      out.push(r);
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const t =
      r.reject_reason || r.reason || r.message || r.reject_reason_text || r.desc || r.reject_description;
    if (t) out.push(String(t));
    for (const sub of asArray(r.reject_reasons || r.reasons || r.sub_reasons)) {
      if (typeof sub === "string") out.push(sub);
      else if (sub && (sub.reason || sub.reject_reason)) out.push(String(sub.reason || sub.reject_reason));
    }
  }
  return out;
}

// -> { review: object|null, adReviewMap: object|null, error: string|null }.
//
// VERIFIED LIVE against the real API (2026-09-07): `ad_review_map` (per-ad
// review, including each ad's own reject_info when rejected) is a TOP-LEVEL
// SIBLING of `ad_group_review_map` in the response, keyed by adgroup_id — it
// is NOT nested inside the ad_group_review_map entry. An earlier version of
// this code assumed the nested shape and silently found nothing for every
// rejected campaign because of it. Real sample for an (approved) ad group:
//   { ad_group_review_map: { "<agId>": { is_approved, review_status,
//       appeal_status, contains_rejected_ads, forbidden_placements, ... } },
//     ad_review_map: { "<agId>": { "<adId>": { is_approved, review_status,
//       forbidden_placements, ... } } } }
// Errors are surfaced (not swallowed) so a persistent
// adgroup_review_info_get failure shows up in appeal_error instead of
// silently looking like "TikTok never gave a reason."
async function fetchInitialAdgroupReview(client, advertiserId, adgroupId) {
  try {
    const r = await mcpCall(client, "adgroup_review_info_get", {
      advertiser_id: String(advertiserId),
      adgroup_ids: [String(adgroupId)],
    });
    const review = (r && r.ad_group_review_map && r.ad_group_review_map[String(adgroupId)]) || null;
    const adReviewMap = (r && r.ad_review_map && r.ad_review_map[String(adgroupId)]) || null;
    return { review, adReviewMap, error: null };
  } catch (err) {
    return { review: null, adReviewMap: null, error: err.message };
  }
}

// Ad-group-level rejection reasons — the last-resort source when the ad-level
// read (fetchAdLevelReasons) comes back empty. Scans both the ad-group's own
// review object and every per-ad entry in its (correctly top-level) review
// map, with the same broad key-probing as the ad-level extractor rather than
// assuming one exact field name for the reason text.
function rejectStringsFromAdgroupReview(review, adReviewMap) {
  const out = [];
  if (review) out.push(...rejectStringsFromAdItem(review));
  for (const adReview of Object.values(adReviewMap || {})) {
    out.push(...rejectStringsFromAdItem(adReview));
  }
  return out;
}

// Real ad ids for the campaign's initial ad group. Prefer the id we recorded at
// creation, then ad_get, then the per-ad review map as a last resort.
async function resolveInitialAdIds(client, advertiserId, adgroupId, knownAdId, adReviewMap) {
  const ids = new Set();
  if (knownAdId) ids.add(String(knownAdId));
  if (!ids.size) {
    try {
      const g = await mcpCall(client, "ad_get", {
        advertiser_id: String(advertiserId),
        filtering: { adgroup_ids: [String(adgroupId)] },
        fields: ["ad_id", "operation_status", "secondary_status"],
        page_size: 100,
      });
      for (const a of (g && g.list) || []) if (a && a.ad_id) ids.add(String(a.ad_id));
    } catch (_) {
      /* fall through to the review map */
    }
  }
  if (!ids.size) {
    for (const k of Object.keys(adReviewMap || {})) ids.add(String(k));
  }
  return [...ids];
}

// Ad-level rejection reasons for the initial ad group.
// -> { raw: [strings], rejectedAdIds: [ids], error: string|null }
async function fetchAdLevelReasons(client, advertiserId, adIds) {
  if (!adIds.length) return { raw: [], rejectedAdIds: [], error: null };
  let list;
  try {
    const ri = await mcpCall(client, "ad_review_info_get", {
      advertiser_id: String(advertiserId),
      ad_ids: adIds.slice(0, 100),
    });
    list = (ri && ri.list) || [];
  } catch (err) {
    return { raw: [], rejectedAdIds: [], error: err.message };
  }
  const raw = [];
  const rejectedAdIds = [];
  for (const item of list) {
    if (!item || item.is_approved === true) continue;
    const strings = rejectStringsFromAdItem(item);
    if (strings.length) {
      raw.push(...strings);
      if (item.ad_id) rejectedAdIds.push(String(item.ad_id));
    } else if (item.is_approved === false && item.ad_id) {
      rejectedAdIds.push(String(item.ad_id));
    }
  }
  return { raw, rejectedAdIds, error: null };
}

// ---------------------------------------------------------------------------
// Appeal-status interpretation
// ---------------------------------------------------------------------------

function appealStatusApproved(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return false;
  return /(APPROVE|APPROVED|PASS|PASSED|SUCCEED|SUCCESS)/.test(s) && !/(NOT|UN|NO_)/.test(s);
}
function appealStatusRejected(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return false;
  return /(REJECT|FAIL|DENY|DENIED|DECLIN|NOT_APPROVE|NOT_PASS)/.test(s);
}
function appealStatusIsSomeAppeal(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return false;
  return !/(NO_APPEAL|NOT_APPEALED|NONE|NOT_APPEAL)/.test(s);
}

// ---------------------------------------------------------------------------
// Orchestrator — called once per WAITING_FOR_ACTIVE row per ~60s cycle.
//
// Returns { blockDuplication, detail, appealState }:
//   blockDuplication true  -> caller must NOT run the 20x duplication this tick
//                             (rejected / appeal under review / appeal rejected)
//   detail                 -> the loadCampaignDetail result (reused by the
//                             caller for status persistence + duplicateForRow)
//   appealState             -> the row's CURRENT appeal_state as of the end of
//                             this call — i.e. reflecting whatever this very
//                             call just wrote, not the value it started with.
//                             The caller needs this (not row.appeal_state,
//                             which is stale the instant this function writes
//                             a new value) to overlay the right label onto
//                             `detail` before persisting/returning it — see
//                             applyAppealOverlay in _shared/tiktok-mcp.js.
// ---------------------------------------------------------------------------

async function handleAutoAppeal({ supabase, client, row, advertiserStatus }) {
  const advId = String(row.advertiser_id);
  const campaignId = String(row.campaign_id);
  const adgroupId = String(row.initial_adgroup_id || "");
  const state = row.appeal_state || "NONE";
  let currentState = state; // tracks whatever `persist` below most recently wrote
  const now = () => new Date().toISOString();
  const log = (msg) => console.log(`[appeals] ${campaignId} — ${msg}`);
  const persist = (patch) => {
    if (patch.appeal_state) currentState = patch.appeal_state;
    return patchAppeal(supabase, campaignId, { ...patch, appeal_updated_at: now() });
  };

  // Terminal appeal states — no more MCP work, just tell the caller whether to
  // hold duplication.
  if (state === "APPEAL_APPROVED") return { blockDuplication: false, detail: null, appealState: state };
  if (state === "APPEAL_REJECTED") return { blockDuplication: true, detail: null, appealState: state };
  if (state === "UNSUPPORTED") return { blockDuplication: true, detail: null, appealState: state };
  if (!adgroupId) return { blockDuplication: false, detail: null, appealState: state };

  // Current live state of the campaign / initial ad group.
  let detail;
  try {
    detail = await loadCampaignDetail({
      client,
      advertiserId: advId,
      advertiserStatus,
      campaignId,
      timezone: null,
    });
  } catch (_) {
    return { blockDuplication: false, detail: null, appealState: state }; // let duplicateForRow surface it
  }
  const ag = (detail.adGroups || []).find((g) => String(g.adgroup_id) === adgroupId);
  const label = String((ag ? ag.status_label : detail.effective_status) || "").toLowerCase();

  // ---- recovered / approved ----
  if (label === "active") {
    if (state === "APPEAL_UNDER_REVIEW" || state === "APPEAL_SUBMITTING") {
      await persist({ appeal_state: "APPEAL_APPROVED" });
      log("appeal approved / campaign active");
    }
    return { blockDuplication: false, detail, appealState: currentState };
  }

  // ---- advertiser suspended / punished — not an appeal case ----
  if (label.includes("suspend") || label.includes("punish") || label.includes("account")) {
    return { blockDuplication: false, detail, appealState: currentState };
  }

  // ---- an appeal is already in flight: poll TikTok's decision ----
  if (state === "APPEAL_UNDER_REVIEW" || state === "APPEAL_SUBMITTING") {
    const { review } = await fetchInitialAdgroupReview(client, advId, adgroupId);
    const appealStatus = (review && review.appeal_status) || "";
    if (appealStatusApproved(appealStatus)) {
      await persist({ appeal_state: "APPEAL_APPROVED" });
      log(`appeal approved (appeal_status=${appealStatus})`);
      return { blockDuplication: false, detail, appealState: currentState };
    }
    if (appealStatusRejected(appealStatus)) {
      await persist({ appeal_state: "APPEAL_REJECTED" });
      log(`appeal rejected by TikTok (appeal_status=${appealStatus})`);
      return { blockDuplication: true, detail, appealState: currentState };
    }
    // TikTok doesn't always leave an explicit "rejected" marker on
    // appeal_status once a decision is made — it can just clear it back to
    // "no active appeal" (e.g. "NOT_APPEALED"/"NO_APPEAL"/empty), which
    // wouldn't match appealStatusRejected above. If there's no appeal in
    // flight anymore per TikTok but the ad group (checked seconds ago, same
    // detail this tick derived) is genuinely back to Rejected — not approved
    // (that already returned above), not still in review — the appeal must
    // have concluded against us. Without this, the row is stuck reporting
    // "Appeal Under Review" at the campaign level forever even though the ad
    // group itself has already flipped back to Rejected.
    if (!appealStatusIsSomeAppeal(appealStatus) && label === "rejected") {
      await persist({ appeal_state: "APPEAL_REJECTED" });
      log(`appeal concluded rejected — ad group back to Rejected with no active appeal (appeal_status=${appealStatus || "empty"})`);
      return { blockDuplication: true, detail, appealState: currentState };
    }
    return { blockDuplication: true, detail, appealState: currentState }; // still pending
  }

  // ---- state is NONE or REJECTED ----
  const rejectedNow = label === "rejected" || detail.effective_status === "Rejected";
  if (!rejectedNow) {
    return { blockDuplication: true, detail, appealState: currentState }; // pending / in review — wait, don't appeal
  }

  // Hard idempotency latch — one successful automatic appeal per lifecycle, ever.
  if (row.appeal_attempted) return { blockDuplication: true, detail, appealState: currentState };

  // Belt for the duplication processor's 3-day give-up: never appeal an old row.
  if (row.created_at && Date.now() - Date.parse(row.created_at) > GIVE_UP_AFTER_MS) {
    return { blockDuplication: true, detail, appealState: currentState };
  }

  // Technical-retry cap already hit — stay Rejected, stop calling adgroup_appeal.
  if (Number(row.appeal_attempts || 0) >= APPEAL_TECH_RETRY_CAP) {
    return { blockDuplication: true, detail, appealState: currentState };
  }

  // ---- fetch AD-LEVEL rejection reasons (source of truth) ----
  const { review, adReviewMap, error: reviewError } = await fetchInitialAdgroupReview(client, advId, adgroupId);
  const adIds = await resolveInitialAdIds(client, advId, adgroupId, row.initial_ad_id, adReviewMap);
  const adLevel = await fetchAdLevelReasons(client, advId, adIds);
  log(`ad review info fetched — adIds=${adIds.length} rawReasons=${adLevel.raw.length} reviewError=${reviewError || "-"}`);

  let rawReasons = adLevel.raw.slice();
  let source = "ad";
  if (!rawReasons.length) {
    // Last resort — ad-group-level reject_info. Real rejections like "Gambling
    // and Games" / "Misleading Opportunities" are often a policy/industry call
    // on the ad group as a whole (landing page, business model) rather than a
    // per-creative rejection, so the ad itself can come back is_approved=true
    // while the ad group is still genuinely Rejected — this is the normal path
    // for that case, not a fallback for a broken read.
    const adgroupReasons = rejectStringsFromAdgroupReview(review, adReviewMap);
    if (adgroupReasons.length) {
      rawReasons = adgroupReasons;
      source = "adgroup";
    }
  }
  rawReasons = [...new Set(rawReasons.map((s) => String(s).trim()).filter(Boolean))];

  if (!rawReasons.length) {
    // No ad rejection information obtained — never appeal on campaign status
    // alone. The raw shapes go into BOTH the function log and appeal_error
    // (truncated) so this is diagnosable straight from Supabase if this still
    // doesn't know how to read whatever TikTok actually sent back.
    const reason = adLevel.error
      ? `ad_review_info_get failed: ${adLevel.error}`
      : reviewError
      ? `adgroup_review_info_get failed: ${reviewError}`
      : "No ad-level rejection reason returned yet";
    const rawDump = `review=${JSON.stringify(review)} adReviewMap=${JSON.stringify(adReviewMap)}`;
    log(`rejection detected but NO ad-level reason available yet (${reason}) — not appealing. raw ${rawDump}`.slice(0, 2000));
    await persist({
      appeal_state: "REJECTED",
      appeal_adgroup_id: adgroupId,
      appeal_error: `${reason} | raw ${rawDump}`.slice(0, 1500),
    });
    return { blockDuplication: true, detail, appealState: currentState };
  }

  const { categories, unknown } = classifyReasons(rawReasons);
  const { groups: reasonGroups } = groupReasonsByCategory(rawReasons);
  log(
    `rejection detected — raw=${JSON.stringify(rawReasons)} ` +
      `normalized=${JSON.stringify(categories)} source=${source}`
  );

  const appealAdId =
    (adLevel.rejectedAdIds && adLevel.rejectedAdIds[0]) ||
    (row.initial_ad_id ? String(row.initial_ad_id) : null) ||
    adIds[0] ||
    null;

  // Unknown reason (or a mix where some are unknown) — conservative: do NOT
  // auto-appeal; record it so a template can be added later.
  if (unknown.length || !categories.length) {
    log(
      `unsupported rejection reason(s): ${JSON.stringify(unknown.length ? unknown : rawReasons)} ` +
        `— leaving rejected, NOT appealing`
    );
    await persist({
      appeal_state: "UNSUPPORTED",
      appeal_raw_reasons: rawReasons,
      appeal_reasons: reasonGroups,
      appeal_adgroup_id: adgroupId,
      appeal_ad_id: appealAdId,
      appeal_error: `Unsupported rejection reason: ${(unknown.length ? unknown : rawReasons).join(" | ")}`,
    });
    return { blockDuplication: true, detail, appealState: currentState };
  }

  // ---- claim the appeal (idempotent) then submit exactly ONE ----
  // Conditional UPDATE: succeeds for at most one concurrent invocation and only
  // while appeal_attempted is still false. A row wedged in APPEAL_SUBMITTING by a
  // crash is recovered by isStaleSubmitting() in the caller (reset to REJECTED).
  const claim = await supabase
    .from("campaign_creator_campaigns")
    .update({ appeal_state: "APPEAL_SUBMITTING", appeal_updated_at: now() })
    .eq("campaign_id", campaignId)
    .eq("appeal_attempted", false)
    .neq("appeal_state", "APPEAL_SUBMITTING")
    .select("campaign_id");
  if (claim.error || !(claim.data && claim.data.length)) {
    return { blockDuplication: true, detail, appealState: currentState }; // another invocation owns it this tick
  }
  currentState = "APPEAL_SUBMITTING";

  const appealText = buildAppealText(categories);
  await persist({
    appeal_raw_reasons: rawReasons,
    appeal_reasons: reasonGroups,
    appeal_text: appealText,
    appeal_adgroup_id: adgroupId,
    appeal_ad_id: appealAdId,
  });
  log(`appeal submission started — ad_id=${appealAdId || "-"} text="${appealText}"`);

  const appealArgs = { advertiser_id: advId, adgroup_id: adgroupId, appeal_reason: appealText };
  if (appealAdId) appealArgs.ad_id = appealAdId;

  try {
    await mcpCall(client, "adgroup_appeal", appealArgs);
  } catch (err) {
    // Did the appeal actually land despite the error (e.g. "already appealed")?
    const { review: after } = await fetchInitialAdgroupReview(client, advId, adgroupId);
    const as = (after && after.appeal_status) || "";
    if (appealStatusIsSomeAppeal(as)) {
      await persist({
        appeal_attempted: true,
        appeal_state: appealStatusRejected(as) ? "APPEAL_REJECTED" : "APPEAL_UNDER_REVIEW",
        appeal_submitted_at: now(),
        appeal_error: null,
      });
      log(`adgroup_appeal errored but appeal_status=${as} — treating as submitted`);
      return { blockDuplication: true, detail, appealState: currentState };
    }
    // Genuine technical failure — DO NOT mark Appeal Rejected. Retry next tick.
    const attempts = Number(row.appeal_attempts || 0) + 1;
    await persist({
      appeal_state: "REJECTED",
      appeal_attempts: attempts,
      appeal_error: `Appeal request failed (attempt ${attempts}/${APPEAL_TECH_RETRY_CAP}): ${err.message}`,
    });
    log(`appeal technical failure (attempt ${attempts}/${APPEAL_TECH_RETRY_CAP}): ${err.message}`);
    return { blockDuplication: true, detail, appealState: currentState };
  }

  await persist({
    appeal_attempted: true,
    appeal_state: "APPEAL_UNDER_REVIEW",
    appeal_submitted_at: now(),
    appeal_error: null,
  });
  log("appeal accepted / submitted — now Appeal Under Review");
  return { blockDuplication: true, detail, appealState: currentState };
}

// Best-effort persist. A missing column just means the migration
// (supabase/campaign_creator_appeals.sql) hasn't been run yet — logged once, not
// fatal (the feature simply stays dormant).
async function patchAppeal(supabase, campaignId, patch) {
  try {
    const { error } = await supabase
      .from("campaign_creator_campaigns")
      .update(patch)
      .eq("campaign_id", String(campaignId));
    if (error) {
      if (/appeal_|column .* does not exist|schema cache/i.test(error.message || "")) {
        console.error(
          `[appeals] ${campaignId} — appeal columns not migrated; run supabase/campaign_creator_appeals.sql (${error.message})`
        );
      } else {
        console.error(`[appeals] ${campaignId} — persist failed: ${error.message}`);
      }
    }
  } catch (err) {
    console.error(`[appeals] ${campaignId} — persist crashed: ${err.message}`);
  }
}

// A row stuck in APPEAL_SUBMITTING (crash between claim and result) older than
// this is reset to REJECTED so the appeal can be retried. Called by the caller
// before the per-row loop.
const STALE_SUBMITTING_MS = 5 * 60 * 1000;
function isStaleSubmitting(row) {
  return (
    row &&
    row.appeal_state === "APPEAL_SUBMITTING" &&
    !row.appeal_attempted &&
    (!row.appeal_updated_at || Date.now() - Date.parse(row.appeal_updated_at) > STALE_SUBMITTING_MS)
  );
}

module.exports = {
  handleAutoAppeal,
  isStaleSubmitting,
  buildAppealText,
  matchReason,
  classifyReasons,
  groupReasonsByCategory,
  REASON_TITLES,
  COMMON_INTRO,
  COMMON_ENDING,
  REASON_MIDDLE,
  REASON_ORDER,
  APPEAL_TECH_RETRY_CAP,
};

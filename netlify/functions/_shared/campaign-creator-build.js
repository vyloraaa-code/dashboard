// Campaign Creator — template normalization + per-advertiser resource lookups +
// the full "create ONE campaign for ONE advertiser" sequence.
//
// Everything TikTok-facing goes through the shared MCP client (server-side only).
// The create sequence mirrors _shared/wh-warmup.js (campaign -> ad group -> Spark
// ad, rollback on failure) and produces the exact adgroup_create / ad_create
// payloads so the EXISTING duplication foundation (_shared/campaign-creator.js)
// can replay them for the 20 extra ad groups.
//
// Manual campaigns only (never smart_plus_*). Spark Ads Pull. Placement = TikTok
// only. Video sharing + downloading disabled. No interests/behaviours.

const { mcpCall, deleteCampaign } = require("./tiktok-mcp");
const { resolveSparkCode } = require("./wh-warmup");

// ---------------------------------------------------------------------------
// Enums / constants — TikTok's real values
// ---------------------------------------------------------------------------

const TEMPLATE_TYPES = ["LEAD_GENERATION", "SALES"];

// Adult age brackets (AGE_13_17 is deliberately never exposed).
const AGE_GROUPS = ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"];
const AGE_LABELS = {
  AGE_18_24: "18–24",
  AGE_25_34: "25–34",
  AGE_35_44: "35–44",
  AGE_45_54: "45–54",
  AGE_55_100: "55+",
};

const GENDERS = ["GENDER_UNLIMITED", "GENDER_MALE", "GENDER_FEMALE"];
const GENDER_LABELS = { GENDER_UNLIMITED: "All", GENDER_MALE: "Male", GENDER_FEMALE: "Female" };

// Device Operating System targeting. TikTok's real `adgroup_create`/`adgroup_update`
// field is `operating_systems: ["ANDROID"|"IOS"]` (array, but "only one value is
// allowed" per the schema) — there is no "ALL" enum. "ALL" here is our own
// template-config sentinel meaning "omit operating_systems entirely", which is
// TikTok's normal unrestricted/broad device behavior.
const DEVICE_OS_VALUES = ["ALL", "ANDROID", "IOS"];
const DEVICE_OS_LABELS = { ALL: "All", ANDROID: "Android", IOS: "iOS" };

// Curated single-select CTA values (TikTok's exact enum tokens). `creative_cta_recommend_get`
// can return more, but these are the safe, always-valid ones for website / lead ads.
const CTA_VALUES = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "DOWNLOAD_NOW",
  "INSTALL_NOW",
  "PLAY_GAME",
  "ORDER_NOW",
  "CONTACT_US",
  "BOOK_NOW",
  "APPLY_NOW",
  "GET_QUOTE",
  "READ_MORE",
  "VIEW_NOW",
  "SUBSCRIBE",
];
const DEFAULT_CTA = "LEARN_MORE";

// Interactive Card (TikTok "Display Card") image spec.
const CARD_IMAGE_W = 750;
const CARD_IMAGE_H = 421;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const reqId = () => String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
const rand4 = () => String(Math.floor(1000 + Math.random() * 9000));

// ---------------------------------------------------------------------------
// Template config normalization (stored in campaign_creator_templates.config)
// ---------------------------------------------------------------------------

function normalizeTemplateConfig(raw) {
  const errors = [];
  const c = raw && typeof raw === "object" ? raw : {};

  const cbo = c.cbo === undefined ? true : !!c.cbo;
  const daily = num(c.daily_budget);
  if (!(daily > 0)) errors.push("Enter a daily campaign budget greater than 0.");

  let locationIds = Array.isArray(c.location_ids) ? c.location_ids.map(String).filter(Boolean) : [];
  let locationLabels = Array.isArray(c.location_labels) ? c.location_labels.map(String) : [];
  locationIds = [...new Set(locationIds)];
  if (!locationIds.length) errors.push("Pick at least one target location.");

  let ages = Array.isArray(c.age_groups) ? c.age_groups.filter((a) => AGE_GROUPS.includes(a)) : [];
  ages = [...new Set(ages)];
  if (!ages.length) ages = AGE_GROUPS.slice(); // default: all adult brackets
  // canonical order
  ages.sort((a, b) => AGE_GROUPS.indexOf(a) - AGE_GROUPS.indexOf(b));

  const gender = GENDERS.includes(c.gender) ? c.gender : "GENDER_UNLIMITED";
  const deviceOs = DEVICE_OS_VALUES.includes(c.device_os) ? c.device_os : "ALL";
  // ctas (new, 1+) wins; cta (single, legacy templates saved before Dynamic
  // CTA support) is the fallback so old templates keep working unchanged.
  let ctas = Array.isArray(c.ctas) ? c.ctas.filter((v) => CTA_VALUES.includes(v)) : [];
  ctas = [...new Set(ctas)];
  if (!ctas.length) ctas = [CTA_VALUES.includes(c.cta) ? c.cta : DEFAULT_CTA];
  const adText = typeof c.ad_text === "string" ? c.ad_text.trim().slice(0, 100) : "";

  const cardRaw = c.interactive_card && typeof c.interactive_card === "object" ? c.interactive_card : {};
  const card = {
    enabled: !!cardRaw.enabled,
    image_url: typeof cardRaw.image_url === "string" ? cardRaw.image_url.trim() : "",
  };
  if (card.enabled && !card.image_url) {
    errors.push("Interactive Card is on but no image link was provided.");
  }

  return {
    errors,
    config: {
      cbo,
      daily_budget: Math.round(daily * 100) / 100,
      location_ids: locationIds,
      location_labels: locationLabels.slice(0, locationIds.length),
      age_groups: ages,
      gender,
      device_os: deviceOs,
      ctas,
      ad_text: adText,
      interactive_card: card,
    },
  };
}

// ---------------------------------------------------------------------------
// Timezone: interpret a wall-clock HH:MM in an advertiser's IANA tz -> UTC.
// One-iteration offset solve (accurate outside the ~1h DST transition window,
// which never matters for "a few hours from now").  Returns a Date.
// ---------------------------------------------------------------------------

function tzParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) if (part.type !== "literal") p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour % 24,
    minute: +p.minute,
    second: +p.second,
  };
}

function tzOffsetMs(date, timeZone) {
  const p = tzParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - date.getTime(); // ms the zone is ahead of UTC at this instant
}

// The next instant at which the wall clock in `timeZone` reads hour:minute and
// which is >= now. Returns { utc: Date, localLabel: "YYYY-MM-DD HH:MM" }.
function nextLocalClockUtc(hour, minute, timeZone) {
  const now = new Date();
  const nowLocal = tzParts(now, timeZone);
  for (let addDays = 0; addDays <= 2; addDays++) {
    // wall-clock target on day (today + addDays) in the zone
    const base = Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day + addDays, hour, minute, 0);
    // solve for the UTC instant whose zone rendering equals that wall clock
    let guess = base - tzOffsetMs(new Date(base), timeZone);
    guess = base - tzOffsetMs(new Date(guess), timeZone); // second pass
    if (guess >= now.getTime() - 60 * 1000) {
      const d = new Date(guess);
      return { utc: d, localLabel: fmtLocal(d, timeZone) };
    }
  }
  const d = new Date(Date.now() + 3600 * 1000);
  return { utc: d, localLabel: fmtLocal(d, timeZone) };
}

function fmtLocal(date, timeZone) {
  const p = tzParts(date, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

// Interpret an explicit wall clock "YYYY-MM-DD" + hour:minute in `timeZone` and
// return the matching UTC instant. Same one-iteration offset solve as
// nextLocalClockUtc, just with a caller-supplied date instead of "next".
function zonedClockToUtc(dateStr, hour, minute, timeZone) {
  const [y, m, d] = String(dateStr || "").split("-").map((n) => parseInt(n, 10));
  if (!(y > 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) {
    return nextLocalClockUtc(hour, minute, timeZone); // bad date -> safe fallback
  }
  const base = Date.UTC(y, m - 1, d, hour, minute, 0);
  let guess = base - tzOffsetMs(new Date(base), timeZone);
  guess = base - tzOffsetMs(new Date(guess), timeZone); // second pass
  const utc = new Date(guess);
  return { utc, localLabel: fmtLocal(utc, timeZone) };
}

// "YYYY-MM-DD HH:MM:SS" UTC — the format adgroup_create wants.
function toApiUtc(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// ---------------------------------------------------------------------------
// Interactive Card image: normalize (Google Drive) -> fetch -> validate 750x421
// -> re-host on Supabase Storage so TikTok always gets a clean image URL.
// ---------------------------------------------------------------------------

const CARD_BUCKET = process.env.CAMPAIGN_ASSETS_BUCKET || "campaign-creator-assets";

function driveDirectUrl(url) {
  const s = String(url || "").trim();
  // https://drive.google.com/file/d/<ID>/view?...   or  ...open?id=<ID>  or  uc?id=<ID>
  let id = null;
  let m = s.match(/\/file\/d\/([-\w]{20,})/);
  if (m) id = m[1];
  if (!id) {
    m = s.match(/[?&]id=([-\w]{20,})/);
    if (m) id = m[1];
  }
  if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  return s; // not a Drive link — use as-is
}

// Minimal PNG / JPEG / GIF dimension reader (no dependencies).
function imageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: "png" };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: "gif" };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      const len = buf.readUInt16BE(off + 2);
      if (isSOF) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), type: "jpeg" };
      }
      off += 2 + len;
    }
  }
  return null;
}

async function fetchImage(url) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 ChiglaAds" } });
  } catch (err) {
    throw new Error(`could not download the image (${err.message})`);
  }
  if (!res.ok) throw new Error(`image link returned HTTP ${res.status}`);
  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 12 * 1024 * 1024) throw new Error("image is larger than 12 MB");

  if (!ct.startsWith("image/")) {
    // Google Drive sometimes serves an HTML interstitial for larger files.
    const head = buf.slice(0, 400).toString("utf8").toLowerCase();
    if (/<html|<!doctype/.test(head)) {
      const m = head.match(/confirm=([0-9a-z_-]+)/i);
      if (m && /drive\.google/.test(url)) {
        return fetchImage(`${url}&confirm=${m[1]}`);
      }
    }
    // Fall through: still try to read dimensions from the bytes.
  }
  return { buf, contentType: ct.startsWith("image/") ? ct : null };
}

// Resolves a template's interactive-card image link to a clean public URL TikTok
// can fetch. -> { url, rehosted, warning }. Throws only on hard validation
// failures (wrong dimensions / not an image) so nothing is created.
async function resolveCardImageUrl(rawUrl, { supabase }) {
  const direct = driveDirectUrl(rawUrl);
  const { buf, contentType } = await fetchImage(direct);

  const dim = imageDimensions(buf);
  if (!dim) throw new Error("that link is not a PNG or JPEG image");
  if (dim.width !== CARD_IMAGE_W || dim.height !== CARD_IMAGE_H) {
    throw new Error(
      `Interactive Card image must be exactly ${CARD_IMAGE_W}×${CARD_IMAGE_H} px (got ${dim.width}×${dim.height}).`
    );
  }

  const ext = dim.type === "jpeg" ? "jpg" : dim.type;
  const mime = contentType || `image/${dim.type === "jpg" ? "jpeg" : dim.type}`;

  // Stable path from the source URL so re-using the same link across launches
  // reuses the same stored object.
  const crypto = require("node:crypto");
  const key = crypto.createHash("sha1").update(String(rawUrl)).digest("hex").slice(0, 20);
  const path = `interactive-cards/${key}.${ext}`;

  try {
    const up = await supabase.storage.from(CARD_BUCKET).upload(path, buf, {
      contentType: mime,
      upsert: true,
      cacheControl: "31536000",
    });
    if (up.error) throw up.error;
    const pub = supabase.storage.from(CARD_BUCKET).getPublicUrl(path);
    const publicUrl = pub?.data?.publicUrl;
    if (!publicUrl) throw new Error("no public URL");
    return { url: publicUrl, rehosted: true };
  } catch (err) {
    // Storage re-host unavailable — the direct link is fine (tested against a
    // real TikTok campaign). Server-side note only, never surfaced to the user.
    console.warn(`[campaign-creator] card image direct link (no re-host): ${err.message || "storage unavailable"}`);
    return { url: direct, rehosted: false };
  }
}

// ---------------------------------------------------------------------------
// Per-advertiser resource lookups (used by the run function's "resources" action)
// ---------------------------------------------------------------------------

function pagesFrom(resp) {
  const list = resp?.list || resp?.page_list || resp?.pages || (Array.isArray(resp) ? resp : []);
  return (list || [])
    .map((p) => {
      const id = String(p.page_id ?? p.id ?? p.instant_page_id ?? "");
      if (!id) return null;
      const name = String(p.title || p.name || p.page_name || p.instant_page_name || id).trim();
      const t = p.create_time || p.created_time || p.create_at || p.created_at || null;
      const mt = p.modify_time || p.update_time || p.modified_time || null;
      return { page_id: id, name, create_time: t, modify_time: mt, status: p.status || null };
    })
    .filter(Boolean);
}

// Every Business Center form library the authorized user can access.
// -> [{ library_id, library_name, advertiser_id }]
//
// IMPORTANT (verified live 2026-09-04): a form created in "BC -> Assets -> Forms"
// and linked to ad accounts is NOT returned by page_get(advertiser_id) for any of
// those accounts. It lives in ONE form library and is only visible via
// page_get(library_id). So the BC-wide form list = sweep page_get over every
// library. page_get has no bc_id parameter and there is no dedicated BC-forms
// endpoint — this sweep is the only way.
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _isRateLimit = (msg) => /rate limit|too many request|429|qps|frequenc|please try again|请求过于频繁/i.test(String(msg || ""));
// The open MCP server's own connection to TikTok is occasionally flaky —
// distinct from rate limiting, these are raw transport/pool failures on the
// MCP server's side (2026-09: seen as "Error 1105: dial tcp ...: connect:
// connection...", "Error 1105: create connection speed too fast; no valid
// transaction", "Error 1040: any connections; no valid transaction", and a
// generic "Couldn't load, refresh to try again."). A user hitting this
// manually just retries the same click and it goes through — this is that
// same retry, automatic. Never a real TikTok API rejection (bad targeting,
// budget, policy, etc.), which always throws a different, specific message.
const _isTransientMcp = (msg) =>
  /dial tcp|connect: connection|no valid transaction|couldn'?t load|connection speed|econnreset|etimedout|socket hang up|network error|temporarily unavailable/i.test(
    String(msg || "")
  );

// mcpCall + backoff retry on TikTok's rate limiter AND on transient MCP-server
// connection failures (see _isTransientMcp above). Any other error — a real
// TikTok API rejection — throws immediately, no retry.
async function mcpThrottled(client, name, args, { tries = 5, base = 1200, deadlineMs } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await mcpCall(client, name, args);
    } catch (err) {
      lastErr = err;
      if (!_isRateLimit(err.message) && !_isTransientMcp(err.message)) throw err;
      const wait = Math.min(base * 2 ** i, 8000) + Math.floor(Math.random() * 400);
      if (deadlineMs && Date.now() + wait > deadlineMs) break;
      await _sleep(wait);
    }
  }
  throw lastErr;
}

// In-process cache for the BC form list — the operator iterates the wizard, and
// a warm Lambda/Vercel instance should not re-sweep every time. 90s TTL.
let _bcFormCache = { key: null, at: 0, forms: null, diag: null };
const BC_FORM_TTL_MS = 90 * 1000;

async function listFormLibraries(client, diag) {
  const out = [];
  let page = 1;
  for (;;) {
    let d;
    try {
      d = await mcpThrottled(client, "page_library_get", { page, page_size: 50 });
    } catch (err) {
      if (diag) diag.errors.push(`page_library_get p${page}: ${err.message}`);
      break;
    }
    for (const lib of d?.list || []) {
      const libId = String(lib.library_id || "");
      if (libId)
        out.push({
          library_id: libId,
          library_name: lib.library_name || null,
          advertiser_id: String(lib.advertiser_id || ""),
          create_time: lib.create_time || lib.update_time || null,
        });
    }
    const info = d?.page_info || {};
    if (!info.total_page || page >= info.total_page) break;
    page += 1;
    if (page > 40) break;
  }
  return out;
}

// Kept for callers that want a quick advertiser -> library_id lookup.
async function formLibraryMap(client) {
  const map = new Map();
  for (const lib of await listFormLibraries(client)) {
    if (lib.advertiser_id && !map.has(lib.advertiser_id)) map.set(lib.advertiser_id, lib.library_id);
  }
  return map;
}

// One page_get (by library_id OR advertiser_id) for published Lead Gen forms.
// Throttled + retried. Throws on non-rate-limit MCP error.
async function _formsFrom(client, key, opts) {
  const d = await mcpThrottled(
    client,
    "page_get",
    { business_type: "LEAD_GEN", status: "PUBLISHED", page_size: 100, ...key },
    opts
  );
  return pagesFrom(d).map((p) => ({ id: p.page_id, name: p.name, status: p.status || null }));
}

// Every Lead Gen Instant Form visible to the BC. Sweeps form libraries SERIALLY
// (TikTok's open MCP rate-limits hard) newest-first, with a per-call pause and
// backoff. Caches the result for BC_FORM_TTL_MS. -> { forms: [{id,name}], diag }
async function listBcForms(client, { deadlineMs, cacheKey } = {}) {
  if (cacheKey && _bcFormCache.key === cacheKey && Date.now() - _bcFormCache.at < BC_FORM_TTL_MS && _bcFormCache.forms) {
    return { forms: _bcFormCache.forms, diag: { ..._bcFormCache.diag, cached: true } };
  }

  const diag = { libraries: 0, scanned: 0, withForms: 0, errors: [] };
  const libs = await listFormLibraries(client, diag);
  // Newest library first — a freshly-made form's library tends to be recent, so
  // we usually hit the forms within the first few calls.
  libs.sort((a, b) => (Date.parse(b.create_time || 0) || 0) - (Date.parse(a.create_time || 0) || 0));
  diag.libraries = libs.length;

  const byId = new Map();
  const MAX_SCAN = 22; // hard cap regardless of deadline
  const MAX_AFTER_HIT = 4; // libraries to keep checking once forms are found
  let afterHit = -1;
  for (const lib of libs) {
    if (diag.scanned >= MAX_SCAN) {
      diag.errors.push(`stopped at ${MAX_SCAN}-library cap`);
      break;
    }
    if (deadlineMs && Date.now() > deadlineMs) {
      diag.errors.push(`deadline after ${diag.scanned}/${libs.length} libraries`);
      break;
    }
    diag.scanned += 1;
    try {
      const rows = await _formsFrom(client, { library_id: lib.library_id }, { deadlineMs });
      if (rows.length) {
        diag.withForms += 1;
        if (afterHit < 0) afterHit = 0;
      }
      for (const f of rows) if (f.id && !byId.has(f.id)) byId.set(f.id, f);
    } catch (err) {
      diag.errors.push(`lib ${lib.library_id}: ${err.message}`);
    }
    if (afterHit >= 0 && afterHit++ >= MAX_AFTER_HIT) {
      diag.stoppedEarly = true;
      break; // forms found + a few more libraries checked
    }
    await _sleep(220); // stay under the MCP's burst limit
  }

  const forms = [...byId.values()].map((f) => ({ id: f.id, name: f.name }));
  if (cacheKey && forms.length) _bcFormCache = { key: cacheKey, at: Date.now(), forms, diag };
  return { forms, diag };
}

// Published Lead Gen forms visible to ONE ad account (its own route + its library).
async function listInstantForms(client, advertiserId, libraryId) {
  const byId = new Map();
  const add = (rows) => {
    for (const f of rows) if (!byId.has(f.id)) byId.set(f.id, { id: f.id, name: f.name });
  };
  try {
    add(await _formsFrom(client, { advertiser_id: String(advertiserId) }));
  } catch (_) {
    /* library route below */
  }
  if (libraryId) {
    try {
      add(await _formsFrom(client, { library_id: String(libraryId) }));
    } catch (_) {
      /* ignore */
    }
  }
  return [...byId.values()];
}

// A BC form assigned to ad accounts often CANNOT be listed by page_get for the
// dashboard's token (different TikTok user than the form's owner), but it CAN be
// resolved by id per-account via page_field_get. This is the reliable way to
// confirm a pasted / remembered Form ID is usable, and to get its real name.
// -> { page_id, ok, name, checks: [{advertiser_id, advertiser_name, ok, error}] }
async function validateFormForAdvertisers(client, pageId, advertisers, { max = 3 } = {}) {
  const id = String(pageId || "").trim();
  const checks = [];
  let name = null;
  for (const adv of (advertisers || []).slice(0, Math.max(1, max))) {
    try {
      const d = await mcpThrottled(
        client,
        "page_field_get",
        { advertiser_id: String(adv.advertiser_id), page_id: id },
        { tries: 3 }
      );
      const n = d?.meta_data?.page_name || d?.page_name || d?.meta_data?.page_id || null;
      if (n && !name) name = n;
      checks.push({ advertiser_id: String(adv.advertiser_id), advertiser_name: adv.advertiser_name || null, ok: true });
    } catch (err) {
      checks.push({
        advertiser_id: String(adv.advertiser_id),
        advertiser_name: adv.advertiser_name || null,
        ok: false,
        error: err.message,
      });
    }
  }
  return { page_id: id, ok: checks.some((c) => c.ok), name, checks };
}

// Resolve the Instant Form page_id to use for ONE advertiser from the operator's
// pick. A BC-level form is referenced by its page_id verbatim (page_get can't
// list it per-account, but ad_create accepts it when the form is linked to the
// account). -> page_id | throws.
async function resolveAdvertiserForm(client, advertiserId, libraryId, pick) {
  if (pick.id) return String(pick.id); // explicit BC / account form id — use as-is
  const forms = await listInstantForms(client, advertiserId, libraryId);
  if (!forms.length) throw new Error("no published Instant Form found for this account and no Form ID was given");
  const want = String(pick.name || "").trim().toLowerCase();
  const byName = forms.find((f) => String(f.name || "").trim().toLowerCase() === want);
  if (byName) return byName.id;
  throw new Error(`no published Instant Form named "${pick.name}" in this account`);
}

async function listInstantPages(client, advertiserId) {
  const d = await mcpCall(client, "page_get", {
    advertiser_id: String(advertiserId),
    business_type: "TIKTOK_INSTANT_PAGE",
    status: "PUBLISHED",
    page_size: 100,
  });
  return pagesFrom(d);
}

// Most-recently-created published Instant Page for an advertiser.
// -> { page_id, name } | { error }
function newestInstantPage(pages) {
  if (!pages || !pages.length) return { error: "no published TikTok Instant Page in this account" };
  const withTime = pages.filter((p) => p.create_time || p.modify_time);
  if (!withTime.length) {
    return { error: "TikTok returned no creation time for the Instant Pages, so the newest one can't be picked automatically" };
  }
  const ts = (p) => {
    const raw = p.create_time || p.modify_time;
    const n = Date.parse(String(raw).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(raw)) ? "" : "Z"));
    return Number.isFinite(n) ? n : 0;
  };
  const best = withTime.slice().sort((a, b) => ts(b) - ts(a))[0];
  return { page_id: best.page_id, name: best.name };
}

async function listBcIdentities(client, advertiserId, bcId) {
  const args = { advertiser_id: String(advertiserId), page_size: 100 };
  if (bcId) {
    args.identity_type = "BC_AUTH_TT";
    args.identity_authorized_bc_id = String(bcId);
  }
  let d;
  try {
    d = await mcpThrottled(client, "identity_get", args, { tries: 3 });
  } catch (_) {
    // Retry without the BC filter (account may not have a BC-authorized identity).
    d = await mcpThrottled(client, "identity_get", { advertiser_id: String(advertiserId), page_size: 100 }, { tries: 3 });
  }
  const list = d?.identity_list || d?.list || [];
  return list
    .map((x) => ({
      identity_id: String(x.identity_id || ""),
      identity_type: x.identity_type || (bcId ? "BC_AUTH_TT" : "TT_USER"),
      name: String(x.display_name || x.profile_name || x.nickname || x.identity_id || "").trim(),
    }))
    .filter((x) => x.identity_id);
}

// Instant Page conversion event for the Sales objective (TikTok Instant Page,
// optimization goal Conversion, no pixel — matches Ads Manager's "Highest
// Volume" Sales setup). Verified live against a real account:
//   pixel_instant_page_event_get({objective_type:"CONVERSIONS",optimization_goal:"CONVERT"})
//   -> { list: [{ instant_page_events: { objective_types: [{ objective_type:"CONVERSIONS",
//        optimization_goals: [{ optimization_goal:"CONVERT", optimization_events:["BUTTON"] }] }] } }] }
// and confirmed against an existing 21-ad-group Sales campaign, every ad group:
// promotion_website_type TIKTOK_NATIVE_PAGE, optimization_goal CONVERT,
// optimization_event BUTTON, pixel_id null. "BUTTON" is the safe default when
// the lookup fails for any reason — this is never a blocker.
// -> { goal: "CONVERT", event: string }  (never throws, never blocks Sales)
const SALES_OPT_GOAL = "CONVERT";
const SALES_OPT_EVENT_DEFAULT = "BUTTON";

async function instantPageConversion(client, advertiserId) {
  try {
    const d = await mcpThrottled(
      client,
      "pixel_instant_page_event_get",
      { advertiser_id: String(advertiserId), objective_type: "CONVERSIONS", optimization_goal: SALES_OPT_GOAL },
      { tries: 3 }
    );
    const events = new Set();
    for (const item of d?.list || []) {
      for (const ot of item?.instant_page_events?.objective_types || []) {
        for (const og of ot?.optimization_goals || []) {
          for (const e of og?.optimization_events || []) if (e) events.add(String(e));
        }
      }
    }
    const event = [...events][0] || SALES_OPT_EVENT_DEFAULT;
    return { goal: SALES_OPT_GOAL, event };
  } catch (err) {
    console.warn(`[campaign-creator] pixel_instant_page_event_get unavailable for ${advertiserId} (${err.message}) — using default "${SALES_OPT_EVENT_DEFAULT}"`);
    return { goal: SALES_OPT_GOAL, event: SALES_OPT_EVENT_DEFAULT };
  }
}

async function ensureLeadAdsTerm(client, advertiserId) {
  try {
    const chk = await mcpCall(client, "term_check", { advertiser_id: String(advertiserId), term_type: "LeadAds" });
    const signed = chk?.is_signed ?? chk?.signed ?? chk?.has_signed ?? chk?.confirmed;
    if (signed === true) return { ok: true };
  } catch (_) {
    /* fall through to confirm */
  }
  try {
    await mcpCall(client, "term_confirm", { advertiser_id: String(advertiserId), term_type: "LeadAds" });
    return { ok: true, justSigned: true };
  } catch (err) {
    // Already signed / concurrently signed — not an error for our purposes.
    if (/already|signed|confirmed|exist/i.test(err.message || "")) return { ok: true };
    throw new Error(`Could not accept TikTok's Lead Ads terms for this account: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function buildCampaignPayload({ advertiserId, campaignName, type, config }) {
  const p = {
    advertiser_id: String(advertiserId),
    campaign_name: campaignName,
    objective_type: type === "SALES" ? "WEB_CONVERSIONS" : "LEAD_GENERATION",
    budget_mode: "BUDGET_MODE_DAY",
    budget: num(config.daily_budget),
    operation_status: "ENABLE",
    request_id: reqId(),
  };
  if (config.cbo !== false) p.budget_optimize_on = true;
  if (type === "SALES") {
    p.virtual_objective_type = "SALES";
    p.sales_destination = "WEBSITE";
  }
  return p;
}

function buildAdgroupPayload({ advertiserId, campaignId, type, config, scheduleUtc, sales }) {
  const p = {
    advertiser_id: String(advertiserId),
    campaign_id: String(campaignId),
    adgroup_name: "adg1", // always the first ad group of a fresh campaign — duplicateForRow names the rest adg2, adg3, ...
    placement_type: "PLACEMENT_TYPE_NORMAL",
    placements: ["PLACEMENT_TIKTOK"],
    location_ids: config.location_ids.slice(),
    age_groups: config.age_groups.slice(),
    gender: config.gender,
    // no interests / behaviours — broad targeting
    budget_mode: "BUDGET_MODE_DAY",
    budget: num(config.daily_budget), // ignored under CBO, still required by the endpoint
    schedule_type: "SCHEDULE_FROM_NOW",
    schedule_start_time: toApiUtc(scheduleUtc),
    billing_event: "OCPM",
    bid_type: "BID_TYPE_NO_BID", // Highest Volume / Lowest Cost
    pacing: "PACING_MODE_SMOOTH",
    operation_status: "ENABLE",
    // sharing + downloading OFF
    share_disabled: true,
    video_download_disabled: true,
    comment_disabled: false,
    request_id: reqId(),
  };
  // Device OS targeting: omit `operating_systems` entirely for "All" (TikTok's
  // normal unrestricted/broad device behavior — there is no "ALL" enum value).
  // Applies identically to LEAD_GENERATION and SALES.
  if (config.device_os === "ANDROID" || config.device_os === "IOS") {
    p.operating_systems = [config.device_os];
  }

  if (type === "SALES") {
    p.promotion_type = "WEBSITE";
    p.promotion_website_type = "TIKTOK_NATIVE_PAGE"; // TikTok Instant Page
    p.optimization_goal = sales?.goal || SALES_OPT_GOAL; // "CONVERT"
    p.optimization_event = sales?.event || SALES_OPT_EVENT_DEFAULT; // "BUTTON" — no pixel involved
  } else {
    p.promotion_type = "LEAD_GENERATION";
    p.promotion_target_type = "INSTANT_PAGE"; // TikTok Instant Form
    p.optimization_goal = "LEAD_GENERATION";
    // TikTok auto-assigns this to "FORM" for a LEAD_GENERATION/INSTANT_PAGE ad
    // group even though it's never required at create time (confirmed live via
    // adgroup_get on a real ad group) — but every SUBSEQUENT ad group under the
    // same CBO campaign must send it explicitly and it must match the first
    // one, or adgroup_create is rejected: "Please follow the same
    // 'optimization_event' of the first adgroup...". Setting it explicitly here
    // means the original ad group's stored adgroup_payload always carries it,
    // so the 20x duplication replay (which reuses this payload verbatim) never
    // hits that mismatch.
    p.optimization_event = "FORM";
  }
  return p;
}

// One or more CTAs picked on the template -> the field(s) ad_create actually
// wants. A single CTA is the plain `call_to_action` text as before. More than
// one turns on TikTok's Dynamic CTA: a `creative_portfolio_create` (type CTA)
// bundling every picked CTA's recommended asset_ids, whose resulting
// creative_portfolio_id becomes `call_to_action_id` — TikTok then shows
// whichever of the picked CTAs a given viewer is likeliest to tap, instead of
// the ad being locked to one fixed CTA. Best-effort: any failure here (a rare
// TikTok-side error on the portfolio call) falls back to the first picked
// CTA as a plain call_to_action rather than blocking campaign creation.
// Verified live 2026-09-07 against creative_cta_recommend_get / portfolio/create.
async function ensureCtaField(client, advId, type, ctas, warnings) {
  const list = Array.isArray(ctas) && ctas.length ? ctas : [DEFAULT_CTA];
  if (list.length === 1) return { call_to_action: list[0] };

  try {
    const rec = await mcpCall(client, "creative_cta_recommend_get", {
      advertiser_id: advId,
      new_version: true,
      objective_type: type === "SALES" ? "WEB_CONVERSIONS" : "LEAD_GENERATION",
      promotion_type: type === "SALES" ? "WEBSITE" : "LEAD_GENERATION",
      placements: ["PLACEMENT_TIKTOK"],
    });
    const byText = new Map(
      (rec?.recommend_assets || []).map((a) => [String(a.asset_content || "").trim().toLowerCase(), a.asset_ids])
    );
    const portfolioContent = list
      .map((v) => {
        const label = ccCtaLabelForLookup(v);
        const assetIds = byText.get(label.toLowerCase());
        return assetIds ? { asset_content: label, asset_ids: assetIds } : null;
      })
      .filter(Boolean);
    if (portfolioContent.length < 2) throw new Error("fewer than 2 of the picked CTAs were recognized by TikTok");

    const portfolio = await mcpCall(client, "creative_portfolio_create", {
      advertiser_id: advId,
      creative_portfolio_type: "CTA",
      portfolio_content: portfolioContent,
    });
    const portfolioId = String(portfolio?.creative_portfolio_id || "");
    if (!portfolioId) throw new Error("no creative_portfolio_id returned");
    return { call_to_action_id: portfolioId };
  } catch (err) {
    warnings.push(`Dynamic CTA (${list.length} CTAs) not applied (${err.message}) — used "${ccCtaLabelForLookup(list[0])}" only.`);
    return { call_to_action: list[0] };
  }
}

// TikTok's CTA enum tokens (LEARN_MORE) vs. the display text
// creative_cta_recommend_get matches on ("Learn more") — same
// underscore-to-title-case rule as the dashboard's own ccCtaLabel (js/app.js),
// duplicated here since this runs server-side.
function ccCtaLabelForLookup(v) {
  return String(v)
    .split("_")
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(" ");
}

function buildAdCreative({ type, config, identity, sparkItemId, pageId, cardId, adFormat, ctaField }) {
  const creative = {
    ad_name: "ad1", // always the first ad of a fresh campaign — duplicateForRow names the rest ad2, ad3, ...
    ad_format: adFormat, // SINGLE_VIDEO | CAROUSEL_ADS
    identity_type: identity.identity_type,
    identity_id: identity.identity_id,
    tiktok_item_id: String(sparkItemId), // Spark Ads Pull
    ...ctaField,
    operation_status: "ENABLE",
  };
  if (identity.identity_type === "BC_AUTH_TT" && identity.identity_authorized_bc_id) {
    creative.identity_authorized_bc_id = String(identity.identity_authorized_bc_id);
  }
  if (config.ad_text) creative.ad_text = config.ad_text;
  if (pageId != null && pageId !== "") {
    // page_id is a numeric id in TikTok's schema; keep it a string unless it is
    // safely representable, so very large ids never lose precision.
    const n = Number(pageId);
    creative.page_id = Number.isSafeInteger(n) ? n : String(pageId);
  }
  if (cardId) creative.card_id = String(cardId);
  return creative;
}

// ---------------------------------------------------------------------------
// Create ONE campaign for ONE advertiser. Throws on any failure (campaign rolled
// back best-effort, id attached as err.rolledBackCampaignId).
//
// Returns everything the caller needs to register the campaign for duplication
// + to store its post URL.
// ---------------------------------------------------------------------------

const SCHEDULE_ERR = /schedul|start.?time|past|time.*earlier|future/i;
const FORMAT_MISMATCH = /photo post|carousel ad|can be delivered|ad_format|single[_ ]video|video post|not a (photo|video)|must be a (photo|video)/i;
const CARD_REJECT = /card|portfolio|display card|add[- ]?on|interactive/i;

async function createOneCampaign({
  client,
  supabase,
  advertiser, // { advertiser_id, advertiser_name, bc_id, timezone }
  connectionId,
  bcId,
  type, // 'LEAD_GENERATION' | 'SALES'
  config, // normalized template config
  campaignName,
  scheduleHour,
  scheduleMinute,
  scheduleDate, // "YYYY-MM-DD" in the advertiser's timezone (optional)
  sparkCode,
  postUrl,
  identity, // { identity_id, identity_type } | { auto: true }
  form, // Lead Gen: { name, id? } — resolved to this advertiser's own form
  libraryId, // Lead Gen: this advertiser's BC form-library id (optional)
  cardImageUrl, // resolved public URL when interactive card enabled, else null
  deadlineMs, // caller's overall request deadline — bounds mcpThrottled retries below
  // so one rate-limited/flaky advertiser can't eat the whole batch's time budget
  // and take the platform's hard function timeout (and every other advertiser's
  // already-created results) down with it.
}) {
  const advId = String(advertiser.advertiser_id);
  const tz = advertiser.timezone || advertiser.display_timezone || "America/New_York";
  const warnings = [];

  // ---- read-only resolutions FIRST (nothing is created until these pass) ----
  if (type === "LEAD_GENERATION") {
    await ensureLeadAdsTerm(client, advId);
  }

  const spark = await resolveSparkCode(client, advId, sparkCode); // { item_id, identity_id, post_type }

  let pageId = null;
  let pageName = null;
  let sales = null;
  if (type === "SALES") {
    const pages = await listInstantPages(client, advId);
    const newest = newestInstantPage(pages);
    if (newest.error) throw new Error(`Instant Page: ${newest.error}`);
    pageId = newest.page_id;
    pageName = newest.name;
    // optimization_goal CONVERT + optimization_event BUTTON — no pixel, never
    // blocks creation (instantPageConversion always returns a usable value).
    sales = await instantPageConversion(client, advId);
  } else {
    // Lead Gen — resolve THIS advertiser's own Instant Form by the operator's pick.
    pageId = await resolveAdvertiserForm(client, advId, libraryId, form || {});
    pageName = form?.name || null;
  }

  // Identity: an explicit BC identity, or "auto" = the Spark code's own identity.
  const resolvedIdentity =
    identity && identity.auto
      ? { identity_id: spark.identity_id, identity_type: "AUTH_CODE" }
      : { identity_id: identity.identity_id, identity_type: identity.identity_type };
  if (!resolvedIdentity.identity_id) {
    throw new Error("could not resolve an ad identity (Spark code returned none and no identity was selected)");
  }
  const identityWithBc = {
    ...resolvedIdentity,
    identity_authorized_bc_id:
      resolvedIdentity.identity_type === "BC_AUTH_TT" ? String(bcId || advertiser.bc_id || "") : undefined,
  };

  // ---- interactive card (best-effort — never blocks the campaign) ----
  let cardId = null;
  if (config.interactive_card && config.interactive_card.enabled && cardImageUrl) {
    try {
      const img = await mcpCall(client, "file_image_ad_upload", {
        advertiser_id: advId,
        upload_type: "UPLOAD_BY_URL",
        image_url: cardImageUrl,
        file_name: `cc_card_${rand4()}_${Date.now()}`,
      });
      const imageId = String(img?.image_id || img?.id || "");
      if (!imageId) throw new Error("no image_id returned");
      const portfolio = await mcpCall(client, "creative_portfolio_create", {
        advertiser_id: advId,
        creative_portfolio_type: "CARD",
        portfolio_content: [{ card_type: "IMAGE", image_id: imageId }],
      });
      cardId = String(
        portfolio?.creative_portfolio_id || portfolio?.card_id || portfolio?.portfolio_id || portfolio?.id || ""
      );
      if (!cardId) throw new Error("no portfolio id returned");
    } catch (err) {
      cardId = null;
      warnings.push(`Interactive Card not attached (${err.message}).`);
    }
  }

  // Resolve once per campaign (not per ad-format retry below) — a single CTA
  // stays a plain call_to_action; 2+ builds a Dynamic CTA portfolio.
  const ctaField = await ensureCtaField(client, advId, type, config.ctas, warnings);

  const scheduleLocal = scheduleDate
    ? zonedClockToUtc(scheduleDate, scheduleHour, scheduleMinute, tz)
    : nextLocalClockUtc(scheduleHour, scheduleMinute, tz);

  let campaignId = null;
  try {
    // 1. campaign
    const campPayload = buildCampaignPayload({ advertiserId: advId, campaignName, type, config });
    const camp = await mcpThrottled(client, "campaign_create", campPayload, { deadlineMs });
    campaignId = String(camp?.campaign_id || "");
    if (!campaignId) throw new Error("campaign_create returned no campaign_id");

    // 2. ad group
    const agPayload = buildAdgroupPayload({
      advertiserId: advId,
      campaignId,
      type,
      config,
      scheduleUtc: scheduleLocal.utc,
      sales,
    });
    let ag;
    try {
      ag = await mcpThrottled(client, "adgroup_create", agPayload, { deadlineMs });
    } catch (err) {
      if (SCHEDULE_ERR.test(err.message || "")) {
        const soon = new Date(Date.now() + 5 * 60 * 1000);
        agPayload.schedule_start_time = toApiUtc(soon);
        scheduleLocal.localLabel = fmtLocal(soon, tz) + " (adjusted — chosen time was in the past)";
        ag = await mcpThrottled(client, "adgroup_create", agPayload, { deadlineMs });
      } else {
        throw err;
      }
    }
    const adgroupId = String(ag?.adgroup_id || "");
    if (!adgroupId) throw new Error("adgroup_create returned no adgroup_id");

    // 3. Spark ad (photo posts -> CAROUSEL_ADS, video -> SINGLE_VIDEO; retry the
    //    other format, and retry without the card if TikTok rejects it).
    const firstFormat = spark.post_type === "CAROUSEL" ? "CAROUSEL_ADS" : "SINGLE_VIDEO";
    const otherFormat = firstFormat === "CAROUSEL_ADS" ? "SINGLE_VIDEO" : "CAROUSEL_ADS";
    const makeCreative = (fmt, withCard) =>
      buildAdCreative({
        type,
        config,
        identity: identityWithBc,
        sparkItemId: spark.item_id,
        pageId,
        cardId: withCard ? cardId : null,
        adFormat: fmt,
        ctaField,
      });

    const tryAd = async (fmt, withCard) =>
      mcpThrottled(client, "ad_create", { advertiser_id: advId, adgroup_id: adgroupId, creatives: [makeCreative(fmt, withCard)] }, { deadlineMs });

    let ad;
    let usedCard = !!cardId;
    try {
      ad = await tryAd(firstFormat, usedCard);
    } catch (err) {
      const msg = err.message || "";
      if (usedCard && CARD_REJECT.test(msg)) {
        usedCard = false;
        warnings.push(`Interactive Card rejected by TikTok (${msg}) — ad created without it.`);
        try {
          ad = await tryAd(firstFormat, false);
        } catch (err2) {
          if (!FORMAT_MISMATCH.test(err2.message || "")) throw err2;
          ad = await tryAd(otherFormat, false);
        }
      } else if (FORMAT_MISMATCH.test(msg)) {
        try {
          ad = await tryAd(otherFormat, usedCard);
        } catch (err2) {
          if (usedCard && CARD_REJECT.test(err2.message || "")) {
            usedCard = false;
            warnings.push(`Interactive Card rejected by TikTok — ad created without it.`);
            ad = await tryAd(otherFormat, false);
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }
    const adId = String((ad?.ad_ids || [])[0] || (ad?.creatives || [])[0]?.ad_id || "");
    if (!adId) throw new Error("ad_create returned no ad_id");

    const adFormatUsed = firstFormat; // recorded on the payload below
    const adgroupPayloadStored = { ...agPayload };
    const adPayloadStored = makeCreative(adFormatUsed, usedCard);
    adPayloadStored.ad_name = ""; // duplication regenerates this

    return {
      campaign_id: campaignId,
      adgroup_id: adgroupId,
      ad_id: adId,
      campaign_name: campaignName,
      adgroup_payload: adgroupPayloadStored,
      ad_payload: adPayloadStored,
      post_url: postUrl,
      instant_page_name: pageName,
      instant_form_id: type === "LEAD_GENERATION" ? String(pageId) : null,
      identity_used: identityWithBc.identity_type,
      schedule_local: scheduleLocal.localLabel,
      schedule_tz: tz,
      warnings,
    };
  } catch (err) {
    if (campaignId) {
      try {
        await deleteCampaign({ client, advertiserId: advId, campaignId });
      } catch (_) {
        /* an empty campaign with no ads never spends */
      }
      err.rolledBackCampaignId = campaignId;
    }
    throw err;
  }
}

module.exports = {
  TEMPLATE_TYPES,
  AGE_GROUPS,
  AGE_LABELS,
  GENDERS,
  GENDER_LABELS,
  DEVICE_OS_VALUES,
  DEVICE_OS_LABELS,
  CTA_VALUES,
  DEFAULT_CTA,
  CARD_IMAGE_W,
  CARD_IMAGE_H,
  CARD_BUCKET,
  normalizeTemplateConfig,
  nextLocalClockUtc,
  zonedClockToUtc,
  fmtLocal,
  resolveCardImageUrl,
  driveDirectUrl,
  imageDimensions,
  listInstantForms,
  listBcForms,
  listFormLibraries,
  formLibraryMap,
  validateFormForAdvertisers,
  resolveAdvertiserForm,
  listInstantPages,
  newestInstantPage,
  listBcIdentities,
  instantPageConversion,
  ensureLeadAdsTerm,
  buildCampaignPayload,
  buildAdgroupPayload,
  buildAdCreative,
  createOneCampaign,
};

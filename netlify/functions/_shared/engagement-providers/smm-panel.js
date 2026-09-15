// Generic SMM-panel client — the classic "PerfectPanel" HTTP API v2 that
// JustAnotherPanel, AutoSMMPanel and DripFeedPanel all expose:
//
//   POST <apiUrl>            (application/x-www-form-urlencoded)
//   key=<apiKey>&action=add&service=<id>&link=<url>&quantity=<n>
//     -> { "order": 23501 }                    on success
//     -> { "error": "Not enough funds ..." }   on failure
//
//   key=<apiKey>&action=status&order=<orderId>
//     -> { charge, start_count, status, remains, currency }
//
// Custom-comment services take a newline-separated `comments` param instead of
// (or alongside) `quantity`.
//
// The API key is passed in by the caller from process.env and is NEVER logged,
// returned, or included in any error surfaced upward.

// `fetch` has no timeout of its own — a panel that never responds would hang
// for the life of the function. Bounding it here means one slow/dead panel
// call fails fast instead of silently eating the whole request's time budget.
const REQUEST_TIMEOUT_MS = 20000;

async function post(apiUrl, params) {
  const body = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`panel timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw new Error(`panel unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error(`panel returned a non-JSON response (HTTP ${res.status})`);
  }
  if (data && data.error) throw new Error(String(data.error));
  if (!res.ok) throw new Error(`panel HTTP ${res.status}`);
  return data || {};
}

// Place an order. `comments` (array) => custom-comments mode. Returns the
// panel's order id as a string.
async function addOrder({ apiUrl, apiKey, serviceId, link, quantity, comments }) {
  if (!apiUrl || !apiKey || !serviceId || !link) throw new Error("missing panel config");
  const params = { key: apiKey, action: "add", service: String(serviceId), link: String(link) };
  const list = Array.isArray(comments) ? comments.map((c) => String(c).trim()).filter(Boolean) : null;
  if (list && list.length) {
    params.comments = list.join("\n");
    params.quantity = String(list.length);
  } else {
    params.quantity = String(Math.max(1, Math.floor(Number(quantity) || 0)));
  }
  const data = await post(apiUrl, params);
  if (data.order == null) throw new Error("panel accepted the request but returned no order id");
  return String(data.order);
}

// Look up a placed order's delivery status. Returns the raw panel object
// ({ charge, start_count, status, remains, currency }) or throws.
async function getStatus({ apiUrl, apiKey, orderRef }) {
  if (!apiUrl || !apiKey || !orderRef) throw new Error("missing panel config");
  return post(apiUrl, { key: apiKey, action: "status", order: String(orderRef) });
}

module.exports = { addOrder, getStatus };

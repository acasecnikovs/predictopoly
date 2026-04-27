// Pages Function: POST /api/check-resolution
// Body: { ids: string[] }   (max 50 per call)
// Returns: { resolutions: { [id]: ResolutionStatus } }
//   ResolutionStatus =
//     { resolved: true, outcome: 0 | 1, outcomePrices: [number, number] }
//     | { resolved: false }
//     | { error: string }
//
// Phase B.3 of the active-mode loop. The browser holds a pending entry per
// active prediction the user made; once that market's endDate has passed,
// it batches a few ids here and we hit polymarket's gamma endpoint
// per-id to see if the market actually resolved. If it did, we report
// which outcome won, the browser scores the user (Brier vs outcome) and
// upgrades the pending entry into history.
//
// Why server-side: keeps gamma off the user's CORS origin (gamma allows
// it today but we don't want to depend on that), gives us a single point
// to add caching/rate-limiting, and keeps the polymarket dep out of the
// static bundle.

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

const GAMMA = "https://gamma-api.polymarket.com";
const MAX_IDS = 50;
// 60s edge cache per id. Resolutions don't flip back; the cache only
// matters when a user reloads quickly. Disputes are vanishingly rare in
// practice and we'd rather show a stale "resolved" than nothing.
const CACHE_TTL_S = 60;

function bad(reason, status = 400) {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: JSON_HEADERS,
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function parseOutcomePrices(raw) {
  if (!raw) return null;
  let arr;
  try {
    arr = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length !== 2) return null;
  const a = Number(arr[0]);
  const b = Number(arr[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function judgeResolution(market) {
  // Only call a market resolved when polymarket has stamped closed=true AND
  // the outcome prices are extreme (>=0.99 on the winning side). Markets
  // that closed but resolved 50/50 (canceled, undecided, or in dispute)
  // still satisfy closed=true; we leave those pending so the user gets a
  // definitive 0/1 outcome rather than a half-point. If a market truly
  // resolves to 50/50 it will sit pending forever - acceptable edge case.
  if (!market || market.closed !== true) return { resolved: false };
  const prices = parseOutcomePrices(market.outcomePrices);
  if (!prices) return { resolved: false };
  const [a, b] = prices;
  if (a >= 0.99) return { resolved: true, outcome: 0, outcomePrices: prices };
  if (b >= 0.99) return { resolved: true, outcome: 1, outcomePrices: prices };
  return { resolved: false };
}

async function fetchOne(id) {
  // Edge-cache per id. Cache.put keys on the request URL.
  const cacheUrl = `https://cache.predictopoly.local/market/${id}`;
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      return await cached.json();
    } catch {
      // fall through and refetch
    }
  }

  let market;
  try {
    const r = await fetch(`${GAMMA}/markets/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": "predictopoly-resolver/0.1" },
    });
    if (!r.ok) {
      // 404 means the market id has been pruned/renamed. Treat as "still
      // pending" rather than error so the browser keeps the user's entry
      // and retries on next app-open.
      if (r.status === 404) return { resolved: false };
      return { error: `gamma ${r.status}` };
    }
    market = await r.json();
  } catch (e) {
    return { error: `fetch failed: ${String(e).slice(0, 80)}` };
  }

  const result = judgeResolution(market);
  // Only cache definite outcomes. Pending-state caching would freeze a
  // recent resolution out of view for up to CACHE_TTL_S after it lands.
  if (result.resolved) {
    const resp = new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, s-maxage=${CACHE_TTL_S}`,
      },
    });
    // Don't await - cache write shouldn't block the response.
    cache.put(cacheKey, resp.clone()).catch(() => {});
  }
  return result;
}

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("bad json");
  }
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids) return bad("ids required");
  if (ids.length === 0) {
    return new Response(JSON.stringify({ resolutions: {} }), {
      headers: JSON_HEADERS,
    });
  }
  if (ids.length > MAX_IDS) return bad(`max ${MAX_IDS} ids per call`);

  // Validate ids: polymarket ids are short numeric strings; cap at 80
  // chars to be safe and reject anything not string-shaped.
  const clean = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.length > 80) {
      return bad("malformed id");
    }
    clean.push(id);
  }

  const results = await Promise.all(clean.map((id) => fetchOne(id)));
  const resolutions = {};
  clean.forEach((id, i) => {
    resolutions[id] = results[i];
  });

  return new Response(JSON.stringify({ resolutions }), {
    headers: JSON_HEADERS,
  });
}

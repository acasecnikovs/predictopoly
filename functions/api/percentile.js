// Pages Function: POST /api/percentile
// Body: {
//   qid: string,
//   p: number in [0, 1],            // user's predicted probability
//   brier?: number in [0, 1],       // omitted for active-mode posts (no outcome yet)
//   mode?: "resolved" | "active",   // defaults to "resolved" for legacy callers
//   session_id?: string,            // anonymous random UUID from localStorage
// }
// Returns: { percentile: number in [0, 100], n: number }
//
// "percentile" = % of recorded resolved-mode players whose brier was strictly
// worse (higher) than yours on this question. Active-mode posts log the
// prediction (so we can compute population calibration server-side later)
// but always return percentile=0, n=0 - there's no brier to rank against
// until the question resolves.
//
// The client only renders percentile when n >= 3.

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  // Same-origin in prod; permissive CORS keeps local dev (:8787) usable.
  "Access-Control-Allow-Origin": "*",
};

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

export async function onRequestPost({ request, env }) {
  if (!env.DB) return bad("d1 not bound", 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return bad("bad json");
  }

  const qid = typeof body?.qid === "string" ? body.qid.trim() : "";
  const p = Number(body?.p);
  const hasBrier = body?.brier !== undefined && body?.brier !== null;
  const brier = hasBrier ? Number(body.brier) : null;
  const mode = body?.mode === "active" ? "active" : "resolved";
  // session_id is opaque to us - cap it conservatively to head off abuse.
  // crypto.randomUUID() output is 36 chars; allow up to 64 for forward room.
  const sessionId = typeof body?.session_id === "string" && body.session_id.length <= 64
    ? body.session_id
    : null;

  // Polymarket condition IDs are hex strings; cap at 80 to leave headroom
  // without inviting megabyte payloads.
  if (!qid || qid.length > 80) return bad("bad qid");
  if (!Number.isFinite(p) || p < 0 || p > 1) return bad("bad p");
  if (hasBrier && (!Number.isFinite(brier) || brier < 0 || brier > 1)) {
    return bad("bad brier");
  }
  // Resolved-mode posts must have a brier (existing behavior). Active-mode
  // posts may omit it - the question hasn't resolved yet.
  if (mode === "resolved" && !hasBrier) return bad("resolved needs brier");

  const db = env.DB;

  // Insert first, then read. Ordering means n always reflects the caller's
  // own row in the resolved branch.
  await db
    .prepare(
      "INSERT INTO predictions (qid, p, brier, mode, session_id) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(qid, p, brier, mode, sessionId)
    .run();

  // Active-mode posts don't get a percentile - there's no brier to rank
  // against. We logged the row for population stats and we're done.
  if (mode === "active") {
    return new Response(JSON.stringify({ percentile: 0, n: 0 }), { headers: JSON_HEADERS });
  }

  // Percentile counts only resolved-mode rows with a brier - active rows
  // would inflate `n` without contributing comparable scores.
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN brier > ?2 THEN 1 ELSE 0 END) AS worse
       FROM predictions
       WHERE qid = ?1 AND mode = 'resolved' AND brier IS NOT NULL`,
    )
    .bind(qid, brier)
    .first();

  const n = Number(row?.n) || 0;
  const worse = Number(row?.worse) || 0;
  const percentile = n > 0 ? (worse / n) * 100 : 0;

  return new Response(JSON.stringify({ percentile, n }), { headers: JSON_HEADERS });
}

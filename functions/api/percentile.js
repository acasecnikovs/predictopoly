// Pages Function: POST /api/percentile
// Body: { qid: string, brier: number in [0, 1] }
// Returns: { percentile: number in [0, 100], n: number }
// "percentile" = % of recorded players whose brier was strictly worse
// (higher) than yours on this question. The client only renders it when
// n >= 3 to avoid showing meaningless rankings on fresh questions.

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
  const brier = Number(body?.brier);

  // Polymarket condition IDs are hex strings; cap at 80 to leave headroom
  // without inviting megabyte payloads. Brier outside [0, 1] is impossible
  // for binary outcomes and signals a malformed client.
  if (!qid || qid.length > 80) return bad("bad qid");
  if (!Number.isFinite(brier) || brier < 0 || brier > 1) return bad("bad brier");

  const db = env.DB;

  // Insert first, then read. Ordering means n always reflects the caller's
  // own row, so a question's first-ever submitter sees percentile=0 / n=1
  // (client hides anything with n < 3 anyway).
  await db
    .prepare("INSERT INTO predictions (qid, brier) VALUES (?1, ?2)")
    .bind(qid, brier)
    .run();

  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN brier > ?2 THEN 1 ELSE 0 END) AS worse
       FROM predictions
       WHERE qid = ?1`,
    )
    .bind(qid, brier)
    .first();

  const n = Number(row?.n) || 0;
  const worse = Number(row?.worse) || 0;
  const percentile = n > 0 ? (worse / n) * 100 : 0;

  return new Response(JSON.stringify({ percentile, n }), { headers: JSON_HEADERS });
}

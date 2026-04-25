-- One row per prediction submitted to /api/percentile.
-- Brier score in [0, 1], lower is better. We need fast COUNT(*) and
-- COUNT(*) WHERE brier > ? grouped by qid, so the index covers both.
CREATE TABLE IF NOT EXISTS predictions (
  qid   TEXT NOT NULL,
  brier REAL NOT NULL,
  ts    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_predictions_qid_brier
  ON predictions(qid, brier);

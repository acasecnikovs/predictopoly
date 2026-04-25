"""Seed D1 predictions table with a synthetic baseline distribution per market.

The /api/percentile endpoint compares a real user's Brier score against all
prior submissions for the same question. With zero prior submissions the
client gates on n>=3 and never shows the badge, which kills the only
dopamine hit on the reveal screen.

This script generates ~30 synthetic Brier scores per market drawn from a
Gaussian centered on the lookback market price (p7 with fallbacks). The
distribution mimics "what humans who saw the question and gave roughly the
market answer plus noise would score". As real users come in, they layer
on top and gradually displace the synthetic baseline.

Output: data/seed_percentile.sql, run via:
    wrangler d1 execute predictopoly-stats --remote --file data/seed_percentile.sql

Synthetic rows use ts=0 to distinguish from real submissions if cleanup is
ever needed. The ts column isn't part of any percentile query so this has
no functional effect.
"""

import argparse
import json
import random
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HOT = REPO / "web" / "data" / "markets-hot.json"
ALL_MARKETS = REPO / "web" / "data" / "markets.json"
OUT = REPO / "data" / "seed_percentile.sql"

N_SYNTHETIC = 30   # synthetic players per market
SIGMA = 0.18       # noise around the market price
BATCH = 500        # SQL statements per batch (D1 has a 100KB command size cap)
SEED = 42          # reproducible


def synth_briers(p_market: float, outcome: int, n: int, rng: random.Random) -> list[float]:
    out = []
    for _ in range(n):
        p = rng.gauss(p_market, SIGMA)
        p = max(0.02, min(0.98, p))
        out.append((p - outcome) ** 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--scope",
        choices=["hot", "all-with-prices"],
        default="hot",
        help="hot = curated 87-market deck only; all-with-prices = every market that has a lookback price",
    )
    args = ap.parse_args()

    rng = random.Random(SEED)

    if args.scope == "hot":
        markets = json.loads(HOT.read_text())
    else:
        markets = json.loads(ALL_MARKETS.read_text())
        markets = [m for m in markets if m.get("p1") or m.get("p7") or m.get("p30")]

    rows = []
    for m in markets:
        outcome = int(m["o"])
        p_market = m.get("p7") or m.get("p1") or m.get("p30") or 0.5
        for brier in synth_briers(p_market, outcome, N_SYNTHETIC, rng):
            rows.append((str(m["id"]), round(brier, 6)))

    # Batched multi-row INSERTs. Each batch is one SQL statement separated
    # by ;. Wrangler streams the file as a series of statements, so big
    # files are fine, but individual statements have a size cap.
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        for i in range(0, len(rows), BATCH):
            chunk = rows[i : i + BATCH]
            values = ",".join(f"('{qid}',{brier},0)" for qid, brier in chunk)
            f.write(f"INSERT INTO predictions (qid, brier, ts) VALUES {values};\n")

    print(
        f"Wrote {len(rows)} synthetic predictions across {len(markets)} markets to {OUT}",
        file=sys.stderr,
    )
    print(f"Run: wrangler d1 execute predictopoly-stats --remote --file {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()

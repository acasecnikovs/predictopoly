"""Fetch currently-open Polymarket markets for the Active mode of predictopoly.

Reuses the gamma-api client from polymarket-bot. Output schema is parallel to
data/resolved_markets.parquet so 02_classify_markets.py can run unchanged
against this file (with --input flag, see 08_classify_active.py).

Filters applied here (cheap, deterministic):
  - closed=false, active=true (gamma flags)
  - endDate parses, endDate > now
  - days_to_resolve <= --max-days (default 90)
  - volume_1mo > 0  (activity floor: drops dead markets)

NOT applied here:
  - Volume floor: leave to deck UI so user can slide it.
  - Price extreme filter: deliberately kept so high-confidence calibration
    is testable. Removing easy markets is the UI's problem, not the data
    layer's.
  - Event dedup: keep all markets, tag event_id, sampler dedups per session.

Usage:
    python -m scripts.07_fetch_active [--max-days 90] [--out data/active_markets.parquet]
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"

# Vendored gamma-api helpers (see scripts/_gamma_api.py for upstream notes).
# Stays inside the repo so GitHub Actions runners don't need the polymarket-bot
# sibling checkout that the original local-only path required.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _gamma_api as api  # noqa: E402


def _parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _fnum(d, key, default=0.0):
    try:
        return float(d.get(key, default) or default)
    except (ValueError, TypeError):
        return default


def _event_id(m):
    events = m.get("events") or []
    if events and isinstance(events[0], dict):
        eid = events[0].get("id")
        return str(eid) if eid else None
    return None


def fetch_window(end_min: datetime, end_max: datetime) -> list[dict]:
    """One window of fetch_open_markets. Gamma cursor is ascending-by-endDate
    and caps at ~20k per call, so we slice the timeline into windows that
    each fit under the cap."""
    return api.fetch_open_markets(
        limit_per_page=100,
        max_pages=300,
        end_date_min=end_min.strftime("%Y-%m-%d"),
        end_date_max=end_max.strftime("%Y-%m-%d"),
        active_only=True,
    )


def fetch_all_active(now: datetime, max_days: float) -> list[dict]:
    """Slice the time horizon into windows so each fetch stays under the
    gamma pagination cap. Dedup on id since adjacent windows can overlap.

    Window step was 30 days originally; tightened to 7 days on 2026-04-29
    after the active deck grew past offset 7300, which is where gamma
    starts hard-500ing the /markets endpoint within a single filter set.
    A 7-day window holds ~1500-2000 active markets in practice, well
    under the cap with room for further deck growth before we hit it
    again. Tradeoff: ~13 windows for the default 90-day horizon instead
    of 3, adding ~30s of fetch time. Acceptable for the daily cron.
    """
    seen = {}
    cursor = now
    horizon = now + timedelta(days=max_days)
    step = timedelta(days=7)
    while cursor < horizon:
        window_end = min(cursor + step, horizon)
        batch = fetch_window(cursor, window_end)
        print(f"  window {cursor.date()} to {window_end.date()}: {len(batch)} raw", file=sys.stderr)
        for m in batch:
            mid = str(m.get("id", ""))
            if mid and mid not in seen:
                seen[mid] = m
        cursor = window_end
    return list(seen.values())


def to_row(m: dict, scan_time: datetime) -> dict | None:
    if m.get("closed") or m.get("archived"):
        return None
    end = _parse_iso(m.get("endDate"))
    if end is None or end <= scan_time:
        return None
    days = (end - scan_time).total_seconds() / 86400
    vol_1mo = _fnum(m, "volume1mo")
    if vol_1mo <= 0:
        return None
    yes_token, no_token = api.parse_clob_tokens(m)
    return {
        "id": str(m.get("id", "")),
        "event_id": _event_id(m),
        "slug": m.get("slug"),
        "question": m.get("question"),
        # Description is free here - the gamma list endpoint already returns
        # it. Keeping it in the parquet means 09_export_active_for_web.py can
        # ship a descriptions-active.json without a separate fetch pass.
        "description": m.get("description") or "",
        # Outcomes JSON ('["Yes","No"]' or '["Rublev","Medjedovic"]'). Drives
        # the YES/NO disambiguation in 09 - markets like "LoL: Weibo vs
        # Bilibili - Game 2 Winner" are unanswerable as YES/NO without
        # knowing which side YES is. Cheap to capture here.
        "outcomes": m.get("outcomes") or "",
        "category": None,
        "endDate": m.get("endDate"),
        "startDate": m.get("startDate"),
        "volume": _fnum(m, "volume"),
        "volume_1mo": vol_1mo,
        "liquidity": _fnum(m, "liquidity"),
        "last_trade_price": _fnum(m, "lastTradePrice"),
        "spread": _fnum(m, "spread"),
        "one_day_price_change": _fnum(m, "oneDayPriceChange"),
        "updated_at": m.get("updatedAt"),
        "days_to_resolve": round(days, 3),
        "yes_token": yes_token,
        "no_token": no_token,
        "scan_time": scan_time.isoformat(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-days", type=float, default=90,
                    help="Drop markets resolving more than N days out (default 90)")
    ap.add_argument("--out", default=str(DATA / "active_markets.parquet"))
    args = ap.parse_args()

    scan_time = datetime.now(timezone.utc)
    print(f"fetching active markets, max-days={args.max_days}", file=sys.stderr)
    raw = fetch_all_active(scan_time, args.max_days)
    print(f"raw deduped: {len(raw)}", file=sys.stderr)

    rows = []
    for m in raw:
        row = to_row(m, scan_time)
        if row is not None:
            rows.append(row)
    print(f"after filters: {len(rows)}", file=sys.stderr)

    df = pd.DataFrame(rows)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, index=False)
    print(f"wrote {out} ({len(df)} rows)", file=sys.stderr)

    if len(df):
        print("\n--- volume distribution ---", file=sys.stderr)
        for floor in [0, 100, 1_000, 10_000, 100_000, 1_000_000]:
            n = (df["volume"] >= floor).sum()
            print(f"  vol >= ${floor:>10,}: {n:>5}", file=sys.stderr)
        print("\n--- days-to-resolve buckets ---", file=sys.stderr)
        for lo, hi in [(0, 7), (7, 30), (30, 90), (90, 365)]:
            n = ((df["days_to_resolve"] >= lo) & (df["days_to_resolve"] < hi)).sum()
            print(f"  {lo:>3}-{hi:<4}d: {n:>5}", file=sys.stderr)
        print(f"\n--- unique events: {df['event_id'].nunique()} ---", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())

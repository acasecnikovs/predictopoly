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


def fetch_window(end_min: datetime, end_max: datetime) -> tuple[list[dict], bool]:
    """One window of fetch_open_markets. Returns (markets, capped)."""
    return api.fetch_open_markets(
        limit_per_page=100,
        max_pages=300,
        end_date_min=end_min.strftime("%Y-%m-%d"),
        end_date_max=end_max.strftime("%Y-%m-%d"),
        active_only=True,
    )


# Gamma's /markets cap is load-dependent: it 500s at variable offsets - sometimes
# 3900, sometimes 200 - on the same query minutes apart. Verified by running the
# script three times back-to-back on 2026-04-29 and seeing the same window cap
# at three different offsets. Static window sizes can't fix this. Adaptive
# splitting can: when a window comes back capped, halve the date range and
# recurse on each half. Each split queries fewer markets, so the smaller
# request stays under whatever ceiling gamma is enforcing right now.
MIN_SPLIT_HOURS = 12  # don't split finer than half a day; below this, accept partial
MAX_SPLIT_DEPTH = 6   # 7d -> 3.5d -> 1.75d -> ~21h -> ~10h floor; safety cap


def fetch_window_adaptive(start: datetime, end: datetime, depth: int = 0) -> list[dict]:
    """Fetch one date window. If gamma caps it, split and recurse on both halves.

    Returns the union of all markets covered. Outer caller dedups on id.
    """
    batch, capped = fetch_window(start, end)
    span_h = (end - start).total_seconds() / 3600
    if not capped or depth >= MAX_SPLIT_DEPTH or span_h <= MIN_SPLIT_HOURS:
        # Either we got the full window, hit the recursion floor, or the window
        # is already too narrow to split usefully. Take what we have.
        if capped:
            print(
                f"  window {start.date()} to {end.date()} ({span_h:.1f}h) "
                f"still capped after split depth {depth}; accepting "
                f"partial {len(batch)} markets",
                file=sys.stderr,
            )
        return batch

    # Capped: split. Use the last endDate we received as the pivot when
    # possible (more efficient than midpoint - we know everything left of
    # that endDate is already covered). Fall back to date midpoint if the
    # batch is empty or has unparseable dates.
    pivot = None
    if batch:
        last_end_str = batch[-1].get("endDate")
        if last_end_str:
            try:
                pivot = datetime.fromisoformat(last_end_str.replace("Z", "+00:00"))
            except ValueError:
                pivot = None
    if pivot is None or pivot <= start or pivot >= end:
        pivot = start + (end - start) / 2

    print(
        f"  splitting {start.date()}..{end.date()} at {pivot.date()} "
        f"(depth {depth}, got {len(batch)} so far)",
        file=sys.stderr,
    )
    # Left half is already covered by `batch` up to pivot. Only re-fetch the
    # right half, which is the part gamma refused.
    right = fetch_window_adaptive(pivot, end, depth + 1)
    return batch + right


def fetch_all_active(now: datetime, max_days: float) -> list[dict]:
    """Slice the time horizon into 7-day windows; each window does adaptive
    split if gamma caps it. Dedup on id since adjacent windows can overlap.

    Window step was 30 days originally; tightened to 7 days on 2026-04-29
    after the active deck grew past gamma's per-query cap. Combined with
    fetch_window_adaptive's recursive splitting, that handles both deck
    growth (more markets per window) and gamma load variance (cap drops
    to surprising offsets under load).
    """
    seen = {}
    cursor = now
    horizon = now + timedelta(days=max_days)
    step = timedelta(days=7)
    while cursor < horizon:
        window_end = min(cursor + step, horizon)
        batch = fetch_window_adaptive(cursor, window_end)
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

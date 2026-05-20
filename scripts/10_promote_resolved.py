"""Promote just-closed active markets into the resolved past-deck.

Runs FIRST in the daily workflow, before 07_fetch_active overwrites
active_markets_classified.parquet. The pipeline now is:

  10_promote_resolved -> 07_fetch_active -> 08_classify_active
   -> 09_export_active_for_web -> 03_export_for_web -> commit

What it does:
  1. Read data/active_markets_classified.parquet (yesterday's snapshot).
  2. Filter to rows with endDate < now and id not already in
     data/resolved_markets_classified.parquet. Idempotent: re-runs on the
     same day promote nothing the second time.
  3. For each candidate, hit gamma /markets/{id} to confirm closed=true
     AND a clear binary outcome (outcomePrices[i] >= 0.99 for exactly one
     side, with "Yes" recognized case-insensitive in outcomes). Anything
     ambiguous gets skipped - the past-deck must never lie about an
     outcome, the active resolver bug from 2026-04-27 made that lesson
     expensive enough.
  4. For each confirmed resolution, pull T-1d, T-7d, T-30d YES prices via
     CLOB /prices-history at hourly fidelity. Missing samples (market
     started less than 30 days before close) get null - 03_export_for_web
     already handles None in p_yes_*d.
  5. Append to data/resolved_markets_classified.parquet,
     data/lookback_prices.parquet, and data/descriptions.jsonl. Each
     append preserves the existing on-disk schema exactly so
     03_export_for_web stays unchanged.

If data/active_markets_classified.parquet doesn't exist (very first run
after deploy, or someone wiped the data dir), exits 0 silently with a
log line - there's nothing to promote yet, the next 07/08 will seed it
and tomorrow's 10 will start producing output.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _gamma_api as api  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"

ACTIVE_IN = DATA / "active_markets_classified.parquet"
RESOLVED_OUT = DATA / "resolved_markets_classified.parquet"
LOOKBACK_OUT = DATA / "lookback_prices.parquet"
DESCS_OUT = DATA / "descriptions.jsonl"

# Margin used to declare an outcome final. Polymarket convention: the
# winning side's outcomePrice settles at >=0.99 (often exactly 1.0).
# Loosening below 0.99 risks promoting a market that's still disputing.
OUTCOME_CONFIDENCE = 0.99

# Max markets to promote per run. Safety cap: a backlog of weeks at first
# deploy could otherwise blow through gamma quota in one run. Daily cron
# at 5-50 expirations/day stays well under this. If we ever hit the cap,
# tomorrow's run picks up the rest (still ordered by endDate ascending).
MAX_PROMOTE_PER_RUN = 500


def _parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def _winner_from_gamma(m: dict) -> tuple[str | None, int | None]:
    """Return (winner_label, outcome_yes) or (None, None) if ambiguous.

    outcome_yes is 1 if the side labeled 'Yes' (case-insensitive) won, 0 if
    the other side won. We resolve YES by reading outcomes, not by index -
    the 2026-04-27 inverted-mapping bug in check-resolution.js was caused
    by assuming index 1 = YES. Same fix here.
    """
    if not m.get("closed"):
        return None, None
    prices = m.get("outcomePrices")
    outcomes = m.get("outcomes")
    if isinstance(prices, str):
        try:
            prices = json.loads(prices)
        except Exception:
            prices = None
    if isinstance(outcomes, str):
        try:
            outcomes = json.loads(outcomes)
        except Exception:
            outcomes = None
    if not isinstance(prices, list) or len(prices) != 2:
        return None, None
    if not isinstance(outcomes, list) or len(outcomes) != 2:
        return None, None
    try:
        p0, p1 = float(prices[0]), float(prices[1])
    except (ValueError, TypeError):
        return None, None
    yes_idx = None
    for i, o in enumerate(outcomes):
        if str(o).strip().lower() == "yes":
            yes_idx = i
            break
    if yes_idx is None:
        # Non-binary outcome set ("Up"/"Down", team names, etc). For those
        # we treat outcomes[0] as YES by convention, matching 03_export and
        # the descriptions.jsonl 'outcomes' field that the web client uses
        # for YES/NO disambiguation.
        yes_idx = 0
    no_idx = 1 - yes_idx
    if (p0 if yes_idx == 0 else p1) >= OUTCOME_CONFIDENCE:
        return str(outcomes[yes_idx]), 1
    if (p0 if no_idx == 0 else p1) >= OUTCOME_CONFIDENCE:
        return str(outcomes[no_idx]), 0
    return None, None


def _lookback_prices(yes_token: str, close_unix: int) -> dict:
    """Pull T-1d/T-7d/T-30d YES prices. Returns dict of float-or-None."""
    out = {}
    for label, days in [("p_yes_1d", 1), ("p_yes_7d", 7), ("p_yes_30d", 30)]:
        target = close_unix - days * 86400
        try:
            p = api.fetch_price_at_time(yes_token, target)
        except Exception as e:
            print(f"    lookback {label}: {type(e).__name__} {e}", file=sys.stderr)
            p = None
        out[label] = p
    return out


def _existing_resolved_ids() -> set[str]:
    if not RESOLVED_OUT.exists():
        return set()
    df = pd.read_parquet(RESOLVED_OUT, columns=["id"])
    return set(df["id"].astype(str).tolist())


def _existing_desc_ids() -> set[str]:
    if not DESCS_OUT.exists():
        return set()
    out = set()
    with DESCS_OUT.open() as f:
        for line in f:
            try:
                out.add(str(json.loads(line)["id"]))
            except Exception:
                continue
    return out


def main():
    if not ACTIVE_IN.exists():
        print(f"  {ACTIVE_IN.name} missing; nothing to promote yet.", file=sys.stderr)
        return 0

    active = pd.read_parquet(ACTIVE_IN)
    if len(active) == 0:
        print("  active snapshot empty; nothing to promote.", file=sys.stderr)
        return 0

    now = datetime.now(timezone.utc)
    already = _existing_resolved_ids()

    # Stable ordering: expired oldest-first, so a multi-day backlog promotes
    # the staler half first and the cap clips the freshest tail.
    active["_end_parsed"] = active["endDate"].map(_parse_iso)
    expired = active[active["_end_parsed"].notna()
                     & (active["_end_parsed"] < now)
                     & (~active["id"].astype(str).isin(already))]
    expired = expired.sort_values("_end_parsed").head(MAX_PROMOTE_PER_RUN)

    if len(expired) == 0:
        print("  no expired-since-last-run markets in the active snapshot.", file=sys.stderr)
        return 0

    print(f"  candidates: {len(expired)} expired-and-not-yet-in-past", file=sys.stderr)

    new_resolved_rows: list[dict] = []
    new_lookback_rows: list[dict] = []
    new_desc_lines: list[dict] = []
    skipped_unresolved = 0
    skipped_ambiguous = 0
    skipped_no_token = 0
    skipped_gamma_miss = 0

    for row in expired.itertuples(index=False):
        mid = str(row.id)
        try:
            m = api.fetch_market(mid)
        except Exception as e:
            print(f"  {mid}: gamma fetch {type(e).__name__}: {e}", file=sys.stderr)
            skipped_gamma_miss += 1
            continue
        if not m:
            skipped_gamma_miss += 1
            continue
        if not m.get("closed"):
            skipped_unresolved += 1
            continue
        winner, outcome_yes = _winner_from_gamma(m)
        if winner is None:
            skipped_ambiguous += 1
            continue

        yes_token = getattr(row, "yes_token", None) or None
        no_token = getattr(row, "no_token", None) or None
        # Re-derive from gamma if the snapshot didn't carry the token (older
        # active rows pre-clob-token export). Cheap fallback.
        if not yes_token:
            yes_token, no_token = api.parse_clob_tokens(m)
        if not yes_token:
            skipped_no_token += 1
            continue

        close_iso = m.get("closedTime") or m.get("endDate") or row.endDate
        close_dt = _parse_iso(close_iso)
        if close_dt is None:
            close_dt = row._end_parsed
        close_unix = int(close_dt.timestamp())

        lookbacks = _lookback_prices(yes_token, close_unix)

        cat = getattr(row, "category", None)
        sub = getattr(row, "subcategory", None)
        volume = float(getattr(row, "volume", 0.0) or 0.0)
        liquidity = float(getattr(row, "liquidity", 0.0) or 0.0)
        last_trade_price = float(getattr(row, "last_trade_price", 0.0) or 0.0)
        spread = float(getattr(row, "spread", 0.0) or 0.0)

        # closedTime in resolved_markets_classified is a tz-aware timestamp
        # in pandas dtype 'object' for the seed scrape (looks like
        # '2026-03-19 23:20:15+00'). We match that string shape rather than
        # introduce a new dtype, to keep the parquet schema homogenous.
        closedTime_str = close_dt.strftime("%Y-%m-%d %H:%M:%S+00")

        new_resolved_rows.append({
            "id": mid,
            "slug": getattr(row, "slug", None) or m.get("slug"),
            "question": getattr(row, "question", None) or m.get("question") or "",
            "endDate": getattr(row, "endDate", None) or m.get("endDate"),
            "closedTime": closedTime_str,
            "startDate": getattr(row, "startDate", None) or m.get("startDate"),
            "volume": volume,
            "liquidity": liquidity,
            "winner": "YES" if outcome_yes == 1 else "NO",
            "outcome_yes": int(outcome_yes),
            "last_trade_price": last_trade_price,
            "spread": spread,
            "yes_token": yes_token,
            "no_token": no_token,
            "category": cat,
            "subcategory": sub,
        })

        new_lookback_rows.append({
            "id": mid,
            "slug": getattr(row, "slug", None) or m.get("slug"),
            "outcome_yes": int(outcome_yes),
            "endDate": getattr(row, "endDate", None) or m.get("endDate"),
            "closedTime": closedTime_str,
            "category": cat,
            "volume": volume,
            "question": getattr(row, "question", None) or m.get("question") or "",
            "p_yes_1d": lookbacks["p_yes_1d"],
            "p_yes_7d": lookbacks["p_yes_7d"],
            "p_yes_30d": lookbacks["p_yes_30d"],
        })

        # descriptions.jsonl line mirrors 05_fetch_descriptions output shape.
        # active_markets_classified already carries description + outcomes,
        # so we don't need an extra gamma round-trip for it.
        new_desc_lines.append({
            "id": mid,
            "desc": (getattr(row, "description", None) or m.get("description") or "").strip(),
            "start": getattr(row, "startDate", None) or m.get("startDate") or "",
            "image": m.get("image") or "",
            "outcomes": getattr(row, "outcomes", None) or m.get("outcomes") or "",
            "resolved_by": m.get("resolvedBy") or "",
            "group": m.get("groupItemTitle") or "",
            "ok": True,
        })

    if not new_resolved_rows:
        print(
            f"  nothing promotable. "
            f"unresolved={skipped_unresolved} ambiguous={skipped_ambiguous} "
            f"no_token={skipped_no_token} gamma_miss={skipped_gamma_miss}",
            file=sys.stderr,
        )
        return 0

    # Append to parquet by reading + concat + write. Parquet has no native
    # append; this is fine at our scale (37k+N rows, tens of MB). Sort by id
    # for stable git diffs.
    existing_resolved = pd.read_parquet(RESOLVED_OUT) if RESOLVED_OUT.exists() else pd.DataFrame()
    merged_resolved = pd.concat(
        [existing_resolved, pd.DataFrame(new_resolved_rows)], ignore_index=True
    )
    merged_resolved = merged_resolved.sort_values("id", kind="stable").reset_index(drop=True)
    merged_resolved.to_parquet(RESOLVED_OUT, index=False)

    existing_lookback = pd.read_parquet(LOOKBACK_OUT) if LOOKBACK_OUT.exists() else pd.DataFrame()
    merged_lookback = pd.concat(
        [existing_lookback, pd.DataFrame(new_lookback_rows)], ignore_index=True
    )
    merged_lookback = merged_lookback.sort_values("id", kind="stable").reset_index(drop=True)
    merged_lookback.to_parquet(LOOKBACK_OUT, index=False)

    # descriptions.jsonl is append-only and skips ids already present so we
    # don't double-write if 10 was re-run by hand on the same day.
    already_desc = _existing_desc_ids()
    appended_desc = 0
    with DESCS_OUT.open("a") as f:
        for rec in new_desc_lines:
            if rec["id"] in already_desc:
                continue
            f.write(json.dumps(rec) + "\n")
            appended_desc += 1

    print(
        f"  promoted: {len(new_resolved_rows)} markets "
        f"(skip unresolved={skipped_unresolved}, ambiguous={skipped_ambiguous}, "
        f"no_token={skipped_no_token}, gamma_miss={skipped_gamma_miss}); "
        f"+{appended_desc} description lines.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

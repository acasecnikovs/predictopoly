"""One-shot backfill of resolved markets in a date window.

Closes the gap between the seed scrape (2026-04-24) and when 10_promote_resolved
started running daily (2026-05-21). Any market that opened before 2026-04-24,
was open at seed time, and resolved during the gap exists in neither source.

This script scrapes gamma for closed markets ending in [start, end], classifies
them via gemini using the same taxonomy as 08_classify_active, pulls
T-1d/T-7d/T-30d YES prices via CLOB, and appends rows to
  data/resolved_markets_classified.parquet
  data/lookback_prices.parquet
  data/descriptions.jsonl
matching the schemas 03_export_for_web already reads.

Idempotent: dedups against existing resolved ids. Re-running on the same
window adds nothing new (modulo markets that flipped from open to closed
since the previous run).

Usage:
    GEMINI_API_KEY=... python scripts/11_backfill_resolved.py \
        --start 2026-04-24 --end 2026-05-21
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
sys.path.insert(0, str(REPO / "scripts"))
import _gamma_api as api  # noqa: E402

RESOLVED_OUT = DATA / "resolved_markets_classified.parquet"
LOOKBACK_OUT = DATA / "lookback_prices.parquet"
DESCS_OUT = DATA / "descriptions.jsonl"

OUTCOME_CONFIDENCE = 0.99
GAMMA = "https://gamma-api.polymarket.com"
LOOKBACK_WORKERS = 20  # CLOB tolerates this fine, gauged from 05_fetch_descriptions

# Match 10_promote_resolved filters. Two-axis quality gate:
#   - duration >= 7 days (seed median 7.2d; below is reactive markets)
#   - volume >= $5000 (seed P25 ~$5500; below means underuse)
# Without these, a 30-day backfill pulls 230k+ closed markets - mostly
# 5-min crypto, daily candles, and tiny per-event sports lines. With
# both, the same window yields a few thousand forecastable markets that
# share calibration character with the original seed.
MIN_DURATION_HOURS = 168.0  # 7 days
MIN_VOLUME = 9000.0

# Classification batching matches 02 / 08 exactly so results stay
# distributionally identical to the rest of the past deck.
BATCH_SIZE = 200
SLEEP_BETWEEN = 0.5
MAX_RETRIES = 8
MODEL = "gemini-2.5-flash-lite"
TAXONOMY = None  # filled in main() from 08_classify_active import

# Gamma list endpoint cap behaviour matches the open-side fetch in 07: 500/422
# at variable offsets. Same adaptive split fixes it.
MIN_SPLIT_HOURS = 12
MAX_SPLIT_DEPTH = 6


def _fetch_closed_window(end_min: str, end_max: str,
                         start_max: str,
                         volume_min: float,
                         limit_per_page: int = 100,
                         max_pages: int = 300) -> tuple[list[dict], bool]:
    """List closed markets with endDate in [end_min, end_max], startDate
    not later than start_max (enforces duration), volume not below
    volume_min. Returns (markets, capped) - cap convention same as
    fetch_open_markets in _gamma_api.

    Pushing duration and volume into the gamma query eliminates the
    99% of casino-style markets that the post-fetch filter would
    otherwise discard, dropping a backfill run's raw API traffic
    from 234k to ~15k for a 30-day window.
    """
    out = []
    offset = 0
    capped = False
    for _ in range(max_pages):
        params = {
            "closed": "true",
            "limit": limit_per_page,
            "offset": offset,
            "order": "endDate",
            "ascending": "true",
            "end_date_min": end_min,
            "end_date_max": end_max,
            "start_date_max": start_max,
            "volume_num_min": int(volume_min),
        }
        url = f"{GAMMA}/markets?{urlencode(params)}"
        req = Request(url, headers={
            "User-Agent": "predictopoly-backfill/0.1",
            "Accept": "application/json",
        })
        try:
            with urlopen(req, timeout=45) as r:
                batch = json.loads(r.read())
        except HTTPError as e:
            if e.code >= 500 or e.code == 422:
                print(f"  gamma {e.code} at offset={offset} window {end_min}..{end_max} - capped",
                      file=sys.stderr)
                capped = True
                break
            raise
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < limit_per_page:
            break
        offset += limit_per_page
        time.sleep(0.25)
    return out, capped


def _fetch_closed_adaptive(start: datetime, end: datetime, depth: int = 0) -> list[dict]:
    end_min = start.strftime("%Y-%m-%d")
    end_max = end.strftime("%Y-%m-%d")
    # Duration filter pushed to gamma: startDate must be at least
    # MIN_DURATION_HOURS earlier than the window's latest endDate. Markets
    # with endDate inside the window but startDate after start_max have
    # duration < MIN_DURATION_HOURS and are excluded server-side.
    start_max = (end - timedelta(hours=MIN_DURATION_HOURS)).strftime("%Y-%m-%d")
    batch, capped = _fetch_closed_window(end_min, end_max, start_max, MIN_VOLUME)
    span_h = (end - start).total_seconds() / 3600
    if not capped or depth >= MAX_SPLIT_DEPTH or span_h <= MIN_SPLIT_HOURS:
        if capped:
            print(f"  window {end_min}..{end_max} still capped at depth {depth}; "
                  f"accepting partial {len(batch)} markets", file=sys.stderr)
        return batch
    pivot = None
    if batch:
        last_end = batch[-1].get("endDate")
        if last_end:
            try:
                pivot = datetime.fromisoformat(last_end.replace("Z", "+00:00"))
            except ValueError:
                pivot = None
    pivot_from_batch = pivot is not None and start < pivot < end
    if not pivot_from_batch:
        pivot = start + (end - start) / 2
    print(f"  split {end_min}..{end_max} at {pivot.date()} (depth {depth}, "
          f"got {len(batch)})", file=sys.stderr)
    right = _fetch_closed_adaptive(pivot, end, depth + 1)
    if pivot_from_batch:
        return batch + right
    left = _fetch_closed_adaptive(start, pivot, depth + 1)
    return left + right


def fetch_closed_in_range(start: datetime, end: datetime) -> list[dict]:
    """Slice [start, end] into 3-day windows, fetch + adaptive-split each."""
    seen: dict[str, dict] = {}
    cursor = start
    step = timedelta(days=3)
    while cursor < end:
        window_end = min(cursor + step, end)
        batch = _fetch_closed_adaptive(cursor, window_end)
        new_here = 0
        for m in batch:
            mid = str(m.get("id", ""))
            if mid and mid not in seen:
                seen[mid] = m
                new_here += 1
        print(f"  window {cursor.date()}..{window_end.date()}: "
              f"+{new_here} (running total {len(seen)})", file=sys.stderr)
        cursor = window_end
    return list(seen.values())


def existing_resolved_ids() -> set[str]:
    if not RESOLVED_OUT.exists():
        return set()
    df = pd.read_parquet(RESOLVED_OUT, columns=["id"])
    return set(df["id"].astype(str).tolist())


def existing_desc_ids() -> set[str]:
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


def winner_from_gamma(m: dict) -> tuple[str | None, int | None]:
    """Same logic as 10_promote_resolved._winner_from_gamma. Inlined to keep
    11 standalone and survivable if 10 is ever rewritten."""
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
        yes_idx = 0
    no_idx = 1 - yes_idx
    if (p0 if yes_idx == 0 else p1) >= OUTCOME_CONFIDENCE:
        return str(outcomes[yes_idx]), 1
    if (p0 if no_idx == 0 else p1) >= OUTCOME_CONFIDENCE:
        return str(outcomes[no_idx]), 0
    return None, None


def parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def lookback_one(args: tuple[str, str, int]) -> tuple[str, dict]:
    mid, yes_token, close_unix = args
    out = {}
    for label, days in [("p_yes_1d", 1), ("p_yes_7d", 7), ("p_yes_30d", 30)]:
        try:
            p = api.fetch_price_at_time(yes_token, close_unix - days * 86400)
        except Exception:
            p = None
        out[label] = p
    return mid, out


def classify_batch(model, batch):
    """Same as 08_classify_active.classify_batch. Inlined for standalone."""
    from google.api_core import exceptions as gexc
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = model.generate_content(_build_prompt(batch))
            text = resp.text.strip()
            if text.startswith("```"):
                lines = text.splitlines()
                text = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
            data = json.loads(text)
            if len(data) != len(batch):
                raise ValueError(f"expected {len(batch)} got {len(data)}")
            return data
        except gexc.ResourceExhausted as e:
            wait = 30 * (attempt + 1)
            print(f"  rate limit, sleep {wait}s", file=sys.stderr)
            time.sleep(wait)
            last_err = e
        except (json.JSONDecodeError, ValueError) as e:
            print(f"  parse error attempt {attempt+1}: {e}", file=sys.stderr)
            time.sleep(2)
            last_err = e
    raise RuntimeError(f"classify failed: {last_err}")


def _build_prompt(batch):
    qs = "\n".join(f"{i+1}. {q}" for i, q in enumerate(batch))
    return f"""Classify each Polymarket question into the taxonomy below.
Return ONLY a JSON array of {len(batch)} objects, one per question in order.
Each object: {{"i": <question-number>, "cat": "<category>", "sub": "<subcategory>"}}
Use the EXACT category and subcategory names from the taxonomy. If truly
unclassifiable, use Miscellaneous / Unclassified.

TAXONOMY:
{TAXONOMY}

QUESTIONS:
{qs}

Output JSON array only, no preamble, no markdown fence:"""


def main():
    global TAXONOMY
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-04-24", help="endDate min (inclusive)")
    ap.add_argument("--end", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                    help="endDate max (inclusive)")
    args = ap.parse_args()

    # Pull taxonomy from 08 so a future edit there propagates here unchanged.
    sys.path.insert(0, str(REPO / "scripts"))
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "classify_active", REPO / "scripts" / "08_classify_active.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    TAXONOMY = mod.TAXONOMY

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        sys.exit("GEMINI_API_KEY not set")
    import google.generativeai as genai
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(MODEL)

    start_dt = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
    end_dt = datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc) + timedelta(days=1)
    print(f"backfill window: {start_dt.date()} .. {end_dt.date()}", file=sys.stderr)

    # === Stage 1: scrape closed markets ===
    raw = fetch_closed_in_range(start_dt, end_dt)
    print(f"\nstage1 done: {len(raw)} closed markets in window", file=sys.stderr)

    # === Stage 2: dedup + filter for clear resolution ===
    already = existing_resolved_ids()
    candidates = []
    skipped_dup = skipped_ambiguous = skipped_no_token = skipped_short = 0
    for m in raw:
        mid = str(m.get("id", ""))
        if not mid:
            continue
        if mid in already:
            skipped_dup += 1
            continue
        start_dt_m = parse_iso(m.get("startDate"))
        end_dt_m = parse_iso(m.get("endDate"))
        if start_dt_m and end_dt_m:
            duration_h = (end_dt_m - start_dt_m).total_seconds() / 3600
            if duration_h < MIN_DURATION_HOURS:
                skipped_short += 1
                continue
        try:
            mvol = float(m.get("volume") or 0)
        except (ValueError, TypeError):
            mvol = 0
        if mvol < MIN_VOLUME:
            skipped_short += 1
            continue
        winner, oy = winner_from_gamma(m)
        if winner is None:
            skipped_ambiguous += 1
            continue
        yes_token, no_token = api.parse_clob_tokens(m)
        if not yes_token:
            skipped_no_token += 1
            continue
        m["_winner"] = winner
        m["_outcome_yes"] = oy
        m["_yes_token"] = yes_token
        m["_no_token"] = no_token
        candidates.append(m)
    print(
        f"stage2 done: {len(candidates)} new candidates "
        f"(skip dup={skipped_dup} short={skipped_short} "
        f"ambiguous={skipped_ambiguous} no_token={skipped_no_token})",
        file=sys.stderr,
    )
    if not candidates:
        print("nothing to backfill.", file=sys.stderr)
        return 0

    # === Stage 3: classify via gemini in batches ===
    classifications: dict[str, dict] = {}
    questions = [(str(m["id"]), m.get("question") or "") for m in candidates]
    total_batches = (len(questions) + BATCH_SIZE - 1) // BATCH_SIZE
    for b in range(total_batches):
        s = b * BATCH_SIZE
        e = min(s + BATCH_SIZE, len(questions))
        ids = [q[0] for q in questions[s:e]]
        qs = [q[1] for q in questions[s:e]]
        t0 = time.time()
        try:
            results = classify_batch(model, qs)
        except Exception as ex:
            print(f"batch {b+1}/{total_batches} FAILED: {ex}", file=sys.stderr)
            continue
        for r, mid in zip(results, ids):
            classifications[mid] = {
                "cat": r.get("cat") or "Miscellaneous",
                "sub": r.get("sub") or "Unclassified",
            }
        elapsed = time.time() - t0
        print(f"classify batch {b+1}/{total_batches} ({len(qs)} q, {elapsed:.1f}s)",
              file=sys.stderr)
        if b < total_batches - 1:
            time.sleep(max(0, SLEEP_BETWEEN - elapsed))
    print(f"stage3 done: {len(classifications)} classified", file=sys.stderr)

    # === Stage 4: parallel lookback price fetch ===
    lookback_args = []
    for m in candidates:
        close_dt = parse_iso(m.get("closedTime")) or parse_iso(m.get("endDate"))
        if close_dt is None:
            continue
        lookback_args.append((str(m["id"]), m["_yes_token"], int(close_dt.timestamp())))
    lookbacks: dict[str, dict] = {}
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=LOOKBACK_WORKERS) as pool:
        futures = {pool.submit(lookback_one, a): a[0] for a in lookback_args}
        for fut in as_completed(futures):
            mid, lb = fut.result()
            lookbacks[mid] = lb
            done += 1
            if done % 200 == 0:
                rate = done / (time.time() - t0)
                print(f"  lookback {done}/{len(lookback_args)} ({rate:.1f}/s)",
                      file=sys.stderr)
    print(f"stage4 done: {len(lookbacks)} lookback fetches, {time.time()-t0:.1f}s",
          file=sys.stderr)

    # === Stage 5: build append rows ===
    new_resolved: list[dict] = []
    new_lookback: list[dict] = []
    new_desc: list[dict] = []
    already_desc = existing_desc_ids()
    for m in candidates:
        mid = str(m["id"])
        cls = classifications.get(mid, {"cat": "Miscellaneous", "sub": "Unclassified"})
        close_dt = parse_iso(m.get("closedTime")) or parse_iso(m.get("endDate"))
        if close_dt is None:
            continue
        closed_str = close_dt.strftime("%Y-%m-%d %H:%M:%S+00")
        lb = lookbacks.get(mid, {"p_yes_1d": None, "p_yes_7d": None, "p_yes_30d": None})
        try:
            vol = float(m.get("volume") or 0.0)
        except (ValueError, TypeError):
            vol = 0.0
        try:
            liq = float(m.get("liquidity") or 0.0)
        except (ValueError, TypeError):
            liq = 0.0
        try:
            ltp = float(m.get("lastTradePrice") or 0.0)
        except (ValueError, TypeError):
            ltp = 0.0
        try:
            spread = float(m.get("spread") or 0.0)
        except (ValueError, TypeError):
            spread = 0.0
        new_resolved.append({
            "id": mid,
            "slug": m.get("slug"),
            "question": m.get("question") or "",
            "endDate": m.get("endDate"),
            "closedTime": closed_str,
            "startDate": m.get("startDate"),
            "volume": vol,
            "liquidity": liq,
            "winner": "YES" if m["_outcome_yes"] == 1 else "NO",
            "outcome_yes": int(m["_outcome_yes"]),
            "last_trade_price": ltp,
            "spread": spread,
            "yes_token": m["_yes_token"],
            "no_token": m["_no_token"],
            "category": cls["cat"],
            "subcategory": cls["sub"],
        })
        new_lookback.append({
            "id": mid,
            "slug": m.get("slug"),
            "outcome_yes": int(m["_outcome_yes"]),
            "endDate": m.get("endDate"),
            "closedTime": closed_str,
            "category": cls["cat"],
            "volume": vol,
            "question": m.get("question") or "",
            "p_yes_1d": lb["p_yes_1d"],
            "p_yes_7d": lb["p_yes_7d"],
            "p_yes_30d": lb["p_yes_30d"],
        })
        if mid not in already_desc:
            outcomes = m.get("outcomes")
            if isinstance(outcomes, list):
                outcomes = json.dumps(outcomes)
            new_desc.append({
                "id": mid,
                "desc": (m.get("description") or "").strip(),
                "start": m.get("startDate") or "",
                "image": m.get("image") or "",
                "outcomes": outcomes or "",
                "resolved_by": m.get("resolvedBy") or "",
                "group": m.get("groupItemTitle") or "",
                "ok": True,
            })

    if not new_resolved:
        print("nothing to write after stage5.", file=sys.stderr)
        return 0

    # === Stage 6: append + write ===
    existing_resolved = pd.read_parquet(RESOLVED_OUT) if RESOLVED_OUT.exists() else pd.DataFrame()
    merged = pd.concat([existing_resolved, pd.DataFrame(new_resolved)], ignore_index=True)
    merged = merged.sort_values("id", kind="stable").reset_index(drop=True)
    merged.to_parquet(RESOLVED_OUT, index=False)

    existing_lb = pd.read_parquet(LOOKBACK_OUT) if LOOKBACK_OUT.exists() else pd.DataFrame()
    merged_lb = pd.concat([existing_lb, pd.DataFrame(new_lookback)], ignore_index=True)
    merged_lb = merged_lb.sort_values("id", kind="stable").reset_index(drop=True)
    merged_lb.to_parquet(LOOKBACK_OUT, index=False)

    with DESCS_OUT.open("a") as f:
        for rec in new_desc:
            f.write(json.dumps(rec) + "\n")

    print(
        f"\nDONE. wrote {len(new_resolved)} resolved rows, "
        f"{len(new_lookback)} lookback rows, +{len(new_desc)} description lines.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

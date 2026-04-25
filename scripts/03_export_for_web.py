"""Convert classified parquet into a browser-ready JSON bundle.

Outputs web/data/markets.json with a trimmed record shape optimized for
client-side filtering and display. Also writes taxonomy.json for the UI
filter dropdowns.
"""

import json
import sys
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
WEB = REPO / "web"

INPUT_MARKETS = DATA / "resolved_markets_classified.parquet"
INPUT_PRICES = DATA / "lookback_prices.parquet"
INPUT_DESCS = DATA / "descriptions.jsonl"  # optional, from 05_fetch_descriptions
OUT_MARKETS = WEB / "data" / "markets.json"
OUT_TAXONOMY = WEB / "data" / "taxonomy.json"
# Cloudflare Pages caps individual files at 25 MiB. The full descriptions
# blob is ~25.1 MiB, so shard by `int(id) % DESC_SHARDS` and have the client
# fetch all shards in parallel and merge.
DESC_SHARDS = 4
OUT_DESCRIPTIONS = [WEB / "data" / f"descriptions-{i}.json" for i in range(DESC_SHARDS)]
# Polymarket URL slugs (~2 MB raw / ~400KB brotli) - only used on the reveal
# screen's "view on Polymarket" link, so lazy-loaded the same way descriptions
# are. Single file since well under the 25 MiB cap.
OUT_SLUGS = WEB / "data" / "slugs.json"


def load_descriptions():
    """Returns dict id -> {'d': str, 'start': str, 'image': str}. Empty if file missing."""
    if not INPUT_DESCS.exists():
        return {}
    out = {}
    with INPUT_DESCS.open() as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not r.get("ok"):
                continue
            rid = str(r["id"])
            out[rid] = {
                "d": (r.get("desc") or "").strip(),
                "start": (r.get("start") or "")[:10],
                "image": r.get("image") or "",
                "outcomes": r.get("outcomes") or "",
            }
    return out


def yes_label(outcomes_json):
    """Returns a plain-English 'YES means ...' label if outcomes aren't just Yes/No.
    E.g. outcomes='["Rublev","Medjedovic"]' -> 'Rublev'. Returns '' for generic Yes/No.
    """
    if not outcomes_json:
        return ""
    try:
        arr = json.loads(outcomes_json)
    except (ValueError, TypeError):
        return ""
    if not isinstance(arr, list) or not arr:
        return ""
    first = str(arr[0]).strip()
    if first.lower() in ("yes", "true", "1"):
        return ""  # generic binary
    return first


def main():
    if not INPUT_MARKETS.exists():
        sys.exit(f"{INPUT_MARKETS} missing - run 02_classify_markets.py first")

    markets = pd.read_parquet(INPUT_MARKETS)
    prices = pd.read_parquet(INPUT_PRICES)
    descs = load_descriptions()
    print(f"Loaded {len(descs)} descriptions", file=sys.stderr)

    # Merge lookback prices for "market said" comparisons after reveal
    price_cols = prices[["id", "p_yes_1d", "p_yes_7d", "p_yes_30d"]].copy()
    price_cols["id"] = price_cols["id"].astype(str)
    markets["id_str"] = markets["id"].astype(str)
    merged = markets.merge(
        price_cols, left_on="id_str", right_on="id", how="left", suffixes=("", "_p")
    ).drop(columns=["id_str", "id_p"], errors="ignore")

    # Trim to web shape. Short keys to minimize JSON size.
    out = []
    for row in merged.itertuples(index=False):
        q = (row.question or "").strip()
        if not q:
            continue
        cat = getattr(row, "category", None) or "Miscellaneous"
        sub = getattr(row, "subcategory", None) or "Unclassified"
        # Date-lock safety: only include lookback prices (seen BEFORE close)
        p1 = None if pd.isna(row.p_yes_1d) else round(float(row.p_yes_1d), 4)
        p7 = None if pd.isna(row.p_yes_7d) else round(float(row.p_yes_7d), 4)
        p30 = None if pd.isna(row.p_yes_30d) else round(float(row.p_yes_30d), 4)
        rid = str(row.id)
        desc_info = descs.get(rid, {})
        rec = {
            "id": rid,
            "q": q,
            "o": int(row.outcome_yes),       # outcome (0/1)
            "c": cat,                         # category
            "s": sub,                         # subcategory
            "v": round(float(row.volume), 0) if not pd.isna(row.volume) else 0,
            "t": str(row.closedTime)[:10],    # close date (YYYY-MM-DD)
            "p1": p1,                         # market price 1d before close
            "p7": p7,                         # market price 7d before close
            "p30": p30,                       # market price 30d before close
        }
        rec["_slug"] = str(row.slug)  # split out below into slugs.json (lazy-loaded)
        if desc_info.get("start"):
            rec["ts"] = desc_info["start"]    # start date (YYYY-MM-DD)
        yn = yes_label(desc_info.get("outcomes"))
        if yn:
            rec["yn"] = yn                    # plain-English label for what YES means
        out.append(rec)

    # Sort by volume desc so "top N" filtering gives good default markets
    out.sort(key=lambda r: -r["v"])

    # Build separate descriptions map keyed by id. Pulled out of markets.json
    # so the initial page load doesn't pay for ~30MB of long-form text - the
    # client lazy-loads this file in the background after first paint.
    desc_shards = [{} for _ in range(DESC_SHARDS)]
    desc_total = 0
    slug_map = {}
    for rec in out:
        info = descs.get(rec["id"], {})
        d_text = info.get("d")
        if d_text:
            try:
                idx = int(rec["id"]) % DESC_SHARDS
            except ValueError:
                idx = sum(rec["id"].encode()) % DESC_SHARDS
            desc_shards[idx][rec["id"]] = d_text
            desc_total += 1
        slug = rec.pop("_slug", None)
        if slug:
            slug_map[rec["id"]] = slug

    WEB.mkdir(exist_ok=True)
    (WEB / "data").mkdir(exist_ok=True)
    with OUT_MARKETS.open("w") as f:
        json.dump(out, f, separators=(",", ":"))
    with OUT_SLUGS.open("w") as f:
        json.dump(slug_map, f, separators=(",", ":"))
    for path, shard in zip(OUT_DESCRIPTIONS, desc_shards):
        with path.open("w") as f:
            json.dump(shard, f, separators=(",", ":"))

    # Build taxonomy from observed data (not the proposal - we trust the
    # classifier's actual output in case it hallucinated buckets)
    from collections import Counter, defaultdict
    pairs = Counter((r["c"], r["s"]) for r in out)
    tax = defaultdict(list)
    for (c, s), n in pairs.most_common():
        tax[c].append({"sub": s, "n": n})

    # Category order: by total volume of markets in it
    cat_volume = defaultdict(float)
    for r in out:
        cat_volume[r["c"]] += r["v"]
    ordered = sorted(tax.keys(), key=lambda c: -cat_volume[c])
    taxonomy_out = {c: tax[c] for c in ordered}

    with OUT_TAXONOMY.open("w") as f:
        json.dump(taxonomy_out, f, indent=2)

    size_mb = OUT_MARKETS.stat().st_size / 1024 / 1024
    slugs_mb = OUT_SLUGS.stat().st_size / 1024 / 1024
    print(f"Wrote {OUT_MARKETS} ({len(out)} markets, {size_mb:.2f} MB)", file=sys.stderr)
    print(f"Wrote {OUT_SLUGS.name} ({len(slug_map)} slugs, {slugs_mb:.2f} MB)", file=sys.stderr)
    for path in OUT_DESCRIPTIONS:
        mb = path.stat().st_size / 1024 / 1024
        print(f"Wrote {path.name} ({mb:.2f} MB)", file=sys.stderr)
    print(f"Total descriptions: {desc_total} across {DESC_SHARDS} shards", file=sys.stderr)
    print(f"Wrote {OUT_TAXONOMY}", file=sys.stderr)
    print(f"\nCategory counts (by volume-weighted order):", file=sys.stderr)
    for c in ordered:
        n = sum(x["n"] for x in tax[c])
        print(f"  {c}: {n} markets ({len(tax[c])} subs)", file=sys.stderr)


if __name__ == "__main__":
    main()

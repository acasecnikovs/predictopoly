"""Convert classified active parquet into a browser-ready JSON bundle.

Outputs web/data/markets-active.json with a trimmed record shape parallel to
markets.json but adapted for unresolved markets:
  - no `o` (outcome) - replaced by `p_now` (current lastTradePrice) so the
    reveal panel can show "you said X, market says Y" instantly
  - `end` (close date) instead of `t` (which was historic close in resolved)
  - `days` (days_to_resolve) for the UI to show "resolves in N days"
  - `ev` (event_id) so the sampler can dedup multi-outcome events at sample
    time (one market per event per session)

Inlines the same normalization that 04_normalize_taxonomy.py runs on the
resolved set: canonical sub map, soundbite sweep, crypto-speculation sweep,
NFL-coach topic sweep, sub aliases. Forking 04's 380 lines for a slightly
different output shape would be worse than ~80 lines of duplicated intent
here. If the resolved-side rules ever drift, sync deliberately.

No hot picks (those are hand-curated against resolved outcomes), no
descriptions sidecar yet (will add when the active reveal panel needs more
than question + price).
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
WEB = REPO / "web" / "data"

INPUT = DATA / "active_markets_classified.parquet"
OUT_MARKETS = WEB / "markets-active.json"
OUT_SLUGS = WEB / "slugs-active.json"
OUT_TAXONOMY = WEB / "taxonomy-active.json"

# --- normalization, ported from 04_normalize_taxonomy.py ---

CANONICAL = {
    "US Politics": ["Presidential Elections", "Nominations & Primaries",
                    "Policy & Governance", "Appointments"],
    "World Politics": ["Non-US Elections", "International Relations & Conflicts"],
    "Economy & Finance": ["Monetary Policy", "Macroeconomics", "Financial Markets"],
    "AI & Tech": ["Model Releases & Benchmarks", "Tech Companies"],
    "Crypto": ["Price Predictions", "Speculation", "Protocol & Launches",
               "Crypto Regulation"],
    "Sports": ["NFL", "NBA", "MLB", "NHL", "Global Soccer", "Combat Sports",
               "Tennis", "F1 & Motorsport", "Olympics & Multi-sport",
               "eSports", "Other Sports"],
    "Culture & Media": ["Movies, TV & Awards", "Social Media",
                        "Celebrity & Events", "Soundbites"],
    "Science": ["Space", "Weather & Disasters", "Health & Science"],
    "Miscellaneous": ["Unclassified"],
}

SUB_TO_PARENT = {sub: parent for parent, subs in CANONICAL.items() for sub in subs}
VALID_TOPS = set(CANONICAL.keys())

ALIASES = {
    "College sports": ("Sports", "Other Sports"),
    "Tech": ("AI & Tech", "Tech Companies"),
    "Health": ("Science", "Health & Science"),
}

SUB_ALIASES = {
    ("Sports", "College sports"): ("Sports", "Other Sports"),
    ("Sports", "NCAA Basketball"): ("Sports", "Other Sports"),
    ("Sports", "NCAA"): ("Sports", "Other Sports"),
    ("Sports", "WNBA"): ("Sports", "NBA"),
    ("Sports", "Golf"): ("Sports", "Other Sports"),
    ("Sports", "Boxing"): ("Sports", "Combat Sports"),
    ("World Politics", "Global Soccer"): ("Sports", "Global Soccer"),
    ("World Politics", "Foreign leadership changes"): ("World Politics", "Non-US Elections"),
    ("World Politics", "Foreign Leadership Changes"): ("World Politics", "Non-US Elections"),
    ("World Politics", "Military actions"): ("World Politics", "International Relations & Conflicts"),
    ("World Politics", "Policy & Governance"): ("World Politics", "International Relations & Conflicts"),
    ("World Politics", "Economy & Finance"): ("World Politics", "International Relations & Conflicts"),
    ("World Politics", "Miscellaneous"): ("Miscellaneous", "Unclassified"),
    ("US Politics", "International Relations & Conflicts"): ("World Politics", "International Relations & Conflicts"),
    ("US Politics", "Miscellaneous"): ("US Politics", "Policy & Governance"),
    ("US Politics", "Unclassified"): ("US Politics", "Policy & Governance"),
    ("Crypto", "Combat Sports"): ("Sports", "Combat Sports"),
    ("Crypto", "Tech Companies"): ("AI & Tech", "Tech Companies"),
    ("Crypto", "Miscellaneous"): ("Crypto", "Price Predictions"),
    ("Crypto", "Unclassified"): ("Crypto", "Price Predictions"),
    ("AI & Tech", "eSports"): ("Sports", "eSports"),
    ("AI & Tech", "Social Media"): ("Culture & Media", "Social Media"),
    ("AI & Tech", "Miscellaneous"): ("AI & Tech", "Tech Companies"),
    ("AI & Tech", "AI Regulation"): ("AI & Tech", "Tech Companies"),
    ("Economy & Finance", "Unclassified"): ("Economy & Finance", "Macroeconomics"),
    ("Economy & Finance", "Miscellaneous"): ("Economy & Finance", "Macroeconomics"),
    ("Culture & Media", "eSports"): ("Sports", "eSports"),
    ("Culture & Media", "Other Sports"): ("Sports", "Other Sports"),
    ("Culture & Media", "Culture & Media"): ("Culture & Media", "Celebrity & Events"),
    ("Culture & Media", "Tech Companies"): ("AI & Tech", "Tech Companies"),
    ("Culture & Media", "Miscellaneous"): ("Culture & Media", "Celebrity & Events"),
    ("Culture & Media", "Unclassified"): ("Culture & Media", "Celebrity & Events"),
    ("US Politics", "AI Regulation"): ("AI & Tech", "Tech Companies"),
    ("Science", "Science"): ("Science", "Health & Science"),
    ("Science", "Miscellaneous"): ("Science", "Health & Science"),
    ("Science", "Unclassified"): ("Science", "Health & Science"),
}

SOUNDBITE_PATTERNS = [
    re.compile(r"\bsay\s+[\"\u201c\u2018]", re.IGNORECASE),
    re.compile(r"\btweet\b.+(?:times|between|\d+\s*-\s*\d+)", re.IGNORECASE),
    re.compile(r"\bpost\b.+\d+\s*-\s*\d+", re.IGNORECASE),
    re.compile(r"\bwill\s+\S+\s+wear\b.+\b(?:during|at|to)\b", re.IGNORECASE),
]

CRYPTO_TICKERS = (
    r"bitcoin|ethereum|solana|btc|eth|sol|xrp|ripple|dogecoin|doge|cardano|ada|"
    r"avax|avalanche|litecoin|ltc|chainlink|polkadot|polygon|matic|uniswap|"
    r"tron|trx|stellar|xlm|usdc|usdt|tether|bnb|near|pepe|shiba|shib|ethbtc|"
    r"bonk|sui|aptos|apt|wif|fartcoin|trumpcoin|memecoin|memecoins"
)
SPECULATION_PATTERNS = [
    re.compile(rf"(?ix)\b(?:{CRYPTO_TICKERS})\b.{{0,80}}"
               r"(?:above|below|over|under|reach|hit|exceed|dip\s+to|"
               r"drop\s+below|drop\s+to|rise\s+to|cross|new\s+ath|"
               r"all[\s-]?time[\s-]?high)"),
    re.compile(rf"(?ix)\b(?:{CRYPTO_TICKERS})\b.{{0,80}}\$\d"),
    re.compile(r"\bup\s+or\s+down\b", re.IGNORECASE),
    re.compile(r"(?i)what\s+will\s+the\s+price\s+of\s+\$?\w+\s+be\b"),
    re.compile(rf"(?ix)\b(?:{CRYPTO_TICKERS})\b.{{0,40}}all[\s-]?time[\s-]?high"),
]

TOPIC_SWEEPS = [
    (re.compile(
        r"(?i)\b(?:Jets|Patriots|Cowboys|Saints|Bears|Jaguars|Raiders|Chargers|"
        r"Giants|Eagles|Commanders|Broncos|Seahawks|Falcons|Panthers|49ers|"
        r"Steelers|Rams|Vikings|Lions|Bengals|Browns|Titans|Texans|Colts|"
        r"Bills|Dolphins|Ravens|Chiefs|Buccaneers|Cardinals|Packers)\b"
        r".+\bhire\b.+\b(?:head coach|coach|GM|general manager)\b"
    ), ("Sports", "NFL")),
]


def is_soundbite(q: str) -> bool:
    return any(p.search(q or "") for p in SOUNDBITE_PATTERNS)


def is_speculation(q: str) -> bool:
    return any(p.search(q or "") for p in SPECULATION_PATTERNS)


# "Who will win" rewrite, ported from 03. Active markets often have
# multi-outcome event slices but we don't have outcomes JSON yet, so this
# only fires if a future descriptions step adds it. Keep the helper here
# so the schema is forward-compatible.
_WHO_WILL_WIN_RE = re.compile(r"^who will win\b", re.IGNORECASE)


def disambiguate_question(q: str, yn: str) -> str:
    if not yn or not q:
        return q
    if _WHO_WILL_WIN_RE.match(q):
        return _WHO_WILL_WIN_RE.sub(f"Will {yn} win", q, count=1)
    return q


def normalize(records):
    """In-place. Returns counters for logging."""
    soundbited = speculated = swept = fixed = dropped = 0

    for m in records:
        if is_soundbite(m["q"]):
            if (m["c"], m["s"]) != ("Culture & Media", "Soundbites"):
                m["c"], m["s"] = "Culture & Media", "Soundbites"
                soundbited += 1

    for m in records:
        if (m["c"], m["s"]) == ("Culture & Media", "Soundbites"):
            continue
        if is_speculation(m["q"]):
            if (m["c"], m["s"]) != ("Crypto", "Speculation"):
                m["c"], m["s"] = "Crypto", "Speculation"
                speculated += 1

    for m in records:
        if (m["c"], m["s"]) in {("Culture & Media", "Soundbites"),
                                 ("Crypto", "Speculation")}:
            continue
        for pat, (nc, ns) in TOPIC_SWEEPS:
            if pat.search(m["q"]):
                if (m["c"], m["s"]) != (nc, ns):
                    m["c"], m["s"] = nc, ns
                    swept += 1
                break

    for m in records:
        c, s = m["c"], m["s"]
        if (c, s) in SUB_ALIASES:
            m["c"], m["s"] = SUB_ALIASES[(c, s)]
            c, s = m["c"], m["s"]
            fixed += 1
        if c in VALID_TOPS:
            if s in CANONICAL[c]:
                continue
            if s in SUB_TO_PARENT and SUB_TO_PARENT[s] == c:
                continue
            m["s"] = "Unclassified" if c == "Miscellaneous" else s
            continue
        if c in ALIASES:
            m["c"], m["s"] = ALIASES[c]
            fixed += 1
        elif c in SUB_TO_PARENT:
            m["s"] = c
            m["c"] = SUB_TO_PARENT[c]
            fixed += 1
        else:
            m["c"], m["s"] = "Miscellaneous", "Unclassified"
            dropped += 1

    return {
        "soundbited": soundbited,
        "speculated": speculated,
        "swept": swept,
        "fixed": fixed,
        "dropped": dropped,
    }


def main():
    if not INPUT.exists():
        sys.exit(f"{INPUT} missing - run 08_classify_active.py first")

    df = pd.read_parquet(INPUT)
    print(f"Loaded {len(df)} active markets", file=sys.stderr)

    records = []
    skipped_no_price = 0
    for row in df.itertuples(index=False):
        q = (row.question or "").strip()
        if not q:
            continue
        # Active markets without a current price are useless for the instant
        # feedback ("market says X") UX. Drop them.
        p_now = float(row.last_trade_price) if not pd.isna(row.last_trade_price) else None
        if p_now is None or p_now <= 0 or p_now >= 1:
            # Polymarket sometimes ships exactly 0 or 1 on stale markets.
            # Both useless for calibration feedback - skip.
            skipped_no_price += 1
            continue
        cat = row.category or "Miscellaneous"
        sub = row.subcategory or "Unclassified"
        rec = {
            "id": str(row.id),
            "q": q,
            "c": cat,
            "s": sub,
            "v": round(float(row.volume), 0) if not pd.isna(row.volume) else 0,
            "p_now": round(p_now, 4),
            "end": str(row.endDate)[:10] if row.endDate else "",
            "days": round(float(row.days_to_resolve), 1) if not pd.isna(row.days_to_resolve) else None,
            "ev": str(row.event_id) if row.event_id else None,
        }
        rec["_slug"] = str(row.slug) if row.slug else ""
        records.append(rec)

    print(f"Skipped {skipped_no_price} markets with degenerate prices "
          f"(<=0 or >=1)", file=sys.stderr)

    stats = normalize(records)
    print(f"Normalized: {stats}", file=sys.stderr)

    # Sort by volume desc - good default for "top N" sliders
    records.sort(key=lambda r: -r["v"])

    slug_map = {}
    for rec in records:
        slug = rec.pop("_slug", "")
        if slug:
            slug_map[rec["id"]] = slug

    WEB.mkdir(parents=True, exist_ok=True)
    with OUT_MARKETS.open("w") as f:
        json.dump(records, f, separators=(",", ":"))
    with OUT_SLUGS.open("w") as f:
        json.dump(slug_map, f, separators=(",", ":"))

    pairs = Counter((r["c"], r["s"]) for r in records)
    tax = defaultdict(list)
    for (c, s), n in pairs.most_common():
        tax[c].append({"sub": s, "n": n})

    cat_volume = defaultdict(float)
    for r in records:
        cat_volume[r["c"]] += r["v"]
    ordered = sorted(tax.keys(), key=lambda c: -cat_volume[c])
    taxonomy_out = {c: tax[c] for c in ordered}

    with OUT_TAXONOMY.open("w") as f:
        json.dump(taxonomy_out, f, indent=2)

    size_kb = OUT_MARKETS.stat().st_size / 1024
    slugs_kb = OUT_SLUGS.stat().st_size / 1024
    print(f"\nWrote {OUT_MARKETS.name} ({len(records)} markets, {size_kb:.1f} KB)",
          file=sys.stderr)
    print(f"Wrote {OUT_SLUGS.name} ({len(slug_map)} slugs, {slugs_kb:.1f} KB)",
          file=sys.stderr)
    print(f"Wrote {OUT_TAXONOMY.name}", file=sys.stderr)
    print("\nCategory counts (volume-ordered):", file=sys.stderr)
    for c in ordered:
        n = sum(x["n"] for x in tax[c])
        print(f"  {c}: {n} markets ({len(tax[c])} subs)", file=sys.stderr)


if __name__ == "__main__":
    main()

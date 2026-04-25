"""Fix markets where classifier put a subcategory in the top-level `c` field.

Remaps leaked subs back to their correct parent top-level, regenerates
web/data/markets.json and web/data/taxonomy.json.

Also runs a pattern-based sweep that pulls noisy meme markets ("Will X say
'Y' during Z?", "Will X tweet 100-110 times?", "Will X wear Y?") into a
single Culture & Media > Soundbites bucket regardless of the classifier's
original guess. These markets aren't really about politics or tech - the
question is whether a person performs a specific verbal/social act, which is
celebrity/culture territory.
"""

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web" / "data"

# Canonical taxonomy: top-level -> list of valid subs
CANONICAL = {
    "US Politics": [
        "Presidential Elections", "Nominations & Primaries",
        "Policy & Governance", "Appointments",
    ],
    "World Politics": [
        "Non-US Elections", "International Relations & Conflicts",
    ],
    "Economy & Finance": [
        "Monetary Policy", "Macroeconomics", "Financial Markets",
    ],
    "AI & Tech": [
        # AI Regulation merged into Tech Companies (only 26 markets, mostly
        # about tech-regulation of the same companies anyway).
        "Model Releases & Benchmarks", "Tech Companies",
    ],
    "Crypto": [
        # Speculation = pure price-target gambling shape ("BTC hit $100k by Y").
        # Default-excluded from Hot picks - terrible first impression for fresh
        # users since you can't calibrate "what will Bitcoin do" without domain
        # knowledge or insider info. The remaining Price Predictions are real
        # event questions (Satoshi reveal, USDC/USDT flip, MicroStrategy buys).
        "Price Predictions", "Speculation", "Protocol & Launches", "Crypto Regulation",
    ],
    "Sports": [
        "NFL", "NBA", "MLB", "NHL", "Global Soccer", "Combat Sports",
        "Tennis", "F1 & Motorsport", "Olympics & Multi-sport",
        # eSports moved here from Culture & Media - these are competitive
        # match outcomes, same shape as NBA/NFL questions.
        "eSports",
        "Other Sports",
    ],
    "Culture & Media": [
        "Movies, TV & Awards", "Social Media", "Celebrity & Events",
        # Soundbites = "Will X say 'Y' during Z?", "Will X tweet 80-99 times?",
        # "Will X wear Y?" - performative meme markets that aren't really about
        # the topic on the surface. Default-excluded from Hot picks in the UI.
        "Soundbites",
    ],
    "Science": [
        "Space", "Weather & Disasters", "Health & Science",
    ],
    "Miscellaneous": ["Unclassified"],
}

# Pattern-based sweep into Culture & Media > Soundbites. Runs FIRST so it
# overrides whatever the classifier chose - the question shape ("X says Y") is
# more reliable than the surface topic.
SOUNDBITE_PATTERNS = [
    re.compile(r"\bsay\s+[\"\u201c\u2018]", re.IGNORECASE),       # say "Word" / say "Phrase"
    re.compile(r"\btweet\b.+(?:times|between|\d+\s*-\s*\d+)", re.IGNORECASE),  # tweet count bingo
    re.compile(r"\bpost\b.+\d+\s*-\s*\d+", re.IGNORECASE),                     # post X-Y times (Truth Social, X)
    re.compile(r"\bwill\s+\S+\s+wear\b.+\b(?:during|at|to)\b", re.IGNORECASE), # wear-during bingo
]

# Crypto price-target shape: "Bitcoin hit $100k by Friday", "ETH above $4k on
# date", "Ripple all time high in 2024", "What will the price of $DOGE be on...".
# Routed to Crypto > Speculation. These are unforgiving number-targeting bets
# that fresh users have no shot at calibrating - bad first impression.
CRYPTO_TICKERS = (
    r"bitcoin|ethereum|solana|btc|eth|sol|xrp|ripple|dogecoin|doge|cardano|ada|"
    r"avax|avalanche|litecoin|ltc|chainlink|polkadot|polygon|matic|uniswap|"
    r"tron|trx|stellar|xlm|usdc|usdt|tether|bnb|near|pepe|shiba|shib|ethbtc|"
    r"bonk|sui|aptos|apt|wif|fartcoin|trumpcoin|memecoin|memecoins"
)
SPECULATION_PATTERNS = [
    # "<ticker> ... above|below|over|under|reach|hit|exceed|dip $X"
    re.compile(rf"(?ix)\b(?:{CRYPTO_TICKERS})\b.{{0,80}}"
               r"(?:above|below|over|under|reach|hit|exceed|dip\s+to|"
               r"drop\s+below|drop\s+to|rise\s+to|cross|new\s+ath|"
               r"all[\s-]?time[\s-]?high)"),
    # "<ticker> ... $<number>"
    re.compile(rf"(?ix)\b(?:{CRYPTO_TICKERS})\b.{{0,80}}\$\d"),
    # "Up or Down" coinflips
    re.compile(r"\bup\s+or\s+down\b", re.IGNORECASE),
    # "What will the price of $<TICKER> be on..."
    re.compile(r"(?i)what\s+will\s+the\s+price\s+of\s+\$?\w+\s+be\b"),
    # "<ticker> all time high in 2024"
    re.compile(rf"(?ix)\b(?:{CRYPTO_TICKERS})\b.{{0,40}}all[\s-]?time[\s-]?high"),
]

# Topic-pattern sweeps: question shape strongly implies a category that the
# classifier got wrong. Tuple: (compiled regex, (top, sub)). Applied right
# after the soundbite sweep, before SUB_ALIASES.
TOPIC_SWEEPS = [
    # "Will the <NFL team> hire X as their next head coach?" - 66 markets,
    # 16 classified into US Politics > Appointments by the classifier.
    (re.compile(
        r"(?i)\b(?:Jets|Patriots|Cowboys|Saints|Bears|Jaguars|Raiders|Chargers|"
        r"Giants|Eagles|Commanders|Broncos|Seahawks|Falcons|Panthers|49ers|"
        r"Steelers|Rams|Vikings|Lions|Bengals|Browns|Titans|Texans|Colts|"
        r"Bills|Dolphins|Ravens|Chiefs|Buccaneers|Cardinals|Packers)\b"
        r".+\bhire\b.+\b(?:head coach|coach|GM|general manager)\b"
    ), ("Sports", "NFL")),
]

# Build reverse map: sub-name -> parent top
SUB_TO_PARENT = {}
for parent, subs in CANONICAL.items():
    for sub in subs:
        SUB_TO_PARENT[sub] = parent

# Manual fixes for common classifier typos / near-misses
ALIASES = {
    "College sports": ("Sports", "Other Sports"),
    "Tech": ("AI & Tech", "Tech Companies"),
    "Health": ("Science", "Health & Science"),
}

# Sub-level remappings: (top, bad_sub) -> (top, good_sub). Applied first, BEFORE
# the cross-category leak check, so we can both (a) rename subs within a top and
# (b) move rows to a different top entirely.
SUB_ALIASES = {
    # eSports stays in Sports now - no remap needed
    # Within-Sports drift
    ("Sports", "College sports"): ("Sports", "Other Sports"),
    ("Sports", "NCAA Basketball"): ("Sports", "Other Sports"),
    ("Sports", "NCAA"): ("Sports", "Other Sports"),
    ("Sports", "WNBA"): ("Sports", "NBA"),
    ("Sports", "Golf"): ("Sports", "Other Sports"),
    ("Sports", "Boxing"): ("Sports", "Combat Sports"),

    # World Politics noise / cross-category leaks
    ("World Politics", "Global Soccer"): ("Sports", "Global Soccer"),
    ("World Politics", "Foreign leadership changes"): ("World Politics", "Non-US Elections"),
    ("World Politics", "Foreign Leadership Changes"): ("World Politics", "Non-US Elections"),
    ("World Politics", "Military actions"): ("World Politics", "International Relations & Conflicts"),
    ("World Politics", "Policy & Governance"): ("World Politics", "International Relations & Conflicts"),
    ("World Politics", "Economy & Finance"): ("World Politics", "International Relations & Conflicts"),
    ("World Politics", "Miscellaneous"): ("Miscellaneous", "Unclassified"),

    # US Politics noise
    ("US Politics", "International Relations & Conflicts"): ("World Politics", "International Relations & Conflicts"),
    ("US Politics", "Miscellaneous"): ("US Politics", "Policy & Governance"),
    ("US Politics", "Unclassified"): ("US Politics", "Policy & Governance"),

    # Crypto leaks
    ("Crypto", "Combat Sports"): ("Sports", "Combat Sports"),
    ("Crypto", "Tech Companies"): ("AI & Tech", "Tech Companies"),
    ("Crypto", "Miscellaneous"): ("Crypto", "Price Predictions"),
    ("Crypto", "Unclassified"): ("Crypto", "Price Predictions"),

    # AI & Tech leaks
    ("AI & Tech", "eSports"): ("Sports", "eSports"),  # eSports lives in Sports now
    ("AI & Tech", "Social Media"): ("Culture & Media", "Social Media"),
    ("AI & Tech", "Miscellaneous"): ("AI & Tech", "Tech Companies"),
    # AI Regulation folded into Tech Companies - only 26 markets and mostly
    # about regulation of the same companies anyway.
    ("AI & Tech", "AI Regulation"): ("AI & Tech", "Tech Companies"),

    # Economy & Finance noise
    ("Economy & Finance", "Unclassified"): ("Economy & Finance", "Macroeconomics"),
    ("Economy & Finance", "Miscellaneous"): ("Economy & Finance", "Macroeconomics"),

    # Culture & Media noise / self-ref
    ("Culture & Media", "eSports"): ("Sports", "eSports"),  # eSports moved to Sports
    ("Culture & Media", "Culture & Media"): ("Culture & Media", "Celebrity & Events"),
    ("Culture & Media", "Tech Companies"): ("AI & Tech", "Tech Companies"),
    ("Culture & Media", "Miscellaneous"): ("Culture & Media", "Celebrity & Events"),
    ("Culture & Media", "Unclassified"): ("Culture & Media", "Celebrity & Events"),

    # Science noise / self-ref
    ("Science", "Science"): ("Science", "Health & Science"),
    ("Science", "Miscellaneous"): ("Science", "Health & Science"),
    ("Science", "Unclassified"): ("Science", "Health & Science"),
}

VALID_TOPS = set(CANONICAL.keys())

# Curated allowlist for the "Hot picks" preset. One ID per line. Built by
# scripts/hot_pick_prompt.md being scored by Gemini 2.5 Pro against ~750
# candidates. See scripts/hot_picks_with_reasons.json for per-ID rationale.
HOT_PICKS_FILE = Path(__file__).resolve().parent / "hot_picks.txt"


def load_hot_ids() -> set:
    if not HOT_PICKS_FILE.exists():
        return set()
    return {line.strip() for line in HOT_PICKS_FILE.read_text().splitlines() if line.strip()}


def is_soundbite(question: str) -> bool:
    return any(p.search(question or "") for p in SOUNDBITE_PATTERNS)


def is_speculation(question: str) -> bool:
    return any(p.search(question or "") for p in SPECULATION_PATTERNS)


def main():
    markets = json.load(open(WEB / "markets.json"))
    fixed = 0
    dropped = 0
    soundbited = 0

    # Pass 0a: pattern-based sweep into Soundbites. Runs first because the
    # question shape is a more reliable signal than the classifier's category.
    for m in markets:
        if is_soundbite(m.get("q", "")):
            if (m.get("c"), m.get("s")) != ("Culture & Media", "Soundbites"):
                m["c"] = "Culture & Media"
                m["s"] = "Soundbites"
                soundbited += 1

    # Pass 0b: crypto-speculation sweep. Pure price-target shapes get pulled
    # into Crypto > Speculation regardless of where the classifier put them
    # (some land in Economy & Finance, some in Crypto > Price Predictions, a
    # few stragglers elsewhere). Default-excluded from Hot picks in the UI.
    speculated = 0
    for m in markets:
        if (m.get("c"), m.get("s")) == ("Culture & Media", "Soundbites"):
            continue
        if is_speculation(m.get("q", "")):
            if (m.get("c"), m.get("s")) != ("Crypto", "Speculation"):
                m["c"] = "Crypto"
                m["s"] = "Speculation"
                speculated += 1

    # Pass 0c: topic-shape sweeps. If a question matches a known shape (e.g.
    # NFL coach hires) override whatever the classifier picked.
    swept = 0
    for m in markets:
        if (m.get("c"), m.get("s")) in {("Culture & Media", "Soundbites"),
                                         ("Crypto", "Speculation")}:
            continue  # already swept above
        q = m.get("q", "")
        for pat, (new_c, new_s) in TOPIC_SWEEPS:
            if pat.search(q):
                if (m.get("c"), m.get("s")) != (new_c, new_s):
                    m["c"], m["s"] = new_c, new_s
                    swept += 1
                break

    # Pass 0d: stamp `hot:true` on the curated allowlist. This is the source
    # of truth for the "Hot picks" preset in the UI - 130-200 hand-picked
    # questions for the fresh-user opening experience. See hot_pick_prompt.md.
    hot_ids = load_hot_ids()
    hot_count = 0
    for m in markets:
        if m["id"] in hot_ids:
            m["hot"] = True
            hot_count += 1
        else:
            m.pop("hot", None)

    print(f"Soundbited (speech/tweet/wear/post bingo): {soundbited}")
    print(f"Speculated (crypto price targets):         {speculated}")
    print(f"Topic-swept (NFL hires etc.):              {swept}")
    print(f"Hot picks (curated):                       {hot_count} / {len(hot_ids)} expected")

    for m in markets:
        c, s = m.get("c", ""), m.get("s", "")

        # Apply sub-level aliases first (keyed on current top+sub)
        if (c, s) in SUB_ALIASES:
            new_c, new_s = SUB_ALIASES[(c, s)]
            m["c"], m["s"] = new_c, new_s
            c, s = new_c, new_s
            fixed += 1

        if c in VALID_TOPS:
            # Top is valid. Check sub is valid for that top.
            if s in CANONICAL[c]:
                continue
            # sub is wrong for this top - try to keep top, relabel sub
            if s in SUB_TO_PARENT and SUB_TO_PARENT[s] == c:
                continue  # already fine
            # unknown sub - fall through to miscellaneous
            m["s"] = "Unclassified" if c == "Miscellaneous" else s
            continue

        # Top is not valid. Try to remap.
        if c in ALIASES:
            new_top, new_sub = ALIASES[c]
            m["c"] = new_top
            m["s"] = new_sub
            fixed += 1
        elif c in SUB_TO_PARENT:
            # c was actually a sub-name - promote its real parent, keep c as sub
            m["s"] = c
            m["c"] = SUB_TO_PARENT[c]
            fixed += 1
        else:
            # truly unknown - send to Miscellaneous
            m["c"] = "Miscellaneous"
            m["s"] = "Unclassified"
            dropped += 1

    print(f"Fixed leaked subs: {fixed}")
    print(f"Dropped to Misc:   {dropped}")

    # Rewrite markets.json
    with open(WEB / "markets.json", "w") as f:
        json.dump(markets, f, separators=(",", ":"))

    # Hot-pack: tiny subset of just the curated questions, ~22 KB raw.
    # Default deck on a fresh visit is "hot", so this is everything the client
    # needs for the first paint. The full markets.json loads in the background.
    hot_only = [m for m in markets if m.get("hot")]
    with open(WEB / "markets-hot.json", "w") as f:
        json.dump(hot_only, f, separators=(",", ":"))
    hot_kb = (WEB / "markets-hot.json").stat().st_size / 1024
    print(f"Hot pack:                                  {len(hot_only)} markets, {hot_kb:.1f} KB")

    # Rebuild taxonomy ordered by volume (sum of v within each group)
    tax_counts = {}
    tax_vol = {}
    for m in markets:
        c, s, v = m["c"], m["s"], m.get("v", 0) or 0
        tax_counts.setdefault(c, {}).setdefault(s, 0)
        tax_counts[c][s] += 1
        tax_vol.setdefault(c, 0)
        tax_vol[c] += v

    # Order cats by volume desc; subs within each cat by count desc
    ordered = {}
    for cat in sorted(tax_counts, key=lambda c: tax_vol[c], reverse=True):
        subs = tax_counts[cat]
        ordered[cat] = [
            {"sub": s, "n": n}
            for s, n in sorted(subs.items(), key=lambda kv: kv[1], reverse=True)
        ]

    with open(WEB / "taxonomy.json", "w") as f:
        json.dump(ordered, f, indent=2)

    print()
    print("Final taxonomy:")
    total = 0
    for cat, subs in ordered.items():
        n = sum(s["n"] for s in subs)
        total += n
        print(f"  {cat:25s} {n:>6}  ({len(subs)} subs)")
    print(f"TOTAL: {total}")


if __name__ == "__main__":
    main()

"""Single source of truth for the predictopoly taxonomy.

Used by:
- 02_classify_markets.py  (past classifier)   - TAXONOMY + validate_classification
- 08_classify_active.py   (active classifier) - TAXONOMY + validate_classification + compact_taxonomy
- 04_normalize_taxonomy.py (past export)      - CANONICAL + VALID_TOPS + SUB_TO_PARENT
- 09_export_active_for_web.py (active export) - CANONICAL + VALID_TOPS + SUB_TO_PARENT

Any change to TAXONOMY here ripples to all four. Before this module the
same taxonomy lived in four files independently and silently drifted -
on 2026-06-08 we found that 09 had Speculation + Soundbites + eSports
under Sports while 08 didn't, and that drift had been polluting the
deployed bundle for weeks. One file kills that failure mode at the root.

CANONICAL is parse_taxonomy(TAXONOMY): the machine-readable
{cat: set(sub)} derived from the same source. Don't edit it by hand;
edit TAXONOMY and CANONICAL follows.

SUB_ALIASES and ALIASES intentionally stay local in 04 and 09 - those
are heuristic legacy-format remappings for fixing classifier output,
not part of the canonical taxonomy definition. They can diverge.
"""

TAXONOMY = """
US Politics:
  - Presidential Elections: US presidential races, popular vote, inauguration, state-level presidential results
  - Nominations & Primaries: Party nominations, VP picks, primary outcomes, candidate dropouts
  - Policy & Governance: Legislation, government shutdowns, legal processes involving politicians, executive actions
  - Appointments: Federal position nominations and confirmations (Fed chair, cabinet, SCOTUS, ambassadors)

World Politics:
  - Non-US Elections: Presidential, PM, parliamentary elections outside the US
  - International Relations & Conflicts: Military actions, ceasefires, diplomacy, foreign leadership changes, wars

Economy & Finance:
  - Monetary Policy: Fed/central bank rate decisions and statements
  - Macroeconomics: Inflation, jobs reports, GDP, recession, national debt
  - Financial Markets: Stock indices, commodities, traditional assets, equities

AI & Tech:
  - Model Releases & Benchmarks: New model launches, benchmark scores, capability milestones (GPT, Claude, Gemini, etc.)
  - Tech Companies: Product launches, exec changes, acquisitions, IPOs in tech (non-crypto)
  - AI Regulation: Government actions, policy, legislation targeting AI

Crypto:
  - Price Predictions: BTC, ETH, altcoin prices hitting thresholds
  - Speculation: Short-horizon up/down bets, ticker-vs-dollar-threshold gambles, generic price-direction wagers without a specific event hook
  - Protocol & Launches: Token launches, FDV, airdrops, NFT floors, exchange volumes
  - Crypto Regulation: Government bans, legislation, ETF approvals

Sports:
  - NFL: National Football League games, Super Bowl, player events
  - NBA: National Basketball Association games, Finals, player awards
  - MLB: Major League Baseball games, World Series
  - NHL: National Hockey League games, Stanley Cup, player awards
  - Global Soccer: EPL, La Liga, Champions League, World Cup, other soccer leagues
  - Combat Sports: Boxing, MMA, UFC
  - Tennis: Grand Slams, ATP, WTA events
  - F1 & Motorsport: Formula 1, NASCAR, motorsport events
  - Olympics & Multi-sport: Olympics, world championships, multi-sport events
  - eSports: Pro gaming tournaments, eSports events
  - Other Sports: College sports, cricket, golf, darts, anything sports not listed above

Culture & Media:
  - Movies, TV & Awards: Box office, films, TV shows, Oscars, Emmys, awards
  - Social Media: Platform events, internet policy, app bans, social media leadership
  - Soundbites: Will-X-say-Y markets, public-figure phrase counts, livestream catchphrase bets
  - Celebrity & Events: Celebrity-related events, public figure drama, non-political

Science:
  - Space: SpaceX, NASA, space exploration, rocket launches
  - Weather & Disasters: Weather forecasts, hurricanes, earthquakes, natural disasters
  - Health & Science: Medical research, pandemics, physics, general science

Miscellaneous:
  - Unclassified: Genuinely unclassifiable (coin tosses, pure novelty, unclear meaning)
"""


def parse_taxonomy(taxonomy_str=None):
    """Return {cat_name: set(sub_names)} parsed from a TAXONOMY-formatted string.

    Top-level categories are lines ending in ':' at column 0. Subcategories
    are '  - SubName: description' lines under the current category.
    """
    s = taxonomy_str if taxonomy_str is not None else TAXONOMY
    cats = {}
    current = None
    for line in s.splitlines():
        if not line.strip():
            continue
        if not line.startswith(" "):
            stripped = line.strip()
            if stripped.endswith(":"):
                current = stripped[:-1].strip()
                cats.setdefault(current, set())
        elif line.lstrip().startswith("- ") and current is not None:
            sub = line.lstrip()[2:].split(":", 1)[0].strip()
            cats[current].add(sub)
    return cats


# Eagerly derived. Anything that imports this module sees the same view.
CANONICAL = parse_taxonomy()
VALID_TOPS = set(CANONICAL.keys())
SUB_TO_PARENT = {sub: cat for cat, subs in CANONICAL.items() for sub in subs}


def validate_classification(cat, sub):
    """Force out-of-taxonomy (cat, sub) pairs to Miscellaneous / Unclassified.

    Called by 02 and 08 on every classifier output before it gets written
    to the progress jsonl. A hallucinated category like 'Tennis' (which
    is a Sports subcategory, not a top-level cat) gets dropped to Misc.
    """
    if cat in CANONICAL and sub in CANONICAL[cat]:
        return cat, sub
    return "Miscellaneous", "Unclassified"


def compact_taxonomy():
    """Return one line per category for use inside LLM prompts.

    Shape: 'Category Name: Sub1, Sub2, Sub3'.

    Drops the per-subcategory descriptions from TAXONOMY (saves ~3k
    tokens vs the full descriptive form). Small enough to fit in the
    Groq free-tier 6k-tokens-per-minute budget for 8b-instant.
    """
    return "\n".join(
        f"{cat}: {', '.join(sorted(subs))}" for cat, subs in CANONICAL.items()
    )

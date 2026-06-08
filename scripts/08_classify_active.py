"""Classify active Polymarket questions into the same taxonomy as resolved.

Forked from 02_classify_markets.py with three changes:
- Reads data/active_markets.parquet
- Writes data/active_markets_classified.parquet
- Progress file is data/active_classification_progress.jsonl (separate from
  resolved progress so the two pipelines never stomp each other)

Same batch size, same taxonomy, same prompt as 02. Model differs - active
uses Groq llama-3.3-70b after 2026-06-07 Gemini free-tier RPD became
insufficient for the daily ~7k cold-cache reseed and runs timed out at
30/60 min boundaries. Past-deck classification still on Gemini. Category
distributions across the two sides may drift slightly because of model
differences; the deck UI filters on category name which is identical
either way, so functional parity holds.

Re-run-safe via the progress file: dedups against already-classified ids on
each invocation. Fits the daily-cron model since most active markets are
already classified from prior runs.

Usage:
    GROQ_API_KEY=... python scripts/08_classify_active.py
"""

import json
import os
import sys
import time
from pathlib import Path

import pandas as pd
from openai import OpenAI, RateLimitError

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
INPUT = DATA / "active_markets.parquet"
PROGRESS = DATA / "active_classification_progress.jsonl"
OUTPUT = DATA / "active_markets_classified.parquet"

BATCH_SIZE = 80
SLEEP_BETWEEN = 0.5
MAX_RETRIES = 8
# Switched 70b -> 8b-instant on 2026-06-08 after the 70b free-tier TPD
# of 100k blew up halfway through a cold reseed (~400k tokens needed
# for full ~7k market pool with 5k-token batches). 8b-instant free has
# 500k TPD, enough headroom for cold start + daily delta. Quality on
# taxonomy classification is fine - the task is not reasoning-heavy.
MODEL = "llama-3.1-8b-instant"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
# 8b-instant free has a tight per-minute cap: 6000 TPM total, counted
# as input_tokens + max_tokens. With BATCH_SIZE=80, output is ~2.4k
# tokens (~30 per classification), so max_tokens=2500 gives the model
# enough room without blowing the per-request budget. Combined with
# the compact prompt below, each request stays around 4k TPM.
MAX_OUTPUT_TOKENS = 2500

# Taxonomy intentionally duplicated rather than imported. If 02 ever drifts
# we want a deliberate sync, not silent inheritance.
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


def parse_taxonomy(taxonomy_str):
    """Build {category: set(subcategories)} whitelist from the TAXONOMY string.

    Top-level categories are lines ending in ':' with no leading whitespace.
    Subcategories are lines starting with '  - ' under the current category.
    Output is the closed set the classifier is allowed to use. Any model
    output not matching exactly falls back to Miscellaneous / Unclassified.
    """
    cats = {}
    current = None
    for line in taxonomy_str.splitlines():
        if not line.strip():
            continue
        if not line.startswith(" "):
            stripped = line.strip()
            if stripped.endswith(":"):
                current = stripped[:-1].strip()
                cats.setdefault(current, set())
        elif line.lstrip().startswith("- ") and current is not None:
            sub_part = line.lstrip()[2:]
            sub = sub_part.split(":", 1)[0].strip()
            cats[current].add(sub)
    return cats


TAXONOMY_WHITELIST = None  # populated in main()


def compact_taxonomy(whitelist=None):
    """One line per category: 'Category: Sub1, Sub2, ...'.

    Used in the request prompt to shrink token cost from ~3.5k (full
    descriptions in TAXONOMY string) to ~200. The 8b model classifies
    fine without the per-subcategory blurbs - the names are descriptive
    enough on their own.
    """
    wl = whitelist if whitelist is not None else parse_taxonomy(TAXONOMY)
    lines = []
    for cat, subs in wl.items():
        lines.append(f"{cat}: {', '.join(sorted(subs))}")
    return "\n".join(lines)


def validate_classification(cat, sub):
    """Force out-of-taxonomy results into Miscellaneous / Unclassified.

    The active-deck UI groups by category name, so a hallucinated cat like
    'Tennis' or 'Global Soccer' (which are actually subcategories under
    Sports) shows up as a new top-level bucket and pollutes the deck.
    """
    if TAXONOMY_WHITELIST and cat in TAXONOMY_WHITELIST and sub in TAXONOMY_WHITELIST[cat]:
        return cat, sub
    return "Miscellaneous", "Unclassified"


def build_prompt(batch):
    questions_block = "\n".join(f"{i+1}. {q}" for i, q in enumerate(batch))
    tax = compact_taxonomy(TAXONOMY_WHITELIST)
    return f"""Classify each Polymarket question into the taxonomy below.
Return ONLY a JSON array of {len(batch)} objects, one per question in order.
Each object: {{"i": <question-number>, "cat": "<category>", "sub": "<subcategory>"}}

Rules:
- "cat" = one of the category names (left side of colon).
- "sub" = one of that category's listed subcategories (right side).
- Never invent a category or subcategory.
- If unsure: {{"cat": "Miscellaneous", "sub": "Unclassified"}}.

TAXONOMY:
{tax}

QUESTIONS:
{questions_block}

Output JSON array only, no preamble, no markdown fence:"""


def parse_response(text, expected_n):
    t = text.strip()
    if t.startswith("```"):
        lines = t.splitlines()
        t = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
    data = json.loads(t)
    if len(data) != expected_n:
        raise ValueError(f"expected {expected_n} classifications, got {len(data)}")
    return data


def classify_batch(client, batch):
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": build_prompt(batch)}],
                temperature=0,
                max_tokens=MAX_OUTPUT_TOKENS,
            )
            return parse_response(resp.choices[0].message.content, len(batch))
        except RateLimitError as e:
            wait = 30 * (attempt + 1)
            print(f"  rate limit, sleeping {wait}s... ({e.__class__.__name__})", file=sys.stderr)
            time.sleep(wait)
            last_err = e
        except (json.JSONDecodeError, ValueError) as e:
            print(f"  parse error on attempt {attempt+1}: {e}", file=sys.stderr)
            time.sleep(2)
            last_err = e
    raise RuntimeError(f"classify_batch failed after {MAX_RETRIES} retries: {last_err}")


def main():
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        sys.exit("GROQ_API_KEY not set")
    client = OpenAI(api_key=api_key, base_url=GROQ_BASE_URL)

    global TAXONOMY_WHITELIST
    TAXONOMY_WHITELIST = parse_taxonomy(TAXONOMY)
    print(
        f"Taxonomy whitelist: {len(TAXONOMY_WHITELIST)} categories, "
        f"{sum(len(s) for s in TAXONOMY_WHITELIST.values())} subcategories",
        file=sys.stderr,
    )

    df = pd.read_parquet(INPUT)
    print(f"Loaded {len(df)} active markets", file=sys.stderr)

    # Only count an id as done if its existing classification is still
    # inside the current whitelist. Anything legacy or out-of-taxonomy
    # gets re-classified automatically, which is the one-shot cleanup
    # for the polluted state from Gemini-era runs (Tennis-as-category,
    # Global-Soccer-as-category etc).
    done_ids = set()
    legacy_drops = 0
    if PROGRESS.exists():
        with PROGRESS.open() as f:
            for line in f:
                r = json.loads(line)
                cat, sub = r.get("cat", ""), r.get("sub", "")
                if cat in TAXONOMY_WHITELIST and sub in TAXONOMY_WHITELIST[cat]:
                    done_ids.add(str(r["id"]))
                else:
                    legacy_drops += 1
        print(
            f"Resuming: {len(done_ids)} already classified "
            f"({legacy_drops} out-of-taxonomy entries dropped, will re-classify)",
            file=sys.stderr,
        )

    remaining = df[~df["id"].isin(done_ids)].reset_index(drop=True)
    print(f"To classify: {len(remaining)}", file=sys.stderr)

    total_batches = (len(remaining) + BATCH_SIZE - 1) // BATCH_SIZE
    with PROGRESS.open("a") as f:
        for b in range(total_batches):
            start = b * BATCH_SIZE
            end = min(start + BATCH_SIZE, len(remaining))
            slice_df = remaining.iloc[start:end]
            batch_questions = slice_df["question"].tolist()
            batch_ids = slice_df["id"].tolist()

            t0 = time.time()
            try:
                results = classify_batch(client, batch_questions)
            except Exception as e:
                print(f"Batch {b+1}/{total_batches} FAILED: {e}", file=sys.stderr)
                continue

            for r, mid in zip(results, batch_ids):
                cat, sub = validate_classification(r.get("cat", ""), r.get("sub", ""))
                rec = {"id": str(mid), "cat": cat, "sub": sub}
                f.write(json.dumps(rec) + "\n")
            f.flush()

            elapsed = time.time() - t0
            print(
                f"Batch {b+1}/{total_batches} ({len(batch_questions)} q, {elapsed:.1f}s) | "
                f"progress {end + len(done_ids)}/{len(df)}",
                file=sys.stderr,
            )
            if b < total_batches - 1:
                time.sleep(max(0, SLEEP_BETWEEN - elapsed))

    print("\nMerging classifications into parquet...", file=sys.stderr)
    rows = []
    if PROGRESS.exists():
        with PROGRESS.open() as f:
            for line in f:
                rows.append(json.loads(line))
    if not rows:
        # Every batch failed and there was no prior progress to merge.
        # Bail loudly rather than crash the downstream merge with a
        # KeyError on 'id' from an empty DataFrame. The workflow fails
        # this step and skips export/deploy, leaving yesterday's bundle
        # on the site, which is the correct behavior.
        sys.exit("No classifications to merge (all batches failed and no prior cache). Aborting.")
    cls_df = pd.DataFrame(rows).drop_duplicates(subset=["id"], keep="last")
    df = df.drop(columns=["category"]).merge(cls_df, on="id", how="left")
    df = df.rename(columns={"cat": "category", "sub": "subcategory"})
    df.to_parquet(OUTPUT, index=False)

    print(f"\nWrote {OUTPUT}", file=sys.stderr)
    print(f"Classified: {df['category'].notna().sum()}/{len(df)}", file=sys.stderr)
    print("\n--- category counts ---", file=sys.stderr)
    print(df["category"].value_counts().to_string(), file=sys.stderr)


if __name__ == "__main__":
    main()

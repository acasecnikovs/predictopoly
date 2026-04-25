"""Classify all 37k Polymarket questions into the signed-off taxonomy.

Batches questions to Gemini Flash, parses JSON response, writes enriched
parquet. Saves progress every N batches so an interruption is recoverable.
"""

import json
import os
import sys
import time
from pathlib import Path

import pandas as pd
import google.generativeai as genai
from google.api_core import exceptions as gexc

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
PROGRESS = DATA / "classification_progress.jsonl"
OUTPUT = DATA / "resolved_markets_classified.parquet"

BATCH_SIZE = 200
SLEEP_BETWEEN = 0.5
MAX_RETRIES = 8  # bigger window since 2.5-flash hits per-minute limits harder
MODEL = "gemini-2.5-flash-lite"

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
  - Other Sports: College sports, cricket, golf, darts, anything sports not listed above

Culture & Media:
  - Movies, TV & Awards: Box office, films, TV shows, Oscars, Emmys, awards
  - Social Media: Platform events, internet policy, app bans, social media leadership
  - eSports: Pro gaming tournaments, eSports events
  - Celebrity & Events: Celebrity-related events, public figure drama, non-political

Science:
  - Space: SpaceX, NASA, space exploration, rocket launches
  - Weather & Disasters: Weather forecasts, hurricanes, earthquakes, natural disasters
  - Health & Science: Medical research, pandemics, physics, general science

Miscellaneous:
  - Unclassified: Genuinely unclassifiable (coin tosses, pure novelty, unclear meaning)
"""


def build_prompt(batch):
    questions_block = "\n".join(
        f"{i+1}. {q}" for i, q in enumerate(batch)
    )
    return f"""Classify each Polymarket question into the taxonomy below.
Return ONLY a JSON array of {len(batch)} objects, one per question in order.
Each object: {{"i": <question-number>, "cat": "<category>", "sub": "<subcategory>"}}
Use the EXACT category and subcategory names from the taxonomy. If truly
unclassifiable, use Miscellaneous / Unclassified.

TAXONOMY:
{TAXONOMY}

QUESTIONS:
{questions_block}

Output JSON array only, no preamble, no markdown fence:"""


def parse_response(text, expected_n):
    # Strip markdown fences if present
    t = text.strip()
    if t.startswith("```"):
        lines = t.splitlines()
        t = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
    data = json.loads(t)
    if len(data) != expected_n:
        raise ValueError(f"expected {expected_n} classifications, got {len(data)}")
    return data


def classify_batch(model, batch):
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = model.generate_content(build_prompt(batch))
            return parse_response(resp.text, len(batch))
        except gexc.ResourceExhausted as e:
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
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        sys.exit("GEMINI_API_KEY not set")
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(MODEL)

    df = pd.read_parquet(DATA / "resolved_markets.parquet")
    print(f"Loaded {len(df)} markets", file=sys.stderr)

    # Resume logic
    done_ids = set()
    if PROGRESS.exists():
        with PROGRESS.open() as f:
            for line in f:
                done_ids.add(str(json.loads(line)["id"]))
        print(f"Resuming: {len(done_ids)} already classified", file=sys.stderr)

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
                results = classify_batch(model, batch_questions)
            except Exception as e:
                print(f"Batch {b+1}/{total_batches} FAILED: {e}", file=sys.stderr)
                continue

            for r, mid in zip(results, batch_ids):
                rec = {"id": str(mid), "cat": r.get("cat", ""), "sub": r.get("sub", "")}
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

    # Merge progress into parquet
    print("\nMerging classifications into parquet...", file=sys.stderr)
    rows = []
    with PROGRESS.open() as f:
        for line in f:
            rows.append(json.loads(line))
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

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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _taxonomy import (  # noqa: E402
    TAXONOMY,
    CANONICAL,
    compact_taxonomy,
    validate_classification,
)

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

# TAXONOMY, CANONICAL, compact_taxonomy, validate_classification all live in
# scripts/_taxonomy.py. Single source of truth shared with 02, 04, 09.


def build_prompt(batch):
    questions_block = "\n".join(f"{i+1}. {q}" for i, q in enumerate(batch))
    tax = compact_taxonomy()
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

    print(
        f"Taxonomy: {len(CANONICAL)} categories, "
        f"{sum(len(s) for s in CANONICAL.values())} subcategories",
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
                if cat in CANONICAL and sub in CANONICAL[cat]:
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

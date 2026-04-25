"""Sample 300 Polymarket questions (stratified by volume) and ask Gemini to
propose a 2-level taxonomy. Output goes to data/proposed_taxonomy.md for
human review before full classification."""

import json
import os
import sys
from pathlib import Path

import pandas as pd
import google.generativeai as genai

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"

api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    sys.exit("GEMINI_API_KEY not set")
genai.configure(api_key=api_key)

df = pd.read_parquet(DATA / "resolved_markets.parquet")

# Stratified sample by volume: top 100 by volume + 100 mid-tier + 100 low-tier.
# Gives Gemini the real shape of what exists, not just mainstream or just obscure.
top = df.nlargest(100, "volume")
mid = df[(df.volume >= 10_000) & (df.volume < 100_000)].sample(100, random_state=42)
low = df[df.volume < 1_000].sample(100, random_state=42)
sample = pd.concat([top, mid, low])[["question", "volume"]].reset_index(drop=True)

questions_block = "\n".join(
    f"{i+1}. {row.question}  (volume=${row.volume:,.0f})"
    for i, row in sample.iterrows()
)

prompt = f"""You are helping design a category taxonomy for a calibration
training tool built on 37,499 resolved Polymarket questions. Users will filter
markets by category and subcategory to train their forecasting in specific
domains.

Here are 300 real Polymarket questions stratified by trading volume:

{questions_block}

Design a clean 2-level taxonomy (category -> subcategory) that:
- Has between 6 and 10 top-level categories
- Each category has 2-5 subcategories where meaningful
- Covers >95% of what you see above
- Includes an "Other" bucket for genuinely unclassifiable markets
- Is mutually exclusive and collectively exhaustive within the observed data
- Uses names a forecaster would actually recognize (not academic jargon)

Important design principles:
- "Sports" alone is useless - nobody cares about sports in general. Split by
  league (NFL, NBA, NHL, MLB, soccer-leagues, combat-sports, F1, tennis, etc.)
- "Politics" should split US / non-US at minimum
- "Crypto" should split price-prediction / protocol-events / regulation
- Prefer concrete over abstract (e.g. "Elections-US" over "Governance")

Output format: pure markdown, no preamble. Use this exact structure:

# Proposed Taxonomy

## <Category 1 Name>
- <Subcategory 1>: <one-line description of what fits>
- <Subcategory 2>: <one-line description>

## <Category 2 Name>
- <Subcategory 1>: ...
...

After the taxonomy, add a section:

## Rationale
<3-5 sentences explaining your key design choices and any tradeoffs>

## Coverage concerns
<Any questions in the sample you weren't confident how to categorize>
"""

print("Calling Gemini with 300-question stratified sample...", file=sys.stderr)
model = genai.GenerativeModel("gemini-2.5-flash")
resp = model.generate_content(prompt)

out_path = DATA / "proposed_taxonomy.md"
out_path.write_text(resp.text)
print(f"Wrote {out_path} ({len(resp.text)} chars)", file=sys.stderr)
print("\n--- PREVIEW (first 2000 chars) ---\n", file=sys.stderr)
print(resp.text[:2000])

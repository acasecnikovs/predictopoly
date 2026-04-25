# Task: pick the 200 best calibration questions

You are curating the opening experience of a calibration-training app
(kelly.app). New users see resolved Polymarket questions, predict the
probability of YES, then see the actual outcome and how the market priced it.

The goal of "Hot picks" (the default preset for fresh users) is to make a
strong first impression. A good Hot picks question is one where a smart
layperson can:

1. **Reason about it from public info.** No insider edge required.
2. **Form a prior that's not obviously 0 or 100.** The question is genuinely
   open at the time it was asked.
3. **Care about learning the answer.** Surprising outcomes, real stakes,
   memorable events.

## Rubric (score each 1-5)

- **REASONABLE** (1-5): Can a smart layperson reason about it without specialist
  knowledge? "Will Trump be inaugurated?" = 5. "Will Solana hit $275 by Jan 31?"
  = 1 (pure speculation). "Fed decreases by 25 bps after May 2025 meeting?" = 2
  (overly specific monetary mechanic, niche).
- **NON-OBVIOUS** (1-5): Was the market price between 5% and 95% with real
  uncertainty? You'll see `p7` (market price 7 days before close, 0..1). Closer
  to 0.5 = more uncertain = better. Already-decided questions (p7 ~0.99 NO or
  ~0.99 YES) = 1.
- **MEMORABLE** (1-5): Will the user recognize the topic and care about the
  outcome? "Will US forces enter Iran by April 30?" = 5. "Will Ciuca win the
  2024 Romanian Presidential election?" = 2 (real but obscure outside Romania).
  "Will Trump end the Ukraine war in first 90 days?" = 5.
- **CLEAN SHAPE** (1-5): Binary, named subject, specific event. "Will Biden
  finish his term?" = 5. "Highest temperature in London on March 17 >= 53F?" =
  1 (numeric band, weather precision). "Will the Democratic candidate win
  Pennsylvania by 1.5%-2.0%?" = 1.
- **TIMELESS** (1-5): Is this question still interesting in 2026 and beyond?
  "Will Bitcoin hit $100k in November?" = 1 if it's a backward-looking number
  bet. "Will TikTok be banned in the US?" = 5 (still a live topic).

Total = sum. Maximum 25.

## Hard exclusions (score = 0, do not include)

- "Up or Down on <date>" coin flip
- "Will <ticker> hit $X by <date>" pure number bet (most should already be filtered out, flag stragglers)
- Election margin precision bands ("by 1%-2%")
- Fed thin-band ("decreases by 25 bps after specific meeting"). Keep at most ONE per Fed meeting topic, the highest-volume one
- Near-duplicates: when several questions ask the same underlying thing
  (e.g. 12x "HBO documentary identifies X as Satoshi" for different X), keep
  at most ONE (the highest volume).
- Stale 2-year-old micro-events nobody remembers
- Anything where the YES outcome is essentially impossible (Michelle Obama
  winning 2024 dem nomination, Hillary running in 2024, etc). These passed
  pre-filters but are still 99%+ NO and have zero calibration value

## Output format

Return ONLY a single JSON object, no prose around it:

```json
{
  "top": [
    {"id": "12345", "score": 23, "why": "Trump inauguration, timeless, memorable, p7 was 0.97 so almost certain but still high stakes"},
    {"id": "67890", "score": 22, "why": "..."}
  ]
}
```

The `top` array must contain EXACTLY 200 entries, sorted by score descending.
Pick the 200 highest-quality questions. The `id` field MUST be the exact `id`
string from the input. The `why` field should be <=120 chars.

## Diversity nudge

Within the top 200, try to span topics. If you have 80 questions that all
qualify highly but they're all 2024 US presidential election variants, drop
some weaker ones in favor of geopolitics, tech, science, culture, etc, even if
the latter score slightly lower. A user playing 50 in a row should not feel
trapped in one news cycle.

Soft category caps as guidance (not strict):
- US Politics: ~70 max
- World Politics: ~40
- Crypto: ~25
- Economy & Finance: ~20
- AI & Tech: ~15
- Culture & Media: ~15
- Science: ~15

## Input

Below is a JSON array of 757 candidates. Each entry has:
- `id`: the market ID (use this in your output)
- `q`: the question text
- `cat`: category/subcategory
- `v_m`: Polymarket volume in millions of USD
- `o`: actual outcome: 1 = YES resolved, 0 = NO resolved
- `p7`: market price for YES seven days before close (0..1, null if not available)

CANDIDATES_JSON_HERE

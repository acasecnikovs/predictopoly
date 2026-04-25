# Task: pick the 150 best calibration questions

You are curating the opening experience of a calibration-training app for a
sharp audience: applied-math grad students, AI/ML researchers, quant-finance
people, rationalist-adjacent friends. Polymarket questions that already
resolved. The user predicts probability of YES, sees the outcome, sees how the
market priced it.

The trap to avoid: "Will Trump win the 2024 election?" feels like a great
question but is **trivia for this audience** - they remember the answer. Same
for "Will Biden be inaugurated?", "Will Harris drop out?", etc. These score
high on volume and memorability but ZERO on calibration value because the user
doesn't have to forecast - they recall.

A great Hot picks question has:

1. **Real uncertainty at resolution time** (p7 between 0.15 and 0.85). The
   market itself didn't know - so the user has to actually reason.
2. **Smart-but-not-news-junkie audience won't remember the outcome.** A grad
   student in Eindhoven, a quant in Riga - they followed Trump in passing,
   but they didn't track "did the Hyperliquid token launch in November?",
   "did Caroline Ellison get 24-35 months?", "did Conclave win Best Picture?",
   "was Liz Cheney's endorsement before or after a specific debate?".
3. **Tractable**: a layperson can reason about it from public info.
4. **Memorable resolution**: the outcome teaches something, isn't pure noise.

## Rubric (1-5 each, total /25)

- **UNCERTAIN** (1-5): how close was p7 to 0.50? p7=0.50 -> 5; p7=0.30 or 0.70 -> 4;
  p7=0.20 or 0.80 -> 3; p7=0.10 or 0.90 -> 2; p7 outside that -> 1.
- **NOT-RECALLED** (1-5): would a smart-but-not-political-news-obsessed reader
  in 2026 NOT remember this resolved? "Will Trump win 2024?" -> 1 (everyone
  knows). "Will Biden finish his term?" -> 1 (memorable resolution). "RFK Jr.
  picks Nicole Shanahan?" -> 4 (specific enough). "Will Hyperliquid launch a
  token in November?" -> 5 (forgotten). "Will Caroline Ellison be sentenced
  24-35 months?" -> 5 (specific, surprising).
- **TRACTABLE** (1-5): can the user reason about it without specialist domain
  knowledge? "Will Israel strike Iran on Friday Oct 25?" -> 4 (date specificity
  hard but plausible to reason). "Will $WIF be listed on Coinbase 2024?" -> 3
  (crypto-specific, ok for tech audience). "Will Justin Trudeau be Canadian PM
  on December 31?" -> 5.
- **MEMORABLE** (1-5): is the resolution interesting/surprising/teaching? Real
  events with stakes. "Will Diddy be released from custody before December?" -> 4.
  "Will Trump impose tariff on oil from Mexico/Canada by next Friday?" -> 4.
  Niche price questions stripped during pre-filter, so most candidates qualify.
- **CLEAN SHAPE** (1-5): named subject, specific binary event. "Will the Fed
  cut by exactly 25 bps after the May meeting?" -> 1 (numeric thin band, also
  pre-filtered). "Will Liz Cheney endorse Harris?" -> 5.

## Hard exclusions (score 0, do not include)

- **Trivia / recall**: any question where a moderately-attentive person in 2026
  would clearly remember the resolution. Includes: "Will Trump win 2024?",
  "Will Harris win 2024?", "Will Biden drop out?", "Will Trump be inaugurated?",
  "Will Trump end Ukraine war in 90 days?" (high-profile, remembered),
  "Will TikTok be banned?", "Will US forces enter Iran by April 30?". These
  pass other filters but fail the audience test.
- **Stale long-resolved obscurities** that nobody cares about now (e.g. random
  small soccer matches between unknown clubs, even if p7 looks good).
- **Single-event near-duplicates**: when 5+ questions ask variations on the
  same event ("Will Israel strike Iran on Friday Oct 25?", "...on Friday Nov 1?",
  "...on Friday Nov 8?"), keep the ONE most calibration-rich.

## Hard category caps (must respect)

The audience tires fast of any single topic. Enforce:

- US Politics:        max 30  (and within that: max 8 from "Presidential Elections")
- World Politics:     max 30
- Culture & Media:    max 30  (movies, awards, celebrity events - this audience likes these)
- Crypto:             max 25
- AI & Tech:          max 20  (we have only 25 candidates, take the best of them)
- Economy & Finance:  max 20
- Science:            max 15

If categories run thin, that's fine - return fewer than 150 rather than pad
with weak picks.

## Output format

Single JSON object, no prose:

```json
{"top": [
  {"id":"12345","score":23,"why":"Liz Cheney endorsement, p7=0.50 perfect uncertainty, niche enough audience won't recall"},
  ...
]}
```

The `top` array sorted by score descending. Each `why` <= 100 chars. Aim for
~150 entries; absolutely cap at 150. The `id` MUST match input exactly.

## Input

JSON array of candidates. Each entry:
- `id`: market ID (use exactly in output)
- `q`: question text
- `cat`: "Category/Subcategory"
- `v_k`: Polymarket volume in thousands USD
- `o`: 1 = YES resolved, 0 = NO resolved
- `p7`: market price for YES seven days before close (0..1)

CANDIDATES_JSON_HERE

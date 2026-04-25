# Predictopoly

A calibration training tool built on 37,499 resolved Polymarket questions.

Pick a category, see a market, predict the probability, reveal the outcome,
get scored. Over time you build a reliability diagram per category - see
where your forecasting is sharp and where your brain makes things up.

**Scoring**: [Brier score](https://en.wikipedia.org/wiki/Brier_score) (squared
error between your probability and the 0/1 outcome) and log score.

## Inspiration

Built by [Artyom Casecnikovs](https://acasecnikovs.com) after going through
every calibration question on [Sage](https://sage.ora.cl) by
[Misha Yagudin](https://x.com/misha_yagudin).

Sage calibrates you on scalar confidence intervals over general knowledge.
Predictopoly calibrates you on probabilities over real prediction market
outcomes, sliced by category. Same skill, different domain, different format.

## Data

- `data/resolved_markets.parquet` - 37,499 resolved Polymarket markets with
  outcome, volume, liquidity, close time
- `data/lookback_prices.parquet` - market price snapshots at T-1d, T-7d, T-30d
  before resolution (95% coverage)
- `data/resolved_markets_classified.parquet` - above plus `category` and
  `subcategory` fields populated via Gemini Flash classification

Data scraped from Polymarket API, 2026-04-24.

## Structure

```
data/       parquet sources, classified output, taxonomy
scripts/    data pipeline (classification, export for web)
web/        static site served to users
docs/       design notes, launch plan, post drafts
```

## Taxonomy

9 top-level categories, ~28 subcategories. See
[`data/proposed_taxonomy.md`](data/proposed_taxonomy.md) for the authoritative
list and rationale.

## License

MIT.

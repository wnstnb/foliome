# PFS assumptions pack

Default assumptions shipped with the `/financial-statement` skill. Every file is dated and says where its numbers come from. A household's own `config/pfs-profile.json` overrides any of them.

| File | What | Refresh |
|---|---|---|
| `capital-markets.json` | Real (after-inflation) median compound return and volatility per asset class | Yearly |
| `tickers.json` | Ticker → asset class map, plus name keywords for unknown tickers | When new holdings show up |
| `tax/federal-2026.json`, `tax/state-*.json` | Bracket and payroll-tax parameters | Each tax year |
| `college-costs.json` | Annual cost of attendance by school type, today's dollars | Yearly |
| `household.json` | Wage-growth curve, income-stability premiums, pre-Medicare health, retirement glide, planning horizon | Rarely |

Rules:
- Real terms everywhere. Returns are **median compound** (geometric), so no volatility drag is applied on top.
- Defaults are deliberately moderate and are not forecasts. The statement labels every number that comes from here as an assumption.
- Risk-free rate and inflation are fetched live from FRED by `scripts/pfs/fetch-rates.js` (no API key). These files only hold the fallback values.

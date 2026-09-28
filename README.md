# VolumeLens

**Volume-Normalized Market Representation for Quantitative Detection of Price–Flow Anomalies**
Team 53 · Hindustan Institute of Technology & Science

VolumeLens redraws NSE stock charts on a volume clock. Each candle holds a fixed number of
shares instead of a fixed number of minutes, so moments when volume arrives unusually fast
stand out. Alongside it the app shows the fill time of every candle, VPIN, an absorption
index, and explained alerts from a LightGBM model.

## What the site shows

| Panel | What it is |
|---|---|
| Time chart | Normal 5-minute candles. Orange shading marks the minutes inside fast-inflow zones; hovering a volume candle highlights the exact minutes it covered. |
| Volume candles | One candle = a fixed number of shares, sized per stock from its previous 20 days (average daily volume ÷ 75). Orange = the last 3 candles filled in under 40% of their normal time. |
| Fill time + VPIN | Minutes each candle took to fill, a smoothed line, the normal fill time (dashed) and VPIN (blue, 0–1). |
| Absorption | `1 − actual move ÷ expected move`. Near 1: heavy volume, price held. |
| Alerts | Top 4% of model scores (max 6 per stock per day) with TreeSHAP reasons. |

## Method

1. **Adaptive volume bars** (`engine/bars.py`): bar size from previous complete days only. When a bar fills part-way through a minute, the minute is split assuming volume and price flowed evenly, which gives sub-minute fill times from 1-minute data.
2. **Normal fill time** (`engine/indicators.py`): the average of (a) the median of the previous 50 bars and (b) the median of the same 30-minute slot on previous days, rescaled to today's bar size.
3. **Fast inflow**: judged on the last 3 bars together, so one busy minute cannot flag a bar on its own.
4. **VPIN**: bulk volume classification (Easley, López de Prado & O'Hara, 2012) over the last 50 bars.
5. **Absorption Anomaly Index**: expected move = median absolute move of the previous 100 bars.
6. **Target**: a *big move* = the price range over the next 30 minutes exceeds 2× the normal 30-minute range (median of the previous ~4 days).
7. **Model** (`engine/model.py`): LightGBM with monotone constraints on four signals (5-minute volume surge, fill pace, VPIN, opening hour). Predictions are reported as percentiles of the model's own training predictions, so scores mean the same thing in every fold.

## Results (walk-forward, unseen days)

Trained only on earlier days with a 1-day gap, tested on 20 later trading days,
3,804 volume candles, 519 big moves (base rate 13.6%). "Caught" compares methods at the
same number of alerts.

| Method | AUC | Big moves caught | Precision |
|---|---|---|---|
| Time chart (5-min volume spike) | 0.743 | 46% | 31.5% |
| VPIN (rebuilt) | 0.653 | 44% | 30.1% |
| Volume bars only (fill pace) | 0.680 | 39% | 27.0% |
| **VolumeLens** | **0.776** | **52%** | **35.0%** |

VolumeLens beats VPIN on 6 of 6 stocks. Full numbers: `results.json`.

**What did not work.** Larger feature sets (absorption, streaks, delta, time of day) and deeper
trees overfitted in walk-forward testing (AUC 0.48–0.60), because the rate of big moves swings
from 0% to 38% between days and there are only ~30 trading days of data. The final model is
deliberately small. Absorption is shown on the chart but did not improve prediction.

**Limits.** 6 stocks, 8–28 days each, 1-minute data (no order book). Results should be
re-checked on more stocks and a longer period before relying on them.

## Run it

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # Windows; use .venv/bin on macOS/Linux
.venv/Scripts/python run.py                       # rebuilds web/data and results.json
.venv/Scripts/python -m pytest -q                 # 9 tests
python -m http.server 8765 --directory web        # open http://localhost:8765
```

Input: one CSV per stock in `data/` with `timestamp,open,high,low,close,volume`
(1-minute NSE candles, e.g. exported from AngelOne SmartAPI).

## Deploy

The site is static (`web/`), so Vercel serves it with no server code: import the repository
in Vercel and it picks up `vercel.json` (output directory `web`, no build step).

Charts: [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0).
Educational project, not investment advice.

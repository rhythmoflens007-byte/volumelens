# VolumeLens

**Volume-Normalized Market Representation for Quantitative Detection of Price–Flow Anomalies**
Team 53 · Hindustan Institute of Technology & Science

VolumeLens redraws NSE stock charts on a volume clock. Each candle holds a fixed number of
shares instead of a fixed number of minutes, so moments when volume arrives unusually fast
stand out. Alongside it the app shows the fill time of every candle, VPIN, an absorption
index, and explained alerts from a LightGBM model.

## What the site shows

| Feature | What it is |
|---|---|
| **Urgency** | A volume candle is *urgent* when the last 3 candles filled in under 40% of their normal time. Urgent candles are orange; the matching minutes are shaded on the 5-minute chart. |
| Time chart | Normal 5-minute candles. Hover a volume candle to highlight exactly which minutes it covered. |
| Volume candles | One candle = a fixed number of shares, sized per stock from its previous 20 days (average daily volume ÷ 75). |
| Fill time + VPIN | Minutes each candle took to fill, a smoothed line, the normal fill time (dashed) and VPIN (blue, 0–1). |
| Absorption | `1 − actual move ÷ expected move`, shown for context. |
| **Today's urgency** | Share of the day's shares traded in urgent candles, and the biggest burst ("55 urgent candles in 12 min; a 5-minute chart shows it as 4 candles"). |
| **Scanner** | Stocks ranked by urgency, plus the most urgent sessions in the data. |
| **Replay** | Plays a session at market pace (urgent bursts arrive fast). Every chart shows only what was known at that moment: completed 5-minute candles, bars and alerts so far. Keys: R, Space, ← →, Esc. |
| Urgency alerts | Top 5% of model scores (at least 15 min apart, max 6 per stock per day) with TreeSHAP reasons. |

**No repainting.** Every indicator only looks backwards, so replay shows exactly what a live chart
would have shown. `tests/test_engine.py` checks this directly: indicators computed on the first *k*
bars equal the first *k* bars of the full computation, and bars built from minute data cut mid-day
equal the bars completed by then.

## Method

1. **Adaptive volume bars** (`engine/bars.py`): bar size from previous complete days only. When a bar fills part-way through a minute, the minute is split assuming volume and price flowed evenly, which gives sub-minute fill times from 1-minute data.
2. **Normal fill time** (`engine/indicators.py`): the average of (a) the median of the previous 50 bars and (b) the median of the same 30-minute slot on previous days, rescaled to today's bar size.
3. **Fast inflow**: judged on the last 3 bars together, so one busy minute cannot flag a bar on its own.
4. **VPIN**: bulk volume classification (Easley, López de Prado & O'Hara, 2012) over the last 50 bars.
5. **Absorption Anomaly Index**: expected move = median absolute move of the previous 100 bars.
6. **Target**: a *big move* = the price range over the next 30 full minutes exceeds 2× the normal 30-minute range (median of the previous ~4 days). Decisions are made at the **end of the minute** a bar completes in, because 1-minute data only reveals a minute's volume and close once it is over; the outcome window starts at the next minute.
7. **Model** (`engine/model.py`): LightGBM with monotone constraints on five signals: time-chart context (5-minute volume spike, last-30-minute range, opening hour) plus the volume clock (fill pace, VPIN). Predictions are reported as percentiles of the model's own training predictions, so scores mean the same thing in every fold.

## Backtest (`python backtest.py` → `backtest/report.md`)

Walk-forward: trained on earlier days only (1-day gap), tested on **20 unseen trading days**,
3,804 volume bars, 447 big moves (base rate 12%). 95% intervals come from 1,000 block-bootstrap
resamples of test days. "Caught" compares methods at the same number of alerts (20% of bars).

| Method | AUC | 95% CI | Caught |
|---|---|---|---|
| VPIN (rebuilt) | 0.657 | 0.52–0.77 | 46% |
| Volume clock: fill pace | 0.668 | 0.58–0.73 | 37% |
| Time chart: 5-min volume spike | 0.720 | 0.63–0.78 | 43% |
| Time chart: last 30-min range | 0.771 | 0.68–0.84 | 46% |
| **VolumeLens** (time chart + volume clock) | **0.778** | 0.70–0.84 | **51%** |

**What holds up**
- **Urgency is real and robust.** After a fast (urgent) bar a big move follows 20% of the time vs 8% after a normal bar (19% vs 5% outside the opening hour). The lift is 2.2–2.4× for every threshold from 0.30 to 0.50, and shuffling fill times within each day removes most of it.
- **VolumeLens beats VPIN** by +0.12 AUC (95% CI +0.03 to +0.22) and on 6 of 6 stocks, and beats the 5-minute volume spike by +0.06 (CI +0.01 to +0.13).

**What does not (yet)**
- **Against recent volatility, it is a tie.** The plain "last 30-minute range" scores 0.771; VolumeLens adds +0.007 (CI −0.04 to +0.06). Adding the volume clock to a time-chart model adds +0.03 (CI −0.01 to +0.07, positive in 92% of resamples): suggestive, not proven on this much data, and not stable at 50 bars per day.
- **No direction.** After 113 fast-inflow zones the price kept its direction 54% of the time (chance range 41–59%). VolumeLens detects **urgency and coming volatility**, not direction, and 1-minute data cannot say *who* traded.
- **A look-ahead leak was found and fixed.** An earlier version started the outcome window inside the minute whose full volume the features had already used; fixing it lowered VolumeLens from 0.776 to 0.718 before recent volatility was added as a signal.
- **Overfitting.** Larger feature sets and deeper trees scored 0.48–0.60 on unseen days because the rate of big moves swings from 0% to 38% between days. The model is deliberately small; absorption is displayed but not used for prediction.

**Limits.** 6 stocks, 8–28 days each, 1-minute data (no order book). The next test is 50+ stocks
over 1–2 years, plus NSE bulk/block deal reports to check whether urgent zones line up with
disclosed institutional trades.

## Run it

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # Windows; use .venv/bin on macOS/Linux
.venv/Scripts/python run.py                       # rebuilds web/data and results.json
.venv/Scripts/python -m pytest -q                 # 11 tests
python -m http.server 8765 --directory web        # open http://localhost:8765
```

Input: one CSV per stock in `data/` with `timestamp,open,high,low,close,volume`
(1-minute NSE candles, e.g. exported from AngelOne SmartAPI).

## Deploy

The site is static (`web/`), so Vercel serves it with no server code: import the repository
in Vercel and it picks up `vercel.json` (output directory `web`, no build step).

Charts: [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0).
Educational project, not investment advice.

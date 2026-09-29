# Model card: VolumeLens urgency signal and alert model

Written in the spirit of model-risk documentation (purpose, design, validation, limits).
All figures are produced by `backtest.py` and stored in `backtest/results.json`
(full tables in `backtest/report.md`).

## 1. Purpose and intended use

| | |
|---|---|
| **What it does** | Flags *urgency*: moments when a stock's volume arrives unusually fast. Shows it on a volume-clock chart and raises explained alerts. |
| **Intended users** | Traders and analysts who want to see intraday urgency that a time-based chart hides; researchers studying volume-clock methods. |
| **Intended use** | Situational awareness and research. Urgency means *a large move is more likely*; it is not a buy or sell signal. |
| **Out of scope** | Predicting price direction; identifying who is trading (institution, algorithm, news); automated trading; any use as investment advice. |

## 2. Data

- NSE cash-market 1-minute OHLCV candles (AngelOne SmartAPI) for 11 large-cap stocks: AXISBANK, HDFCBANK, ICICIBANK, INFY, ITC, PNB, RELIANCE, SBIN, TCS, TECHM, YESBANK. 85 sessions each, 1 June to 29 September 2026.
- Session window 09:30–15:29 (the opening auction period is excluded).
- **Quality gate** (`engine/quality.py`): drops invalid prices and minutes outside market hours, and removes runs where the feed reported the day's running total as a minute's volume (at least 5 consecutive minutes above 20× the session's median minute volume, with the run's median above 60×, nearly flat from minute to minute). On this data it removed exactly one event, 15:20–15:29 on 29 September, in all 11 stocks, and nothing in the earlier archive. Every removal is published in `web/data/index.json`.

## 3. Method

1. **Volume candles.** Each candle holds a fixed number of shares = average daily volume of up to 20 *previous* complete sessions ÷ candles per session (Fine 150, Standard 75, Coarse 40), rounded to two significant figures. A candle closes at the end of the minute in which its size is reached, so candles align with real minutes; a minute that alone holds several candles' worth of shares becomes one wide candle and records that multiple.
2. **Normal fill time** = mean of (median per-share fill time of the previous 50 candles) and (the same for the same 30-minute slot on previous sessions), scaled to the candle's volume.
3. **Pace** = fill time of the last 3 candles ÷ their normal fill time. **Urgency Index** = max(0, 1 − pace) × 100. Urgent at 60 (pace under 0.40), watch at 30 (pace under 0.70).
4. **VPIN** = Σ|buy − sell| / Σ volume over the last 50 candles, with bulk volume classification (Easley, López de Prado & O'Hara, 2012).
5. **Alert model.** LightGBM (3 leaves, 150 rounds, L2 = 10) with monotone constraints on five signals: 5-minute volume vs normal, last-30-minute range vs normal, opening hour, fill pace, VPIN. Scores are reported as percentiles of the model's own training predictions. Alerts are the top 5% of scores, at least 15 minutes apart, at most 6 per stock per session. Each alert lists its largest TreeSHAP contributions.
6. **Target** ("large move") = the price range over the next 30 full minutes exceeds 2× the normal 30-minute range. Decisions are made at the end of the minute a candle completes in; the outcome window starts at the next minute.

## 4. Validation

**Design.** Walk-forward: train on earlier sessions only, 1-session gap, test on the following sessions, roll forward. **74 unseen test sessions, 37,292 candles, 3,996 large moves** (base rate 10.7%). 95% intervals from 1,000 block-bootstrap resamples of test sessions.

**Urgency (the core claim)**

| After a candle that is… | Candles | Next-30-min range vs normal | Large move follows |
|---|---|---|---|
| Urgent | 3,617 | 1.53× | **31%** |
| Watch | 6,693 | 1.23× | 14% |
| Normal | 31,292 | 1.02× | 7% |

- Urgent vs all other candles: 31% vs 8%, lift **3.8×**; outside the opening hour **3.3×** (21% vs 6%).
- Stable at **3.4–4.1×** for every urgency threshold from 0.30 to 0.50.
- Shuffling fill times within each session removes most of the effect: real AUC 0.684 vs shuffled mean 0.606 (best of 100 shuffles 0.613).

**Alerts vs alternatives (AUC, 0.5 = chance)**

| Signal | AUC | 95% CI | Large moves caught at equal alert rate (11%) |
|---|---|---|---|
| VPIN (rebuilt) | 0.592 | 0.553–0.626 | 21% |
| Fill pace alone (volume clock) | 0.688 | 0.658–0.713 | 31% |
| Time chart: 5-minute volume spike | 0.703 | 0.675–0.727 | 30% |
| Time chart: last 30-minute range | 0.725 | 0.693–0.753 | 26% |
| Model on time-chart signals only | 0.765 | 0.739–0.787 | 39% |
| **VolumeLens alerts** | **0.763** | 0.738–0.785 | **39%** |

| Comparison | AUC difference | 95% CI |
|---|---|---|
| VolumeLens vs VPIN | +0.172 | +0.141 to +0.203 |
| Fill pace alone vs VPIN | +0.096 | +0.065 to +0.128 |
| VolumeLens vs 5-minute volume spike | +0.061 | +0.045 to +0.076 |
| VolumeLens vs last-30-minute range | +0.039 | +0.024 to +0.054 |
| VolumeLens vs time-chart model | −0.002 | −0.006 to +0.001 (a tie) |

VolumeLens beats VPIN on all 11 stocks.

**Look-ahead controls.** Automated tests check that candle sizes use previous sessions only, that no indicator changes when future data is rewritten, that indicators and candles computed on part of a session equal the same part of the full computation (replay shows exactly what was known at the time), and that the live server produces exactly the batch output and never changes a published candle.

## 5. Limitations and known issues

- **Direction is not predicted.** After 647 urgent zones the price continued the zone's direction 46% of the time over 30 minutes, inside the chance range (46–54%). No direction claim is made.
- **Against a good time-chart model, the alert model is a tie** (0.763 vs 0.765). A model on volume-clock signals alone scores 0.720. The volume clock's value is making urgency visible, timely and explainable on the chart, and it clearly improves on VPIN, the established volume-clock measure.
- **Sample.** 11 large-cap stocks, about four months. Mid- and small-caps, other regimes and other years are untested.
- **1-minute data.** Candles close on minute boundaries; within-minute timing and trade-level detail are not available.
- **Settings chosen after looking at the data.** The 0.40 threshold and 75 candles per session were picked with data in view; the stability tables show results hold nearby (50–100 candles per session change AUC by under 0.01).
- **A look-ahead leak was found and fixed** during development: the outcome window once started inside the minute whose full volume the features had already used.

## 6. Monitoring and next validation

- Re-run `backtest.py` on every data refresh; results are versioned in `backtest/results.json`.
- Next: 50+ stocks over 1–2 years; comparison with NSE bulk and block deal disclosures to test whether urgent zones coincide with reported large trades; tick-level data for within-minute timing.

# Model card: VolumeLens urgency signal and alert model

Written in the spirit of model-risk documentation (purpose, design, validation, limits).
All figures are produced by `backtest.py` and stored in `backtest/results.json`.

## 1. Purpose and intended use

| | |
|---|---|
| **What it does** | Flags *urgency*: moments when a stock's volume arrives unusually fast. Shows it on a volume-clock chart and raises explained alerts. |
| **Intended users** | Traders and analysts who want to see intraday urgency that a time-based chart hides; researchers studying volume-clock methods. |
| **Intended use** | Situational awareness and research. Urgency means *a large move is more likely*; it is not a buy or sell signal. |
| **Out of scope** | Predicting price direction; identifying who is trading (institution, algorithm, news); automated trading; any use as investment advice. |

## 2. Data

- NSE cash-market 1-minute OHLCV candles (AngelOne SmartAPI), 6 stocks (RELIANCE, SBIN, TECHM, PNB, YESBANK, NARMADA), 8–28 sessions each, May–June 2026.
- Session window 09:30–15:29 (the opening auction period is excluded).
- Known gaps: some sessions are partial; 1-minute data has no trade-level or order-book detail.

## 3. Method

1. **Volume candles.** Each candle holds a fixed number of shares = average daily volume of up to 20 *previous* complete sessions ÷ 75. When a candle fills part-way through a minute, the minute is split assuming even flow.
2. **Normal fill time** = mean of (median of the previous 50 candles) and (median of the same 30-minute slot on previous sessions), rescaled to the current candle size.
3. **Urgent** = the last 3 candles filled in under 0.40× their normal time.
4. **VPIN** = Σ|buy − sell| / Σ volume over the last 50 candles, with bulk volume classification (Easley, López de Prado & O'Hara, 2012).
5. **Alert model.** LightGBM (3 leaves, 150 rounds, L2 = 10) with monotone constraints on five signals: 5-minute volume vs normal, last-30-minute range vs normal, opening hour, fill pace, VPIN. Scores are reported as percentiles of the model's own training predictions. Alerts are the top 5% of scores, at least 15 minutes apart, at most 6 per stock per session. Each alert lists its largest TreeSHAP contributions.
6. **Target** ("large move") = the price range over the next 30 full minutes exceeds 2× the normal 30-minute range (median of the previous ~4 sessions). Decisions are made at the end of the minute a candle completes in; the outcome window starts at the next minute.

## 4. Validation

**Design.** Walk-forward: train on earlier sessions only, 1-session gap, test on the next 3 sessions, roll forward. 20 unseen test sessions, 3,804 candles, 447 large moves (base rate 11.8%). 95% intervals from 1,000 block-bootstrap resamples of test sessions.

**Urgency (the core claim)**

| After a candle that is… | Candles | Large move follows |
|---|---|---|
| Urgent | 677 | **19.9%** |
| All other (watch + normal) | 4,044 | 8.6% |
| Normal only | 3,365 | 7.7% |

- Lift **2.3×**; outside the opening hour **3.5×**.
- Stable at **2.2–2.4×** for every urgency threshold from 0.30 to 0.50.
- Shuffling fill times within each session removes most of the effect (real AUC 0.635 vs shuffled mean 0.567, best of 100 shuffles 0.596).

**Alerts vs alternatives (AUC, 0.5 = chance)**

| Signal | AUC | 95% CI | Large moves caught at equal alert count |
|---|---|---|---|
| VPIN | 0.657 | 0.52–0.77 | 46% |
| Fill pace alone | 0.668 | 0.58–0.73 | 37% |
| Time chart: 5-minute volume spike | 0.720 | 0.63–0.78 | 43% |
| Time chart: last 30-minute range | 0.771 | 0.68–0.84 | 46% |
| **VolumeLens alerts** | **0.778** | 0.70–0.84 | **51%** |

| Comparison | AUC difference | 95% CI |
|---|---|---|
| VolumeLens vs VPIN | +0.121 | +0.030 to +0.223 |
| VolumeLens vs 5-minute volume spike | +0.059 | +0.014 to +0.125 |
| VolumeLens vs time-chart model | +0.029 | −0.010 to +0.074 (positive in 92% of resamples) |
| VolumeLens vs last-30-minute range | +0.007 | −0.041 to +0.062 |

**Look-ahead controls.** Automated tests check that bar sizes use previous sessions only, that no indicator changes when future data is rewritten, and that indicators and bars computed on part of a session equal the same part of the full computation (replay shows exactly what was known at the time).

## 5. Limitations and known issues

- **Direction is not predicted.** After 113 urgent zones the price continued the zone's direction 62% of the time over 30 minutes (chance range 41–59%), but an earlier zone definition gave 54%. The result is sensitive to definition and is not claimed.
- **Against recent volatility, the alert model is a tie.** The simple last-30-minute range scores 0.771. The volume clock's value is in making urgency visible and explainable; its extra predictive power over a good time-chart model is suggestive (+0.03) but not proven on 20 sessions.
- **Small sample.** 6 stocks and about 30 sessions. Intervals are wide.
- **1-minute data.** Sub-minute timing is estimated by assuming even flow within a minute; a single large print (for example a block trade) becomes many identical candles.
- **Settings chosen after looking at the data.** 0.40× and 75 candles per session were picked with all data in view; the stability tables show results hold nearby (bar sizes of 50–100 per session change AUC by about ±0.02).
- **A look-ahead leak was found and fixed** during development: the outcome window once started inside the minute whose full volume the features had already used. Fixing it lowered the alert AUC from 0.776 to 0.718 before recent volatility was added as a signal.

## 6. Monitoring and next validation

- Re-run `backtest.py` on every data refresh; results are versioned in `backtest/results.json`.
- Next: 50+ stocks over 1–2 years; comparison with NSE bulk and block deal disclosures to test whether urgent zones coincide with reported institutional trades; tick-level data to remove the even-flow assumption.

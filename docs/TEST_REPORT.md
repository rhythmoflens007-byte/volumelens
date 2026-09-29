# Test report

Run everything with:

```bash
.venv/Scripts/python -m pytest -q        # engine and live server: 16 tests
npx playwright test                      # terminal: 19 checks x 2 browsers (starts a simulated live server)
.venv/Scripts/python backtest.py         # validation: backtest/report.md
```

## Engine and live server (pytest): 16 passed

| Test | Guarantees |
|---|---|
| every bar reaches its share target | each volume candle holds at least its share size |
| candles are minute-aligned with real prices | every candle starts and ends on a minute boundary; open, high, low and close are real traded minute prices |
| bar volume is conserved | candles contain exactly the shares traded in the session |
| no bar crosses a trading day | every candle starts and ends in its own session |
| bars in time order, positive fill | no zero-duration or out-of-order candles |
| bar size uses previous days only | changing today's or later volume leaves today's candle size unchanged |
| indicators never use future bars | rewriting the second half of history leaves first-half indicators identical |
| **no repaint: indicators** | indicators on the first *k* candles equal the first *k* of the full computation, for every column the chart draws |
| **no repaint: bars** | cutting the minute data mid-session reproduces exactly the candles completed by then |
| VPIN and absorption ranges | VPIN in [0, 1], absorption ≤ 1 |
| labels look forward within the day only | late candles whose 30-minute window runs past the close get no label |
| AUC implementation | matches known values |
| quality gate | removes the running-total volume glitch and nothing else |
| **live equals batch** (RELIANCE, SBIN) | feeding 29 Sep minute by minute through the live server gives exactly the candles and indicators of the batch pipeline, for all three densities |
| **live never repaints** | recomputing after every minute never changes a candle that was already published |

## Terminal (Playwright): 38 passed (19 checks × Microsoft Edge and Google Chrome)

Every check fails on any uncaught page error or console error.

| Check | What is verified |
|---|---|
| Opens fast | continuous chart of the latest sessions, legends placed, load time checked |
| History streams in | scrolling left loads earlier sessions without the view jumping |
| Ranges, sessions, densities | 1D/5D/1M/All, go to session, Fine/Standard/Coarse keep the same moments in view |
| Time frames 1/3/5/15/30 m | compare chart rebuilds and stays aligned with the main chart |
| Zoom, pan, go to latest | both charts stay aligned; legends stay pinned to their panes |
| Drawing tools | zone and trend line from fast two-click input, horizontal line on both charts, measure, undo, clear |
| Replay | no candle or alert from the future is shown; stepping works; exit restores the view |
| Unfold | clicking a time candle reveals the volume candles inside it |
| Layers, theme, scanner, sessions | optional panes add and remove; light/dark; scanner and session list navigate |
| Snapshot | downloads a PNG |
| Data failure | a failed data request shows a clear message; Try again recovers |
| Layouts | 1920×1080, 1366×768 and 1024×768 in dark and light: no horizontal overflow, legends inside the chart |
| **Phone** | 390×844: chart on the first screen, no sideways scroll, scanner and evidence reachable |
| Smoothness | frame rate while zooming and panning matches the idle frame rate, with no long frames |
| Accessibility | axe-core WCAG 2 A/AA scan: no serious or critical issues (chart canvases excluded) |
| **Live stream** | against the live server replaying 29 Sep: SIMULATED badge, the chart holds exactly what the server published, new candles arrive, published candles never change, the view follows the newest candle |
| **Live server missing** | the badge shows Reconnecting… and the terminal stays fully usable |

Firefox could not be tested from the build machine (the Playwright Firefox download was blocked); Edge and Chrome cover the Chromium engine.

## Issues found by these tests and fixed

| Found by | Issue | Fix |
|---|---|---|
| Replay tests | the "zone" flag looked ahead to the rest of its run | zones now form from the streak so far |
| Backtest review | outcome window started inside the minute already used by the features | decisions at minute end; outcome window starts next minute |
| Data review | AngelOne reported the day's running total as minute volume (15:20–15:29, 29 Sep, all stocks) | quality gate removes such runs before candles are built |
| Live test | live candles differed slightly from batch (too little history for the baselines) | live server keeps 45 sessions of history |
| Browser test | separator labels showed the wrong date at fractional positions | interpolated coordinates |
| Browser test | switching density while history loaded made the view jump | view kept by time, history loading paused during rebuilds |
| Browser test | quick two-click drawing lost the second point | points read from raw pointer events, drags ignored |
| Accessibility scan | text elements below WCAG AA contrast | muted text and accent colours darkened |

# Test report

Run everything with:

```bash
.venv/Scripts/python -m pytest -q        # engine: 11 tests
npx playwright test                      # terminal: 13 checks x 2 browsers
.venv/Scripts/python backtest.py         # validation: backtest/report.md
```

## Engine (pytest): 11 passed

| Test | Guarantees |
|---|---|
| every bar reaches its share target | each volume candle holds exactly its share size |
| bar volume is conserved | candles never contain more shares than traded that session |
| no bar crosses a trading day | every candle starts and ends in its own session |
| bars in time order, positive fill | no zero-duration or out-of-order candles |
| bar size uses previous days only | changing today's or later volume leaves today's candle size unchanged |
| indicators never use future bars | rewriting the second half of history leaves first-half indicators identical |
| **no repaint: indicators** | indicators on the first *k* candles equal the first *k* of the full computation, for every column the chart draws |
| **no repaint: bars** | cutting the minute data mid-session reproduces exactly the candles completed by then |
| VPIN and absorption ranges | VPIN in [0, 1], absorption ≤ 1 |
| labels look forward within the day only | late candles whose 30-minute window runs past the close get no label |
| AUC implementation | matches known values |

## Terminal (Playwright): 26 passed (13 checks × Microsoft Edge and Google Chrome)

Every check fails on any uncaught page error or console error.

| Check | What is verified |
|---|---|
| Loads the most urgent session | URL, urgency card, scanner, evidence table, legends placed; load time under 3 s |
| Time frames 1/3/5/15/30 m | compare chart rebuilds with the right candle count and stays aligned with the main chart |
| Zoom in, zoom out, pan, fit | after 8 zoom-ins, a drag pan, 20 zoom-outs and Esc, the compare chart still covers the main chart's time span (within one candle) and legends stay pinned to their panes |
| Drawing tools | zone and trend line from fast two-click input, horizontal line on both charts, measure, undo, clear, keyboard shortcuts |
| Replay | at 30 min/s: no time candle or alert from the future is shown; stepping works; exit restores the full session in sync |
| Unfold | clicking a time candle shows the unfold card and glides the main chart; Esc closes it |
| Layers, theme, navigation | absorption pane adds and removes a pane; compare chart hides and shows; light/dark; scanner, sessions list and day navigation |
| Snapshot | downloads `VolumeLens_<SYMBOL>_<date>.png` |
| Data failure | a failed data request shows a clear message; Try again recovers |
| Layouts | 1920×1080, 1366×768 and 1024×768 in dark and light: no horizontal overflow, legends inside the chart; screenshots saved to `test-results/screens/` |
| Accessibility | axe-core WCAG 2 A/AA scan: no serious or critical issues (chart canvases excluded) |

Firefox could not be tested from the build machine (the Playwright Firefox download was blocked); Edge and Chrome cover the Chromium engine.

## Issues found by these tests and fixed

| Found by | Issue | Fix |
|---|---|---|
| Replay tests | the "zone" flag looked ahead to the rest of its run | zones now form from the streak so far |
| Backtest review | outcome window started inside the minute already used by the features | decisions at minute end; outcome window starts next minute |
| Browser test | switching time frame left the compare chart on a stale range | explicit re-sync after every rebuild |
| Browser test | quick two-click drawing lost the second point (chart treats it as a double-click) | points read from raw pointer events, drags ignored |
| Accessibility scan | 20 text elements below WCAG AA contrast | muted text, light-theme accent and up/down colours darkened |
| Manual QA | alerts repeated inside one block-trade minute; absorption faked inside a single minute | 15-minute alert spacing; no absorption reading inside one minute |

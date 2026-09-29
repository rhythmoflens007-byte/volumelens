"""Data-quality gate for 1-minute candles, applied before anything is computed.

Rules (each removal is recorded so it can be shown and audited):
  * duplicate timestamps, non-positive prices, high < low, negative volume  -> dropped
  * minutes outside the 09:15-15:29 cash session                             -> dropped
  * "running-total" glitches: some feeds report the day's cumulative volume for the last
    minutes of the most recent session. Signature: at least 5 consecutive minutes above 20x
    the session's median volume, averaging over 60x (observed glitches: 99-335x; the largest
    real closing bursts in our data: under 40x), whose values barely change minute to minute (median step
    under 15%) and that almost never fall (at most one drop of more than 2%). Real bursts
    fluctuate up and down, so they are kept.
"""

import numpy as np
import pandas as pd

GLITCH_MULTIPLE = 20
GLITCH_MIN_RUN = 5
GLITCH_MAX_STEP = 0.15
GLITCH_MAX_DROPS = 1
GLITCH_RUN_MULTIPLE = 60


def clean(df: pd.DataFrame, symbol: str = "") -> tuple[pd.DataFrame, list[dict]]:
    """df has ts (tz-aware), date, hm, open, high, low, close, volume. Returns cleaned df and issues."""
    issues = []
    n0 = len(df)
    bad = (df[["open", "high", "low", "close"]] <= 0).any(axis=1) | (df["high"] < df["low"]) | (df["volume"] < 0)
    outside = (df["hm"] < "09:15") | (df["hm"] > "15:29")
    for mask, why in [(bad, "invalid price or volume"), (outside, "outside the cash session")]:
        if mask.any():
            issues.append({"symbol": symbol, "rule": why, "minutes": int(mask.sum())})
    df = df[~bad & ~outside]

    drop = pd.Series(False, index=df.index)
    for date, day in df.groupby("date"):
        vol = day["volume"].to_numpy(dtype=float)
        med = max(1.0, np.median(vol))
        huge = vol > GLITCH_MULTIPLE * med
        i = 0
        while i < len(day):
            if not huge[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(day) and huge[j + 1]:
                j += 1
            run = vol[i:j + 1]
            steps = np.diff(run) / run[:-1] if len(run) > 1 else np.array([1.0])
            if (len(run) >= GLITCH_MIN_RUN and np.median(run) > GLITCH_RUN_MULTIPLE * med
                    and np.median(np.abs(steps)) < GLITCH_MAX_STEP
                    and (steps < -0.02).sum() <= GLITCH_MAX_DROPS):
                drop.loc[day.index[i:j + 1]] = True
                issues.append({"symbol": symbol, "rule": "running-total volume glitch", "date": date,
                               "from": day["hm"].iat[i], "to": day["hm"].iat[j], "minutes": int(j - i + 1)})
            i = j + 1
    df = df[~drop]
    if issues:
        issues.append({"symbol": symbol, "rule": "total removed", "minutes": int(n0 - len(df))})
    return df.reset_index(drop=True), issues

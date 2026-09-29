"""Adaptive, minute-aligned volume candles.

A candle collects consecutive 1-minute candles until at least `size` shares have traded, then
closes at the end of that minute. So every candle's open, high, low and close are real market
prices, and a very heavy minute becomes a single candle holding a multiple of `size` (its
`multiple`), instead of being split into artificial slices.

`size` is set per session from the average session volume of up to 20 *previous* complete
sessions divided by the target candles per session, so it adapts to each stock without using
future data. Candles never cross a session.
"""

import numpy as np
import pandas as pd

from . import config as C


def daily_bar_sizes(sess: pd.DataFrame, bars_per_day: int | None = None) -> dict[str, int]:
    """Map each date to its candle size, using previous complete sessions only."""
    per_day = bars_per_day or C.BARS_PER_DAY
    by_day = sess.groupby("date").agg(volume=("volume", "sum"), minutes=("volume", "size"))
    sizes: dict[str, int] = {}
    history: list[float] = []
    for date, row in by_day.iterrows():
        if len(history) >= C.MIN_HISTORY_DAYS:
            sizes[date] = _nice_round(float(np.mean(history[-C.LOOKBACK_DAYS:])) / per_day)
        if row["minutes"] >= C.FULL_DAY_MIN_MINUTES:
            history.append(float(row["volume"]))
    return sizes


def build_bars(sess: pd.DataFrame, sizes: dict[str, int]) -> pd.DataFrame:
    """Volume candles for every session that has a size."""
    frames = [_build_day(day, sizes[date]) for date, day in sess.groupby("date") if date in sizes]
    frames = [f for f in frames if len(f)]
    if not frames:
        return pd.DataFrame()
    bars = pd.concat(frames, ignore_index=True)
    bars["fill_min"] = (bars["end"] - bars["start"]) / 60.0
    bars["multiple"] = bars["volume"] / bars["size"]
    return bars


def _build_day(day: pd.DataFrame, size: int) -> pd.DataFrame:
    rows = []
    cum = buy = 0.0
    o = h = l = start = None
    date = day["date"].iat[0]
    for t, O, H, L, Cl, V, bf in day[["epoch", "open", "high", "low", "close", "volume", "buy_frac"]].itertuples(index=False):
        if V <= 0:
            continue
        if cum == 0:
            o, h, l, start = O, H, L, t
        else:
            h, l = max(h, H), min(l, L)
        cum += V
        buy += V * bf
        if cum >= size:
            rows.append((date, start, t + 60, o, h, l, Cl, cum, buy, size))
            cum = buy = 0.0
    # the unfinished last candle of the session is dropped: it never reached its size
    return pd.DataFrame(rows, columns=["date", "start", "end", "open", "high", "low", "close", "volume", "buy_vol", "size"])


def _nice_round(x: float) -> int:
    """Round to 2 significant figures so sizes read cleanly (e.g. 1,80,000)."""
    if x <= 0:
        return 1000
    mag = 10 ** (int(np.floor(np.log10(x))) - 1)
    return int(max(1000, round(x / mag) * mag))

"""Adaptive volume bars with sub-minute fill timing.

Each bar holds exactly `size` shares. `size` is set per day from the average session volume
of up to 20 *previous* complete days, so it adapts to each stock without using future data.
1-minute data only tells us how much traded in a minute, so when a bar fills part-way through
a minute we assume volume and price flowed evenly through that minute and split it.
"""

import numpy as np
import pandas as pd

from . import config as C


def daily_bar_sizes(sess: pd.DataFrame) -> dict[str, int]:
    """Map each date to its volume-bar size, using previous complete days only."""
    per_day = sess.groupby("date").agg(volume=("volume", "sum"), minutes=("volume", "size"))
    sizes: dict[str, int] = {}
    history: list[float] = []
    for date, row in per_day.iterrows():
        if len(history) >= C.MIN_HISTORY_DAYS:
            avg = float(np.mean(history[-C.LOOKBACK_DAYS:]))
            sizes[date] = _nice_round(avg / C.BARS_PER_DAY)
        if row["minutes"] >= C.FULL_DAY_MIN_MINUTES:
            history.append(float(row["volume"]))
    return sizes


def build_bars(sess: pd.DataFrame, sizes: dict[str, int]) -> pd.DataFrame:
    """Volume bars for every date that has a size. Bars never cross a trading day."""
    frames = [_build_day(day, sizes[date]) for date, day in sess.groupby("date") if date in sizes]
    frames = [f for f in frames if len(f)]
    if not frames:
        return pd.DataFrame()
    bars = pd.concat(frames, ignore_index=True)
    bars["fill_min"] = (bars["end"] - bars["start"]) / 60.0
    return bars


def _build_day(day: pd.DataFrame, size: int) -> pd.DataFrame:
    rows = []
    cum = 0.0
    buy = 0.0
    o = h = l = start = None
    for t, O, H, L, Cl, V, bf in day[["epoch", "open", "high", "low", "close", "volume", "buy_frac"]].itertuples(index=False):
        if V <= 0:
            continue
        remaining = float(V)
        pos = 0.0                                   # fraction of this minute already used
        while remaining > 1e-9:
            take = min(size - cum, remaining)
            end_frac = min(1.0, pos + take / V)
            p0 = O + (Cl - O) * pos                 # price assumed to move evenly within the minute
            p1 = O + (Cl - O) * end_frac
            whole = pos == 0.0 and end_frac >= 1.0
            seg_hi = H if whole else max(p0, p1)
            seg_lo = L if whole else min(p0, p1)
            if cum == 0.0:
                o, h, l, start = p0, seg_hi, seg_lo, t + pos * 60.0
            else:
                h, l = max(h, seg_hi), min(l, seg_lo)
            cum += take
            buy += take * bf
            remaining -= take
            pos = end_frac
            if cum >= size - 1e-6:
                rows.append((day["date"].iat[0], start, t + end_frac * 60.0, o, h, l, p1, size, buy))
                cum, buy = 0.0, 0.0
    # the unfinished last bar of the day is dropped: it never reached its share target
    return pd.DataFrame(rows, columns=["date", "start", "end", "open", "high", "low", "close", "volume", "buy_vol"])


def _nice_round(x: float) -> int:
    """Round to 2 significant figures so bar sizes read cleanly (e.g. 216,000)."""
    if x <= 0:
        return 1000
    mag = 10 ** (int(np.floor(np.log10(x))) - 1)
    return int(max(1000, round(x / mag) * mag))

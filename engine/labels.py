"""Targets and time-chart comparison scores, computed from the raw 1-minute data."""

import numpy as np
import pandas as pd

from . import config as C


def add_labels(bars: pd.DataFrame, sess: pd.DataFrame) -> pd.DataFrame:
    """big_move = the price range over the 30 minutes after a bar closes is more than
    2x the normal 30-minute range (normal = median of the previous ~4 days of 30-minute ranges).
    Bars whose 30-minute window runs past the session end get no label."""
    b = bars.copy()
    m = sess
    hor = C.LABEL_HORIZON_MIN

    back_rng = []
    for _, day in m.groupby("date", sort=False):
        hi = day["high"].rolling(hor, min_periods=hor).max()
        lo = day["low"].rolling(hor, min_periods=hor).min()
        back_rng.append((hi - lo) / day["close"])
    m = m.assign(back_rng=pd.concat(back_rng))
    m["normal_rng"] = m["back_rng"].shift(1).rolling(C.LABEL_NORMAL_MINUTES, min_periods=300).median()

    # 5-minute volume spike: the natural "fast volume" signal on a time-based chart
    vol5 = m.groupby("date")["volume"].transform(lambda s: s.rolling(5, min_periods=5).sum())
    m["vol5_ratio"] = vol5 / vol5.shift(1).rolling(C.LABEL_NORMAL_MINUTES, min_periods=300).median()

    fwd, normal, spike = [], [], []
    by_date = {d: g for d, g in m.groupby("date")}
    for date, end in zip(b["date"], b["end"]):
        day = by_date[date]
        t = day["epoch"].to_numpy()
        i = np.searchsorted(t, end, side="right") - 1           # minute the bar closed in
        if i < 0:
            fwd.append(np.nan); normal.append(np.nan); spike.append(np.nan)
            continue
        normal.append(day["normal_rng"].iat[i])
        spike.append(day["vol5_ratio"].iat[i])
        last_needed = end + hor * 60
        if t[-1] + 60 < last_needed:                            # window runs past the day
            fwd.append(np.nan)
            continue
        win = day[(day["epoch"] + 60 > end) & (day["epoch"] < last_needed)]
        fwd.append((win["high"].max() - win["low"].min()) / win["close"].iat[0])

    b["fwd_range"] = fwd
    b["normal_range"] = normal
    b["time_vol_spike"] = spike
    valid = b["fwd_range"].notna() & b["normal_range"].notna()
    b["big_move"] = np.where(valid, (b["fwd_range"] > C.LABEL_MULTIPLIER * b["normal_range"]).astype(float), np.nan)
    return b


def time_candles(sess: pd.DataFrame, date: str, minutes: int = 5) -> pd.DataFrame:
    """Classic time-based candles for one day."""
    day = sess[sess["date"] == date]
    key = day["epoch"] // (minutes * 60) * (minutes * 60)
    g = day.groupby(key)
    return pd.DataFrame({
        "time": g["epoch"].first().index,
        "open": g["open"].first(), "high": g["high"].max(),
        "low": g["low"].min(), "close": g["close"].last(), "volume": g["volume"].sum(),
    }).reset_index(drop=True)

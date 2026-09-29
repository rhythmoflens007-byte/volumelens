"""Targets and time-chart comparison scores, computed from the raw 1-minute data."""

import numpy as np
import pandas as pd

from . import config as C


def add_labels(bars: pd.DataFrame, sess: pd.DataFrame) -> pd.DataFrame:
    """Decision time for a bar = the end of the minute in which it completed (1-minute data
    only reveals a minute's volume and close once that minute is over).

    big_move = the price range over the next 30 full minutes after that decision time is
    more than 2x the normal 30-minute range (median of the previous ~4 days of 30-minute
    ranges). Bars whose window runs past the session end get no label.

    Also adds two comparison signals known at decision time:
      time_vol_spike - last 5 minutes' volume vs normal (what a time chart shows)
      recent_range   - last 30 minutes' price range vs normal (recent volatility)"""
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

    fwd, normal, spike, recent = [], [], [], []
    by_date = {d: g for d, g in m.groupby("date")}
    for date, end in zip(b["date"], b["end"]):
        day = by_date[date]
        t = day["epoch"].to_numpy()
        i = np.searchsorted(t, end - 1e-6, side="right") - 1    # minute the bar completed in
        if i < 0:
            fwd.append(np.nan); normal.append(np.nan); spike.append(np.nan); recent.append(np.nan)
            continue
        nr = day["normal_rng"].iat[i]
        normal.append(nr)
        spike.append(day["vol5_ratio"].iat[i])
        recent.append(day["back_rng"].iat[i] / nr if nr else np.nan)
        decided = t[i] + 60                                     # end of that minute
        if t[-1] + 60 < decided + hor * 60:                     # window runs past the day
            fwd.append(np.nan)
            continue
        win = day[(day["epoch"] >= decided) & (day["epoch"] < decided + hor * 60)]
        fwd.append((win["high"].max() - win["low"].min()) / day["close"].iat[i])

    b["fwd_range"] = fwd
    b["normal_range"] = normal
    b["time_vol_spike"] = spike
    b["recent_range"] = recent
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

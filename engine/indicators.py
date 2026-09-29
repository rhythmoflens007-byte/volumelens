"""Per-bar indicators. Every rolling statistic is shifted so a bar never sees its own future."""

import numpy as np
import pandas as pd

from . import config as C


def add_indicators(bars: pd.DataFrame) -> pd.DataFrame:
    b = bars.copy().reset_index(drop=True)
    _fill_baseline(b)
    _speed_classes(b)
    _vpin(b)
    _absorption(b)
    _shape(b)
    b["fill_smooth"] = b.groupby("date")["fill_min"].transform(
        lambda s: s.ewm(span=C.SMOOTH_SPAN_FILL, adjust=False).mean())
    return b


def _fill_baseline(b: pd.DataFrame) -> None:
    """Normal fill time for each bar = blend of
    (a) median of the previous 50 bars (recent activity) and
    (b) median of the same 30-minute slot on previous days (time-of-day pattern).
    Fill times are rescaled to the current bar size so days with different sizes compare fairly."""
    per_share = b["fill_min"] / b["volume"]
    recent = per_share.shift(1).rolling(C.BASELINE_BARS, min_periods=C.BASELINE_MIN_BARS).median()

    slot_of_day = ((b["end"] + C.IST_OFFSET_SECONDS) // 60 % 1440 // C.SLOT_MINUTES).astype(int)
    b["slot"] = slot_of_day
    slot_med = pd.Series(np.nan, index=b.index)
    dates = list(dict.fromkeys(b["date"]))
    for i, date in enumerate(dates):
        prev = b["date"].isin(dates[max(0, i - C.LOOKBACK_DAYS):i])
        if not prev.any():
            continue
        med = per_share[prev].groupby(slot_of_day[prev]).median()
        today = b["date"] == date
        slot_med[today] = slot_of_day[today].map(med)

    base = pd.concat([recent, slot_med], axis=1).mean(axis=1, skipna=True)
    b["baseline_min"] = base * b["volume"]
    b["ratio"] = b["fill_min"] / b["baseline_min"]


def _speed_classes(b: pd.DataFrame) -> None:
    """Pace = time to fill the last 3 bars / normal time for 3 bars (within the day).
    Judging 3 bars together stops one busy minute from flagging a bar on its own."""
    by_day = b.groupby("date")
    fill_k = by_day["fill_min"].transform(lambda s: s.rolling(C.PACE_BARS, min_periods=1).sum())
    base_k = by_day["baseline_min"].transform(lambda s: s.rolling(C.PACE_BARS, min_periods=1).sum())
    b["pace"] = fill_k / base_k
    fast = (b["pace"] < C.FAST_RATIO).fillna(False)
    watch = (~fast & (b["pace"] < C.WATCH_RATIO)).fillna(False)
    b["speed"] = np.where(fast, "fast", np.where(watch, "watch", "normal"))

    # consecutive fast bars (resets every day) and fast-inflow zones of >= 2 bars
    run_id = (fast != fast.shift()).cumsum() + b["date"].factorize()[0] * 100000
    streak = fast.groupby(run_id).cumsum().where(fast, 0)
    run_len = fast.groupby(run_id).transform("sum").where(fast, 0)
    b["streak"] = streak.astype(int)
    b["zone"] = (run_len >= C.ZONE_MIN_BARS)


def _vpin(b: pd.DataFrame) -> None:
    """VPIN = sum |buy - sell| / sum volume over the last 50 volume bars."""
    imbalance = (2 * b["buy_vol"] - b["volume"]).abs()
    num = imbalance.rolling(C.VPIN_WINDOW, min_periods=C.VPIN_MIN_BARS).sum()
    den = b["volume"].rolling(C.VPIN_WINDOW, min_periods=C.VPIN_MIN_BARS).sum()
    b["vpin"] = (num / den).clip(0, 1)


def _absorption(b: pd.DataFrame) -> None:
    """Absorption Anomaly Index = 1 - actual move / expected move.
    Actual move = |log return| of the bar; expected = median of the previous 100 bars.
    Near 1: volume came in but price barely moved (someone absorbed it)."""
    prev_close = b.groupby("date")["close"].shift(1).fillna(b["open"])
    move = np.log(b["close"] / prev_close).abs()
    expected = move.shift(1).rolling(C.AAI_WINDOW, min_periods=C.AAI_MIN_BARS).median()
    aai = 1 - move / expected.replace(0, np.nan)
    # A bar that starts and ends inside one minute has no measurable price path in 1-minute
    # data (the even split inside the minute would fake "no move"), so it gets no reading.
    inside_one_minute = (b["start"] // 60) == ((b["end"] - 1e-6) // 60)
    aai = aai.mask(inside_one_minute)
    b["move"] = move
    b["aai"] = aai.clip(lower=C.AAI_FLOOR, upper=1.0)
    b["aai_smooth"] = b.groupby("date")["aai"].transform(
        lambda s: s.ewm(span=C.SMOOTH_SPAN_AAI, adjust=False).mean())


def _shape(b: pd.DataFrame) -> None:
    rng = (b["high"] - b["low"]).replace(0, np.nan)
    b["delta"] = ((b["close"] - b["open"]) / rng).fillna(0).clip(-1, 1)
    ret = np.log(b["close"] / b.groupby("date")["close"].shift(1).fillna(b["open"]))
    short = ret.shift(1).rolling(20, min_periods=10).std()
    long = ret.shift(1).rolling(200, min_periods=50).std()
    b["vol_regime"] = (short / long).clip(0, 5)
    b["tod"] = ((b["end"] + C.IST_OFFSET_SECONDS) // 60 % 1440) - (9 * 60 + 15)

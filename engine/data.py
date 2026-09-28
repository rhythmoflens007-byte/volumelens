"""Load 1-minute NSE OHLCV data exported from AngelOne SmartAPI."""

from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C


def load_minutes(csv_path: str | Path) -> pd.DataFrame:
    """Return clean session minutes with epoch seconds, date and a bulk-volume buy fraction."""
    df = pd.read_csv(csv_path)
    ts = pd.to_datetime(df["timestamp"])
    if ts.dt.tz is None:
        ts = ts.dt.tz_localize("Asia/Kolkata")
    df["ts"] = ts.dt.tz_convert("Asia/Kolkata")
    df = (df.drop(columns=["timestamp"])
            .drop_duplicates("ts")
            .sort_values("ts")
            .reset_index(drop=True))
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["open", "high", "low", "close", "volume"])

    # Bulk volume classification (Easley, Lopez de Prado & O'Hara): the share of a minute's
    # volume that was buyer-initiated = Phi(price change / sigma), sigma from past minutes only.
    dp = df["close"].diff()
    sigma = dp.shift(1).rolling(C.BVC_SIGMA_MINUTES, min_periods=30).std()
    z = (dp / sigma).clip(-6, 6)
    df["buy_frac"] = _norm_cdf(z.to_numpy()).clip(0, 1)
    df.loc[sigma.isna() | (sigma == 0) | dp.isna(), "buy_frac"] = 0.5

    df["date"] = df["ts"].dt.strftime("%Y-%m-%d")
    df["hm"] = df["ts"].dt.strftime("%H:%M")
    df["epoch"] = (df["ts"] - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(seconds=1)
    return df


def session(df: pd.DataFrame) -> pd.DataFrame:
    """Minutes inside the analysed session window."""
    return df[(df["hm"] >= C.SESSION_START) & (df["hm"] <= C.SESSION_END)].reset_index(drop=True)


def _norm_cdf(x: np.ndarray) -> np.ndarray:
    from math import erf, sqrt
    out = np.full(x.shape, 0.5)
    ok = ~np.isnan(x)
    out[ok] = 0.5 * (1.0 + np.vectorize(erf)(x[ok] / sqrt(2.0)))
    return out

"""Urgency: how much of a day's volume arrived unusually fast, and what followed it.

A bar is *urgent* when the last 3 volume bars filled in under 40% of their normal time
(see indicators._speed_classes). Everything here is computed from those flags.
"""

import numpy as np
import pandas as pd

from . import config as C


def hhmm(epoch: float) -> str:
    m = int((epoch + C.IST_OFFSET_SECONDS) // 60 % 1440)
    return f"{m // 60:02d}:{m % 60:02d}"


def day_stats(day: pd.DataFrame) -> dict:
    """Urgency summary for one stock on one day (bars in time order)."""
    urgent = (day["speed"] == "fast").to_numpy()
    vol = day["volume"].to_numpy()
    score = float(vol[urgent].sum() / vol.sum() * 100) if vol.sum() else 0.0

    best = None
    i, n = 0, len(day)
    while i < n:
        if not urgent[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and urgent[j + 1]:
            j += 1
        run = {"bars": j - i + 1, "start": float(day["start"].iat[i]), "end": float(day["end"].iat[j]),
               "shares": int(vol[i:j + 1].sum())}
        if best is None or run["shares"] > best["shares"]:
            best = run
        i = j + 1

    out = {"urgency_score": round(score, 1),
           "zones": int((day["streak"] == C.ZONE_MIN_BARS).sum()),
           "urgent_bars": int(urgent.sum())}
    if best:
        minutes = max(1, round((best["end"] - best["start"]) / 60))
        first = day[(day["end"] > best["start"])].iloc[0]
        out["burst"] = {"bars": best["bars"], "shares": best["shares"], "minutes": minutes,
                        "from": hhmm(best["start"]), "to": hhmm(best["end"]),
                        "time_candles": int(np.ceil((best["end"] - best["start"] + 1) / 300)),
                        "start_price": round(float(first["open"]), 2)}
    return out


def event_study(df: pd.DataFrame) -> dict:
    """What happened in the 30 minutes after urgent vs normal bars (all labelled bars)."""
    lab = df[df["big_move"].notna()]

    def rates(d: pd.DataFrame) -> dict:
        u = d["speed"] == "fast"
        after_u, after_n = d.loc[u, "big_move"].mean(), d.loc[~u, "big_move"].mean()
        return {"urgent": float(after_u), "other": float(after_n), "lift": float(after_u / after_n),
                "urgent_bars": int(u.sum()), "bars": int(len(d))}

    lifts = []
    for thr in (0.30, 0.35, 0.40, 0.45, 0.50):
        u = lab["pace"] < thr
        lifts.append(float(lab.loc[u, "big_move"].mean() / lab.loc[~u, "big_move"].mean()))
    return {"all_day": rates(lab), "after_10_30": rates(lab[lab["tod"] >= 75]),
            "lift_range": [min(lifts), max(lifts)], "thresholds": [0.30, 0.50]}

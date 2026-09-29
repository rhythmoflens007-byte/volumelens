"""LightGBM model, walk-forward validation, fair baselines and explained AI alerts."""

import numpy as np
import pandas as pd
import lightgbm as lgb

# Kept deliberately small: with ~30 trading days, larger feature sets and deeper trees
# overfitted in walk-forward tests (see README). Monotone constraints encode the only
# direction each signal is allowed to push the risk.
# Same signal set that backtest.py validates as "VolumeLens": time-chart context plus the volume clock.
FEATURES = ["vol_spike_log", "recent_range_log", "open_hour", "log_pace", "vpin"]
MONOTONE = [1, 1, 1, -1, 1]

PARAMS = dict(objective="binary", learning_rate=0.05, num_leaves=3, min_data_in_leaf=150,
              lambda_l2=10.0, monotone_constraints=MONOTONE,
              verbose=-1, seed=7, deterministic=True, num_threads=4)
ROUNDS = 150
TEST_BLOCK_DAYS = 3
MIN_TRAIN_DAYS = 8
EMBARGO_DAYS = 1
ALERT_QUANTILE = 0.95
ALERT_COOLDOWN_SECONDS = 15 * 60   # one burst -> one alert, even if it spans many bars
MAX_ALERTS_PER_DAY = 6


def add_features(b: pd.DataFrame) -> pd.DataFrame:
    b = b.copy()
    b["log_ratio"] = np.log(b["ratio"].clip(0.01, 20))
    b["log_pace"] = np.log(b["pace"].clip(0.01, 20))
    b["zone"] = b["zone"].astype(int)
    b["vol_spike_log"] = np.log(b["time_vol_spike"].clip(0.01, 50))
    b["open_hour"] = (b["tod"] < 75).astype(int)          # 09:15-10:30
    b["recent_range_log"] = np.log(b["recent_range"].clip(0.01, 50))
    return b


class Model:
    """LightGBM plus a past-only calibration: a prediction is reported as its percentile
    among the model's own training predictions, so scores mean the same thing in every fold."""

    def __init__(self, rows: pd.DataFrame, features=None, monotone=None):
        self.features = features or FEATURES
        y = rows["big_move"].to_numpy()
        pos = max(1.0, y.sum())
        params = dict(PARAMS, scale_pos_weight=(len(y) - pos) / pos,
                      monotone_constraints=monotone or MONOTONE)
        self.booster = lgb.train(params, lgb.Dataset(rows[self.features], y), ROUNDS)
        self.ref = np.sort(self.booster.predict(rows[self.features]))

    def predict(self, rows: pd.DataFrame) -> np.ndarray:
        raw = self.booster.predict(rows[self.features])
        return np.searchsorted(self.ref, raw, side="right") / len(self.ref)

    def contributions(self, rows: pd.DataFrame) -> np.ndarray:
        """Exact TreeSHAP values (log-odds) per feature, plus the bias column."""
        return self.booster.predict(rows[self.features], pred_contrib=True)


def _train(rows: pd.DataFrame, features=None, monotone=None) -> Model:
    return Model(rows, features, monotone)


def walk_forward(df: pd.DataFrame, features=None, monotone=None) -> tuple[pd.DataFrame, list[dict]]:
    """Strict walk-forward: every test block is predicted by a model trained only on
    earlier days, with a 1-day gap between training and testing."""
    labelled = df[df["big_move"].notna()]
    dates = sorted(labelled["date"].unique())
    preds, folds = [], []
    for start in range(MIN_TRAIN_DAYS + EMBARGO_DAYS, len(dates), TEST_BLOCK_DAYS):
        test_dates = dates[start:start + TEST_BLOCK_DAYS]
        train_dates = dates[:start - EMBARGO_DAYS]
        train = labelled[labelled["date"].isin(train_dates)]
        test = labelled[labelled["date"].isin(test_dates)]
        if train["big_move"].sum() < 20 or test.empty:
            continue
        model = _train(train, features, monotone)
        preds.append(pd.Series(model.predict(test), index=test.index))
        folds.append({"train_days": len(train_dates), "test_days": test_dates,
                      "train_rows": len(train), "test_rows": len(test)})
    oos = labelled.loc[pd.concat(preds).index].copy()
    oos["prob"] = pd.concat(preds)
    return oos, folds


def cross_fit(df: pd.DataFrame) -> tuple[pd.Series, pd.DataFrame]:
    """Predictions for the website: each 3-day block is scored by a model that never saw it
    (trained on all other days, 1-day gap on each side). Returns probabilities and SHAP values."""
    labelled = df[df["big_move"].notna()]
    dates = sorted(df["date"].unique())
    probs = pd.Series(np.nan, index=df.index)
    contrib = pd.DataFrame(np.nan, index=df.index, columns=FEATURES + ["bias"])
    for start in range(0, len(dates), TEST_BLOCK_DAYS):
        block = dates[start:start + TEST_BLOCK_DAYS]
        lo, hi = max(0, start - EMBARGO_DAYS), start + TEST_BLOCK_DAYS + EMBARGO_DAYS
        banned = set(dates[lo:hi])
        train = labelled[~labelled["date"].isin(banned)]
        rows = df[df["date"].isin(block)]
        if rows.empty or train["big_move"].sum() < 20:
            continue
        model = _train(train)
        probs[rows.index] = model.predict(rows)
        contrib.loc[rows.index] = model.contributions(rows)
    return probs, contrib


def auc(y: np.ndarray, s: np.ndarray) -> float:
    """Area under the ROC curve (Mann-Whitney U), ties handled by average ranks."""
    ok = ~np.isnan(s)
    y, s = y[ok], s[ok]
    pos, neg = y.sum(), len(y) - y.sum()
    if pos == 0 or neg == 0:
        return float("nan")
    ranks = pd.Series(s).rank().to_numpy()
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))


def evaluate(oos: pd.DataFrame, fast_rate: float) -> dict:
    """Compare four ways of spotting a coming big move on identical out-of-sample bars."""
    y = oos["big_move"].to_numpy().astype(int)
    scores = {
        "time_chart": oos["time_vol_spike"].to_numpy(),      # 5-min volume spike on a time chart
        "vpin": oos["vpin"].to_numpy(),
        "volume_bars": -oos["log_pace"].to_numpy(),           # faster fill = higher score
        "recent_volatility": oos["recent_range"].to_numpy(),  # last 30 min range vs normal
        "volumelens": oos["prob"].to_numpy(),
    }
    out = {"rows": int(len(oos)), "big_moves": int(y.sum()), "base_rate": float(y.mean()),
           "alert_rate": float(fast_rate), "auc": {}, "catch_rate": {}, "precision": {}, "per_stock": {}}
    for name, s in scores.items():
        s = s.astype(float)
        out["auc"][name] = auc(y, s)
        thr = np.nanquantile(s, 1 - fast_rate)                 # same number of alarms for everyone
        flag = s >= thr
        out["catch_rate"][name] = float(flag[y == 1].mean())
        out["precision"][name] = float(y[flag].mean())
    for sym, g in oos.groupby("symbol"):
        yy = g["big_move"].to_numpy().astype(int)
        out["per_stock"][sym] = {"rows": int(len(g)), "big_moves": int(yy.sum()),
                                 "auc_vpin": auc(yy, g["vpin"].to_numpy()),
                                 "auc_volumelens": auc(yy, g["prob"].to_numpy())}
    return out


# ---------- AI alerts ----------

def pick_alerts(df: pd.DataFrame, probs: pd.Series, contrib: pd.DataFrame) -> pd.DataFrame:
    thr = float(np.nanquantile(probs, ALERT_QUANTILE))
    alerts = []
    for (sym, date), g in df.assign(prob=probs).groupby(["symbol", "date"], sort=False):
        last_end = -10**12
        for pos, (idx, row) in enumerate(g.iterrows()):
            if np.isnan(row["prob"]) or row["prob"] < thr or row["end"] - last_end < ALERT_COOLDOWN_SECONDS:
                continue
            last_end = row["end"]
            c = contrib.loc[idx, FEATURES]
            top = [f for f in c.sort_values(ascending=False).index
                   if c[f] > 0 and not pd.isna(row[f])][:3]
            alerts.append({"index": idx, "prob": float(row["prob"]), "kind": _kind(row),
                           "reasons": [_reason(f, row) for f in top] or ["unusual mix of flow signals"]})
    out = pd.DataFrame(alerts)
    if len(out):
        # keep the chart readable: at most the strongest few alerts per stock per day
        day_key = df.loc[out["index"], ["symbol", "date"]].agg("|".join, axis=1).to_numpy()
        out = (out.assign(day=day_key).sort_values("prob", ascending=False)
                  .groupby("day").head(MAX_ALERTS_PER_DAY).drop(columns="day").sort_values("index"))
    out.attrs["threshold"] = thr
    return out


def _kind(r) -> str:
    if r["speed"] == "fast" and r["aai_smooth"] > 0.4:
        return "Urgent volume, price held"
    if r["zone"]:
        return "Urgent inflow"
    if r["aai_smooth"] > 0.4:
        return "Price held on heavy volume"
    if r["vol_regime"] > 1.5:
        return "Volatility build-up"
    return "Unusual flow"


def _reason(f: str, r) -> str:
    if f == "vol_spike_log":
        return f"last 5 min volume {r['time_vol_spike']:.1f}x normal"
    if f == "recent_range_log":
        return f"last 30 min range {r['recent_range']:.1f}x normal"
    if f == "open_hour":
        return "opening hour, the most volatile part of the day"
    if f == "log_ratio":
        return f"bar filled {1 / max(r['ratio'], 1e-3):.1f}x faster than normal"
    if f == "log_pace":
        return f"last 3 bars filled {1 / max(r['pace'], 1e-3):.1f}x faster than normal"
    if f == "streak":
        return f"{int(r['streak'])} fast bars in a row"
    if f == "zone":
        return "inside a fast-inflow zone"
    if f in ("aai", "aai_smooth"):
        v = r[f]
        return (f"price moved {v * 100:.0f}% less than expected" if v > 0
                else f"price moved {1 - v:.1f}x the expected amount")
    if f == "delta":
        d = r["delta"]
        return "buyers in control" if d > 0.3 else "sellers in control" if d < -0.3 else "buyers and sellers balanced"
    if f == "vpin":
        return f"one-sided order flow (VPIN {r['vpin']:.2f})"
    if f == "vol_regime":
        return f"volatility {r['vol_regime']:.1f}x its usual level"
    if f == "tod":
        m = int(r["tod"]) + 9 * 60 + 15
        return f"time-of-day pattern ({m // 60:02d}:{m % 60:02d})"
    return f

"""Full backtest of the VolumeLens methodology. Writes backtest/report.md and backtest/results.json.

Questions answered, all on out-of-sample (walk-forward) days:
  1. How do simple signals and models compare at spotting a coming big move?
  2. Does the volume clock add information beyond a time chart? (same model, with/without it)
  3. Are the differences real? (block bootstrap over test days)
  4. Do results survive other reasonable thresholds? (stability grid)
  5. Does "urgency" mean anything on its own? (event study, shuffle test, direction test)

    python backtest.py
"""

import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

import run
from engine import config as C
from engine import model as M

ROOT = Path(__file__).parent
OUT = ROOT / "backtest"
RNG = np.random.default_rng(7)
N_BOOT = 1000

MODELS = {
    # a model that only sees what a normal time chart shows
    "time_chart_model": (["vol_spike_log", "recent_range_log", "open_hour"], [1, 1, 1]),
    # the same model plus the volume-clock signals
    "volumelens": (["vol_spike_log", "recent_range_log", "open_hour", "log_pace", "vpin"], [1, 1, 1, -1, 1]),
    # volume-clock signals on their own
    "volume_clock_model": (["log_pace", "vpin", "open_hour"], [-1, 1, 1]),
}
SIGNALS = {  # single signals, no training
    "time_volume_spike": lambda d: d["time_vol_spike"],
    "recent_volatility": lambda d: d["recent_range"],
    "vpin": lambda d: d["vpin"],
    "fill_pace": lambda d: -d["log_pace"],
}
LABELS = {
    "time_volume_spike": "Time chart: 5-min volume spike",
    "recent_volatility": "Time chart: last 30-min range",
    "vpin": "VPIN (rebuilt)",
    "fill_pace": "Volume clock: fill pace",
    "time_chart_model": "Model: time-chart signals only",
    "volume_clock_model": "Model: volume-clock signals only",
    "volumelens": "VolumeLens: time chart + volume clock",
}


def build(bars_per_day: int | None = None) -> pd.DataFrame:
    old = C.BARS_PER_DAY
    if bars_per_day:
        C.BARS_PER_DAY = bars_per_day
    try:
        frames = [run.build_symbol(p)[0] for p in sorted((ROOT / "data").glob("*.csv"))]
    finally:
        C.BARS_PER_DAY = old
    return M.add_features(pd.concat(frames, ignore_index=True))


def out_of_sample(df: pd.DataFrame) -> pd.DataFrame:
    """One table of out-of-sample scores for every signal and model, on identical rows."""
    base = None
    for name, (feats, mono) in MODELS.items():
        oos, folds = M.walk_forward(df, feats, mono)
        if base is None:
            base = oos.drop(columns="prob")
            base.attrs["folds"] = folds
        base[name] = oos["prob"]
    for name, f in SIGNALS.items():
        base[name] = f(base).astype(float)
    return base


def bootstrap(oos: pd.DataFrame, names: list[str], pairs: list[tuple[str, str]]) -> dict:
    """Resample whole test days with replacement (keeps intraday dependence intact)."""
    days = oos["date"].unique()
    groups = {d: g.index.to_numpy() for d, g in oos.groupby("date")}
    y_all = oos["big_move"].to_numpy().astype(int)
    pos = {i: k for k, i in enumerate(oos.index)}
    cols = {n: oos[n].to_numpy() for n in names}
    draws = {n: [] for n in names}
    for _ in range(N_BOOT):
        pick = RNG.choice(days, size=len(days), replace=True)
        idx = np.concatenate([[pos[i] for i in groups[d]] for d in pick])
        y = y_all[idx]
        for n in names:
            draws[n].append(M.auc(y, cols[n][idx]))
    out = {"auc_ci": {}, "diff": {}}
    for n in names:
        a = np.array(draws[n])
        out["auc_ci"][n] = [float(np.nanpercentile(a, 2.5)), float(np.nanpercentile(a, 97.5))]
    for a, b in pairs:
        d = np.array(draws[a]) - np.array(draws[b])
        out["diff"][f"{a} - {b}"] = {"mean": float(np.nanmean(d)), "ci": [float(np.nanpercentile(d, 2.5)), float(np.nanpercentile(d, 97.5))],
                                     "share_above_zero": float(np.nanmean(d > 0))}
    return out


def catch_rates(oos: pd.DataFrame, names: list[str], alert_rate: float) -> dict:
    y = oos["big_move"].to_numpy().astype(int)
    res = {}
    for n in names:
        s = oos[n].to_numpy()
        flag = s >= np.nanquantile(s, 1 - alert_rate)
        res[n] = {"caught": float(flag[y == 1].mean()), "precision": float(y[flag].mean())}
    return res


def event_study(df: pd.DataFrame) -> dict:
    lab = df[df["big_move"].notna()].copy()
    lab["rel"] = lab["fwd_range"] / lab["normal_range"]
    def table(d):
        g = d.groupby("speed").agg(bars=("rel", "size"), next30_range_x_normal=("rel", "median"), big_move_rate=("big_move", "mean"))
        return {k: {c: float(v) for c, v in row.items()} for k, row in g.iterrows()}
    y = lab["big_move"].to_numpy().astype(int)
    real = M.auc(y, -lab["log_pace"].to_numpy())
    shuffled = [M.auc(y, -lab.groupby(["symbol", "date"])["log_pace"].transform(lambda x: RNG.permutation(x.to_numpy())).to_numpy())
                for _ in range(100)]
    return {"all_day": table(lab), "after_10_30": table(lab[lab["open_hour"] == 0]),
            "shuffle": {"real_auc": real, "shuffled_mean": float(np.mean(shuffled)), "shuffled_max": float(np.max(shuffled))}}


def direction_test(df: pd.DataFrame) -> dict:
    """After a fast-inflow zone, does the price keep going the zone's way over 30 minutes?"""
    moves = []
    for _, day in df.groupby(["symbol", "date"]):
        z = day["zone"].to_numpy().astype(bool)
        i = 0
        while i < len(day):
            if not z[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(day) and z[j + 1]:
                j += 1
            zone_move = day["close"].iat[j] / day["open"].iat[i] - 1
            later = day[day["end"] >= day["end"].iat[j] + 30 * 60]
            if len(later) and abs(zone_move) > 1e-5:
                moves.append((np.sign(zone_move), np.sign(later["close"].iat[0] / day["close"].iat[j] - 1)))
            i = j + 1
    m = np.array(moves)
    same = float((m[:, 0] == m[:, 1]).mean())
    half = 1.96 * np.sqrt(0.25 / len(m))
    return {"zones": int(len(m)), "continued": same, "chance_range": [0.5 - half, 0.5 + half]}


def stability(df: pd.DataFrame) -> dict:
    """Lift of the urgency rule and signal AUC across nearby settings."""
    lab = df[df["big_move"].notna()]
    y = lab["big_move"].to_numpy().astype(int)
    grid = {}
    for fast in [0.30, 0.35, 0.40, 0.45, 0.50]:
        flag = lab["pace"] < fast
        grid[f"fast<{fast:.2f}"] = {"urgent_share": float(flag.mean()),
                                    "big_move_after_urgent": float(lab.loc[flag, "big_move"].mean()),
                                    "big_move_after_other": float(lab.loc[~flag, "big_move"].mean())}
        g = grid[f"fast<{fast:.2f}"]
        g["lift"] = g["big_move_after_urgent"] / g["big_move_after_other"]
    bars = {}
    for n in [50, 75, 100]:
        d = df if n == C.BARS_PER_DAY else build(n)
        oos = out_of_sample(d)
        yy = oos["big_move"].to_numpy().astype(int)
        bars[f"{n} bars/day"] = {k: M.auc(yy, oos[k].to_numpy()) for k in ["fill_pace", "vpin", "time_chart_model", "volumelens"]}
    return {"fast_threshold": grid, "bars_per_day": bars, "pace_auc": M.auc(y, -lab["log_pace"].to_numpy())}


def main() -> None:
    t0 = time.time()
    OUT.mkdir(exist_ok=True)
    df = build()
    oos = out_of_sample(df)
    names = list(SIGNALS) + list(MODELS)
    y = oos["big_move"].to_numpy().astype(int)
    fast_rate = float((df["speed"] == "fast").mean())
    res = {
        "rows": int(len(oos)), "big_moves": int(y.sum()), "base_rate": float(y.mean()),
        "test_days": int(oos["date"].nunique()), "stocks": sorted(oos["symbol"].unique()),
        "auc": {n: M.auc(y, oos[n].to_numpy()) for n in names},
        "alert_rate": fast_rate,
        "at_same_alert_rate": catch_rates(oos, names, fast_rate),
        "per_stock": {s: {n: M.auc(g["big_move"].to_numpy().astype(int), g[n].to_numpy()) for n in ["vpin", "time_chart_model", "volumelens"]}
                      for s, g in oos.groupby("symbol")},
    }
    print("bootstrap...", flush=True)
    res["bootstrap"] = bootstrap(oos, names, [("volumelens", "recent_volatility"), ("volumelens", "time_chart_model"), ("volumelens", "vpin"),
                                              ("volumelens", "time_volume_spike"), ("fill_pace", "vpin"),
                                              ("volume_clock_model", "time_chart_model")])
    print("event study / stability...", flush=True)
    res["urgency"] = event_study(df)
    res["direction"] = direction_test(df)
    res["stability"] = stability(df)
    res["seconds"] = round(time.time() - t0, 1)
    (OUT / "results.json").write_text(json.dumps(res, indent=1, default=float))
    (OUT / "report.md").write_text(report(res), encoding="utf-8")
    print(report(res))


def report(r: dict) -> str:
    f3 = lambda x: f"{x:.3f}"
    pct = lambda x: f"{x * 100:.0f}%"
    L = ["# VolumeLens backtest", "",
         f"Walk-forward: models trained on earlier days only (1-day gap), tested on **{r['test_days']} unseen trading days**, "
         f"{r['rows']:,} volume bars, {r['big_moves']} big moves (base rate {pct(r['base_rate'])}), stocks: {', '.join(r['stocks'])}.",
         "Big move = price range over the next 30 full minutes > 2x the normal 30-minute range. Decisions are made at the end of the minute a bar completes in.", "",
         "## 1. Who spots big moves best?", "",
         f"| Method | AUC | 95% CI | Caught (same alert rate {pct(r['alert_rate'])}) | Precision |", "|---|---|---|---|---|"]
    order = sorted(r["auc"], key=lambda n: r["auc"][n])
    for n in order:
        ci = r["bootstrap"]["auc_ci"][n]
        c = r["at_same_alert_rate"][n]
        L.append(f"| {LABELS[n]} | {f3(r['auc'][n])} | {f3(ci[0])}–{f3(ci[1])} | {pct(c['caught'])} | {pct(c['precision'])} |")
    L += ["", "## 2. Are the differences real? (1,000 block-bootstrap resamples of test days)", "",
          "| Comparison | AUC difference | 95% CI | Share of resamples > 0 |", "|---|---|---|---|"]
    for k, d in r["bootstrap"]["diff"].items():
        a, b = k.split(" - ")
        L.append(f"| {LABELS[a]} vs {LABELS[b]} | {d['mean']:+.3f} | {d['ci'][0]:+.3f} to {d['ci'][1]:+.3f} | {pct(d['share_above_zero'])} |")
    u = r["urgency"]
    L += ["", "## 3. Does urgency mean anything?", "",
          "| After a bar that is… | Bars | Next-30-min range vs normal | Big move follows |", "|---|---|---|---|"]
    for k in ["fast", "watch", "normal"]:
        v = u["all_day"][k]
        L.append(f"| {k} | {int(v['bars'])} | {v['next30_range_x_normal']:.2f}x | {pct(v['big_move_rate'])} |")
    a, n = u["after_10_30"]["fast"], u["after_10_30"]["normal"]
    L += ["", f"Outside the opening hour: big move after fast bars {pct(a['big_move_rate'])} vs normal bars {pct(n['big_move_rate'])}.",
          f"Shuffle test (fill times randomly reordered within each day, 100 times): real AUC {f3(u['shuffle']['real_auc'])}, shuffled mean {f3(u['shuffle']['shuffled_mean'])}, best shuffled {f3(u['shuffle']['shuffled_max'])}.",
          f"Direction: after {r['direction']['zones']} fast-inflow zones the price continued the same way {pct(r['direction']['continued'])} of the time "
          f"(chance range {pct(r['direction']['chance_range'][0])}–{pct(r['direction']['chance_range'][1])}).", "",
          "## 4. Stability across settings", "", "| Urgency rule | Bars flagged | Big move after urgent | After others | Lift |", "|---|---|---|---|---|"]
    for k, v in r["stability"]["fast_threshold"].items():
        L.append(f"| pace {k.replace('fast', '')} | {pct(v['urgent_share'])} | {pct(v['big_move_after_urgent'])} | {pct(v['big_move_after_other'])} | {v['lift']:.1f}x |")
    L += ["", "| Bar size | Fill pace AUC | VPIN AUC | Time-chart model AUC | VolumeLens AUC |", "|---|---|---|---|---|"]
    for k, v in r["stability"]["bars_per_day"].items():
        L.append(f"| {k} | {f3(v['fill_pace'])} | {f3(v['vpin'])} | {f3(v['time_chart_model'])} | {f3(v['volumelens'])} |")
    L += ["", "## 5. Per stock (AUC)", "", "| Stock | VPIN | Time-chart model | VolumeLens |", "|---|---|---|---|"]
    for s, v in r["per_stock"].items():
        L.append(f"| {s} | {f3(v['vpin'])} | {f3(v['time_chart_model'])} | {f3(v['volumelens'])} |")
    L += ["", f"_Generated by backtest.py in {r['seconds']}s._", ""]
    return "\n".join(L)


if __name__ == "__main__":
    main()

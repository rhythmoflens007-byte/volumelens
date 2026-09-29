"""VolumeLens pipeline: CSV minutes -> volume bars -> indicators -> AI model -> web/data JSON.

    python run.py            # all CSVs in ./data
"""

import json
import math
import shutil
import time
from pathlib import Path

import numpy as np
import pandas as pd

from engine import bars as B, config as C, data, indicators as I, labels as L, model as M, urgency as U

ROOT = Path(__file__).parent
OUT = ROOT / "web" / "data"


def build_symbol(csv: Path) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    minutes = data.load_minutes(csv)
    sess = data.session(minutes)
    sizes = B.daily_bar_sizes(sess)
    bars = I.add_indicators(B.build_bars(sess, sizes))
    bars = L.add_labels(bars, sess)
    bars["symbol"] = csv.stem.upper()
    return bars, sess, sizes


def main() -> None:
    t0 = time.time()
    frames, sessions, sizes = [], {}, {}
    for csv in sorted((ROOT / "data").glob("*.csv")):
        b, sess, sz = build_symbol(csv)
        frames.append(b)
        sessions[b["symbol"].iat[0]] = sess
        sizes[b["symbol"].iat[0]] = sz
        print(f"{csv.stem:10s} {b['date'].nunique():3d} days {len(b):5d} bars")
    df = M.add_features(pd.concat(frames, ignore_index=True))

    oos, folds = M.walk_forward(df)
    fast_rate = float((df["speed"] == "fast").mean())
    results = M.evaluate(oos, fast_rate)
    results["folds"] = len(folds)
    results["test_days"] = sorted({d for f in folds for d in f["test_days"]})
    results["features"] = M.FEATURES
    results["urgency"] = U.event_study(df)
    u = results["urgency"]["all_day"]
    print(f"urgency: big move after urgent bars {u['urgent']:.1%} vs {u['other']:.1%} ({u['lift']:.1f}x)")
    print(json.dumps({k: results[k] for k in ("rows", "big_moves", "base_rate", "auc", "catch_rate", "precision")}, indent=1))

    probs, contrib = M.cross_fit(df)
    alerts = M.pick_alerts(df, probs, contrib)
    print(f"alerts: {len(alerts)} (threshold p >= {alerts.attrs['threshold']:.3f})")
    export(df.assign(prob=probs), alerts, sessions, sizes, results)
    print(f"done in {time.time() - t0:.1f}s")


def export(df, alerts, sessions, sizes, results) -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    alert_by_idx = {int(a["index"]): a for a in alerts.to_dict("records")} if len(alerts) else {}
    index = {"generated": time.strftime("%Y-%m-%d %H:%M"), "stocks": [], "results": _clean(results),
             "settings": {"bars_per_day": C.BARS_PER_DAY, "lookback_days": C.LOOKBACK_DAYS,
                          "fast": C.FAST_RATIO, "watch": C.WATCH_RATIO, "pace_bars": C.PACE_BARS,
                          "vpin_window": C.VPIN_WINDOW, "label": f"range over next {C.LABEL_HORIZON_MIN} min > {C.LABEL_MULTIPLIER}x normal"}}
    for sym, g in df.groupby("symbol"):
        (OUT / sym).mkdir()
        sess = sessions[sym]
        dates = sorted(g["date"].unique())
        day_meta = []
        for date in dates:
            day = g[g["date"] == date]
            minutes = L.time_candles(sess, date, minutes=1)     # the browser builds any time frame from these
            day_alerts, rows, used = [], [], set()
            for i, (idx, r) in enumerate(day.iterrows()):
                t = int(round(r["end"])) + C.IST_OFFSET_SECONDS
                while t in used:                                  # charts need unique times
                    t += 1
                used.add(t)
                rows.append([t, int(round(r["start"])) + C.IST_OFFSET_SECONDS,
                             _r(r["open"]), _r(r["high"]), _r(r["low"]), _r(r["close"]),
                             _r(r["fill_min"], 3), _r(r["fill_smooth"], 3), _r(r["baseline_min"], 3),
                             _r(r["pace"], 3), {"normal": 0, "watch": 1, "fast": 2}[r["speed"]],
                             int(r["zone"]), _r(r["vpin"], 4), _r(r["aai"], 3), _r(r["aai_smooth"], 3),
                             _r(r["prob"], 4)])
                if idx in alert_by_idx:
                    a = alert_by_idx[idx]
                    day_alerts.append({"i": i, "t": t, "prob": round(a["prob"], 3), "kind": a["kind"], "reasons": a["reasons"]})
            payload = {"symbol": sym, "date": date, "barSize": sizes[sym][date],
                       "minutes": [[int(c.time) + C.IST_OFFSET_SECONDS, _r(c.open), _r(c.high), _r(c.low), _r(c.close), int(c.volume)]
                                   for c in minutes.itertuples()],
                       "bars": rows, "alerts": day_alerts}
            stats = U.day_stats(day)
            payload["urgency"] = stats
            (OUT / sym / f"{date}.json").write_text(json.dumps(payload, separators=(",", ":")))
            day_meta.append({"date": date, "alerts": len(day_alerts), "bars": len(rows),
                             "close": _r(day["close"].iat[-1]), "open": _r(day["open"].iat[0]), **stats})
        last, prev = day_meta[-1], (day_meta[-2] if len(day_meta) > 1 else day_meta[-1])
        index["stocks"].append({"symbol": sym, "dates": day_meta, "last": last["close"],
                                "change": _r((last["close"] / prev["close"] - 1) * 100, 2)})
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    (ROOT / "results.json").write_text(json.dumps(_clean(results), indent=1))


def _r(x, nd=2):
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return None
    return round(float(x), nd)


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        return None if math.isnan(o) else round(float(o), 4)
    if isinstance(o, np.integer):
        return int(o)
    return o


if __name__ == "__main__":
    main()

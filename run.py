"""VolumeLens pipeline: CSV minutes -> quality gate -> volume candles -> indicators -> model
-> web/data (one index plus one file per stock per session).

    python run.py
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
SPEED = {"normal": 0, "watch": 1, "fast": 2}


def build_symbol(csv: Path, bars_per_day: int | None = None, labels: bool = True):
    """Volume candles with indicators (and labels) for one stock. Returns bars, session minutes, sizes, quality issues."""
    minutes = data.load_minutes(csv)
    sess = data.session(minutes)
    sizes = B.daily_bar_sizes(sess, bars_per_day)
    bars = I.add_indicators(B.build_bars(sess, sizes))
    if labels:
        bars = L.add_labels(bars, sess)
    bars["symbol"] = csv.stem.upper()
    return bars, sess, sizes, minutes.attrs.get("quality", [])


def main() -> None:
    t0 = time.time()
    std, sessions, sizes, other, issues = [], {}, {}, {}, []
    for csv in sorted((ROOT / "data").glob("*.csv")):
        sym = csv.stem.upper()
        b, sess, sz, q = build_symbol(csv, C.DENSITIES["standard"])
        std.append(b); sessions[sym] = sess; issues += q
        sizes[sym] = {"standard": sz}
        other[sym] = {}
        for name in ("fine", "coarse"):
            ob, _, osz, _ = build_symbol(csv, C.DENSITIES[name], labels=False)
            other[sym][name] = ob; sizes[sym][name] = osz
        print(f"{sym:10s} {b['date'].nunique():3d} sessions {len(b):6d} standard candles")
    df = M.add_features(pd.concat(std, ignore_index=True))

    oos, folds = M.walk_forward(df)
    results = M.evaluate(oos, float((df["speed"] == "fast").mean()))
    results.update(folds=len(folds), test_days=sorted({d for f in folds for d in f["test_days"]}),
                   features=M.FEATURES, urgency=U.event_study(df))
    u = results["urgency"]["all_day"]
    print(f"urgency: large move after urgent candles {u['urgent']:.1%} vs {u['other']:.1%} ({u['lift']:.2f}x)")
    print("AUC", {k: round(v, 3) for k, v in results["auc"].items()})

    probs, contrib = M.cross_fit(df)
    alerts = M.pick_alerts(df, probs, contrib)
    print(f"alerts: {len(alerts)}")
    export(df.assign(prob=probs), other, alerts, sessions, sizes, results, issues)
    print(f"done in {time.time() - t0:.1f}s")


def _rows(day: pd.DataFrame) -> list:
    return [[int(r.end) + C.IST_OFFSET_SECONDS, int(r.start) + C.IST_OFFSET_SECONDS,
             _r(r.open), _r(r.high), _r(r.low), _r(r.close), int(r.volume),
             _r(r.fill_min, 2), _r(r.fill_smooth, 2), _r(r.baseline_min, 2), _r(r.pace, 3), _r(r.urgency, 1),
             SPEED[r.speed], _r(r.vpin, 3), _r(r.aai_smooth, 2)]
            for r in day.itertuples()]


def export(df, other, alerts, sessions, sizes, results, issues) -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    alert_by_idx = {int(a["index"]): a for a in alerts.to_dict("records")} if len(alerts) else {}
    index = {"generated": time.strftime("%Y-%m-%d %H:%M"), "densities": C.DENSITIES, "stocks": [],
             "results": _clean(results), "quality": issues,
             "settings": {"lookback_sessions": C.LOOKBACK_DAYS, "urgent_index": C.URGENT_INDEX, "watch_index": C.WATCH_INDEX,
                          "pace_bars": C.PACE_BARS, "vpin_window": C.VPIN_WINDOW,
                          "target": f"range over next {C.LABEL_HORIZON_MIN} min > {C.LABEL_MULTIPLIER}x normal"}}
    for sym, g in df.groupby("symbol"):
        (OUT / sym).mkdir()
        sess = sessions[sym]
        meta = []
        for date in sorted(g["date"].unique()):
            day = g[g["date"] == date]
            day_alerts = []
            rows = _rows(day)
            for i, idx in enumerate(day.index):
                if idx in alert_by_idx:
                    a = alert_by_idx[idx]
                    day_alerts.append({"i": i, "t": rows[i][0], "prob": round(a["prob"], 3), "kind": a["kind"], "reasons": a["reasons"]})
            minutes = L.time_candles(sess, date, minutes=1)
            bars = {"standard": rows}
            for name in ("fine", "coarse"):
                ob = other[sym][name]
                bars[name] = _rows(ob[ob["date"] == date])
            payload = {"symbol": sym, "date": date,
                       "size": {k: sizes[sym][k].get(date) for k in C.DENSITIES},
                       "minutes": [[int(c.time) + C.IST_OFFSET_SECONDS, _r(c.open), _r(c.high), _r(c.low), _r(c.close), int(c.volume)]
                                   for c in minutes.itertuples()],
                       "bars": bars, "alerts": day_alerts}
            (OUT / sym / f"{date}.json").write_text(json.dumps(payload, separators=(",", ":")))
            meta.append({"date": date, "alerts": len(day_alerts), "candles": len(rows),
                         "size": payload["size"], "open": _r(day["open"].iat[0]), "close": _r(day["close"].iat[-1]),
                         **U.day_stats(day)})
        last, prev = meta[-1], (meta[-2] if len(meta) > 1 else meta[-1])
        index["stocks"].append({"symbol": sym, "sessions": meta, "last": last["close"],
                                "change": _r((last["close"] / prev["close"] - 1) * 100, 2)})
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))
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

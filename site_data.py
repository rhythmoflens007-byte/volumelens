"""Small data excerpts for the website pages (the landing hero). Run after run.py.

    python site_data.py
"""

import json
from pathlib import Path

WEB = Path(__file__).parent / "web"
SYMBOL, DATE, FROM, TO, TF = "RELIANCE", "2026-09-29", "09:30", "11:00", 300


def hm(t: int) -> str:
    return f"{t // 3600 % 24:02d}:{t // 60 % 60:02d}"


def main() -> None:
    s = json.loads((WEB / "data" / SYMBOL / f"{DATE}.json").read_text())
    mins = [m for m in s["minutes"] if FROM <= hm(m[0]) < TO]
    t0, t1 = mins[0][0], mins[-1][0] + 60
    candles = {}
    for t, o, h, l, c, v in mins:                          # 5-minute time candles
        k = t - (t - t0) % TF
        x = candles.setdefault(k, [k, o, h, l, c, 0])
        x[2], x[3], x[4], x[5] = max(x[2], h), min(x[3], l), c, x[5] + v
    bricks, prev = [], None
    for r in s["bars"]["standard"]:                       # [T, START, o, h, l, c, vol, ..., uidx(11), speed(12)]
        if t0 < r[0] <= t1:
            o = prev if prev is not None else r[2]
            bricks.append([r[1], r[0], o, r[5], r[11], r[12]])
        prev = r[5]
    out = {"symbol": SYMBOL, "date": DATE, "from": FROM, "to": TO, "t0": t0, "t1": t1, "size": s["size"]["standard"],
           "candles": list(candles.values()), "bricks": bricks}
    (WEB / "data" / "hero.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"hero.json: {len(out['candles'])} five-minute candles, {len(bricks)} bricks, "
          f"{sum(b[5] == 2 for b in bricks)} urgent")


if __name__ == "__main__":
    main()

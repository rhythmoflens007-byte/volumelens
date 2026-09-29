"""Sanity checks: does 'fast inflow' mean anything, and what can it say about who is trading?"""

from pathlib import Path

import numpy as np
import pandas as pd

import run
from engine import model as M

rng = np.random.default_rng(7)
frames, sess = [], {}
for p in sorted(Path("data").glob("*.csv")):
    b, s, _ = run.build_symbol(p)
    frames.append(b)
    sess[b["symbol"].iat[0]] = s
df = M.add_features(pd.concat(frames, ignore_index=True))
lab = df[df["big_move"].notna()].copy()
lab["fwd_rel"] = lab["fwd_range"] / lab["normal_range"]
y = lab["big_move"].to_numpy().astype(int)

print("=== 1. What happens in the 30 minutes after each kind of bar? ===")
g = lab.groupby("speed").agg(bars=("fwd_rel", "size"), next30_range_vs_normal=("fwd_rel", "median"),
                             big_move_rate=("big_move", "mean"))
print(g.round(3).to_string())

print("\n=== 2. Is 'fast' just the opening hour? (same test, excluding 09:15-10:30) ===")
later = lab[lab["open_hour"] == 0]
print(later.groupby("speed").agg(bars=("fwd_rel", "size"), next30_range_vs_normal=("fwd_rel", "median"),
                                 big_move_rate=("big_move", "mean")).round(3).to_string())
print("AUC of fill pace after 10:30:", round(M.auc(later["big_move"].to_numpy().astype(int), -later["log_pace"].to_numpy()), 3))

print("\n=== 3. Shuffle test: randomly reorder fill times within each day ===")
real = M.auc(y, -lab["log_pace"].to_numpy())
shuffled = []
for _ in range(50):
    s = lab.groupby(["symbol", "date"])["log_pace"].transform(lambda x: rng.permutation(x.to_numpy()))
    shuffled.append(M.auc(y, -s.to_numpy()))
print(f"real AUC {real:.3f} | shuffled AUC mean {np.mean(shuffled):.3f} (max of 50: {np.max(shuffled):.3f})")

print("\n=== 4. Direction: after a fast-inflow zone, does price keep going the same way? ===")
rows = []
for (sym, date), day in df.groupby(["symbol", "date"]):
    m = sess[sym][sess[sym]["date"] == date]
    t, c = m["epoch"].to_numpy(), m["close"].to_numpy()
    zone = day["zone"].to_numpy().astype(bool)
    i = 0
    while i < len(day):
        if not zone[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(day) and zone[j + 1]:
            j += 1
        start_px = day["open"].iat[i]
        end_px = day["close"].iat[j]
        end_t = day["end"].iat[j]
        k = np.searchsorted(t, end_t + 30 * 60)
        if k < len(t) and (t[k] - end_t) < 40 * 60:
            zone_move = end_px / start_px - 1
            after = c[k] / end_px - 1
            buy_share = day["buy_vol"].iloc[i:j + 1].sum() / day["volume"].iloc[i:j + 1].sum()
            rows.append((sym, date, zone_move, after, buy_share, j - i + 1))
        i = j + 1
z = pd.DataFrame(rows, columns=["sym", "date", "zone_move", "after30", "buy_share", "bars"])
z = z[z["zone_move"].abs() > 1e-5]
same = np.sign(z["zone_move"]) == np.sign(z["after30"])
print(f"fast-inflow zones tested: {len(z)}")
print(f"price continued in the zone's direction over the next 30 min: {same.mean():.1%} (coin toss = 50%)")
n, k = len(z), int(same.sum())
se = np.sqrt(0.25 / n)
print(f"95% range if it were a coin toss: {0.5 - 1.96 * se:.1%} to {0.5 + 1.96 * se:.1%}")
flow = np.sign(z["buy_share"] - 0.5) == np.sign(z["after30"])
print(f"price followed the buy/sell imbalance (VPIN side) over next 30 min: {flow.mean():.1%}")
big = z[z["bars"] >= 4]
if len(big) >= 10:
    print(f"longer zones (>=4 bars, n={len(big)}): continued {(np.sign(big.zone_move) == np.sign(big.after30)).mean():.1%}")
print("\nper stock continuation:", z.assign(same=same).groupby("sym")["same"].agg(["mean", "size"]).round(2).to_dict("index"))

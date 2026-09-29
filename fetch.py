"""Download recent 1-minute NSE history into data/<SYMBOL>.csv.

    python fetch.py                       # default watchlist, since 2026-06-01
    python fetch.py --since 2026-08-01 RELIANCE SBIN
"""

import argparse
from datetime import date
from pathlib import Path

from feed.angel import Angel

WATCHLIST = ["RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "INFY", "TCS", "AXISBANK", "ITC", "TECHM", "YESBANK", "PNB"]
DATA = Path(__file__).parent / "data"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="*", default=WATCHLIST)
    ap.add_argument("--since", default="2026-06-01")
    ap.add_argument("--until", default=date.today().isoformat())
    args = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    angel = Angel()
    for sym in args.symbols:
        df = angel.history(sym, args.since, args.until)
        if df.empty:
            print(f"{sym:10s} no data")
            continue
        df.to_csv(DATA / f"{sym}.csv", index=False)
        days = df["timestamp"].str[:10].nunique()
        print(f"{sym:10s} {len(df):6d} minutes  {days:3d} sessions  {df['timestamp'].iat[0][:10]} to {df['timestamp'].iat[-1][:16]}")


if __name__ == "__main__":
    main()

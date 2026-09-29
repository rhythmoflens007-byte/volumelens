"""VolumeLens live server.

Receives NSE ticks from the AngelOne WebSocket, builds 1-minute candles, and at every minute
close re-runs the same engine used for history (quality gate -> volume candles -> Urgency Index).
Browsers subscribe with Server-Sent Events and receive today's session in the same format as the
historical session files, so the terminal treats live data exactly like history.

    python -m live.server                              # live, during market hours
    python -m live.server --simulate 2026-09-29        # replay a recorded session through the same path
    python -m live.server --simulate 2026-09-29 --speed 20

Credentials come from ./config.py and never leave this machine; browsers only receive candles.
Endpoints (CORS open, read-only):
    GET /status                      -> {"mode", "date", "symbols", "updated", "market_open"}
    GET /session/<SYMBOL>            -> today's session payload
    GET /stream?symbol=<SYMBOL>      -> text/event-stream of session payloads on every update
"""

import argparse
import json
import queue
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd

import run
from engine import bars as B, config as C, data, indicators as I, urgency as U

ROOT = Path(__file__).resolve().parents[1]
IST = timezone(timedelta(hours=5, minutes=30))
HISTORY_SESSIONS = 45        # 20 sessions of baseline, each with its own full 20-session candle size


class Book:
    """One stock: recorded history plus today's minutes, and the latest computed session."""

    def __init__(self, symbol: str, history: pd.DataFrame, today: str):
        self.symbol = symbol
        self.history = history                  # raw 1-minute rows (timestamp, o, h, l, c, v)
        # History is processed once: cleaned minutes, and raw volume candles per density.
        hist = data.session(data.prepare(history, symbol))
        self.hist_tail = history.tail(400)      # recent minutes, so today's buy/sell split has its past
        self.sizes, self.hist_bars = {}, {}
        for name, per_day in C.DENSITIES.items():
            probe = pd.concat([hist, pd.DataFrame({"date": [today], "volume": [0.0]})], ignore_index=True)
            self.sizes[name] = B.daily_bar_sizes(probe, per_day).get(today)
            self.hist_bars[name] = B.build_bars(hist, B.daily_bar_sizes(hist, per_day))
        self.minutes: dict[int, list] = {}      # today: minute epoch (UTC) -> [o, h, l, c, v]
        self.forming = None                     # the current, unfinished minute
        self.last_cum = None                    # day volume at the previous tick (live mode)
        self.payload = None
        self.version = 0
        self.lock = threading.Lock()

    # ---------- ticks (live mode) ----------
    def tick(self, ts: float, price: float, day_volume: int) -> None:
        minute = int(ts // 60 * 60)
        with self.lock:
            vol = 0 if self.last_cum is None else max(0, day_volume - self.last_cum)
            self.last_cum = day_volume
            f = self.forming
            if f is None or f[0] != minute:
                if f is not None:
                    self.minutes[f[0]] = f[1:]
                self.forming = [minute, price, price, price, price, vol]
            else:
                f[2] = max(f[2], price); f[3] = min(f[3], price); f[4] = price; f[5] += vol

    def close_minute_if_due(self, now: float) -> bool:
        with self.lock:
            f = self.forming
            if f is not None and now >= f[0] + 60:
                self.minutes[f[0]] = f[1:]
                self.forming = None
                return True
        return False

    # ---------- engine ----------
    def compute(self, today: str, mode: str) -> None:
        with self.lock:
            rows = [(datetime.fromtimestamp(t, IST).isoformat(), *v) for t, v in sorted(self.minutes.items())]
            forming = self.forming[:] if self.forming else None
        if not rows:
            return
        now_df = pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
        minutes = data.prepare(pd.concat([self.hist_tail, now_df], ignore_index=True), self.symbol)
        today_min = data.session(minutes)
        today_min = today_min[today_min["date"] == today]
        if today_min.empty:
            return
        bars, stats = {}, {}
        for name in C.DENSITIES:
            size = self.sizes[name]
            if not size:
                bars[name] = []
                continue
            new = B.build_bars(today_min, {today: size})
            b = I.add_indicators(pd.concat([self.hist_bars[name], new], ignore_index=True))   # same engine, history in front
            today_bars = b[b["date"] == today]
            bars[name] = run._rows(today_bars)
            if name == "standard" and len(today_bars):
                stats = U.day_stats(today_bars)
        sizes = self.sizes
        mins = [[int(r.epoch) + C.IST_OFFSET_SECONDS, run._r(r.open), run._r(r.high), run._r(r.low), run._r(r.close), int(r.volume)]
                for r in today_min.itertuples()]
        payload = {"symbol": self.symbol, "date": today, "size": sizes, "minutes": mins, "bars": bars, "alerts": [],
                   "live": {"mode": mode, "updated": datetime.now(IST).strftime("%H:%M:%S"), "stats": stats,
                            "forming": None if not forming else [forming[0] + C.IST_OFFSET_SECONDS, *forming[1:]]}}
        with self.lock:
            self.payload = payload
            self.version += 1


class Hub:
    """Fan-out of updates to connected browsers."""

    def __init__(self):
        self.clients: list[tuple[str, queue.Queue]] = []
        self.lock = threading.Lock()

    def add(self, symbol):
        q = queue.Queue(maxsize=8)
        with self.lock:
            self.clients.append((symbol, q))
        return q

    def remove(self, q):
        with self.lock:
            self.clients = [c for c in self.clients if c[1] is not q]

    def publish(self, symbol, payload):
        msg = json.dumps(payload, separators=(",", ":"))
        with self.lock:
            for sym, q in self.clients:
                if sym == symbol:
                    try:
                        q.put_nowait(msg)
                    except queue.Full:            # a slow client drops old frames, never blocks the feed
                        pass


def load_history(symbol: str, before: str) -> pd.DataFrame:
    df = pd.read_csv(ROOT / "data" / f"{symbol}.csv")
    df = df[df["timestamp"].str[:10] < before]
    keep = sorted(df["timestamp"].str[:10].unique())[-HISTORY_SESSIONS:]
    return df[df["timestamp"].str[:10].isin(keep)].reset_index(drop=True)


def make_handler(books, hub, info):
    class Handler(BaseHTTPRequestHandler):
        def _headers(self, code=200, ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def log_message(self, *args):                # keep the console for the feed log
            pass

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/status":
                self._headers()
                self.wfile.write(json.dumps({**info, "symbols": sorted(books), "updated": datetime.now(IST).strftime("%H:%M:%S")}).encode())
            elif url.path.startswith("/session/"):
                book = books.get(url.path.rsplit("/", 1)[-1].upper())
                if not book or not book.payload:
                    self._headers(404); self.wfile.write(b'{"error":"no live session yet"}'); return
                self._headers(); self.wfile.write(json.dumps(book.payload, separators=(",", ":")).encode())
            elif url.path == "/stream":
                sym = (parse_qs(url.query).get("symbol") or [""])[0].upper()
                if sym not in books:
                    self._headers(404); return
                self._headers(200, "text/event-stream")
                q = hub.add(sym)
                try:
                    if books[sym].payload:
                        self.wfile.write(f"data: {json.dumps(books[sym].payload, separators=(',', ':'))}\n\n".encode())
                    self.wfile.flush()
                    while True:
                        try:
                            msg = q.get(timeout=15)
                            self.wfile.write(f"data: {msg}\n\n".encode())
                        except queue.Empty:
                            self.wfile.write(b": keep-alive\n\n")      # keeps proxies and tunnels open
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    hub.remove(q)
            else:
                self._headers(404)
    return Handler


def run_live(books, hub, info):
    """AngelOne WebSocket -> ticks -> minute candles -> engine -> browsers."""
    from SmartApi.smartWebSocketV2 import SmartWebSocketV2
    from feed.angel import Angel, TOKENS
    angel = Angel()
    by_token = {TOKENS[s]: s for s in books}
    sws = SmartWebSocketV2(angel.jwt, angel.cfg.API_KEY, angel.cfg.CLIENT_ID, angel.feed_token, max_retry_attempt=50)

    def on_data(_, msg):
        sym = by_token.get(str(msg.get("token")))
        if sym and msg.get("last_traded_price"):
            ts = (msg.get("exchange_timestamp") or time.time() * 1000) / 1000
            books[sym].tick(ts, msg["last_traded_price"] / 100, int(msg.get("volume_trade_for_the_day") or 0))

    def on_open(_):
        sws.subscribe("volumelens", 2, [{"exchangeType": 1, "tokens": list(by_token)}])     # mode 2 = quote
        print("live feed connected:", ", ".join(sorted(books)))

    sws.on_open, sws.on_data = on_open, on_data
    sws.on_error = lambda *a: print("feed error:", a[-1] if a else "")
    sws.on_close = lambda *a: print("feed closed; reconnecting")
    threading.Thread(target=sws.connect, daemon=True).start()

    while True:                                           # close minutes and recompute
        now = time.time()
        for sym, book in books.items():
            if book.close_minute_if_due(now):
                book.compute(info["date"], "live")
                hub.publish(sym, book.payload)
        time.sleep(1)


def run_simulated(books, hub, info, speed: float):
    """Feed a recorded session one minute at a time through the same path."""
    frames = {s: pd.read_csv(ROOT / "data" / f"{s}.csv") for s in books}
    frames = {s: f[f["timestamp"].str[:10] == info["date"]].reset_index(drop=True) for s, f in frames.items()}
    n = max(len(f) for f in frames.values())
    print(f"simulating {info['date']}: {n} minutes at {speed} market minutes per real minute")
    for k in range(n):
        for sym, f in frames.items():
            if k < len(f):
                r = f.iloc[k]
                t = int(pd.Timestamp(r["timestamp"]).timestamp())
                with books[sym].lock:
                    books[sym].minutes[t] = [float(r.open), float(r.high), float(r.low), float(r.close), int(r.volume)]
                books[sym].compute(info["date"], "simulated")
                hub.publish(sym, books[sym].payload)
        time.sleep(60 / speed)
    print("simulated session finished; serving the final state")
    while True:
        time.sleep(60)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="*")
    ap.add_argument("--simulate", metavar="DATE", help="replay a recorded session instead of the live feed")
    ap.add_argument("--speed", type=float, default=30, help="simulated market minutes per real minute")
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()

    symbols = [s.upper() for s in args.symbols] or sorted(p.stem for p in (ROOT / "data").glob("*.csv"))
    today = args.simulate or datetime.now(IST).strftime("%Y-%m-%d")
    t0 = time.time()
    books = {s: Book(s, load_history(s, today), today) for s in symbols}
    print(f"history prepared in {time.time() - t0:.1f}s")
    hub = Hub()
    info = {"mode": "simulated" if args.simulate else "live", "date": today}
    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(books, hub, info))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"VolumeLens live server on http://localhost:{args.port}  ({info['mode']}, {today}, {len(books)} stocks)")
    try:
        if args.simulate:
            run_simulated(books, hub, info, args.speed)
        else:
            run_live(books, hub, info)
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()

"""AngelOne SmartAPI access: login, symbol lookup, 1-minute history.

Credentials come from ./config.py (API_KEY, CLIENT_ID, PASSWORD, TOTP_SECRET), which is
git-ignored and never leaves this machine.
"""

import time
from datetime import datetime, timedelta

import pandas as pd
import pyotp
from SmartApi import SmartConnect

CHUNK_DAYS = 28          # stay under the per-request range limit for 1-minute candles
PAUSE = 1.0              # seconds between requests (AngelOne rate limits historical calls)

# NSE instrument tokens (AngelOne scrip master); unknown symbols fall back to a search
TOKENS = {"RELIANCE": "2885", "HDFCBANK": "1333", "ICICIBANK": "4963", "SBIN": "3045", "INFY": "1594",
          "TCS": "11536", "AXISBANK": "5900", "ITC": "1660", "TECHM": "13538", "YESBANK": "11915", "PNB": "10666"}


def _retry(call, what: str, tries: int = 5):
    """Retry on AngelOne's 'exceeding access rate' and transient errors, backing off."""
    for k in range(tries):
        try:
            res = call()
            if res and res.get("status"):
                return res
            msg = (res or {}).get("message", "empty response")
        except Exception as e:           # the SDK raises when the rate-limit reply is not JSON
            msg = str(e)[:120]
        time.sleep(3 * 2 ** k)
    raise RuntimeError(f"{what} failed after {tries} tries: {msg}")


class Angel:
    def __init__(self):
        import config
        self.cfg = config
        self.api = SmartConnect(api_key=config.API_KEY)
        session = self.api.generateSession(config.CLIENT_ID, config.PASSWORD, pyotp.TOTP(config.TOTP_SECRET).now())
        if not session.get("status"):
            raise RuntimeError(f"AngelOne login failed: {session.get('message')}")
        self.feed_token = self.api.getfeedToken()
        self.jwt = session["data"]["jwtToken"]
        self._tokens = dict(TOKENS)

    def token(self, symbol: str) -> str:
        """NSE equity token; AngelOne lists equities as SYMBOL-EQ."""
        if symbol not in self._tokens:
            data = _retry(lambda: self.api.searchScrip("NSE", symbol), f"lookup {symbol}").get("data") or []
            match = next((d for d in data if d.get("tradingsymbol", "").upper() == f"{symbol}-EQ"), None) \
                or next((d for d in data if d.get("tradingsymbol", "").upper() == symbol), None)
            if not match:
                raise LookupError(f"no NSE equity token for {symbol}")
            self._tokens[symbol] = str(match["symboltoken"])
            time.sleep(PAUSE)
        return self._tokens[symbol]

    def history(self, symbol: str, start: str, end: str) -> pd.DataFrame:
        """1-minute candles between two dates (inclusive), as timestamp/open/high/low/close/volume."""
        tok = self.token(symbol)
        cur = datetime.strptime(start, "%Y-%m-%d").replace(hour=9, minute=15)
        stop = datetime.strptime(end, "%Y-%m-%d").replace(hour=15, minute=30)
        rows = []
        while cur < stop:
            to = min(cur + timedelta(days=CHUNK_DAYS), stop)
            params = {"exchange": "NSE", "symboltoken": tok, "interval": "ONE_MINUTE",
                      "fromdate": cur.strftime("%Y-%m-%d %H:%M"), "todate": to.strftime("%Y-%m-%d %H:%M")}
            rows += _retry(lambda: self.api.getCandleData(params), f"{symbol} {params['fromdate'][:10]}").get("data") or []
            time.sleep(PAUSE)
            cur = to + timedelta(minutes=1)
        df = pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
        return df.drop_duplicates("timestamp").sort_values("timestamp").reset_index(drop=True)

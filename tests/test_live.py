"""The live server must produce exactly what the batch pipeline produces for the same minutes."""

import json
from pathlib import Path

import pandas as pd
import pytest

from live.server import Book, load_history

ROOT = Path(__file__).resolve().parents[1]
DAY = "2026-09-29"


@pytest.mark.parametrize("symbol", ["RELIANCE", "SBIN"])
def test_live_session_equals_batch_session(symbol):
    batch_file = ROOT / "web" / "data" / symbol / f"{DAY}.json"
    if not batch_file.exists():
        pytest.skip("run run.py first")
    book = Book(symbol, load_history(symbol, DAY), DAY)
    rows = pd.read_csv(ROOT / "data" / f"{symbol}.csv")
    for r in rows[rows["timestamp"].str[:10] == DAY].itertuples():       # feed the day minute by minute
        book.minutes[int(pd.Timestamp(r.timestamp).timestamp())] = [r.open, r.high, r.low, r.close, r.volume]
    book.compute(DAY, "simulated")
    batch = json.loads(batch_file.read_text())
    assert book.payload["size"] == batch["size"]
    for density, rows_batch in batch["bars"].items():
        assert book.payload["bars"][density] == rows_batch, density


def test_live_is_incremental_and_never_repaints():
    """Computing after each minute: earlier candles never change once published."""
    symbol = "RELIANCE"
    book = Book(symbol, load_history(symbol, DAY), DAY)
    rows = pd.read_csv(ROOT / "data" / f"{symbol}.csv")
    rows = rows[rows["timestamp"].str[:10] == DAY].head(90)
    published = []
    for r in rows.itertuples():
        book.minutes[int(pd.Timestamp(r.timestamp).timestamp())] = [r.open, r.high, r.low, r.close, r.volume]
        book.compute(DAY, "simulated")
        if book.payload:
            published.append(book.payload["bars"]["standard"])
    for earlier, later in zip(published, published[1:]):
        assert later[:len(earlier)] == earlier
